import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { AppContext } from '../context.js';
import { withTransaction, type Queryable } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { isUniqueViolation, uuidParams } from '../http.js';
import { normalizeUsername } from './admin-sign-in.js';
import { currentUser, SESSION_COOKIE } from './guard.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from './passwords.js';
import { hashToken } from './sessions.js';

const USERNAME_FORMAT = /^\S{3,254}$/;
const passwordProperty = { type: 'string', minLength: MIN_PASSWORD_LENGTH, maxLength: 1024 } as const;

/**
 * Sets a new password for an admin, ends all their sessions except `keepToken` (the caller's own),
 * and clears their failed sign-in attempts so a locked-out admin can sign in at once.
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
  const updated = await db.query<{ id: string; username: string }>(
    `UPDATE users SET password_hash = $3
     WHERE role = 'admin' AND (id = $1::uuid OR username = $2) RETURNING id, username`,
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
  await db.query('DELETE FROM login_attempts WHERE key = $1', [`admin:${admin.username}`]);
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
    const result = await pool.query(
      `SELECT id, username, created_at AS "createdAt", disabled_at IS NOT NULL AS disabled
       FROM users WHERE role = 'admin' ORDER BY username`,
    );
    return { admins: result.rows };
  });

  app.post<{ Body: { username: string; password: string } }>(
    '/admin/team',
    {
      preHandler: guards.admin,
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          additionalProperties: false,
          properties: { username: { type: 'string', minLength: 3, maxLength: 254 }, password: passwordProperty },
        },
      },
    },
    async (request, reply) => {
      const username = normalizeUsername(request.body.username);
      if (!USERNAME_FORMAT.test(username)) {
        throw badRequest('invalid_username');
      }
      try {
        const created = await pool.query(
          `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'admin')
           RETURNING id, username, created_at AS "createdAt", false AS disabled`,
          [username, await hashPassword(request.body.password)],
        );
        request.log.info({ event: 'admin_created', adminId: created.rows[0]?.id, by: currentUser(request).id });
        return reply.code(201).send({ admin: created.rows[0] });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict('username_taken');
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
        setAdminPassword(client, { id: request.params.id }, request.body.password, request.cookies[SESSION_COOKIE]),
      );
      if (!done) {
        throw notFound();
      }
      request.log.info({ event: 'admin_password_reset', adminId: request.params.id, by: currentUser(request).id });
      return reply.code(204).send();
    },
  );
}
