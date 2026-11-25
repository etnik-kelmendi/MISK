import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import type { AppContext } from '../context.js';
import { withTransaction, type Queryable } from '../db.js';
import { ApiError, conflict, notFound } from '../errors.js';
import type { PaymentGateway, SavedCard } from './gateway.js';

const paymentUnavailable = () => new ApiError(502, 'payment_unavailable');

const cardParams = {
  type: 'object',
  required: ['cardId'],
  properties: { cardId: { type: 'string', pattern: '^[A-Za-z0-9_]{1,100}$' } },
} as const;

/** Plans that still bill the customer every month: running, paused (billing paused) or ending (D92). */
const BILLING_STATUSES = ['active', 'past_due'];

/** What Payment methods shows (D92). */
export interface CardList {
  cards: SavedCard[];
  /** The card future payments and plan bills go to; null when none is set. */
  defaultCardId: string | null;
  /** Cards that pay for a plan, which cannot be removed until another card is made the default. */
  planCardIds: string[];
  publishableKey: string | null;
}

async function customerRef(db: Queryable, customerId: string): Promise<string | null> {
  const owner = await db.query<{ ref: string | null }>('SELECT stripe_customer_id AS ref FROM users WHERE id = $1', [customerId]);
  return owner.rows[0]?.ref ?? null;
}

/** Calls the payment provider; any failure is logged and answered as 502 payment_unavailable. */
async function provider<T>(log: FastifyBaseLogger, event: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    log.error({ event, err: error });
    throw paymentUnavailable();
  }
}

/** The provider's ids of the customer's plans that still bill them. */
async function billingPlans(db: Queryable, customerId: string): Promise<string[]> {
  const result = await db.query<{ ref: string }>(
    `SELECT stripe_subscription_id AS ref FROM subscriptions
     WHERE customer_id = $1 AND status = ANY($2::text[]) AND stripe_subscription_id IS NOT NULL`,
    [customerId, BILLING_STATUSES],
  );
  return result.rows.map((row) => row.ref);
}

/**
 * The cards that pay for the customer's plans: each plan's own card, or the customer's default card for a plan
 * without one, since the provider bills such a plan to the default card.
 */
async function planCards(gateway: PaymentGateway, plans: string[], defaultCardId: string | null): Promise<Set<string>> {
  const paying = new Set<string>();
  for (const plan of plans) {
    const card = (await gateway.subscriptionCardId(plan)) ?? defaultCardId;
    if (card) paying.add(card);
  }
  return paying;
}

/**
 * Payment methods (D92): the customer's saved cards with the provider, adding one (the card goes straight to
 * the provider), making one the default and removing one. MISK never sees or stores card numbers. A card that
 * pays for a plan stays until another card is made the default, which also moves the plans to that card.
 */
export async function cardRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards, gateway } = ctx;

  async function load(db: Queryable, log: FastifyBaseLogger, customerId: string): Promise<CardList> {
    const ref = await customerRef(db, customerId);
    if (!ref) {
      return { cards: [], defaultCardId: null, planCardIds: [], publishableKey: gateway.publishableKey };
    }
    const plans = await billingPlans(db, customerId);
    return provider(log, 'card_list_failed', async () => {
      const [cards, savedDefault] = await Promise.all([gateway.listCards(ref), gateway.defaultCardId(ref)]);
      // A default that is a wallet card, or one that is gone, is not one of the listed cards.
      const savedListed = savedDefault && cards.some((card) => card.id === savedDefault) ? savedDefault : null;
      const paying = await planCards(gateway, plans, savedDefault);
      // A card saved while paying is often never made the provider's default. Then the card that pays for a
      // plan, or else the first card, is the one MISK uses next, so it is shown as the default.
      const defaultCardId = savedListed ?? cards.find((card) => paying.has(card.id))?.id ?? cards[0]?.id ?? null;
      return {
        cards,
        defaultCardId,
        planCardIds: cards.filter((card) => paying.has(card.id)).map((card) => card.id),
        publishableKey: gateway.publishableKey,
      };
    });
  }

  /** The customer's provider id and their saved card, or 404 card_not_found for a card that is not theirs. */
  async function ownCard(db: Queryable, log: FastifyBaseLogger, customerId: string, cardId: string): Promise<string> {
    const ref = await customerRef(db, customerId);
    if (!ref) throw notFound('card_not_found');
    const cards = await provider(log, 'card_list_failed', () => gateway.listCards(ref));
    if (!cards.some((card) => card.id === cardId)) throw notFound('card_not_found');
    return ref;
  }

  /** Locks the customer, so removing a card and making another the default cannot cross. */
  const lockCustomer = (db: Queryable, customerId: string) => db.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [customerId]);

  app.get('/account/cards', { preHandler: guards.customer }, async (request) => load(pool, request.log, currentUser(request).id));

  // Adding a card: the browser confirms the returned secret with the provider's card form; nothing is charged.
  app.post('/account/cards/setup', { preHandler: guards.customer }, async (request) => {
    const customerId = currentUser(request).id;
    const existing = await customerRef(pool, customerId);
    const ref = await provider(request.log, 'card_setup_failed', () => gateway.ensureCustomer({ userId: customerId, existing }));
    if (!existing) {
      await pool.query('UPDATE users SET stripe_customer_id = $2 WHERE id = $1 AND stripe_customer_id IS NULL', [customerId, ref]);
    }
    const setup = await provider(request.log, 'card_setup_failed', () =>
      gateway.createCardSetup({ customerRef: ref, idempotencyKey: `card-setup-${customerId}-${randomUUID()}` }),
    );
    request.log.info({ event: 'card_setup_started' });
    return { clientSecret: setup.clientSecret, publishableKey: gateway.publishableKey };
  });

  app.post<{ Params: { cardId: string } }>(
    '/account/cards/:cardId/default',
    { preHandler: guards.customer, schema: { params: cardParams } },
    async (request) => {
      const customerId = currentUser(request).id;
      const { cardId } = request.params;
      return withTransaction(pool, async (client) => {
        await lockCustomer(client, customerId);
        const ref = await ownCard(client, request.log, customerId, cardId);
        const plans = await billingPlans(client, customerId);
        await provider(request.log, 'card_default_failed', async () => {
          await gateway.setDefaultCard(ref, cardId);
          // The plans move to the new default too, so the card they used before can be removed.
          for (const plan of plans) await gateway.setSubscriptionCard(plan, cardId);
        });
        request.log.info({ event: 'card_made_default', plans: plans.length });
        return load(client, request.log, customerId);
      });
    },
  );

  app.delete<{ Params: { cardId: string } }>(
    '/account/cards/:cardId',
    { preHandler: guards.customer, schema: { params: cardParams } },
    async (request, reply) => {
      const customerId = currentUser(request).id;
      const { cardId } = request.params;
      await withTransaction(pool, async (client) => {
        await lockCustomer(client, customerId);
        const ref = await ownCard(client, request.log, customerId, cardId);
        const plans = await billingPlans(client, customerId);
        const paying = await provider(request.log, 'card_list_failed', async () => planCards(gateway, plans, await gateway.defaultCardId(ref)));
        if (paying.has(cardId)) throw conflict('card_pays_for_plan');
        await provider(request.log, 'card_remove_failed', () => gateway.detachCard(ref, cardId));
      });
      request.log.info({ event: 'card_removed' });
      return reply.code(204).send();
    },
  );
}
