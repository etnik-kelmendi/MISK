import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { withTransaction, type Queryable } from '../db.js';
import { ApiError, badRequest } from '../errors.js';
import { isUniqueViolation } from '../http.js';
import { normalizeEmail } from './admin-accounts.js';
import { hashPassword, slowDownFailedLogin, spendVerificationTime, verifyPassword } from './passwords.js';
import { publicUser, refuseWrongSite, startSessionCookie } from './routes.js';
import { createSession, deleteExpiredRows, hashToken, recordAttempt, USER_COLUMNS, type User } from './sessions.js';

/** Customers' and pros' passwords: at least 8 characters with a letter and a number. */
export const MIN_USER_PASSWORD_LENGTH = 8;
export const MAX_REGISTRATIONS_PER_IP = 10;
/** How long a link to confirm an email address works. */
export const VERIFY_LINK_HOURS = 24;
export const MAX_VERIFY_EMAILS_PER_ACCOUNT = 5;
export const MAX_VERIFY_EMAILS_PER_IP = 20;

const EMAIL_FORMAT = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const nameProperty = { type: 'string', minLength: 1, maxLength: 60, pattern: '\\S' } as const;

export function passwordProblems(password: string): ('length' | 'letter' | 'number')[] {
  const problems: ('length' | 'letter' | 'number')[] = [];
  if (password.length < MIN_USER_PASSWORD_LENGTH) problems.push('length');
  if (!/\p{L}/u.test(password)) problems.push('letter');
  if (!/\p{N}/u.test(password)) problems.push('number');
  return problems;
}

export function verificationEmail(firstName: string, link: string) {
  return {
    subject: 'Confirm your email for MISK',
    text: [
      `Hello ${firstName},`,
      '',
      `Please confirm your email address to finish signing up for MISK. Open this link within ${VERIFY_LINK_HOURS} hours. It works once:`,
      link,
      '',
      'If you did not sign up for MISK, you can ignore this email.',
    ].join('\n'),
  };
}

/**
 * Makes a new confirmation link for the account (older links stop working) and returns it. The token goes
 * after #, so it never reaches server logs or other sites in a Referer header.
 */
async function newVerificationLink(db: Queryable, userId: string, webOrigin: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query('UPDATE email_verifications SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
  await db.query(`INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))`, [
    userId,
    hashToken(token),
    VERIFY_LINK_HOURS,
  ]);
  return `${webOrigin}/verify-email#token=${token}`;
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
      if (refuseWrongSite(request, reply, config, 'app')) {
        return reply;
      }
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

      const deliver = ctx.deliverEmail;
      if (!deliver) {
        throw new ApiError(503, 'email_unavailable');
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
          return { user, link: await newVerificationLink(client, user.id, config.webOrigin) };
        });
        request.log.info({ event: 'account_registered', userId: result.user.id });
        try {
          await deliver({ to: email, ...verificationEmail(body.firstName.trim(), result.link) });
          request.log.info({ event: 'verification_email_sent', userId: result.user.id });
        } catch (error) {
          // The account exists; the person can ask for the link again from the confirmation screen.
          request.log.error({ event: 'verification_email_failed', userId: result.user.id, err: error });
        }
        // No session yet: the account can sign in once the email is confirmed.
        return reply.code(201).send({ status: 'verification_sent', email });
      } catch (error) {
        if (isUniqueViolation(error)) {
          return reply.code(409).send({ error: 'email_taken' });
        }
        throw error;
      }
    },
  );

  // Opens the link from the email: confirms the address once and signs the person in.
  app.post<{ Body: { token: string } }>(
    '/auth/verify-email',
    {
      schema: {
        body: {
          type: 'object',
          required: ['token'],
          additionalProperties: false,
          properties: { token: { type: 'string', minLength: 20, maxLength: 200 } },
        },
      },
    },
    async (request, reply) => {
      if (refuseWrongSite(request, reply, config, 'app')) {
        return reply;
      }
      const result = await withTransaction(pool, async (client) => {
        const used = await client.query<{ userId: string }>(
          `UPDATE email_verifications v SET used_at = now()
           FROM users u
           WHERE v.token_hash = $1 AND v.used_at IS NULL AND v.expires_at > now()
             AND u.id = v.user_id AND u.disabled_at IS NULL
           RETURNING v.user_id AS "userId"`,
          [hashToken(request.body.token)],
        );
        const userId = used.rows[0]?.userId;
        if (!userId) {
          return null;
        }
        const verified = await client.query<User>(
          `UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1 RETURNING ${USER_COLUMNS}`,
          [userId],
        );
        const user = verified.rows[0];
        if (!user) {
          return null;
        }
        return { user, token: await createSession(client, user.id) };
      });
      if (!result) {
        return reply.code(400).send({ error: 'invalid_verification_link' });
      }
      await startSessionCookie(request, reply, pool, config, result.token);
      request.log.info({ event: 'email_verified', userId: result.user.id });
      return { user: publicUser(result.user) };
    },
  );

  // A new confirmation link. The answer is the same whether or not the account exists.
  app.post<{ Body: { email: string } }>(
    '/auth/verify-email/resend',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          additionalProperties: false,
          properties: { email: { type: 'string', minLength: 3, maxLength: 254 } },
        },
      },
    },
    async (request, reply) => {
      if (refuseWrongSite(request, reply, config, 'app')) {
        return reply;
      }
      const deliver = ctx.deliverEmail;
      if (!deliver) {
        throw new ApiError(503, 'email_unavailable');
      }
      const email = normalizeEmail(request.body.email);
      if (!EMAIL_FORMAT.test(email)) {
        throw badRequest('invalid_email');
      }
      await deleteExpiredRows(pool);
      const byAccount = await recordAttempt(pool, `verify:${email}`, MAX_VERIFY_EMAILS_PER_ACCOUNT);
      const byIp = await recordAttempt(pool, `verify-ip:${request.ip}`, MAX_VERIFY_EMAILS_PER_IP);
      if (byAccount.overLimit || byIp.overLimit) {
        return reply.code(429).send({ error: 'too_many_attempts' });
      }
      const found = await pool.query<{ id: string; firstName: string | null }>(
        `SELECT id, first_name AS "firstName" FROM users
         WHERE email = $1 AND password_hash IS NOT NULL AND email_verified_at IS NULL AND disabled_at IS NULL
           AND role IS DISTINCT FROM 'admin'`,
        [email],
      );
      const user = found.rows[0];
      if (!user) {
        request.log.info({ event: 'verification_resend_no_match' });
        return reply.code(202).send({});
      }
      const link = await withTransaction(pool, (client) => newVerificationLink(client, user.id, config.webOrigin));
      try {
        await deliver({ to: email, ...verificationEmail(user.firstName ?? 'there', link) });
        request.log.info({ event: 'verification_email_sent', userId: user.id });
      } catch (error) {
        request.log.error({ event: 'verification_email_failed', userId: user.id, err: error });
      }
      return reply.code(202).send({});
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
      if (refuseWrongSite(request, reply, config, 'app')) {
        return reply;
      }
      const email = normalizeEmail(request.body.email);
      // Admins sign in with their username on the control panel, never here.
      const found = await pool.query<User & { passwordHash: string; disabled: boolean; verified: boolean }>(
        `SELECT ${USER_COLUMNS}, users.password_hash AS "passwordHash", users.disabled_at IS NOT NULL AS disabled,
           users.email_verified_at IS NOT NULL AS verified
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
      // Said only after the right password, so it does not reveal which emails have accounts.
      if (!row.verified) {
        return reply.code(403).send({ error: 'email_not_verified' });
      }
      await startSessionCookie(request, reply, pool, config, await createSession(pool, row.id));
      request.log.info({ event: 'login_succeeded', userId: row.id });
      return { user: publicUser(row) };
    },
  );
}
