import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import { badRequest } from '../errors.js';
import { isUniqueViolation } from '../http.js';
import { normalizeEmail } from './admin-accounts.js';
import { hashPassword, slowDownFailedLogin, spendVerificationTime, verifyPassword } from './passwords.js';
import { publicUser, startSessionCookie } from './routes.js';
import { createSession, deleteExpiredRows, recordAttempt, USER_COLUMNS, type User } from './sessions.js';

/** Customers' and pros' passwords: at least 8 characters with a letter and a number. */
export const MIN_USER_PASSWORD_LENGTH = 8;
export const MAX_REGISTRATIONS_PER_IP = 10;

const EMAIL_FORMAT = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const nameProperty = { type: 'string', minLength: 1, maxLength: 60, pattern: '\\S' } as const;

export function passwordProblems(password: string): ('length' | 'letter' | 'number')[] {
  const problems: ('length' | 'letter' | 'number')[] = [];
  if (password.length < MIN_USER_PASSWORD_LENGTH) problems.push('length');
  if (!/\p{L}/u.test(password)) problems.push('letter');
  if (!/\p{N}/u.test(password)) problems.push('number');
  return problems;
}

interface RegisterBody {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  acceptTerms: boolean;
}

export async function emailAccountRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, config } = ctx;

  app.post<{ Body: RegisterBody }>(
    '/auth/register',
    {
      schema: {
        body: {
          type: 'object',
          required: ['firstName', 'lastName', 'email', 'password', 'acceptTerms'],
          additionalProperties: false,
          properties: {
            firstName: nameProperty,
            lastName: nameProperty,
            email: { type: 'string', minLength: 3, maxLength: 254 },
            // The upper limit stops very long inputs from being used to overload password hashing.
            password: { type: 'string', minLength: 1, maxLength: 1024 },
            acceptTerms: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const email = normalizeEmail(body.email);
      if (!EMAIL_FORMAT.test(email)) {
        throw badRequest('invalid_email');
      }
      if (passwordProblems(body.password).length) {
        throw badRequest('weak_password');
      }
      if (body.acceptTerms !== true) {
        throw badRequest('terms_not_accepted');
      }
      await deleteExpiredRows(pool);
      const byIp = await recordAttempt(pool, `register-ip:${request.ip}`, MAX_REGISTRATIONS_PER_IP);
      if (byIp.overLimit) {
        return reply.code(429).send({ error: 'too_many_attempts' });
      }

      const passwordHash = await hashPassword(body.password);
      try {
        const result = await withTransaction(pool, async (client) => {
          const created = await client.query<User>(
            `INSERT INTO users (email, password_hash, first_name, last_name, terms_accepted_at)
             VALUES ($1, $2, $3, $4, now())
             RETURNING ${USER_COLUMNS}`,
            [email, passwordHash, body.firstName.trim(), body.lastName.trim()],
          );
          const user = created.rows[0];
          if (!user) {
            throw new Error('Registration returned no user');
          }
          return { user, token: await createSession(client, user.id) };
        });
        await startSessionCookie(request, reply, pool, config, result.token);
        request.log.info({ event: 'account_registered', userId: result.user.id });
        return reply.code(201).send({ user: publicUser(result.user) });
      } catch (error) {
        if (isUniqueViolation(error)) {
          return reply.code(409).send({ error: 'email_taken' });
        }
        throw error;
      }
    },
  );

  app.post<{ Body: { email: string; password: string } }>(
    '/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          additionalProperties: false,
          properties: {
            email: { type: 'string', minLength: 3, maxLength: 254 },
            password: { type: 'string', minLength: 1, maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      // Admins sign in with their username on the control panel, never here.
      const found = await pool.query<User & { passwordHash: string; disabled: boolean }>(
        `SELECT ${USER_COLUMNS}, users.password_hash AS "passwordHash", users.disabled_at IS NOT NULL AS disabled
         FROM users WHERE users.email = $1 AND users.password_hash IS NOT NULL AND users.role IS DISTINCT FROM 'admin'`,
        [email],
      );
      const row = found.rows[0];
      if (!row) {
        await spendVerificationTime(request.body.password);
        await slowDownFailedLogin();
        return reply.code(401).send({ error: 'invalid_login' });
      }
      if (!(await verifyPassword(row.passwordHash, request.body.password))) {
        await slowDownFailedLogin();
        return reply.code(401).send({ error: 'invalid_login' });
      }
      if (row.disabled) {
        return reply.code(403).send({ error: 'account_disabled' });
      }
      await startSessionCookie(request, reply, pool, config, await createSession(pool, row.id));
      request.log.info({ event: 'login_succeeded', userId: row.id });
      return { user: publicUser(row) };
    },
  );
}
