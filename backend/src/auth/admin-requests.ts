import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { isUniqueViolation, uuidParams } from '../http.js';
import { normalizeEmail } from './admin-accounts.js';
import { currentUser } from './guard.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from './passwords.js';
import { refuseWrongSite } from './routes.js';
import { hashToken, recordAttempt } from './sessions.js';
import { logTeamActivity } from '../settings/activity.js';

export const MAX_ADMIN_REQUESTS_PER_IP = 5;
/** How long the one-click approval link in the admins' email works. */
export const APPROVAL_LINK_DAYS = 7;
const EMAIL_FORMAT = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const nameProperty = { type: 'string', minLength: 1, maxLength: 60, pattern: '\\S' } as const;

export function adminRequestEmail(name: string, email: string, approveLink: string, teamLink: string) {
  return {
    subject: 'New MISK admin account request',
    text: [
      `${name} (${email}) asked for an admin account on the MISK control panel.`,
      '',
      `To approve, open this link. ${name} can sign in with ${email} straight away. It works once, for ${APPROVAL_LINK_DAYS} days:`,
      approveLink,
      '',
      'If you do not know this person, do not open the link. Decline the request under Team instead:',
      teamLink,
    ].join('\n'),
  };
}

export function adminApprovedEmail(name: string, email: string, loginLink: string) {
  return {
    subject: 'Your MISK admin account is ready',
    text: [`Hello ${name},`, '', `Your admin account is approved. Sign in with ${email} and your password:`, loginLink].join('\n'),
  };
}

/**
 * New team members ask for an admin account on the control panel. The account cannot sign in until
 * an existing admin approves it (D21), because admins can approve pros and refund money.
 */
export async function adminRequestRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards, config } = ctx;

  app.post<{ Body: { firstName: string; lastName: string; email: string; password: string } }>(
    '/auth/admin/register',
    {
      schema: {
        body: {
          type: 'object',
          required: ['firstName', 'lastName', 'email', 'password'],
          additionalProperties: false,
          properties: {
            firstName: nameProperty,
            lastName: nameProperty,
            email: { type: 'string', minLength: 3, maxLength: 254 },
            password: { type: 'string', minLength: 1, maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      if (refuseWrongSite(request, reply, config, 'admin')) {
        return reply;
      }
      const email = normalizeEmail(request.body.email);
      if (!EMAIL_FORMAT.test(email)) {
        throw badRequest('invalid_email');
      }
      if (request.body.password.length < MIN_PASSWORD_LENGTH) {
        throw badRequest('password_too_short');
      }
      const byIp = await recordAttempt(pool, `admin-request-ip:${request.ip}`, MAX_ADMIN_REQUESTS_PER_IP);
      if (byIp.overLimit) {
        return reply.code(429).send({ error: 'too_many_attempts' });
      }
      const firstName = request.body.firstName.trim();
      const lastName = request.body.lastName.trim();
      const token = randomBytes(32).toString('base64url');
      try {
        await withTransaction(pool, async (client) => {
          const created = await client.query<{ id: string }>(
            `INSERT INTO users (username, email, password_hash, role, first_name, last_name, admin_requested_at)
             VALUES ($1, $1, $2, 'admin', $3, $4, now()) RETURNING id`,
            [email, await hashPassword(request.body.password), firstName, lastName],
          );
          await client.query(
            `INSERT INTO admin_approval_links (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
            [created.rows[0]?.id, hashToken(token), APPROVAL_LINK_DAYS],
          );
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          return reply.code(409).send({ error: 'email_taken' });
        }
        throw error;
      }
      request.log.info({ event: 'admin_account_requested' });

      // Tell the approved admins who have an email, so the request is not left waiting.
      if (ctx.deliverEmail) {
        const admins = await pool.query<{ email: string }>(
          `SELECT email FROM users WHERE role = 'admin' AND email IS NOT NULL AND disabled_at IS NULL
             AND (admin_requested_at IS NULL OR admin_approved_at IS NOT NULL)`,
        );
        // The token goes after #, so it never reaches server logs or other sites in a Referer header.
        const message = adminRequestEmail(
          `${firstName} ${lastName}`,
          email,
          `${config.adminOrigin}/admin/approve#token=${token}`,
          `${config.adminOrigin}/admin/settings/team`,
        );
        for (const admin of admins.rows) {
          await ctx.deliverEmail({ to: admin.email, ...message }).catch((error: unknown) =>
            request.log.error({ event: 'admin_request_email_failed', err: error }),
          );
        }
      }
      return reply.code(201).send({ status: 'pending_approval' });
    },
  );

  /** Lets the new admin know they can sign in. A failed email never undoes the approval. */
  async function tellApproved(userId: string) {
    if (!ctx.deliverEmail) {
      return;
    }
    const found = await pool.query<{ email: string; first_name: string | null }>('SELECT email, first_name FROM users WHERE id = $1', [userId]);
    const user = found.rows[0];
    if (user) {
      await ctx
        .deliverEmail({ to: user.email, ...adminApprovedEmail(user.first_name ?? '', user.email, `${config.adminOrigin}/admin/login`) })
        .catch((error: unknown) => app.log.error({ event: 'admin_approved_email_failed', err: error }));
    }
  }

  // The link in the admins' email. Holding the link is the permission: only approved admins get it.
  app.post<{ Body: { token: string } }>(
    '/auth/admin/approve',
    {
      schema: {
        body: {
          type: 'object',
          required: ['token'],
          additionalProperties: false,
          properties: { token: { type: 'string', minLength: 20, maxLength: 100 } },
        },
      },
    },
    async (request, reply) => {
      if (refuseWrongSite(request, reply, config, 'admin')) {
        return reply;
      }
      const approved = await withTransaction(pool, async (client) => {
        const link = await client.query<{ user_id: string }>(
          `UPDATE admin_approval_links SET used_at = now()
           WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
           RETURNING user_id`,
          [hashToken(request.body.token)],
        );
        const userId = link.rows[0]?.user_id;
        if (!userId) {
          return null;
        }
        const user = await client.query<{ id: string; email: string; firstName: string | null; lastName: string | null }>(
          `UPDATE users SET admin_approved_at = now()
           WHERE id = $1 AND role = 'admin' AND admin_requested_at IS NOT NULL AND admin_approved_at IS NULL
           RETURNING id, email, first_name AS "firstName", last_name AS "lastName"`,
          [userId],
        );
        // The same link goes to every admin, so the log cannot say which one used it.
        if (user.rows[0]) await logTeamActivity(client, { adminId: null, memberId: userId, action: 'request_approved_by_link' });
        return user.rows[0] ?? null;
      });
      if (!approved) {
        return reply.code(400).send({ error: 'invalid_approval_link' });
      }
      request.log.info({ event: 'admin_request_approved_by_link', adminId: approved.id });
      await tellApproved(approved.id);
      return { admin: { email: approved.email, firstName: approved.firstName, lastName: approved.lastName } };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/team/:id/approve',
    { preHandler: guards.admin, schema: { params: uuidParams } },
    async (request) => {
      const adminId = currentUser(request).id;
      await withTransaction(pool, async (client) => {
        const approved = await client.query(
          `UPDATE users SET admin_approved_at = now(), admin_approved_by = $2
           WHERE id = $1 AND role = 'admin' AND admin_requested_at IS NOT NULL AND admin_approved_at IS NULL`,
          [request.params.id, adminId],
        );
        if (!approved.rowCount) {
          throw conflict('not_pending');
        }
        await client.query('UPDATE admin_approval_links SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [request.params.id]);
        await logTeamActivity(client, { adminId, memberId: request.params.id, action: 'request_approved' });
      });
      await tellApproved(request.params.id);
      request.log.info({ event: 'admin_request_approved', adminId: request.params.id, by: currentUser(request).id });
      return { approved: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/team/:id/decline',
    { preHandler: guards.admin, schema: { params: uuidParams } },
    async (request, reply) => {
      const adminId = currentUser(request).id;
      await withTransaction(pool, async (client) => {
        // Logged first: once the request is deleted, its name is gone. The transaction undoes the line if
        // nothing was declined.
        await logTeamActivity(client, { adminId, memberId: request.params.id, action: 'request_declined' });
        const declined = await client.query(
          `DELETE FROM users WHERE id = $1 AND role = 'admin' AND admin_requested_at IS NOT NULL AND admin_approved_at IS NULL`,
          [request.params.id],
        );
        if (!declined.rowCount) {
          const exists = await client.query('SELECT 1 FROM users WHERE id = $1', [request.params.id]);
          throw exists.rowCount ? conflict('not_pending') : notFound();
        }
      });
      request.log.info({ event: 'admin_request_declined', adminId: request.params.id, by: currentUser(request).id });
      return reply.code(204).send();
    },
  );
}
