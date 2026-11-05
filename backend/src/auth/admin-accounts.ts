import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { AppContext } from '../context.js';
import { withTransaction, type Queryable } from '../db.js';
import { ApiError, badRequest, conflict, notFound } from '../errors.js';
import { isUniqueViolation, uuidParams } from '../http.js';
import { normalizeUsername } from './admin-sign-in.js';
import { currentUser, sessionCookieFor, siteOf } from './guard.js';
import { refuseWrongSite } from './routes.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from './passwords.js';
import { hashToken, recordAttempt } from './sessions.js';

const USERNAME_FORMAT = /^\S{3,254}$/;
const passwordProperty = { type: 'string', minLength: MIN_PASSWORD_LENGTH, maxLength: 1024 } as const;
const emailProperty = { type: 'string', minLength: 3, maxLength: 254, pattern: '^\\s*[^@\\s]+@[^@\\s]+\\.[^@\\s]+\\s*$' } as const;

export const RESET_LINK_MINUTES = 30;
export const MAX_RESETS_PER_ACCOUNT = 3;
export const MAX_RESETS_PER_IP = 10;
const TEAM_COLUMNS = `id, username, email, first_name AS "firstName", last_name AS "lastName", created_at AS "createdAt",
  disabled_at IS NOT NULL AS disabled, (admin_requested_at IS NOT NULL AND admin_approved_at IS NULL) AS pending`;

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export function resetEmail(username: string, link: string) {
  return {
    subject: 'Reset your MISK admin password',
    text: [
      `Someone asked to reset the password of the MISK admin account "${username}".`,
      '',
      `To choose a new password, open this link within ${RESET_LINK_MINUTES} minutes. It works once:`,
      link,
      '',
      'If this was not you, ignore this email. Your password stays the same.',
    ].join('\n'),
  };
}

/**
 * Sets a new password for an admin and ends all their sessions except `keepToken` (the caller's own).
 * Returns false when no admin has that id.
 */
export async function setAdminPassword(
  db: Queryable,
  where: { id: string } | { username: string },
  password: string,
  keepToken?: string,
): Promise<boolean> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw badRequest('password_too_short');
  }
  const passwordHash = await hashPassword(password);
  const updated = await db.query<{ id: string; username: string; email: string | null }>(
    `UPDATE users SET password_hash = $3
     WHERE role = 'admin' AND (id = $1::uuid OR username = $2) RETURNING id, username, email`,
    ['id' in where ? where.id : null, 'username' in where ? normalizeUsername(where.username) : null, passwordHash],
  );
  const admin = updated.rows[0];
  if (!admin) {
    return false;
  }
  await db.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash IS DISTINCT FROM $2', [
    admin.id,
    keepToken ? hashToken(keepToken) : null,
  ]);
  return true;
}

/** Used by `npm run user:reset-password` when no admin can sign in to reset another. */
export async function resetAdminPasswordByUsername(pool: Pool, username: string, password: string) {
  const done = await withTransaction(pool, (client) => setAdminPassword(client, { username }, password));
  if (!done) {
    throw new Error('There is no admin with that username.');
  }
}

export async function adminAccountRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards } = ctx;

  app.get('/admin/team', { preHandler: guards.admin }, async () => {
    const result = await pool.query(`SELECT ${TEAM_COLUMNS} FROM users WHERE role = 'admin' ORDER BY username`);
    return { admins: result.rows };
  });

  app.post<{ Body: { username: string; password: string; email?: string } }>(
    '/admin/team',
    {
      preHandler: guards.admin,
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          additionalProperties: false,
          properties: { username: { type: 'string', minLength: 3, maxLength: 254 }, password: passwordProperty, email: emailProperty },
        },
      },
    },
    async (request, reply) => {
      const username = normalizeUsername(request.body.username);
      if (!USERNAME_FORMAT.test(username)) {
        throw badRequest('invalid_username');
      }
      try {
        const email = request.body.email ? normalizeEmail(request.body.email) : null;
        const created = await pool.query(
          `INSERT INTO users (username, password_hash, role, email) VALUES ($1, $2, 'admin', $3) RETURNING ${TEAM_COLUMNS}`,
          [username, await hashPassword(request.body.password), email],
        );
        request.log.info({ event: 'admin_created', adminId: created.rows[0]?.id, by: currentUser(request).id });
        return reply.code(201).send({ admin: created.rows[0] });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict(String((error as { constraint?: string }).constraint).includes('email') ? 'email_taken' : 'username_taken');
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { password: string } }>(
    '/admin/team/:id/password',
    {
      preHandler: guards.admin,
      schema: {
        params: uuidParams,
        body: { type: 'object', required: ['password'], additionalProperties: false, properties: { password: passwordProperty } },
      },
    },
    async (request, reply) => {
      const done = await withTransaction(pool, (client) =>
        setAdminPassword(client, { id: request.params.id }, request.body.password, request.cookies[sessionCookieFor(ctx.config, siteOf(request, ctx.config))]),
      );
      if (!done) {
        throw notFound();
      }
      request.log.info({ event: 'admin_password_reset', adminId: request.params.id, by: currentUser(request).id });
      return reply.code(204).send();
    },
  );

  app.patch<{ Params: { id: string }; Body: { email: string | null } }>(
    '/admin/team/:id',
    {
      preHandler: guards.admin,
      schema: {
        params: uuidParams,
        body: {
          type: 'object',
          required: ['email'],
          additionalProperties: false,
          properties: { email: { anyOf: [emailProperty, { type: 'null' }] } },
        },
      },
    },
    async (request) => {
      const email = request.body.email === null ? null : normalizeEmail(request.body.email);
      try {
        const updated = await pool.query(`UPDATE users SET email = $2 WHERE id = $1 AND role = 'admin' RETURNING ${TEAM_COLUMNS}`, [
          request.params.id,
          email,
        ]);
        if (!updated.rowCount) {
          throw notFound();
        }
        request.log.info({ event: 'admin_email_changed', adminId: request.params.id, by: currentUser(request).id });
        return { admin: updated.rows[0] };
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict('email_taken');
        }
        throw error;
      }
    },
  );

  // Always answers the same way, so nobody can find out which usernames or emails exist.
  app.post<{ Body: { identifier: string } }>(
    '/auth/admin/forgot',
    {
      schema: {
        body: {
          type: 'object',
          required: ['identifier'],
          additionalProperties: false,
          properties: { identifier: { type: 'string', minLength: 3, maxLength: 254 } },
        },
      },
    },
    async (request, reply) => {
      if (refuseWrongSite(request, reply, ctx.config, 'admin')) {
        return reply;
      }
      const deliver = ctx.deliverEmail;
      if (!deliver) {
        throw new ApiError(503, 'email_unavailable');
      }
      const identifier = normalizeEmail(request.body.identifier);
      const byAccount = await recordAttempt(pool, `reset:${identifier}`, MAX_RESETS_PER_ACCOUNT);
      const byIp = await recordAttempt(pool, `reset-ip:${request.ip}`, MAX_RESETS_PER_IP);
      if (byAccount.overLimit || byIp.overLimit) {
        return reply.code(429).send({ error: 'too_many_attempts' });
      }
      const found = await pool.query<{ id: string; username: string; email: string }>(
        `SELECT id, username, email FROM users
         WHERE role = 'admin' AND disabled_at IS NULL AND email IS NOT NULL AND (username = $1 OR email = $1)
           AND (admin_requested_at IS NULL OR admin_approved_at IS NOT NULL)`,
        [identifier],
      );
      const admin = found.rows[0];
      if (!admin) {
        request.log.info({ event: 'admin_reset_no_match' });
        return reply.code(202).send({});
      }
      const token = randomBytes(32).toString('base64url');
      await withTransaction(pool, async (client) => {
        // Only the newest link works.
        await client.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [admin.id]);
        await client.query(
          `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))`,
          [admin.id, hashToken(token), RESET_LINK_MINUTES],
        );
      });
      // The token goes after #, so it never reaches server logs or other sites in a Referer header.
      const link = `${ctx.config.adminOrigin}/admin/reset-password#token=${token}`;
      try {
        await deliver({ to: admin.email, ...resetEmail(admin.username, link) });
        request.log.info({ event: 'admin_reset_email_sent', adminId: admin.id });
      } catch (error) {
        // Answering differently would reveal that the account exists; the log tells the team.
        request.log.error({ event: 'admin_reset_email_failed', adminId: admin.id, err: error });
      }
      return reply.code(202).send({});
    },
  );

  app.post<{ Body: { token: string; password: string } }>(
    '/auth/admin/reset',
    {
      schema: {
        body: {
          type: 'object',
          required: ['token', 'password'],
          additionalProperties: false,
          properties: { token: { type: 'string', minLength: 20, maxLength: 100 }, password: passwordProperty },
        },
      },
    },
    async (request, reply) => {
      if (refuseWrongSite(request, reply, ctx.config, 'admin')) {
        return reply;
      }
      const adminId = await withTransaction(pool, async (client) => {
        const claimed = await client.query<{ user_id: string }>(
          `UPDATE password_resets r SET used_at = now()
           FROM users u
           WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > now()
             AND u.id = r.user_id AND u.role = 'admin' AND u.disabled_at IS NULL
           RETURNING r.user_id`,
          [hashToken(request.body.token)],
        );
        const userId = claimed.rows[0]?.user_id;
        if (!userId) {
          return null;
        }
        await setAdminPassword(client, { id: userId }, request.body.password);
        await client.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
        return userId;
      });
      if (!adminId) {
        return reply.code(400).send({ error: 'invalid_reset_link' });
      }
      request.log.info({ event: 'admin_password_reset_by_email', adminId });
      return reply.code(204).send();
    },
  );
}
