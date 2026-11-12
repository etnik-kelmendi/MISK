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
        `SELECT id, kind, body, read_at IS NOT NULL AS read, created_at AS "createdAt"
         FROM inbox WHERE user_id = $1 ORDER BY created_at DESC, id LIMIT ${INBOX_SIZE}`,
        [userId],
      ),
      pool.query<{ n: number }>('SELECT count(*)::int AS n FROM inbox WHERE user_id = $1 AND read_at IS NULL', [userId]),
    ]);
    return { messages: messages.rows, unread: unread.rows[0]?.n ?? 0 };
  });

  // Opening Messages marks everything there as read.
  app.post('/inbox/read', { preHandler: guards.signedIn }, async (request, reply) => {
    await pool.query('UPDATE inbox SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [currentUser(request).id]);
    return reply.code(204).send();
  });
}
