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
      reason: string | null;
    };
  const move = (subscriptionId: string, visitId: string, startsAt: string) =>
    call(t, 'POST', `/subscriptions/${subscriptionId}/visits/${visitId}/move`, { cookie: customer, body: { startsAt } });
  const inbox = async (kind: string) =>
    (await t.pool.query<{ user_id: string; body: string }>('SELECT user_id, body FROM inbox WHERE kind = $1 ORDER BY created_at', [kind])).rows;

  it('no longer lets the customer skip a visit (D77)', async () => {
    const subscription = (await subscribe()).json().subscription;
    expect(subscription).not.toHaveProperty('skipsLeftThisMonth');
    const [first] = subscription.visits;
    for (const action of ['skip', 'unskip']) {
      const response = await call(t, 'POST', `/subscriptions/${subscription.id}/visits/${first.id}/${action}`, { cookie: customer });
      expect(response.statusCode).toBe(410);
      expect(response.json()).toEqual({ error: 'skips_removed' });
    }
    expect((await load(subscription.id)).visits[0].status).toBe('planned');
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
    await t.pool.query("UPDATE subscription_visits SET starts_at = now() + interval '23 hours', ends_at = now() + interval '24 hours' WHERE id = $1", [
      visit.id,
    ]);
    expect(await options(subscription.id, visit.id)).toEqual({ options: [], reason: 'too_late' });
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
    expect(await options(subscription.id, visit.id)).toEqual({ options: [], reason: 'move_pending' });

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

  it('only cancels after the minimum term, then with 30 days notice', async () => {
    const subscription = (await subscribe()).json().subscription;
    expect((await call(t, 'POST', `/subscriptions/${subscription.id}/cancel`, { cookie: customer })).json()).toEqual({
      error: 'in_minimum_term',
    });
    await t.pool.query("UPDATE subscriptions SET started_at = now() - interval '4 months'");
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
