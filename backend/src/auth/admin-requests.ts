import { randomBytes } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { onlyRow, withTransaction, type Queryable } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { isUniqueViolation, uuidParams } from '../http.js';
import { ADMIN_ROLES, type AdminRole } from './access.js';
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

/** The admins' email about someone who signed up with an invitation link and waits for approval (D84). */
export function invitedMemberEmail(name: string, email: string, role: string, approveLink: string, teamLink: string) {
  return {
    subject: 'New MISK team member waiting for approval',
    text: [
      `${name} (${email}) signed up for the MISK control panel with an invitation link for the role "${role}".`,
      '',
      `They cannot sign in until an admin approves them. To approve with that role, open this link. It works once, for ${APPROVAL_LINK_DAYS} days:`,
      approveLink,
      '',
      'To choose another role or to decline, go to Team & access:',
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

/** Whether an account came from an invitation link, which the log and emails then say (D84). */
const INVITED = 'invited_at IS NOT NULL';

/**
 * Makes the one-click approval link for a waiting account. Call it in the transaction that creates the
 * account; returns the token, which only goes into the admins' email.
 */
export async function createApprovalLink(db: Queryable, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query(`INSERT INTO admin_approval_links (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`, [
    userId,
    hashToken(token),
    APPROVAL_LINK_DAYS,
  ]);
  return token;
}

/**
 * Tells every approved admin with an email about an account waiting for approval, so it is not left
 * waiting. A failed email is logged and never undoes the sign-up.
 */
export async function emailAdminsAboutRequest(
  ctx: AppContext,
  log: FastifyBaseLogger,
  request: { name: string; email: string; token: string; invitedRole?: AdminRole },
) {
  const deliver = ctx.deliverEmail;
  if (!deliver) {
    return;
  }
  const admins = await ctx.pool.query<{ email: string }>(
    `SELECT email FROM users WHERE role = 'admin' AND email IS NOT NULL AND disabled_at IS NULL
       AND (admin_requested_at IS NULL OR admin_approved_at IS NOT NULL)`,
  );
  // The token goes after #, so it never reaches server logs or other sites in a Referer header.
  const approveLink = `${ctx.config.adminOrigin}/admin/approve#token=${request.token}`;
  const teamLink = `${ctx.config.adminOrigin}/admin/settings/team`;
  const message = request.invitedRole
    ? invitedMemberEmail(request.name, request.email, request.invitedRole, approveLink, teamLink)
    : adminRequestEmail(request.name, request.email, approveLink, teamLink);
  for (const admin of admins.rows) {
    await deliver({ to: admin.email, ...message }).catch((error: unknown) => log.error({ event: 'admin_request_email_failed', err: error }));
  }
}

/**
 * New team members ask for an admin account on the control panel, or sign up with an invitation link. Either
 * way the account cannot sign in until an existing admin approves it (D21, D84), because admins can approve
 * pros and refund money.
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
      let token: string;
      try {
        token = await withTransaction(pool, async (client) => {
          const created = await client.query<{ id: string }>(
            `INSERT INTO users (username, email, password_hash, role, first_name, last_name, admin_requested_at)
             VALUES ($1, $1, $2, 'admin', $3, $4, now()) RETURNING id`,
            [email, await hashPassword(request.body.password), firstName, lastName],
          );
          return createApprovalLink(client, onlyRow(created).id);
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          return reply.code(409).send({ error: 'email_taken' });
        }
        throw error;
      }
      request.log.info({ event: 'admin_account_requested' });
      await emailAdminsAboutRequest(ctx, request.log, { name: `${firstName} ${lastName}`, email, token });
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
        const user = await client.query<{
          id: string;
          email: string;
          firstName: string | null;
          lastName: string | null;
          role: AdminRole;
          invited: boolean;
        }>(
          `UPDATE users SET admin_approved_at = now()
           WHERE id = $1 AND role = 'admin' AND admin_requested_at IS NOT NULL AND admin_approved_at IS NULL AND disabled_at IS NULL
           RETURNING id, email, first_name AS "firstName", last_name AS "lastName", admin_role AS role, ${INVITED} AS invited`,
          [userId],
        );
        const approved = user.rows[0];
        if (!approved) {
          return null;
        }
        // The same link goes to every admin, so the log cannot say which one used it.
        await logTeamActivity(client, {
          adminId: null,
          memberId: userId,
          action: approved.invited ? 'invite_approved_by_link' : 'request_approved_by_link',
          details: approved.invited ? { role: approved.role } : {},
        });
        return approved;
      });
      if (!approved) {
        return reply.code(400).send({ error: 'invalid_approval_link' });
      }
      request.log.info({ event: 'admin_request_approved_by_link', adminId: approved.id });
      await tellApproved(approved.id);
      return { admin: { email: approved.email, firstName: approved.firstName, lastName: approved.lastName } };
    },
  );

  // The body is optional: { role } gives the person another role than the one they asked or were invited for.
  app.post<{ Params: { id: string }; Body: { role?: AdminRole } | undefined }>(
    '/admin/team/:id/approve',
    { preHandler: guards.admin, schema: { params: uuidParams } },
    async (request) => {
      const adminId = currentUser(request).id;
      const body: unknown = request.body;
      const role = body && typeof body === 'object' && 'role' in body ? body.role : undefined;
      if (role !== undefined && !ADMIN_ROLES.includes(role as AdminRole)) {
        throw badRequest('invalid_role');
      }
      if (body !== undefined && body !== null && (typeof body !== 'object' || Object.keys(body).some((key) => key !== 'role'))) {
        throw badRequest('invalid_body');
      }
      await withTransaction(pool, async (client) => {
        // Only one approval wins: the row changes once, so a second admin (or the email link) gets not_pending.
        const approved = await client.query<{ role: AdminRole; invited: boolean }>(
          `UPDATE users SET admin_approved_at = now(), admin_approved_by = $2, admin_role = COALESCE($3, admin_role)
           WHERE id = $1 AND role = 'admin' AND admin_requested_at IS NOT NULL AND admin_approved_at IS NULL AND disabled_at IS NULL
           RETURNING admin_role AS role, ${INVITED} AS invited`,
          [request.params.id, adminId, role ?? null],
        );
        const member = approved.rows[0];
        if (!member) {
          const exists = await client.query('SELECT 1 FROM users WHERE id = $1', [request.params.id]);
          throw exists.rowCount ? conflict('not_pending') : notFound();
        }
        await client.query('UPDATE admin_approval_links SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [request.params.id]);
        await logTeamActivity(client, {
          adminId,
          memberId: request.params.id,
          action: member.invited ? 'invite_approved' : 'request_approved',
          details: member.invited ? { role: member.role } : {},
        });
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
        // Locked first, so an approval at the same moment either happens before (and this answers
        // not_pending) or waits and then finds nothing to approve.
        const waiting = await client.query<{ invited: boolean; role: AdminRole }>(
          `SELECT ${INVITED} AS invited, admin_role AS role FROM users
           WHERE id = $1 AND role = 'admin' AND admin_requested_at IS NOT NULL AND admin_approved_at IS NULL FOR UPDATE`,
          [request.params.id],
        );
        const member = waiting.rows[0];
        if (!member) {
          const exists = await client.query('SELECT 1 FROM users WHERE id = $1', [request.params.id]);
          throw exists.rowCount ? conflict('not_pending') : notFound();
        }
        // Logged before the delete: once the account is gone, its name is gone too. Declining removes the
        // account, so the person cannot sign in; a used invitation link stays used.
        await logTeamActivity(client, {
          adminId,
          memberId: request.params.id,
          action: member.invited ? 'invite_declined' : 'request_declined',
          details: member.invited ? { role: member.role } : {},
        });
        await client.query('DELETE FROM users WHERE id = $1', [request.params.id]);
      });
      request.log.info({ event: 'admin_request_declined', adminId: request.params.id, by: currentUser(request).id });
      return reply.code(204).send();
    },
  );
}
