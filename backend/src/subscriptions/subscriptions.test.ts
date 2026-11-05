import {
  approvedPro,
  call,
  createTestContext,
  giveRating,
  resetDatabase,
  seedMarket,
  signIn,
  signInAdmin,
  type Market,
  type TestContext,
} from '../../test/helpers.js';
import { planSizePrice, subscriptionTick } from './service.js';

let t: TestContext;
let market: Market;
let customer: string;
let planId: string;

beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(async () => {
  await resetDatabase(t.pool);
  t.fake.reset();
  market = await seedMarket(t.pool);
  const admin = await signInAdmin(t);
  const plan = await call(t, 'POST', '/admin/plans', {
    cookie: admin,
    body: {
      name: 'Lawn care',
      categoryId: market.gardening,
      priceCents: 4900,
      frequency: 'weekly',
      visitMinutes: 60,
      tasks: ['Mow', 'Edge', 'Blow paths'],
      addonName: 'Hedge trimming',
      addonPriceCents: 1500,
      seasonal: false,
      skipsPerMonth: 1,
      minTermMonths: 3,
      proSharePct: 70,
    },
  });
  planId = plan.json().plan.id;
  await call(t, 'POST', `/admin/plans/${planId}/status`, { cookie: admin, body: { published: true } });
  customer = await signIn(t, '+4915100000001', 'customer', 'Sara');
});

const subscribe = (body: Record<string, unknown> = {}, cookie = customer) =>
  call(t, 'POST', '/subscriptions', {
    cookie,
    body: { planId, size: 'M', days: [2], timeWindow: 'morning', address: '12 Linden Street', postcode: '10115', withAddon: true, ...body },
  });

describe('subscribing to a plan', () => {
  it('prices by size and extra', () => {
    expect([planSizePrice(4900, 'S'), planSizePrice(4900, 'M'), planSizePrice(4900, 'L')]).toEqual([4165, 4900, 6615]);
  });

  it('starts monthly billing, picks the best-rated free pro and plans four weeks of visits', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening], firstName: 'Ok' });
    const best = await approvedPro(t, '+4915100000102', { trades: [market.gardening], firstName: 'Daniel' });
    await giveRating(t.pool, best.proId, 5);

    const response = await subscribe();
    expect(response.statusCode).toBe(201);
    const subscription = response.json().subscription;
    expect(subscription).toMatchObject({ status: 'active', planName: 'Lawn care', proName: 'Daniel', priceCents: 6400, withAddon: true });
    expect(subscription.visits.length).toBeGreaterThanOrEqual(3);
    expect(subscription.visits.every((v: { status: string }) => v.status === 'planned')).toBe(true);
    expect([...t.fake.subscriptions.values()][0]).toMatchObject({ amountCents: 6400, status: 'active' });

    const payouts = await t.pool.query('SELECT amount_cents, status FROM subscription_payouts');
    expect(payouts.rows).toEqual([{ amount_cents: Math.floor(6400 * 0.7), status: 'sent' }]);
  });

  it('shows the plan and its visits to the pro, who ticks off the tasks', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    await subscribe({ withAddon: false });
    const plans = (await call(t, 'GET', '/pro/plans', { cookie: pro.cookie })).json().plans;
    expect(plans).toEqual([expect.objectContaining({ name: 'Lawn care', mySubscribers: 1, earningsPerMonthCents: 3430 })]);

    const to = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const visits = (await call(t, 'GET', `/pro/visits?to=${encodeURIComponent(to)}`, { cookie: pro.cookie })).json().visits;
    expect(visits[0]).toMatchObject({ planName: 'Lawn care', customerName: 'Sara', tasks: ['Mow', 'Edge', 'Blow paths'], status: 'planned' });
    const one = await call(t, 'GET', `/pro/visits/${visits[0].id}`, { cookie: pro.cookie });
    expect(one.json().visit).toMatchObject({ id: visits[0].id, planName: 'Lawn care', earningsCents: Math.round(3430 / 4.3) });
    const stranger = await approvedPro(t, '+4915100000109', { trades: [market.plumbing] });
    expect((await call(t, 'GET', `/pro/visits/${visits[0].id}`, { cookie: stranger.cookie })).statusCode).toBe(404);

    const early = await call(t, 'POST', `/pro/visits/${visits[0].id}/complete`, { cookie: pro.cookie, body: { tasksDone: ['Mow'] } });
    expect(early.json()).toEqual({ error: 'visit_not_started' });
    await t.pool.query("UPDATE subscription_visits SET starts_at = now() - interval '1 hour', ends_at = now() WHERE id = $1", [visits[0].id]);
    const unknown = await call(t, 'POST', `/pro/visits/${visits[0].id}/complete`, { cookie: pro.cookie, body: { tasksDone: ['Paint'] } });
    expect(unknown.json()).toEqual({ error: 'unknown_task' });
    const done = await call(t, 'POST', `/pro/visits/${visits[0].id}/complete`, {
      cookie: pro.cookie,
      body: { tasksDone: ['Mow', 'Edge', 'Blow paths'] },
    });
    expect(done.json().visit).toMatchObject({ status: 'completed', tasksDone: ['Mow', 'Edge', 'Blow paths'] });
  });

  it('checks the days, the extra and the postcode', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    expect((await subscribe({ days: [2, 4] })).json()).toEqual({ error: 'wrong_number_of_days' });
    expect((await subscribe({ postcode: '99999' })).json()).toEqual({ error: 'postcode_not_served' });
    expect((await subscribe({ planId: '00000000-0000-4000-8000-000000000000' })).json()).toEqual({ error: 'plan_not_found' });
  });

  it('says when no pro is free for those days', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening], days: [1] });
    const response = await subscribe({ days: [2] });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'no_pro_available' });
  });

  it('never gives the same pro two plans at the same time', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    expect((await subscribe()).statusCode).toBe(201);
    const other = await signIn(t, '+4915100000002', 'customer');
    expect((await subscribe({}, other)).json()).toEqual({ error: 'no_pro_available' });
    expect((await subscribe({ timeWindow: 'afternoon' }, other)).statusCode).toBe(201);
  });

  it('keeps one-off bookings away from planned visits', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const subscription = (await subscribe({ days: [1, 2, 3, 4, 5, 6, 7].slice(0, 1) })).json().subscription;
    const first = subscription.visits[0];
    const slots = (await call(t, 'GET', `/availability?serviceId=${market.mowing}&postcode=10115`, { cookie: customer })).json().slots as {
      startsAt: string;
      available: boolean;
    }[];
    const clash = slots.find((s) => s.startsAt === first.startsAt);
    if (clash) {
      expect(clash.available).toBe(false);
    }
  });

  it('waits for the card when the bank needs the customer, and drops the sign-up if never paid', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    t.fake.setInstantHolds(false);
    const { subscription, payment } = (await subscribe()).json();
    expect(subscription.status).toBe('awaiting_payment');
    expect(payment.clientSecret).toMatch(/_secret$/);
    expect(subscription.visits).toEqual([]);

    await t.pool.query("UPDATE subscriptions SET created_at = now() - interval '31 minutes'");
    await subscriptionTick(t.deps);
    const after = (await call(t, 'GET', `/subscriptions/${subscription.id}`, { cookie: customer })).json().subscription;
    expect(after.status).toBe('cancelled');
    expect([...t.fake.subscriptions.values()][0]?.status).toBe('cancelled');
  });

  it('activates on the paid-invoice webhook and pays the pro each month', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    t.fake.setInstantHolds(false);
    const { subscription } = (await subscribe()).json();
    const stripeId = [...t.fake.subscriptions.keys()][0] ?? '';
    const webhook = (eventId: string, event: unknown) =>
      t.app.inject({
        method: 'POST',
        url: '/payments/webhook',
        headers: { 'stripe-signature': 'fake-signature', 'content-type': 'application/json' },
        payload: JSON.stringify({ eventId, event }),
      });
    const month = (invoiceId: string) => ({
      kind: 'invoice_paid',
      subscriptionId: stripeId,
      invoiceId,
      amountCents: 6400,
      periodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    });
    expect((await webhook('evt_1', month('in_1'))).statusCode).toBe(200);
    const active = (await call(t, 'GET', `/subscriptions/${subscription.id}`, { cookie: customer })).json().subscription;
    expect(active.status).toBe('active');
    expect(active.visits.length).toBeGreaterThan(0);

    await webhook('evt_2', month('in_2'));
    await webhook('evt_2', month('in_2'));
    const payouts = await t.pool.query("SELECT count(*)::int AS n FROM subscription_payouts WHERE status = 'sent'");
    expect(payouts.rows[0].n).toBe(2);

    await webhook('evt_3', { kind: 'invoice_failed', subscriptionId: stripeId });
    expect((await call(t, 'GET', `/subscriptions/${subscription.id}`, { cookie: customer })).json().subscription.status).toBe('past_due');
  });
});

describe('managing a plan', () => {
  beforeEach(async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
  });

  it('lets the customer skip as many visits a month as the plan allows, and undo a skip', async () => {
    const subscription = (await subscribe()).json().subscription;
    const [first, second] = subscription.visits;
    const skipped = await call(t, 'POST', `/subscriptions/${subscription.id}/visits/${first.id}/skip`, { cookie: customer });
    expect(skipped.json().subscription.visits[0].status).toBe('skipped');
    const sameMonth = new Date(first.startsAt).getMonth() === new Date(second.startsAt).getMonth();
    const another = await call(t, 'POST', `/subscriptions/${subscription.id}/visits/${second.id}/skip`, { cookie: customer });
    if (sameMonth) {
      expect(another.json()).toEqual({ error: 'no_skips_left' });
    }
    const undone = await call(t, 'POST', `/subscriptions/${subscription.id}/visits/${first.id}/unskip`, { cookie: customer });
    expect(undone.json().subscription.visits[0].status).toBe('planned');
  });

  it('only cancels after the minimum term, and then at the end of the paid month', async () => {
    const subscription = (await subscribe()).json().subscription;
    expect((await call(t, 'POST', `/subscriptions/${subscription.id}/cancel`, { cookie: customer })).json()).toEqual({
      error: 'in_minimum_term',
    });
    await t.pool.query("UPDATE subscriptions SET started_at = now() - interval '4 months'");
    const cancelled = (await call(t, 'POST', `/subscriptions/${subscription.id}/cancel`, { cookie: customer })).json().subscription;
    expect(cancelled.endsAt).not.toBeNull();
    expect([...t.fake.subscriptions.values()][0]?.cancelAtPeriodEnd).toBe(true);
    expect(cancelled.visits.filter((v: { status: string; startsAt: string }) => v.status === 'planned' && v.startsAt >= cancelled.endsAt)).toEqual([]);

    await t.pool.query("UPDATE subscriptions SET ends_at = now() - interval '1 minute'");
    await subscriptionTick(t.deps);
    expect((await call(t, 'GET', `/subscriptions/${subscription.id}`, { cookie: customer })).json().subscription.status).toBe('cancelled');
  });

  it('keeps other customers out', async () => {
    const subscription = (await subscribe()).json().subscription;
    const other = await signIn(t, '+4915100000002', 'customer');
    expect((await call(t, 'GET', `/subscriptions/${subscription.id}`, { cookie: other })).statusCode).toBe(404);
  });
});

describe('seasons', () => {
  it('refuses new seasonal plans in winter and pauses billing outside the season', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    await t.pool.query('UPDATE plans SET seasonal = true, season_from = 4, season_to = 10');
    const month = (await t.pool.query<{ m: number }>("SELECT extract(month FROM now() AT TIME ZONE 'Europe/Berlin')::int AS m")).rows[0]?.m ?? 1;
    const inSeason = month >= 4 && month <= 10;
    const response = await subscribe();
    if (!inSeason) {
      expect(response.json()).toEqual({ error: 'off_season' });
      return;
    }
    expect(response.statusCode).toBe(201);
    await t.pool.query('UPDATE subscriptions SET season_from = 1, season_to = 1');
    await subscriptionTick(t.deps);
    expect([...t.fake.subscriptions.values()][0]?.paused).toBe(true);
  });

  it('pauses billing outside the season and resumes inside it', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const subscription = (await subscribe()).json().subscription;
    const month = (await t.pool.query<{ m: number }>("SELECT extract(month FROM now() AT TIME ZONE 'Europe/Berlin')::int AS m")).rows[0]?.m ?? 1;
    const other = month === 12 ? 1 : month + 1;
    await t.pool.query('UPDATE subscriptions SET seasonal = true, season_from = $2, season_to = $2 WHERE id = $1', [subscription.id, other]);
    await subscriptionTick(t.deps);
    expect([...t.fake.subscriptions.values()][0]?.paused).toBe(true);
    await t.pool.query('UPDATE subscriptions SET season_from = $2, season_to = $2 WHERE id = $1', [subscription.id, month]);
    await subscriptionTick(t.deps);
    expect([...t.fake.subscriptions.values()][0]?.paused).toBe(false);
  });
});
