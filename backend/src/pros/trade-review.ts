import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { enqueue } from '../notifications/outbox.js';
import { marketToday } from './checks.js';
import { logProAction } from './management.js';

/** Where a pro reads and changes their trades. */
export const WORK_LINK = '/pro/profile/work';
export const TRADE_NOTE_MAX_LENGTH = 300;

/** The texts the pro gets about a trade they added (D100). */
export const tradeMessages = {
  approved: (trade: string) => `MISK: ${trade} is now one of your trades. You get job offers in it from now on.`,
  declined: (trade: string, note: string | null) =>
    `MISK could not add ${trade} to your trades${note ? `: ${note.replace(/[.!?]+$/, '')}.` : '.'} Questions? Contact pro support in the app.`,
};

const tradeParams = {
  type: 'object',
  required: ['id', 'categoryId'],
  properties: { id: { type: 'string', format: 'uuid' }, categoryId: { type: 'string', format: 'uuid' } },
} as const;

/**
 * The team's check of a trade an approved pro added on Work information (D100). Until it is approved the pro gets no
 * offers in it and customers do not see it. A trade that needs a certificate is only approved once the pro's trade
 * certificate is accepted and valid.
 */
export async function tradeReviewRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards } = ctx;

  app.post<{ Params: { id: string; categoryId: string } }>(
    '/admin/pros/:id/trades/:categoryId/approve',
    { preHandler: guards.admin, schema: { params: tradeParams } },
    async (request) => {
      const { id: proId, categoryId } = request.params;
      const adminId = currentUser(request).id;
      await withTransaction(pool, async (client) => {
        const found = await client.query<{ name: string; needsCertificate: boolean; approved: boolean }>(
          `SELECT c.name, c.needs_certificate AS "needsCertificate", t.approved
           FROM pro_trades t JOIN categories c ON c.id = t.category_id
           WHERE t.pro_id = $1 AND t.category_id = $2 FOR UPDATE OF t`,
          [proId, categoryId],
        );
        const trade = found.rows[0];
        if (!trade) {
          throw notFound('trade_not_found');
        }
        if (trade.approved) {
          throw conflict('trade_not_pending');
        }
        if (trade.needsCertificate) {
          const certificate = await client.query(
            `SELECT 1 FROM pro_documents WHERE pro_id = $1 AND kind = 'certificate' AND review_status = 'accepted'
               AND (valid_until = 'infinity' OR valid_until >= $2::date)`,
            [proId, marketToday(ctx.config.timezone)],
          );
          if (!certificate.rowCount) {
            throw conflict('certificate_missing');
          }
        }
        await client.query('UPDATE pro_trades SET approved = true WHERE pro_id = $1 AND category_id = $2', [proId, categoryId]);
        await logProAction(client, proId, adminId, 'trade_approved', { trade: trade.name });
        await enqueue(client, proId, 'pro_account', tradeMessages.approved(trade.name), { link: WORK_LINK });
      });
      request.log.info({ event: 'pro_trade_approved', proId, categoryId, by: adminId });
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string; categoryId: string }; Body: { note?: string } | undefined }>(
    '/admin/pros/:id/trades/:categoryId/decline',
    {
      preHandler: guards.admin,
      schema: {
        params: tradeParams,
        body: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: { note: { type: 'string', maxLength: TRADE_NOTE_MAX_LENGTH } },
        },
      },
    },
    async (request) => {
      const { id: proId, categoryId } = request.params;
      const adminId = currentUser(request).id;
      const note = request.body?.note?.trim().replace(/\s+/g, ' ') || null;
      await withTransaction(pool, async (client) => {
        const removed = await client.query<{ name: string }>(
          `DELETE FROM pro_trades t USING categories c
           WHERE c.id = t.category_id AND t.pro_id = $1 AND t.category_id = $2 AND NOT t.approved
           RETURNING c.name`,
          [proId, categoryId],
        );
        const trade = removed.rows[0];
        if (!trade) {
          throw conflict('trade_not_pending');
        }
        await logProAction(client, proId, adminId, 'trade_declined', { trade: trade.name, note });
        await enqueue(client, proId, 'pro_account', tradeMessages.declined(trade.name, note), { link: WORK_LINK });
      });
      request.log.info({ event: 'pro_trade_declined', proId, categoryId, by: adminId });
      return { ok: true };
    },
  );
}
