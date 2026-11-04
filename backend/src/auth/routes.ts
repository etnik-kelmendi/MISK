import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import { conflict } from '../errors.js';
import { normalizePhone } from '../notifications/phone.js';
import { adminLogin } from './admin-sign-in.js';
import { currentUser, SESSION_COOKIE } from './guard.js';
import { startPhoneSignIn, verifyPhoneSignIn } from './phone-sign-in.js';
import { deleteSession, findUser, SESSION_MAX_AGE_SECONDS, type User } from './sessions.js';

const phoneProperty = { type: 'string', minLength: 6, maxLength: 32 } as const;
const firstNameProperty = { type: 'string', minLength: 1, maxLength: 60, pattern: '\\S' } as const;

export function publicUser({ id, role, phone, username, firstName }: User) {
  return { id, role, phone, username, firstName };
}

export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, config, guards } = ctx;
  const cookieOptions = { path: '/', httpOnly: true, secure: config.secureCookies, sameSite: 'lax' } as const;

  async function startSession(request: FastifyRequest, reply: FastifyReply, token: string) {
    // Replacing any earlier session means a session planted before sign-in is never upgraded.
    const previous = request.cookies[SESSION_COOKIE];
    if (previous) {
      await deleteSession(pool, previous);
    }
    reply.setCookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: SESSION_MAX_AGE_SECONDS });
  }

  async function requireUser(userId: string): Promise<User> {
    const found = await findUser(pool, userId);
    if (!found) {
      throw new Error(`User ${userId} vanished during the request`);
    }
    return found;
  }

  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });

  app.post<{ Body: { phone: string } }>(
    '/auth/phone/start',
    {
      schema: {
        body: { type: 'object', required: ['phone'], additionalProperties: false, properties: { phone: phoneProperty } },
      },
    },
    async (request, reply) => {
      const phone = normalizePhone(request.body.phone);
      if (!phone) {
        return reply.code(400).send({ error: 'invalid_phone' });
      }
      const result = await startPhoneSignIn(pool, ctx.deliverCode, { phone, ip: request.ip });
      if (result.outcome === 'too_many_attempts') {
        request.log.warn({ event: 'sign_in_code_limited' });
        return reply.code(429).send({ error: 'too_many_attempts' });
      }
      return reply.code(202).send({ phone });
    },
  );

  app.post<{ Body: { phone: string; code: string } }>(
    '/auth/phone/verify',
    {
      schema: {
        body: {
          type: 'object',
          required: ['phone', 'code'],
          additionalProperties: false,
          properties: { phone: phoneProperty, code: { type: 'string', pattern: '^[0-9]{6}$' } },
        },
      },
    },
    async (request, reply) => {
      const phone = normalizePhone(request.body.phone);
      if (!phone) {
        return reply.code(400).send({ error: 'invalid_phone' });
      }
      const result = await verifyPhoneSignIn(pool, { phone, code: request.body.code, ip: request.ip });
      if (result.outcome !== 'success') {
        request.log.warn({ event: 'sign_in_rejected', reason: result.outcome });
        const status = { invalid_code: 401, too_many_attempts: 429, account_disabled: 403 }[result.outcome];
        return reply.code(status).send({ error: result.outcome });
      }
      await startSession(request, reply, result.token);
      request.log.info({ event: 'sign_in_succeeded', userId: result.user.id, isNew: result.isNew });
      return { user: publicUser(result.user) };
    },
  );

  app.post<{ Body: { username: string; password: string } }>(
    '/auth/admin/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          additionalProperties: false,
          properties: {
            username: { type: 'string', minLength: 3, maxLength: 254 },
            // The upper limit stops very long inputs from being used to overload password hashing.
            password: { type: 'string', minLength: 1, maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await adminLogin(pool, { ...request.body, ip: request.ip });
      if (result.outcome !== 'success') {
        request.log.warn({ event: 'admin_login_rejected', reason: result.outcome });
        return reply.code(result.outcome === 'too_many_attempts' ? 429 : 401).send({ error: result.outcome });
      }
      await startSession(request, reply, result.token);
      request.log.info({ event: 'admin_login_succeeded', userId: result.user.id });
      return { user: publicUser(result.user) };
    },
  );

  app.post('/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      await deleteSession(pool, token);
    }
    return reply.clearCookie(SESSION_COOKIE, cookieOptions).code(204).send();
  });

  app.get('/auth/me', { preHandler: guards.signedIn }, async (request) => ({
    user: publicUser(currentUser(request)),
  }));

  // First sign-in: the person says whether they need help or offer it. The choice is final (QUESTIONS Q10).
  app.post<{ Body: { role: 'customer' | 'pro'; firstName: string } }>(
    '/account/role',
    {
      preHandler: guards.signedIn,
      schema: {
        body: {
          type: 'object',
          required: ['role', 'firstName'],
          additionalProperties: false,
          properties: { role: { type: 'string', enum: ['customer', 'pro'] }, firstName: firstNameProperty },
        },
      },
    },
    async (request) => {
      const user = currentUser(request);
      const { role } = request.body;
      const firstName = request.body.firstName.trim();
      await withTransaction(pool, async (client) => {
        const updated = await client.query(
          'UPDATE users SET role = $2, first_name = $3 WHERE id = $1 AND role IS NULL',
          [user.id, role, firstName],
        );
        if (!updated.rowCount) {
          throw conflict('role_already_chosen');
        }
        if (role === 'pro') {
          await client.query('INSERT INTO pro_profiles (user_id) VALUES ($1)', [user.id]);
        }
      });
      request.log.info({ event: 'role_chosen', userId: user.id, role });
      return { user: publicUser(await requireUser(user.id)) };
    },
  );

  app.patch<{ Body: { firstName: string } }>(
    '/account',
    {
      preHandler: guards.signedIn,
      schema: {
        body: {
          type: 'object',
          required: ['firstName'],
          additionalProperties: false,
          properties: { firstName: firstNameProperty },
        },
      },
    },
    async (request) => {
      const user = currentUser(request);
      await pool.query('UPDATE users SET first_name = $2 WHERE id = $1', [user.id, request.body.firstName.trim()]);
      return { user: publicUser(await requireUser(user.id)) };
    },
  );
}
