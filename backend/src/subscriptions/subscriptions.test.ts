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
import { visitMoveTick } from './moves.js';
import { monthlyPrice, planPrice, planPriceTable, planSizePrice, subscriptionTick } from './service.js';

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
      pauseNoticeDays: 7,
      maxPauseWeeks: 4,
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
    body: {
      planId,
      size: 'M',
      days: [2],
      timeWindow: 'morning',
      address: '12 Linden Street',
      postcode: '10115',
      withAddon: true,
      acceptTerms: true,
      ...body,
    },
  });

const DAY_MS = 24 * 3600 * 1000;
/** A day ('YYYY-MM-DD') in Berlin and its weekday (1 = Monday). */
async function berlinToday(): Promise<string> {
  const result = await t.pool.query<{ d: string }>("SELECT to_char((now() AT TIME ZONE 'Europe/Berlin')::date, 'YYYY-MM-DD') AS d");
  return result.rows[0]?.d ?? '';
}
const plusDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const isoWeekday = (day: string) => ((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
const berlinDay = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date(iso));
/**
 * The weekday of tomorrow in Berlin: "As soon as possible" on it puts the first visit tomorrow, less than 24 hours
 * from the start of billing, so the first month is charged at once (D91), whatever day the test runs.
 */
const tomorrowWeekday = async () => isoWeekday(plusDays(await berlinToday(), 1));
/** Midnight in Berlin at the start of a day ('YYYY-MM-DD'), when billing from that first visit day starts (D91). */
async function berlinMidnight(day: string): Promise<number> {
  const result = await t.pool.query<{ at: Date }>("SELECT $1::date::timestamp AT TIME ZONE 'Europe/Berlin' AS at", [day]);
  return result.rows[0]?.at.getTime() ?? 0;
}
const webhook = (eventId: string, event: unknown) =>
  t.app.inject({
    method: 'POST',
    url: '/payments/webhook',
    headers: { 'stripe-signature': 'fake-signature', 'content-type': 'application/json' },
    payload: JSON.stringify({ eventId, event }),
  });

describe('subscribing to a plan', () => {
  it('prices by size and extra', () => {
    expect([planSizePrice(4900, 'S'), planSizePrice(4900, 'M'), planSizePrice(4900, 'L')]).toEqual([4165, 4900, 6615]);
  });

  it("prices another frequency from the plan's own one, rounded once (D90)", () => {
    const weekly = { priceCents: 4900, frequency: 'weekly' as const, addonPriceCents: 1500 };
    expect(planPriceTable(weekly)).toEqual({
      every_2_weeks: { S: 2499, M: 2940, L: 3969 },
      weekly: { S: 4165, M: 4900, L: 6615 },
      twice_weekly: { S: 7497, M: 8820, L: 11907 },
      three_times_weekly: { S: 10413, M: 12250, L: 16538 },
    });
    // A plan priced for twice a week: once a week is that price / 1.8.
    expect(planPrice({ priceCents: 9000, frequency: 'twice_weekly' }, { frequency: 'weekly', size: 'M' })).toBe(5000);
    expect(monthlyPrice(weekly, { frequency: 'twice_weekly', size: 'L', withAddon: true })).toBe(11907 + 1500);
    expect(monthlyPrice(weekly, { frequency: 'twice_weekly', size: 'L', withAddon: false })).toBe(11907);
  });

  it('charges exactly the price the Plan builder showed from /plans, for the chosen frequency (D90)', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const [plan] = (await call(t, 'GET', '/plans')).json().plans;
    expect(plan.fromCents).toBe(4165);
    const shown = plan.prices.twice_weekly.L + plan.addonPriceCents;
    const response = await subscribe({ frequency: 'twice_weekly', size: 'L', days: [2, 4] });
    expect(response.statusCode).toBe(201);
    expect(response.json().subscription).toMatchObject({ frequency: 'twice_weekly', priceCents: shown, days: [2, 4] });
    expect([...t.fake.subscriptions.values()][0]?.amountCents).toBe(shown);
  });

  it('needs as many days as the frequency: 1 for every 2 weeks and once a week, 2 for twice, 3 for three times (D90)', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    expect((await subscribe({ frequency: 'twice_weekly', days: [2] })).json()).toEqual({ error: 'wrong_number_of_days' });
    expect((await subscribe({ frequency: 'three_times_weekly', days: [1, 3] })).json()).toEqual({ error: 'wrong_number_of_days' });
    expect((await subscribe({ frequency: 'every_2_weeks', days: [1, 3] })).json()).toEqual({ error: 'wrong_number_of_days' });
    expect((await subscribe({ frequency: 'monthly', days: [1] })).statusCode).toBe(400);
    const three = await subscribe({ frequency: 'three_times_weekly', days: [1, 3, 5] });
    expect(three.statusCode).toBe(201);
    expect(three.json().subscription).toMatchObject({ frequency: 'three_times_weekly', days: [1, 3, 5] });
  });

  it('refuses a sign-up without the subscription terms ticked (D90)', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    expect((await subscribe({ acceptTerms: false })).statusCode).toBe(400);
    const missing = await call(t, 'POST', '/subscriptions', {
      cookie: customer,
      body: { planId, size: 'M', days: [2], timeWindow: 'morning', address: '12 Linden Street', postcode: '10115', withAddon: true },
    });
    expect(missing.statusCode).toBe(400);
    expect(await t.pool.query('SELECT 1 FROM subscriptions')).toMatchObject({ rowCount: 0 });
    expect((await subscribe()).statusCode).toBe(201);
    expect((await t.pool.query('SELECT terms_accepted_at IS NOT NULL AS ok FROM subscriptions')).rows).toEqual([{ ok: true }]);
  });

  it('starts as soon as possible, next week or in 2 weeks, on the first chosen weekday from then (D90)', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const today = await berlinToday();
    // Every weekday is checked against the server's rule, whatever day the test runs on.
    const offsets: Record<string, number> = { asap: 0, next_week: 7, in_2_weeks: 14 };
    const firstOn = (start: string, weekday: number) => {
      let day = plusDays(today, 1 + (offsets[start] ?? 0));
      while (isoWeekday(day) !== weekday) day = plusDays(day, 1);
      return day;
    };
    const cases: [string, number][] = [
      ['asap', 3],
      ['next_week', 5],
      ['in_2_weeks', 1],
    ];
    let phone = 2;
    for (const [start, weekday] of cases) {
      const cookie = await signIn(t, `+49151000000${String(phone).padStart(2, '0')}`, 'customer');
      phone += 1;
      const response = await subscribe({ start, days: [weekday], timeWindow: start === 'next_week' ? 'afternoon' : 'morning' }, cookie);
      expect(response.statusCode).toBe(201);
      const subscription = response.json().subscription;
      const expected = firstOn(start, weekday);
      expect(subscription.firstVisitOn).toBe(expected);
      expect(berlinDay(subscription.nextVisitAt)).toBe(expected);
      expect(subscription.visits.every((v: { startsAt: string }) => berlinDay(v.startsAt) >= expected)).toBe(true);
      // The planning job never plans anything before the first visit either.
      await subscriptionTick(t.deps);
      const early = await t.pool.query(
        "SELECT 1 FROM subscription_visits WHERE subscription_id = $1 AND (starts_at AT TIME ZONE 'Europe/Berlin')::date < $2::date",
        [subscription.id, expected],
      );
      expect(early.rowCount).toBe(0);
    }
    expect((await subscribe({ start: 'tomorrow' })).statusCode).toBe(400);
  });

  it('plans every-2-weeks visits from the week of the first visit (D90)', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const response = await subscribe({ frequency: 'every_2_weeks', start: 'next_week', days: [3] });
    const subscription = response.json().subscription;
    const days = (subscription.visits as { startsAt: string }[]).map((v) => berlinDay(v.startsAt));
    expect(days[0]).toBe(subscription.firstVisitOn);
    for (let i = 1; i < days.length; i += 1) {
      expect(Date.parse(`${days[i]}T12:00:00Z`) - Date.parse(`${days[i - 1]}T12:00:00Z`)).toBe(14 * DAY_MS);
    }
    expect(subscription.priceCents).toBe(2940 + 1500);
  });

  it("charges a saved card of the customer at once when the first visit is tomorrow, and refuses someone else's card (D90, D91)", async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    expect((await subscribe({ paymentMethod: { type: 'card', cardId: 'pm_not_mine' } })).json()).toEqual({ error: 'card_not_found' });
    expect((await subscribe({ paymentMethod: { type: 'card' } })).json()).toEqual({ error: 'card_not_found' });
    expect(await t.pool.query('SELECT 1 FROM subscriptions')).toMatchObject({ rowCount: 0 });
    // A returning customer, known to the payment provider with a saved card.
    await t.pool.query("UPDATE users SET stripe_customer_id = 'cus_returning' WHERE first_name = 'Sara'");
    const paid = await subscribe({ days: [await tomorrowWeekday()], paymentMethod: { type: 'card', cardId: 'pm_card_visa' } });
    expect(paid.statusCode).toBe(201);
    expect([...t.fake.subscriptions.values()][0]).toMatchObject({ paymentMethodId: 'pm_card_visa', status: 'active' });
    const mine = (await call(t, 'GET', `/subscriptions/${paid.json().subscription.id}`, { cookie: customer })).json().subscription;
    expect(mine.paymentMethod).toEqual({ brand: 'visa', last4: '4242', wallet: null });
    // The paid first invoice and its webhook are one month, paid out once.
    const payouts = await t.pool.query<{ invoice_id: string }>('SELECT invoice_id FROM subscription_payouts');
    expect(payouts.rows.map((r) => r.invoice_id)).toEqual([expect.stringMatching(/^in_first_/)]);
  });

  it('starts monthly billing, picks the best-rated free pro and plans four weeks of visits', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening], firstName: 'Ok' });
    const best = await approvedPro(t, '+4915100000102', { trades: [market.gardening], firstName: 'Daniel' });
    await giveRating(t.pool, best.proId, 5);

    // The first visit is tomorrow, so the first month is charged at sign-up (D91).
    const response = await subscribe({ days: [await tomorrowWeekday()] });
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
    const { subscription, payment } = (await subscribe({ days: [await tomorrowWeekday()] })).json();
    expect(subscription.status).toBe('awaiting_payment');
    expect(payment).toMatchObject({ clientSecret: expect.stringMatching(/^sub_.*_secret$/), confirm: 'payment' });
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
    const { subscription } = (await subscribe({ days: [await tomorrowWeekday()] })).json();
    const stripeId = [...t.fake.subscriptions.keys()][0] ?? '';
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

describe('billing from the first visit day (D91)', () => {
  let pro: { cookie: string; proId: string };
  beforeEach(async () => {
    pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
  });

  const load = async (id: string) => (await call(t, 'GET', `/subscriptions/${id}`, { cookie: customer })).json().subscription;
  const stripeIdOf = async (id: string) =>
    (await t.pool.query<{ ref: string }>('SELECT stripe_subscription_id AS ref FROM subscriptions WHERE id = $1', [id])).rows[0]?.ref ?? '';
  const payouts = async () => (await t.pool.query('SELECT invoice_id, amount_cents, status FROM subscription_payouts')).rows;
  const visitStatuses = async (id: string) =>
    (await t.pool.query<{ status: string }>('SELECT status FROM subscription_visits WHERE subscription_id = $1 ORDER BY starts_at', [id])).rows.map(
      (r) => r.status,
    );
  const time = (iso: string | null) => (iso ? new Date(iso).getTime() : null);
  const monthsLater = async (at: number, months: number) =>
    (await t.pool.query<{ at: Date }>('SELECT $1::timestamptz + make_interval(months => $2) AS at', [new Date(at), months])).rows[0]?.at.getTime();

  it('charges nothing at sign-up for a start next week or in 2 weeks: billing, next payment and the minimum term start on the first visit day', async () => {
    let phone = 2;
    for (const start of ['next_week', 'in_2_weeks']) {
      const cookie = await signIn(t, `+49151000000${String(phone).padStart(2, '0')}`, 'customer');
      phone += 1;
      const response = await subscribe({ start, timeWindow: start === 'next_week' ? 'morning' : 'afternoon' }, cookie);
      expect(response.statusCode).toBe(201);
      const { subscription, payment } = response.json();
      const midnight = await berlinMidnight(subscription.firstVisitOn);
      // The card is set up, so the plan is active and its visits planned; nothing is charged or paid out yet.
      expect(payment).toBeNull();
      expect(subscription).toMatchObject({ status: 'active', startedAt: null });
      expect(subscription.visits.length).toBeGreaterThan(0);
      expect(subscription.visits.every((v: { status: string }) => v.status === 'planned')).toBe(true);
      const stripe = [...t.fake.subscriptions.values()].find((s) => s.metadata.subscriptionId === subscription.id);
      expect(stripe?.status).toBe('trialing');
      expect(stripe?.firstChargeAt?.getTime()).toBe(midnight);
      expect(time(subscription.billingStartsAt)).toBe(midnight);
      // My plan's next payment is the first visit day until the first month is paid.
      expect(time(subscription.currentPeriodEnd)).toBe(midnight);
      expect(time(subscription.minTermEndsAt)).toBe(await monthsLater(midnight, 3));
      expect(time(subscription.cancelEndsAt)).toBe(await monthsLater(midnight, 3));
    }
    expect(await payouts()).toEqual([]);
  });

  it('charges at once only when the first visit is tomorrow, less than 24 hours from the first visit day starting', async () => {
    const today = await berlinToday();
    const tomorrow = await subscribe({ days: [isoWeekday(plusDays(today, 1))] });
    const other = await signIn(t, '+4915100000002', 'customer');
    const dayAfter = await subscribe({ days: [isoWeekday(plusDays(today, 2))], timeWindow: 'afternoon' }, other);
    const [first, second] = [...t.fake.subscriptions.values()];
    // Tomorrow: billed from sign-up, the first month paid at once.
    expect(first).toMatchObject({ status: 'active', firstChargeAt: null });
    expect(tomorrow.json().subscription.startedAt).not.toBeNull();
    const startsAt = time(tomorrow.json().subscription.billingStartsAt) ?? 0;
    expect(Math.abs(startsAt - Date.now())).toBeLessThan(60_000);
    // The day after tomorrow: nothing charged until that day begins.
    expect(second).toMatchObject({ status: 'trialing' });
    expect(second?.firstChargeAt?.getTime()).toBe(await berlinMidnight(plusDays(today, 2)));
    expect(dayAfter.json().subscription.startedAt).toBeNull();
    expect((await payouts()).map((p) => p.invoice_id)).toEqual([expect.stringMatching(/^in_first_/)]);
  });

  it("makes a saved card the plan's card without charging it", async () => {
    await t.pool.query("UPDATE users SET stripe_customer_id = 'cus_returning' WHERE first_name = 'Sara'");
    const response = await subscribe({ start: 'next_week', paymentMethod: { type: 'card', cardId: 'pm_card_visa' } });
    expect(response.json().payment).toBeNull();
    expect([...t.fake.subscriptions.values()][0]).toMatchObject({ paymentMethodId: 'pm_card_visa', status: 'trialing', cardReady: true });
    const mine = await load(response.json().subscription.id);
    expect(mine).toMatchObject({ status: 'active', paymentMethod: { brand: 'visa', last4: '4242', wallet: null } });
    expect(await payouts()).toEqual([]);
  });

  it('asks the browser to set up a new card, not to pay, and starts the plan once the card is set up', async () => {
    t.fake.setInstantHolds(false);
    const { subscription, payment } = (await subscribe({ start: 'next_week' })).json();
    expect(subscription.status).toBe('awaiting_payment');
    expect(subscription.visits).toEqual([]);
    expect(payment).toEqual({ clientSecret: expect.stringMatching(/^seti_.*_secret$/), confirm: 'setup', publishableKey: null });
    // After a reload, My plan gets the same set-up to finish.
    const again = (await call(t, 'GET', `/subscriptions/${subscription.id}/payment`, { cookie: customer })).json();
    expect(again.payment).toMatchObject({ clientSecret: payment.clientSecret, confirm: 'setup' });

    const check = () => call(t, 'POST', `/subscriptions/${subscription.id}/payment/check`, { cookie: customer });
    expect((await check()).json().subscription.status).toBe('awaiting_payment');
    t.fake.confirmSetup(await stripeIdOf(subscription.id));
    const started = (await check()).json().subscription;
    expect(started.status).toBe('active');
    expect(started.visits.length).toBeGreaterThan(0);
    expect(time(started.currentPeriodEnd)).toBe(await berlinMidnight(subscription.firstVisitOn));
    expect(await payouts()).toEqual([]);
    const other = await signIn(t, '+4915100000002', 'customer');
    expect((await call(t, 'POST', `/subscriptions/${subscription.id}/payment/check`, { cookie: other })).statusCode).toBe(404);
  });

  it('starts a plan whose card is set up from the webhook, or from the planning job when the webhook never came', async () => {
    t.fake.setInstantHolds(false);
    const byWebhook = (await subscribe({ start: 'next_week' })).json().subscription;
    const byJob = (await subscribe({ start: 'next_week', timeWindow: 'afternoon' }, await signIn(t, '+4915100000002', 'customer'))).json()
      .subscription;
    const webhookRef = await stripeIdOf(byWebhook.id);
    t.fake.confirmSetup(webhookRef);
    expect((await webhook('evt_ready', { kind: 'subscription_ready', subscriptionId: webhookRef })).statusCode).toBe(200);
    expect((await load(byWebhook.id)).status).toBe('active');

    t.fake.confirmSetup(await stripeIdOf(byJob.id));
    await t.pool.query("UPDATE subscriptions SET created_at = now() - interval '31 minutes' WHERE id = $1", [byJob.id]);
    await subscriptionTick(t.deps);
    expect((await t.pool.query<{ status: string }>('SELECT status FROM subscriptions WHERE id = $1', [byJob.id])).rows[0]?.status).toBe('active');
  });

  it('records the first month only when the first invoice is paid, from the first visit day, and pays the pro', async () => {
    const { subscription } = (await subscribe({ start: 'in_2_weeks' })).json();
    const midnight = await berlinMidnight(subscription.firstVisitOn);
    const periodEnd = (await monthsLater(midnight, 1)) ?? 0;
    const paid = await webhook('evt_first', {
      kind: 'invoice_paid',
      subscriptionId: await stripeIdOf(subscription.id),
      invoiceId: 'in_first_month',
      amountCents: 6400,
      periodEnd: new Date(periodEnd).toISOString(),
    });
    expect(paid.statusCode).toBe(200);
    const after = await load(subscription.id);
    expect(after.status).toBe('active');
    expect(time(after.startedAt)).toBe(midnight);
    expect(time(after.currentPeriodEnd)).toBe(periodEnd);
    expect(await payouts()).toEqual([{ invoice_id: 'in_first_month', amount_cents: Math.floor(6400 * 0.7), status: 'sent' }]);
  });

  it('holds the visits and tells the customer when the first charge fails, and plans them again once it is paid', async () => {
    const { subscription } = (await subscribe({ start: 'next_week' })).json();
    const ref = await stripeIdOf(subscription.id);
    expect((await webhook('evt_failed', { kind: 'invoice_failed', subscriptionId: ref })).statusCode).toBe(200);
    const failed = await load(subscription.id);
    expect(failed.status).toBe('past_due');
    expect(await visitStatuses(subscription.id)).toEqual(subscription.visits.map(() => 'pending'));
    // Off the pro's week, and they cannot tick it off.
    const to = new Date(Date.now() + 30 * DAY_MS).toISOString();
    expect((await call(t, 'GET', `/pro/visits?to=${encodeURIComponent(to)}`, { cookie: pro.cookie })).json().visits).toEqual([]);
    const firstVisit = subscription.visits[0].id as string;
    await t.pool.query("UPDATE subscription_visits SET starts_at = now() - interval '1 hour', ends_at = now() + interval '1 minute' WHERE id = $1", [
      firstVisit,
    ]);
    const done = await call(t, 'POST', `/pro/visits/${firstVisit}/complete`, { cookie: pro.cookie, body: { tasksDone: ['Mow'] } });
    expect(done.json()).toEqual({ error: 'invalid_status' });
    const told = await t.pool.query<{ body: string; link: string }>("SELECT body, link FROM inbox WHERE kind = 'payment_action_needed'");
    expect(told.rows).toEqual([{ body: expect.stringContaining('on hold'), link: `/my-plans/${subscription.id}` }]);
    // A second failed attempt does not tell them again.
    await webhook('evt_failed_2', { kind: 'invoice_failed', subscriptionId: ref });
    expect((await t.pool.query("SELECT 1 FROM inbox WHERE kind = 'payment_action_needed'")).rowCount).toBe(1);

    // Stripe's retry goes through: the visits take place again, except the one whose time passed meanwhile.
    await webhook('evt_paid', {
      kind: 'invoice_paid',
      subscriptionId: ref,
      invoiceId: 'in_retry',
      amountCents: 6400,
      periodEnd: new Date(Date.now() + 40 * DAY_MS).toISOString(),
    });
    expect((await load(subscription.id)).status).toBe('active');
    const statuses = await visitStatuses(subscription.id);
    expect(statuses[0]).toBe('cancelled');
    expect(statuses.slice(1).every((s) => s === 'planned')).toBe(true);
    expect((await payouts()).map((p) => p.invoice_id)).toEqual(['in_retry']);
  });

  it('holds a visit about to start when billing has started but the first month is still not paid', async () => {
    const { subscription } = (await subscribe({ start: 'next_week' })).json();
    const [soon, later] = subscription.visits as { id: string }[];
    // The first visit day has come, the charge has not been reported, and a visit starts within the hour.
    await t.pool.query("UPDATE subscriptions SET billing_starts_at = now() - interval '7 hours' WHERE id = $1", [subscription.id]);
    await t.pool.query("UPDATE subscription_visits SET starts_at = now() + interval '1 hour', ends_at = now() + interval '2 hours' WHERE id = $1", [
      soon?.id,
    ]);
    await subscriptionTick(t.deps);
    const status = async (id: string | undefined) =>
      (await t.pool.query<{ status: string }>('SELECT status FROM subscription_visits WHERE id = $1', [id])).rows[0]?.status;
    expect(await status(soon?.id)).toBe('pending');
    expect(await status(later?.id)).toBe('planned');
    await subscriptionTick(t.deps);
    expect((await t.pool.query("SELECT 1 FROM inbox WHERE kind = 'payment_action_needed'")).rowCount).toBe(1);
  });

  it('ends a cancelled plan at the end of the minimum term counted from the first visit day', async () => {
    const { subscription } = (await subscribe({ start: 'in_2_weeks' })).json();
    const termEnds = await monthsLater(await berlinMidnight(subscription.firstVisitOn), 3);
    const cancelled = (await call(t, 'POST', `/subscriptions/${subscription.id}/cancel`, { cookie: customer })).json().subscription;
    expect(time(cancelled.endsAt)).toBe(termEnds);
    expect([...t.fake.subscriptions.values()][0]?.cancelAt?.getTime()).toBe(termEnds);
  });
});

describe('managing a plan', () => {
  let pro: { cookie: string; proId: string };
  beforeEach(async () => {
    pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
  });

  interface Visit {
    id: string;
    startsAt: string;
    endsAt: string;
    status: string;
    movedFrom: string | null;
    pendingMove: { toStartsAt: string; toEndsAt: string; respondBy: string } | null;
  }
  const DAY = 24 * 3600 * 1000;
  const weekday = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', weekday: 'short' }).format(new Date(iso));
  const clock = (iso: string) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  const load = async (id: string) => (await call(t, 'GET', `/subscriptions/${id}`, { cookie: customer })).json().subscription;
  /** A subscribed customer and a planned visit at least 8 days ahead, so its whole week is still to come. */
  async function laterVisit() {
    const subscription = (await subscribe()).json().subscription;
    const visit = (subscription.visits as Visit[]).find((v) => new Date(v.startsAt).getTime() > Date.now() + 8 * DAY);
    if (!visit) throw new Error('no visit 8 days ahead');
    return { subscription, visit };
  }
  const options = async (subscriptionId: string, visitId: string) =>
    (await call(t, 'GET', `/subscriptions/${subscriptionId}/visits/${visitId}/move-options`, { cookie: customer })).json() as {
      options: { startsAt: string; endsAt: string }[];
      days: { startsAt: string; endsAt: string; free: boolean }[];
      reason: string | null;
    };
  const move = (subscriptionId: string, visitId: string, startsAt: string) =>
    call(t, 'POST', `/subscriptions/${subscriptionId}/visits/${visitId}/move`, { cookie: customer, body: { startsAt } });
  const inbox = async (kind: string) =>
    (await t.pool.query<{ user_id: string; body: string }>('SELECT user_id, body FROM inbox WHERE kind = $1 ORDER BY created_at', [kind])).rows;

  describe('skipping visits (D90)', () => {
    const skip = (subscriptionId: string, visitId: string, cookie = customer) =>
      call(t, 'POST', `/subscriptions/${subscriptionId}/visits/${visitId}/skip`, { cookie });
    const unskip = (subscriptionId: string, visitId: string, cookie = customer) =>
      call(t, 'POST', `/subscriptions/${subscriptionId}/visits/${visitId}/unskip`, { cookie });

    /**
     * A plan with four visits of its own in one calendar month two months ahead (10:00 Berlin on the 2nd, 9th, 16th
     * and 23rd), well past the planning window, so the test never depends on the day it runs.
     */
    async function monthOfVisits() {
      const subscription = (await subscribe()).json().subscription;
      const inserted = await t.pool.query<{ id: string }>(
        `INSERT INTO subscription_visits (subscription_id, pro_id, starts_at, ends_at, status)
         SELECT $1, $2, at, at + interval '1 hour', 'planned'
         FROM unnest(ARRAY[1, 8, 15, 22]) AS d,
           LATERAL (SELECT ((date_trunc('month', (now() AT TIME ZONE 'Europe/Berlin') + interval '2 months')::date + d) + time '10:00')
                    AT TIME ZONE 'Europe/Berlin' AS at) x
         ORDER BY at RETURNING id`,
        [subscription.id, pro.proId],
      );
      return { subscription, ids: inserted.rows.map((row) => row.id) };
    }
    const visitOf = async (subscriptionId: string, visitId: string) =>
      ((await load(subscriptionId)).visits as (Visit & { skipsUsedInMonth: number })[]).find((v) => v.id === visitId);

    it('skips up to 2 visits a calendar month, frees the pro, tells them, and charges the same', async () => {
      const { subscription, ids } = await monthOfVisits();
      const [a = '', b = '', c = ''] = ids;
      const before = await t.pool.query('SELECT price_cents, current_period_end FROM subscriptions');
      const payoutsBefore = await t.pool.query('SELECT invoice_id, amount_cents FROM subscription_payouts ORDER BY invoice_id');
      expect(subscription).toMatchObject({ skipsPerMonth: 2, skipsLeftThisMonth: 2 });

      const first = await skip(subscription.id, a);
      expect(first.statusCode).toBe(200);
      const skipped = (first.json().subscription.visits as (Visit & { skipsUsedInMonth: number; skippedAt: string })[]).find((v) => v.id === a);
      expect(skipped).toMatchObject({ status: 'skipped', skipsUsedInMonth: 1 });
      expect(skipped?.skippedAt).toBeTruthy();
      expect((await skip(subscription.id, a)).json()).toEqual({ error: 'visit_not_skippable' });
      expect((await skip(subscription.id, b)).statusCode).toBe(200);
      const third = await skip(subscription.id, c);
      expect(third.statusCode).toBe(409);
      expect(third.json()).toEqual({ error: 'no_skips_left' });
      expect((await visitOf(subscription.id, c))?.status).toBe('planned');
      expect((await visitOf(subscription.id, c))?.skipsUsedInMonth).toBe(2);

      // The pro is told and no longer expects the visits: their time is free and listed as skipped.
      const told = await inbox('visit_skipped');
      expect(told).toHaveLength(2);
      expect(told[0]).toEqual({ user_id: pro.proId, body: expect.stringContaining('Sara skipped the Lawn care visit') });
      const to = new Date(Date.now() + 61 * DAY).toISOString();
      const from = new Date(Date.now() + 30 * DAY).toISOString();
      const listed = (await call(t, 'GET', `/pro/visits?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { cookie: pro.cookie })).json()
        .visits as Visit[];
      expect(listed.filter((v) => v.status === 'skipped').map((v) => v.id).sort()).toEqual([a, b].sort());
      const overlap = await t.pool.query(
        `INSERT INTO subscription_visits (subscription_id, pro_id, starts_at, ends_at, status)
         SELECT subscription_id, pro_id, starts_at + interval '30 minutes', ends_at, 'planned' FROM subscription_visits WHERE id = $1
         RETURNING id`,
        [a],
      );
      expect(overlap.rowCount).toBe(1);
      await t.pool.query('DELETE FROM subscription_visits WHERE id = $1', [overlap.rows[0]?.id]);

      // D90: a skipped visit is still part of the monthly price; nothing is credited or refunded.
      expect((await t.pool.query('SELECT price_cents, current_period_end FROM subscriptions')).rows).toEqual(before.rows);
      expect((await t.pool.query('SELECT invoice_id, amount_cents FROM subscription_payouts ORDER BY invoice_id')).rows).toEqual(payoutsBefore.rows);
      expect(t.fake.balance).toEqual([]);
      expect([...t.fake.subscriptions.values()][0]).toMatchObject({ amountCents: 6400 });

      // Undo gives the skip back, and the third visit can be skipped then.
      const undone = await unskip(subscription.id, a);
      expect((undone.json().subscription.visits as Visit[]).find((v) => v.id === a)?.status).toBe('planned');
      expect((await inbox('visit_unskipped'))[0]?.user_id).toBe(pro.proId);
      expect((await unskip(subscription.id, a)).json()).toEqual({ error: 'visit_not_skipped' });
      expect((await skip(subscription.id, c)).statusCode).toBe(200);
    });

    it('lets only one of two skips at the same moment take the last skip of the month', async () => {
      const { subscription, ids } = await monthOfVisits();
      const [a = '', b = '', c = '', d = ''] = ids;
      expect((await skip(subscription.id, a)).statusCode).toBe(200);
      const answers = await Promise.all([skip(subscription.id, b), skip(subscription.id, c), skip(subscription.id, d)]);
      expect(answers.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
      expect(answers.filter((r) => r.statusCode === 409).map((r) => r.json())).toEqual([{ error: 'no_skips_left' }, { error: 'no_skips_left' }]);
      const count = await t.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM subscription_visits WHERE status = 'skipped'");
      expect(count.rows[0]?.n).toBe(2);
    });

    it("counts this month for skips left, and each visit's own month for the limit", async () => {
      const { subscription, ids } = await monthOfVisits();
      await skip(subscription.id, ids[0] ?? '');
      await skip(subscription.id, ids[1] ?? '');
      // Those skips are in a later month: this month's skips are untouched.
      expect((await load(subscription.id)).skipsLeftThisMonth).toBe(2);
      // A skip this month, made directly (a visit this month may not exist on every day the test runs).
      await t.pool.query(
        `INSERT INTO subscription_visits (subscription_id, pro_id, starts_at, ends_at, status, skipped_at)
         VALUES ($1, $2, date_trunc('month', now() AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'Europe/Berlin' + interval '1 minute',
                 date_trunc('month', now() AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'Europe/Berlin' + interval '2 minutes', 'skipped', now())`,
        [subscription.id, pro.proId],
      );
      expect((await load(subscription.id)).skipsLeftThisMonth).toBe(1);
    });

    it('needs 24 hours: no skip and no undo later than that', async () => {
      const subscription = (await subscribe()).json().subscription;
      await t.pool.query('DELETE FROM subscription_visits WHERE subscription_id = $1', [subscription.id]);
      const insert = (hours: number, status: string) =>
        t.pool.query<{ id: string }>(
          `INSERT INTO subscription_visits (subscription_id, pro_id, starts_at, ends_at, status)
           VALUES ($1, $2, now() + make_interval(hours => $3), now() + make_interval(hours => $3 + 1), $4) RETURNING id`,
          [subscription.id, pro.proId, hours, status],
        );
      const soon = (await insert(23, 'planned')).rows[0]?.id ?? '';
      const soonSkipped = (await insert(20, 'skipped')).rows[0]?.id ?? '';
      const later = (await insert(25, 'planned')).rows[0]?.id ?? '';
      expect((await skip(subscription.id, soon)).json()).toEqual({ error: 'skip_too_late' });
      expect((await unskip(subscription.id, soonSkipped)).json()).toEqual({ error: 'skip_too_late' });
      expect((await skip(subscription.id, later)).statusCode).toBe(200);
      expect((await unskip(subscription.id, later)).statusCode).toBe(200);
    });

    it('undoes a skip only when the visit can still take place', async () => {
      const { subscription, ids } = await monthOfVisits();
      const [a = '', b = '', c = ''] = ids;
      await skip(subscription.id, a);
      await skip(subscription.id, b);
      // The pro's time was taken by another visit meanwhile.
      await t.pool.query(
        `INSERT INTO subscription_visits (subscription_id, pro_id, starts_at, ends_at, status)
         SELECT subscription_id, pro_id, starts_at + interval '30 minutes', ends_at + interval '30 minutes', 'planned'
         FROM subscription_visits WHERE id = $1`,
        [a],
      );
      expect((await unskip(subscription.id, a)).json()).toEqual({ error: 'pro_no_longer_free' });
      // The plan has another regular pro now.
      const other = await approvedPro(t, '+4915100000105', { trades: [market.gardening] });
      await t.pool.query('UPDATE subscriptions SET pro_id = $1', [other.proId]);
      expect((await unskip(subscription.id, b)).json()).toEqual({ error: 'pro_no_longer_free' });
      await t.pool.query('UPDATE subscriptions SET pro_id = $1', [pro.proId]);
      // After the plan's end, or in a pause.
      await t.pool.query("UPDATE subscriptions SET ends_at = now() + interval '40 days'");
      expect((await unskip(subscription.id, b)).json()).toEqual({ error: 'plan_ending' });
      await t.pool.query('UPDATE subscriptions SET ends_at = NULL');
      await t.pool.query(
        `INSERT INTO subscription_pauses (subscription_id, customer_id, starts_on, weeks, starts_at, ends_at)
         SELECT s.id, s.customer_id, (v.starts_at AT TIME ZONE 'Europe/Berlin')::date, 1, v.starts_at - interval '1 hour', v.starts_at + interval '6 days'
         FROM subscriptions s JOIN subscription_visits v ON v.subscription_id = s.id WHERE v.id = $1`,
        [b],
      );
      expect((await unskip(subscription.id, b)).json()).toEqual({ error: 'visit_paused' });
      // A visit with a move waiting for the pro is not skipped until the request is withdrawn.
      await t.pool.query(
        `INSERT INTO subscription_visit_moves (visit_id, subscription_id, customer_id, pro_id, from_starts_at, from_ends_at, to_starts_at, to_ends_at, respond_by)
         SELECT v.id, v.subscription_id, s.customer_id, v.pro_id, v.starts_at, v.ends_at, v.starts_at + interval '1 day', v.ends_at + interval '1 day', v.starts_at - interval '1 day'
         FROM subscription_visits v JOIN subscriptions s ON s.id = v.subscription_id WHERE v.id = $1`,
        [c],
      );
      expect((await skip(subscription.id, c)).json()).toEqual({ error: 'move_pending' });
    });

    it('keeps other customers out', async () => {
      const { subscription, ids } = await monthOfVisits();
      const other = await signIn(t, '+4915100000002', 'customer');
      expect((await skip(subscription.id, ids[0] ?? '', other)).statusCode).toBe(404);
      expect((await unskip(subscription.id, ids[0] ?? '', other)).statusCode).toBe(404);
      expect((await call(t, 'POST', `/subscriptions/${subscription.id}/visits/${ids[0]}/skip`, { cookie: pro.cookie })).statusCode).toBe(404);
      expect((await visitOf(subscription.id, ids[0] ?? ''))?.status).toBe('planned');
    });
  });

  it('copies the minimum term and pause rules onto the subscription', async () => {
    await t.pool.query('UPDATE plans SET min_term_months = 6, pause_notice_days = 14, max_pause_weeks = 2');
    const subscription = (await subscribe()).json().subscription;
    expect(subscription).toMatchObject({ minTermMonths: 6, pauseNoticeDays: 14, maxPauseWeeks: 2 });
    await t.pool.query('UPDATE plans SET pause_notice_days = 30');
    expect((await load(subscription.id)).pauseNoticeDays).toBe(14);
  });

  it('offers the other days of the same week when the pro is free at the same time', async () => {
    const { subscription, visit } = await laterVisit();
    // The pro does not work on Thursdays.
    await t.pool.query("UPDATE pro_profiles SET working_days = '{1,2,3,5,6,7}' WHERE user_id = $1", [pro.proId]);
    const result = await options(subscription.id, visit.id);
    expect(result.reason).toBeNull();
    expect(result.options.map((o) => weekday(o.startsAt))).toEqual(['Mon', 'Wed', 'Fri', 'Sat', 'Sun']);
    // The nearby days also show the day the pro is not free (D90).
    expect(result.days.map((o) => [weekday(o.startsAt), o.free])).toEqual([
      ['Mon', true],
      ['Wed', true],
      ['Thu', false],
      ['Fri', true],
      ['Sat', true],
      ['Sun', true],
    ]);
    expect(result.options.every((o) => clock(o.startsAt) === clock(visit.startsAt))).toBe(true);
    const length = new Date(visit.endsAt).getTime() - new Date(visit.startsAt).getTime();
    expect(result.options.every((o) => new Date(o.endsAt).getTime() - new Date(o.startsAt).getTime() === length)).toBe(true);
    const sameWeek = await t.pool.query<{ ok: boolean }>(
      `SELECT bool_and(date_trunc('week', o AT TIME ZONE 'Europe/Berlin') = date_trunc('week', $1::timestamptz AT TIME ZONE 'Europe/Berlin')) AS ok
       FROM unnest($2::timestamptz[]) AS o`,
      [visit.startsAt, result.options.map((o) => o.startsAt)],
    );
    expect(sameWeek.rows[0]?.ok).toBe(true);

    // A day the pro is busy or off, another week, or another time of day is refused.
    const thursday = new Date(new Date(visit.startsAt).getTime() + 2 * DAY).toISOString();
    expect((await move(subscription.id, visit.id, thursday)).json()).toEqual({ error: 'pro_not_free' });
    const nextWeek = new Date(new Date(visit.startsAt).getTime() + 7 * DAY).toISOString();
    expect((await move(subscription.id, visit.id, nextWeek)).json()).toEqual({ error: 'move_not_same_week' });
    const otherTime = new Date(new Date(result.options[0]?.startsAt ?? '').getTime() + 3600_000).toISOString();
    expect((await move(subscription.id, visit.id, otherTime)).json()).toEqual({ error: 'move_not_same_week' });
  });

  it('needs the request at least 24 hours before the visit', async () => {
    const { subscription, visit } = await laterVisit();
    // Move the visit to under 24 hours away. The pro may already have another visit at a given hour (it
    // depends on the day the test runs), so take the first hour in that window that is free.
    let moved = false;
    for (let hours = 23; hours >= 2 && !moved; hours -= 1) {
      try {
        await t.pool.query(
          'UPDATE subscription_visits SET starts_at = now() + make_interval(hours => $2), ends_at = now() + make_interval(hours => $2 + 1) WHERE id = $1',
          [visit.id, hours],
        );
        moved = true;
      } catch (error) {
        if (!String(error).includes('subscription_visits_no_overlap')) throw error;
      }
    }
    expect(moved).toBe(true);
    expect(await options(subscription.id, visit.id)).toEqual({ options: [], days: [], reason: 'too_late' });
    const target = new Date(Date.now() + 2 * DAY).toISOString();
    expect((await move(subscription.id, visit.id, target)).json()).toEqual({ error: 'visit_not_movable' });
  });

  it('moves only that visit once the pro accepts, and leaves billing alone', async () => {
    const { subscription, visit } = await laterVisit();
    const before = await t.pool.query('SELECT price_cents, current_period_end FROM subscriptions');
    const payoutsBefore = await t.pool.query('SELECT count(*)::int AS n FROM subscription_payouts');
    const { options: choices } = await options(subscription.id, visit.id);
    const target = choices.find((o) => weekday(o.startsAt) === 'Thu');
    if (!target) throw new Error('no Thursday offered');

    const requested = await move(subscription.id, visit.id, target.startsAt);
    expect(requested.statusCode).toBe(200);
    const waiting = (requested.json().subscription.visits as Visit[]).find((v) => v.id === visit.id);
    expect(waiting?.startsAt).toBe(visit.startsAt);
    expect(new Date(waiting?.pendingMove?.toStartsAt ?? '').toISOString()).toBe(new Date(target.startsAt).toISOString());
    // The pro answers by 24 hours before the original time (sooner than the new time here).
    expect(new Date(waiting?.pendingMove?.respondBy ?? '').getTime()).toBe(new Date(visit.startsAt).getTime() - DAY);
    expect((await move(subscription.id, visit.id, target.startsAt)).json()).toEqual({ error: 'move_pending' });
    expect(await options(subscription.id, visit.id)).toEqual({ options: [], days: [], reason: 'move_pending' });

    // The pro is told in the app and by push, not by SMS.
    const told = await inbox('visit_move_requested');
    expect(told).toEqual([{ user_id: pro.proId, body: expect.stringContaining('Sara asks to move the Lawn care visit') }]);
    const sms = await t.pool.query("SELECT 1 FROM notifications WHERE kind = 'visit_move_requested' AND channel = 'sms'");
    expect(sms.rowCount).toBe(0);

    const moves = (await call(t, 'GET', '/pro/visit-moves', { cookie: pro.cookie })).json().moves;
    expect(moves).toEqual([
      expect.objectContaining({ visitId: visit.id, customerName: 'Sara', planName: 'Lawn care', fromStartsAt: visit.startsAt }),
    ]);
    const stranger = await approvedPro(t, '+4915100000109', { trades: [market.gardening] });
    expect((await call(t, 'POST', `/pro/visit-moves/${moves[0].id}/accept`, { cookie: stranger.cookie })).statusCode).toBe(404);

    const accepted = await call(t, 'POST', `/pro/visit-moves/${moves[0].id}/accept`, { cookie: pro.cookie });
    expect(accepted.json()).toEqual({ moves: [] });
    const after = await load(subscription.id);
    const moved = (after.visits as Visit[]).find((v) => v.id === visit.id);
    expect(moved).toMatchObject({ startsAt: target.startsAt, endsAt: target.endsAt, status: 'planned', pendingMove: null });
    expect(moved?.movedFrom).toBe(visit.startsAt);
    const others = (after.visits as Visit[]).filter((v) => v.id !== visit.id);
    expect(others.map((v) => v.startsAt)).toEqual((subscription.visits as Visit[]).filter((v) => v.id !== visit.id).map((v) => v.startsAt));
    expect((await inbox('visit_move_answered'))[0]?.body).toContain('Daniel confirmed');

    // The planner never plans the original time again, and nothing about billing changed.
    await subscriptionTick(t.deps);
    const again = await t.pool.query('SELECT 1 FROM subscription_visits WHERE starts_at = $1', [visit.startsAt]);
    expect(again.rowCount).toBe(0);
    expect((await t.pool.query('SELECT price_cents, current_period_end FROM subscriptions')).rows).toEqual(before.rows);
    expect((await t.pool.query('SELECT count(*)::int AS n FROM subscription_payouts')).rows).toEqual(payoutsBefore.rows);
    expect([...t.fake.subscriptions.values()][0]).toMatchObject({ amountCents: 6400, cancelAt: null, cancelAtPeriodEnd: false });
  });

  it('keeps the visit when the pro declines, and tells the customer', async () => {
    const { subscription, visit } = await laterVisit();
    const target = (await options(subscription.id, visit.id)).options[0];
    await move(subscription.id, visit.id, target?.startsAt ?? '');
    const [request] = (await call(t, 'GET', '/pro/visit-moves', { cookie: pro.cookie })).json().moves;
    const declined = await call(t, 'POST', `/pro/visit-moves/${request.id}/decline`, { cookie: pro.cookie });
    expect(declined.json()).toEqual({ moves: [] });
    const kept = ((await load(subscription.id)).visits as Visit[]).find((v) => v.id === visit.id);
    expect(kept).toMatchObject({ startsAt: visit.startsAt, status: 'planned', pendingMove: null, movedFrom: null });
    expect((await inbox('visit_move_answered'))[0]?.body).toMatch(/Daniel cannot come on .*\. Your Lawn care visit stays at /);
    expect((await call(t, 'POST', `/pro/visit-moves/${request.id}/accept`, { cookie: pro.cookie })).json()).toEqual({ error: 'move_not_pending' });
  });

  it('refuses the move when the pro is no longer free, leaving the request to decline', async () => {
    const { subscription, visit } = await laterVisit();
    const target = (await options(subscription.id, visit.id)).options.find((o) => weekday(o.startsAt) === 'Thu');
    await move(subscription.id, visit.id, target?.startsAt ?? '');
    await t.pool.query("UPDATE pro_profiles SET working_days = '{1,2,3,5,6,7}' WHERE user_id = $1", [pro.proId]);
    const [request] = (await call(t, 'GET', '/pro/visit-moves', { cookie: pro.cookie })).json().moves;
    expect((await call(t, 'POST', `/pro/visit-moves/${request.id}/accept`, { cookie: pro.cookie })).json()).toEqual({ error: 'pro_not_free' });
    expect((await call(t, 'GET', '/pro/visit-moves', { cookie: pro.cookie })).json().moves).toHaveLength(1);
    expect(((await load(subscription.id)).visits as Visit[]).find((v) => v.id === visit.id)?.startsAt).toBe(visit.startsAt);
  });

  it('declines a move by itself when the pro does not answer in time', async () => {
    const { subscription, visit } = await laterVisit();
    const target = (await options(subscription.id, visit.id)).options[0];
    await move(subscription.id, visit.id, target?.startsAt ?? '');
    expect(await visitMoveTick(t.deps)).toBe(0);
    await t.pool.query("UPDATE subscription_visit_moves SET respond_by = now() - interval '1 minute'");
    expect((await call(t, 'GET', '/pro/visit-moves', { cookie: pro.cookie })).json().moves).toEqual([]);
    expect(await visitMoveTick(t.deps)).toBe(1);
    expect((await t.pool.query('SELECT status FROM subscription_visit_moves')).rows).toEqual([{ status: 'expired' }]);
    expect((await inbox('visit_move_answered'))[0]?.body).toMatch(/Daniel did not confirm the new time in time\. Your Lawn care visit stays at /);
    const kept = ((await load(subscription.id)).visits as Visit[]).find((v) => v.id === visit.id);
    expect(kept).toMatchObject({ startsAt: visit.startsAt, pendingMove: null });
    expect(await visitMoveTick(t.deps)).toBe(0);
  });

  it('lets the customer withdraw a request the pro has not answered', async () => {
    const { subscription, visit } = await laterVisit();
    const target = (await options(subscription.id, visit.id)).options[0];
    await move(subscription.id, visit.id, target?.startsAt ?? '');
    const url = `/subscriptions/${subscription.id}/visits/${visit.id}/move/withdraw`;
    const withdrawn = await call(t, 'POST', url, { cookie: customer });
    expect(((withdrawn.json().subscription.visits as Visit[]).find((v) => v.id === visit.id))?.pendingMove).toBeNull();
    expect((await call(t, 'POST', url, { cookie: customer })).json()).toEqual({ error: 'move_not_pending' });
    expect((await call(t, 'GET', '/pro/visit-moves', { cookie: pro.cookie })).json().moves).toEqual([]);
    expect((await inbox('visit_move_withdrawn'))[0]?.user_id).toBe(pro.proId);
    // The visit can be moved again afterwards.
    expect((await move(subscription.id, visit.id, target?.startsAt ?? '')).statusCode).toBe(200);
  });

  it('cancels during the minimum term: the plan ends when the term is over (D90)', async () => {
    const subscription = (await subscribe()).json().subscription;
    // Counted from when billing starts (D91), whatever day that is.
    const term = await t.pool.query<{ ends: Date }>("SELECT billing_starts_at + interval '3 months' AS ends FROM subscriptions");
    const termEnds = term.rows[0]?.ends.getTime() ?? 0;
    expect(new Date(subscription.minTermEndsAt).getTime()).toBe(termEnds);
    expect(new Date(subscription.cancelEndsAt).getTime()).toBe(termEnds);

    const cancelled = (await call(t, 'POST', `/subscriptions/${subscription.id}/cancel`, { cookie: customer })).json().subscription;
    expect(new Date(cancelled.endsAt).getTime()).toBe(termEnds);
    expect([...t.fake.subscriptions.values()][0]?.cancelAt?.getTime()).toBe(termEnds);
    // Visits until then still take place.
    expect((cancelled.visits as Visit[]).every((v) => v.status === 'planned')).toBe(true);

    // Near the term's end, the 30 days' notice still applies.
    await t.pool.query("UPDATE subscriptions SET ends_at = NULL, billing_starts_at = now() - interval '3 months' + interval '10 days'");
    const late = Date.now();
    const again = (await call(t, 'POST', `/subscriptions/${subscription.id}/cancel`, { cookie: customer })).json().subscription;
    expect(new Date(again.endsAt).getTime()).toBeGreaterThanOrEqual(late + 30 * DAY - 1000);
    expect(new Date(again.endsAt).getTime()).toBeLessThanOrEqual(Date.now() + 30 * DAY + 1000);
  });

  it('keeps the plan after all with Keep my plan, until it has ended (D90)', async () => {
    const subscription = (await subscribe()).json().subscription;
    await t.pool.query("UPDATE subscriptions SET billing_starts_at = now() - interval '4 months'");
    const keep = () => call(t, 'POST', `/subscriptions/${subscription.id}/keep`, { cookie: customer });
    expect((await keep()).json()).toEqual({ error: 'not_cancelled' });

    // A visit after the end (planned earlier) is called off by the cancellation; keeping the plan frees that
    // time again, for the planning job to plan.
    const late = await t.pool.query<{ id: string }>(
      `INSERT INTO subscription_visits (subscription_id, pro_id, starts_at, ends_at, status)
       VALUES ($1, $2, now() + interval '35 days', now() + interval '35 days 1 hour', 'planned') RETURNING id`,
      [subscription.id, pro.proId],
    );
    const before = ((await load(subscription.id)).visits as Visit[]).filter((v) => v.id !== late.rows[0]?.id);
    const cancelled = (await call(t, 'POST', `/subscriptions/${subscription.id}/cancel`, { cookie: customer })).json().subscription;
    expect(cancelled.endsAt).not.toBeNull();
    expect((cancelled.visits as Visit[]).find((v) => v.id === late.rows[0]?.id)?.status).toBe('cancelled');

    const kept = await keep();
    expect(kept.statusCode).toBe(200);
    const after = kept.json().subscription;
    expect(after.endsAt).toBeNull();
    expect(after.status).toBe('active');
    expect((after.visits as Visit[]).map((v) => [v.startsAt, v.status])).toEqual(before.map((v) => [v.startsAt, 'planned']));
    expect((await t.pool.query("SELECT 1 FROM subscription_visits WHERE status = 'cancelled'")).rowCount).toBe(0);
    expect([...t.fake.subscriptions.values()][0]).toMatchObject({ cancelAt: null, cancelAtPeriodEnd: false });
    expect((await keep()).json()).toEqual({ error: 'not_cancelled' });

    // Once the plan has ended it cannot be kept.
    await call(t, 'POST', `/subscriptions/${subscription.id}/cancel`, { cookie: customer });
    await t.pool.query("UPDATE subscriptions SET ends_at = now() - interval '1 minute'");
    expect((await keep()).json()).toEqual({ error: 'not_cancelled' });
    const other = await signIn(t, '+4915100000002', 'customer');
    expect((await call(t, 'POST', `/subscriptions/${subscription.id}/keep`, { cookie: other })).statusCode).toBe(404);
  });

  it('cancels after the minimum term with 30 days notice', async () => {
    const subscription = (await subscribe()).json().subscription;
    await t.pool.query("UPDATE subscriptions SET billing_starts_at = now() - interval '4 months'");
    // A visit after the notice ends, e.g. planned before the plan was cancelled.
    const late = await t.pool.query<{ id: string }>(
      `INSERT INTO subscription_visits (subscription_id, pro_id, starts_at, ends_at, status)
       VALUES ($1, $2, now() + interval '35 days', now() + interval '35 days 1 hour', 'planned') RETURNING id`,
      [subscription.id, pro.proId],
    );
    const plannedBefore = (subscription.visits as Visit[]).filter((v) => v.status === 'planned').map((v) => v.id);

    const started = Date.now();
    const cancelled = (await call(t, 'POST', `/subscriptions/${subscription.id}/cancel`, { cookie: customer })).json().subscription;
    const endsAt = new Date(cancelled.endsAt).getTime();
    expect(endsAt).toBeGreaterThanOrEqual(started + 30 * DAY - 1000);
    expect(endsAt).toBeLessThanOrEqual(Date.now() + 30 * DAY + 1000);
    const stripe = [...t.fake.subscriptions.values()][0];
    expect(stripe?.cancelAt?.getTime()).toBe(endsAt);
    expect(stripe?.cancelAtPeriodEnd).toBe(false);
    // Visits during the notice still take place; the one after the end is cancelled.
    const statuses = new Map((cancelled.visits as Visit[]).map((v) => [v.id, v.status]));
    expect(plannedBefore.every((id) => statuses.get(id) === 'planned')).toBe(true);
    expect(statuses.get(late.rows[0]?.id ?? '')).toBe('cancelled');
    expect((await call(t, 'POST', `/subscriptions/${subscription.id}/cancel`, { cookie: customer })).json()).toEqual({ error: 'already_cancelled' });

    // Planning never adds visits after the end.
    await t.pool.query("DELETE FROM subscription_visits WHERE starts_at > now() + interval '9 days'");
    await t.pool.query("UPDATE subscriptions SET ends_at = now() + interval '10 days'");
    await subscriptionTick(t.deps);
    const afterEnd = await t.pool.query(
      "SELECT 1 FROM subscription_visits v JOIN subscriptions s ON s.id = v.subscription_id WHERE v.status = 'planned' AND v.ends_at > s.ends_at",
    );
    expect(afterEnd.rowCount).toBe(0);

    await t.pool.query("UPDATE subscriptions SET ends_at = now() - interval '1 minute'");
    await subscriptionTick(t.deps);
    expect((await load(subscription.id)).status).toBe('cancelled');
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
