import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import type { AppContext } from '../context.js';

/** Messages shown in the app; older ones stay in the database but are not listed. */
export const INBOX_SIZE = 50;

/** A customer's or pro's messages in the app: newest first, with how many are unread. */
export async function inboxRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards } = ctx;

  app.get('/inbox', { preHandler: guards.signedIn }, async (request) => {
    const userId = currentUser(request).id;
    const [messages, unread] = await Promise.all([
      pool.query(
        `SELECT id, kind, body, link, read_at IS NOT NULL AS read, created_at AS "createdAt"
         FROM inbox WHERE user_id = $1 ORDER BY created_at DESC, id LIMIT ${INBOX_SIZE}`,
        [userId],
      ),
      pool.query<{ n: number }>('SELECT count(*)::int AS n FROM inbox WHERE user_id = $1 AND read_at IS NULL', [userId]),
    ]);
    return { messages: messages.rows, unread: unread.rows[0]?.n ?? 0 };
  });

  // The app checks this often while open (D87): only the unread count and the newest message, so it loads the
  // whole list only when something changed.
  app.get('/inbox/unread', { preHandler: guards.signedIn }, async (request) => {
    const found = await pool.query<{ unread: number; newestId: string | null }>(
      `SELECT (SELECT count(*)::int FROM inbox WHERE user_id = $1 AND read_at IS NULL) AS unread,
              (SELECT id FROM inbox WHERE user_id = $1 ORDER BY created_at DESC, id LIMIT 1) AS "newestId"`,
      [currentUser(request).id],
    );
    return found.rows[0] ?? { unread: 0, newestId: null };
  });

  // Opening Messages marks everything there as read.
  app.post('/inbox/read', { preHandler: guards.signedIn }, async (request, reply) => {
    await pool.query('UPDATE inbox SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [currentUser(request).id]);
    return reply.code(204).send();
  });
}
