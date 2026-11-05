import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { isUniqueViolation, uuidParams } from '../http.js';
import { normalizeEmail } from './admin-accounts.js';
import { currentUser } from './guard.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from './passwords.js';
import { refuseWrongSite } from './routes.js';
import { recordAttempt } from './sessions.js';

export const MAX_ADMIN_REQUESTS_PER_IP = 5;
const EMAIL_FORMAT = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const nameProperty = { type: 'string', minLength: 1, maxLength: 60, pattern: '\\S' } as const;

export function adminRequestEmail(name: string, email: string, teamLink: string) {
  return {
    subject: 'New MISK admin account request',
    text: [
      `${name} (${email}) asked for an admin account on the MISK control panel.`,
      '',
      `They cannot sign in until an admin approves the request. Approve or decline it under Team:`,
      teamLink,
      '',
      'If you do not know this person, decline the request.',
    ].join('\n'),
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
      try {
        await pool.query(
          `INSERT INTO users (username, email, password_hash, role, first_name, last_name, admin_requested_at)
           VALUES ($1, $1, $2, 'admin', $3, $4, now())`,
          [email, await hashPassword(request.body.password), firstName, lastName],
        );
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
        const message = adminRequestEmail(`${firstName} ${lastName}`, email, `${config.adminOrigin}/admin/settings/team`);
        for (const admin of admins.rows) {
          await ctx.deliverEmail({ to: admin.email, ...message }).catch((error: unknown) =>
            request.log.error({ event: 'admin_request_email_failed', err: error }),
          );
        }
      }
      return reply.code(201).send({ status: 'pending_approval' });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/team/:id/approve',
    { preHandler: guards.admin, schema: { params: uuidParams } },
    async (request) => {
      const approved = await pool.query(
        `UPDATE users SET admin_approved_at = now(), admin_approved_by = $2
         WHERE id = $1 AND role = 'admin' AND admin_requested_at IS NOT NULL AND admin_approved_at IS NULL`,
        [request.params.id, currentUser(request).id],
      );
      if (!approved.rowCount) {
        throw conflict('not_pending');
      }
      request.log.info({ event: 'admin_request_approved', adminId: request.params.id, by: currentUser(request).id });
      return { approved: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/team/:id/decline',
    { preHandler: guards.admin, schema: { params: uuidParams } },
    async (request, reply) => {
      const declined = await pool.query(
        `DELETE FROM users WHERE id = $1 AND role = 'admin' AND admin_requested_at IS NOT NULL AND admin_approved_at IS NULL`,
        [request.params.id],
      );
      if (!declined.rowCount) {
        const exists = await pool.query('SELECT 1 FROM users WHERE id = $1', [request.params.id]);
        throw exists.rowCount ? conflict('not_pending') : notFound();
      }
      request.log.info({ event: 'admin_request_declined', adminId: request.params.id, by: currentUser(request).id });
      return reply.code(204).send();
    },
  );
}
