import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import { publicUser } from '../auth/routes.js';
import { findUser, type User } from '../auth/sessions.js';
import type { AppContext } from '../context.js';
import { withTransaction, type Queryable } from '../db.js';
import { conflict } from '../errors.js';

/**
 * The languages the app has texts for: English, German and Albanian (D110). A language is added here together
 * with its translation file in the web app, never before (D92).
 */
export const LANGUAGES = ['en', 'de', 'sq'] as const;
export type Language = (typeof LANGUAGES)[number];
export const MAX_NAME_LENGTH = 60;

const nameProperty = { type: 'string', minLength: 1, maxLength: MAX_NAME_LENGTH, pattern: '\\S' } as const;

interface PersonalBody {
  firstName: string;
  /** A blank last name, or null, removes it. */
  lastName?: string | null;
  language?: Language;
}

async function languageOf(db: Queryable, userId: string): Promise<string> {
  const result = await db.query<{ language: string }>('SELECT language FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.language ?? 'en';
}

async function reload(db: Queryable, userId: string): Promise<User> {
  const user = await findUser(db, userId);
  if (!user) throw new Error(`User ${userId} vanished during the request`);
  return user;
}

/**
 * The customer's Profile (D92): Personal information (name and language; the phone number has its own route
 * with a texted code, D87), the support contact for Help & support, and Become a pro.
 */
export async function profileRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards, config } = ctx;

  app.get('/account/settings', { preHandler: guards.customer }, async (request) => ({
    language: await languageOf(pool, currentUser(request).id),
    languages: LANGUAGES,
    // Help & support offers only the ways of reaching the team that are set up.
    support: config.support,
  }));

  app.patch<{ Body: PersonalBody }>(
    '/account/personal',
    {
      preHandler: guards.customer,
      schema: {
        body: {
          type: 'object',
          required: ['firstName'],
          additionalProperties: false,
          properties: {
            firstName: nameProperty,
            lastName: { anyOf: [{ type: 'string', maxLength: MAX_NAME_LENGTH }, { type: 'null' }] },
            language: { type: 'string', enum: [...LANGUAGES] },
          },
        },
      },
    },
    async (request) => {
      const userId = currentUser(request).id;
      const { firstName, lastName, language } = request.body;
      const last = lastName?.trim() ?? '';
      await pool.query(
        `UPDATE users SET first_name = $2,
           last_name = CASE WHEN $3 THEN $4 ELSE last_name END,
           language = COALESCE($5, language)
         WHERE id = $1`,
        [userId, firstName.trim(), lastName !== undefined, last || null, language ?? null],
      );
      request.log.info({ event: 'personal_information_saved' });
      return { user: publicUser(await reload(pool, userId)), language: await languageOf(pool, userId) };
    },
  );

  // Language on its own (D110): the pro app sets it from a Profile row of its own, without the name form.
  app.patch<{ Body: { language: Language } }>(
    '/account/language',
    {
      preHandler: guards.customer,
      schema: {
        body: {
          type: 'object',
          required: ['language'],
          additionalProperties: false,
          properties: { language: { type: 'string', enum: [...LANGUAGES] } },
        },
      },
    },
    async (request) => {
      const userId = currentUser(request).id;
      await pool.query('UPDATE users SET language = $2 WHERE id = $1', [userId, request.body.language]);
      request.log.info({ event: 'language_saved', language: request.body.language });
      return { user: publicUser(await reload(pool, userId)), language: await languageOf(pool, userId) };
    },
  );

  // "Start my pro application" (D92): the same account becomes a pro's, keeping its bookings and plans (D64),
  // and the pro app opens the application. The team still checks the pro before any job.
  app.post('/account/become-pro', { preHandler: guards.customer }, async (request) => {
    const user = currentUser(request);
    if (user.role !== 'customer') throw conflict('already_pro');
    await withTransaction(pool, async (client) => {
      const changed = await client.query("UPDATE users SET role = 'pro' WHERE id = $1 AND role = 'customer'", [user.id]);
      if (!changed.rowCount) throw conflict('already_pro');
      await client.query('INSERT INTO pro_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [user.id]);
    });
    request.log.info({ event: 'customer_became_pro', userId: user.id });
    return { user: publicUser(await reload(pool, user.id)) };
  });
}
