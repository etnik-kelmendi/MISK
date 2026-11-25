import { vi } from 'vitest';
import { call, createTestContext, resetDatabase, seedMarket, signIn, signInAdmin, type Market, type TestContext } from '../../test/helpers.js';

/** D92: Payment methods — the customer's saved cards: list, add, make default and remove. */

let t: TestContext;
let market: Market;
let customer: string;
let customerId: string;

const VISA = { id: 'pm_card_visa', brand: 'visa', last4: '4242', expMonth: 8, expYear: 2030 };
const MASTERCARD = { id: 'pm_card_mc', brand: 'mastercard', last4: '4444', expMonth: 1, expYear: 2031 };

beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(async () => {
  await resetDatabase(t.pool);
  t.fake.reset();
  vi.restoreAllMocks();
  market = await seedMarket(t.pool);
  customer = await signIn(t, '+4915100000001', 'customer', 'Sara');
  customerId = (await call(t, 'GET', '/auth/me', { cookie: customer })).json().user.id as string;
});

const list = (cookie = customer) => call(t, 'GET', '/account/cards', { cookie });
const setup = (cookie = customer) => call(t, 'POST', '/account/cards/setup', { cookie });
const makeDefault = (cardId: string, cookie = customer) => call(t, 'POST', `/account/cards/${cardId}/default`, { cookie });
const remove = (cardId: string, cookie = customer) => call(t, 'DELETE', `/account/cards/${cardId}`, { cookie });

/** A customer who has paid before, so the provider knows them, with a Visa and a Mastercard saved. */
async function returningCustomer() {
  await t.pool.query('UPDATE users SET stripe_customer_id = $2 WHERE id = $1', [customerId, `cus_${customerId}`]);
  t.fake.setCards([VISA, MASTERCARD]);
}

/** A plan of the customer billed by the provider, to the given card or (without one) to their default card. */
async function plan(status: 'active' | 'past_due' | 'cancelled' | 'awaiting_payment', cardId?: string) {
  const started = await t.fake.gateway.createSubscription({
    customerRef: `cus_${customerId}`,
    productId: 'prod_test',
    amountCents: 4900,
    idempotencyKey: `sub-${status}-${cardId ?? 'default'}`,
    metadata: {},
    ...(cardId ? { paymentMethodId: cardId } : {}),
  });
  const planRow = await t.pool.query<{ id: string }>(
    `INSERT INTO plans (name, category_id, price_cents, frequency, visit_minutes, tasks) VALUES ('Lawn care', $1, 4900, 'weekly', 60, '{Mow}') RETURNING id`,
    [market.gardening],
  );
  await t.pool.query(
    `INSERT INTO subscriptions (customer_id, plan_id, category_id, plan_name, tasks, size, frequency, days, time_window,
       visit_minutes, address, postcode, with_addon, price_cents, pro_share_pct, seasonal, skips_per_month, min_term_months, status,
       stripe_subscription_id)
     VALUES ($1, $2, $3, 'Lawn care', '{Mow}', 'M', 'weekly', '{2}', 'morning', 60, '12 Linden Street', '10115',
       false, 4900, 70, false, 2, 3, $4, $5)`,
    [customerId, planRow.rows[0]?.id, market.gardening, status, started.subscriptionId],
  );
  return started.subscriptionId;
}

describe('listing saved cards', () => {
  it('lists nothing for a customer the provider does not know yet', async () => {
    expect((await list()).json()).toEqual({ cards: [], defaultCardId: null, planCardIds: [], publishableKey: null });
  });

  it('lists the cards with brand, last 4 digits and expiry, the default and the cards paying for plans', async () => {
    await returningCustomer();
    // No default saved at the provider: the first card is the one used next, so it is shown as the default.
    expect((await list()).json()).toEqual({ cards: [VISA, MASTERCARD], defaultCardId: VISA.id, planCardIds: [], publishableKey: null });
    // A card that pays for a plan is the default before the first card.
    await plan('active', MASTERCARD.id);
    expect((await list()).json()).toMatchObject({ defaultCardId: MASTERCARD.id, planCardIds: [MASTERCARD.id] });
  });

  it('says payments are not working when the provider cannot be reached', async () => {
    await returningCustomer();
    vi.spyOn(t.fake.gateway, 'listCards').mockRejectedValue(new Error('provider down'));
    const response = await list();
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: 'payment_unavailable' });
  });

  it('is for signed-in customers', async () => {
    expect((await call(t, 'GET', '/account/cards')).statusCode).toBe(401);
    const admin = await signInAdmin(t);
    expect((await call(t, 'GET', '/account/cards', { cookie: admin })).statusCode).toBe(403);
  });
});

describe('adding a card', () => {
  it('makes the customer known to the provider once and starts a card set-up without charging anything', async () => {
    const first = await setup();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ clientSecret: 'seti_1_secret', publishableKey: null });
    const ref = await t.pool.query<{ ref: string }>('SELECT stripe_customer_id AS ref FROM users WHERE id = $1', [customerId]);
    expect(ref.rows[0]?.ref).toBe(`cus_${customerId}`);
    expect((await setup()).json().clientSecret).toBe('seti_2_secret');
    expect(t.fake.cardSetups).toHaveLength(2);
    expect(t.fake.intents.size).toBe(0);
  });
});

describe('making a card the default', () => {
  it('makes it the default and moves the plans that still bill to it', async () => {
    await returningCustomer();
    const running = await plan('active', VISA.id);
    const ended = await plan('cancelled', VISA.id);
    const answer = await makeDefault(MASTERCARD.id);
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject({ defaultCardId: MASTERCARD.id, planCardIds: [MASTERCARD.id] });
    expect(t.fake.currentDefaultCard()).toBe(MASTERCARD.id);
    expect(t.fake.subscriptions.get(running)?.paymentMethodId).toBe(MASTERCARD.id);
    expect(t.fake.subscriptions.get(ended)?.paymentMethodId).toBe(VISA.id);
  });

  it('only takes a card of the customer', async () => {
    await returningCustomer();
    expect((await makeDefault('pm_card_someone_else')).json()).toEqual({ error: 'card_not_found' });
    expect((await makeDefault('not a card')).statusCode).toBe(400);
    expect(t.fake.currentDefaultCard()).toBeNull();
    // A customer the provider does not know has no cards.
    await t.pool.query('UPDATE users SET stripe_customer_id = NULL WHERE id = $1', [customerId]);
    expect((await makeDefault(VISA.id)).statusCode).toBe(404);
  });
});

describe('removing a card', () => {
  it('removes a card that pays for nothing', async () => {
    await returningCustomer();
    expect((await remove(MASTERCARD.id)).statusCode).toBe(204);
    expect(t.fake.currentCards()).toEqual([VISA]);
    expect((await remove(MASTERCARD.id)).json()).toEqual({ error: 'card_not_found' });
  });

  it('keeps a card that pays for a plan until another card is made the default', async () => {
    await returningCustomer();
    await plan('active', VISA.id);
    const refused = await remove(VISA.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'card_pays_for_plan' });
    expect(t.fake.currentCards()).toEqual([VISA, MASTERCARD]);

    await makeDefault(MASTERCARD.id);
    expect((await remove(VISA.id)).statusCode).toBe(204);
    expect(t.fake.currentCards()).toEqual([MASTERCARD]);
  });

  it('counts the default card as paying for a plan without its own card, also while the plan is behind on payment', async () => {
    await returningCustomer();
    await makeDefault(VISA.id);
    await plan('past_due');
    expect((await list()).json().planCardIds).toEqual([VISA.id]);
    expect((await remove(VISA.id)).json()).toEqual({ error: 'card_pays_for_plan' });
    expect((await remove(MASTERCARD.id)).statusCode).toBe(204);
  });

  it('lets go of a card whose plans ended or never started', async () => {
    await returningCustomer();
    await plan('cancelled', VISA.id);
    await plan('awaiting_payment', VISA.id);
    expect((await list()).json().planCardIds).toEqual([]);
    expect((await remove(VISA.id)).statusCode).toBe(204);
  });

  it('never looks at another customer’s plans', async () => {
    await returningCustomer();
    await plan('active', VISA.id);
    const other = await signIn(t, '+4915100000002', 'customer', 'Ben');
    const otherId = (await call(t, 'GET', '/auth/me', { cookie: other })).json().user.id as string;
    await t.pool.query('UPDATE users SET stripe_customer_id = $2 WHERE id = $1', [otherId, `cus_${otherId}`]);
    expect((await remove(VISA.id, other)).statusCode).toBe(204);
  });
});
