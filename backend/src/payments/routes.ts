import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { confirmHold, markPaymentFailed } from '../bookings/lifecycle.js';
import { markPastDue, recordPaidMonth } from '../subscriptions/service.js';

export const WEBHOOK_PATH = '/payments/webhook';

export async function paymentRoutes(app: FastifyInstance, ctx: AppContext) {
  // The signature covers the exact bytes Stripe sent, so this route reads the body unparsed.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 512 * 1024 }, (_request, body, done) => done(null, body));

  app.post(WEBHOOK_PATH, async (request, reply) => {
    const signature = request.headers['stripe-signature'];
    if (typeof signature !== 'string' || !Buffer.isBuffer(request.body)) {
      return reply.code(400).send({ error: 'invalid_signature' });
    }
    let parsed;
    try {
      parsed = ctx.gateway.parseWebhook(request.body, signature);
    } catch {
      request.log.warn({ event: 'webhook_rejected' });
      return reply.code(400).send({ error: 'invalid_signature' });
    }

    const fresh = await ctx.pool.query('INSERT INTO stripe_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [
      parsed.eventId,
    ]);
    if (!fresh.rowCount) {
      return { received: true };
    }
    const deps = { pool: ctx.pool, gateway: ctx.gateway, config: ctx.config, log: request.log };
    try {
      if (parsed.event.kind === 'hold_confirmed') {
        await confirmHold(deps, parsed.event.intentId);
      } else if (parsed.event.kind === 'payment_failed') {
        await markPaymentFailed(deps, parsed.event.intentId);
      } else if (parsed.event.kind === 'invoice_paid') {
        const { subscriptionId, invoiceId, amountCents, periodEnd } = parsed.event;
        await recordPaidMonth(deps, { subscriptionId, invoiceId, amountCents, periodEnd });
      } else if (parsed.event.kind === 'invoice_failed') {
        await markPastDue(deps, parsed.event.subscriptionId);
      }
    } catch (error) {
      // Forget the event so Stripe's retry is handled instead of skipped.
      await ctx.pool.query('DELETE FROM stripe_events WHERE event_id = $1', [parsed.eventId]);
      throw error;
    }
    request.log.info({ event: 'webhook_handled', kind: parsed.event.kind, eventId: parsed.eventId });
    return { received: true };
  });
}
