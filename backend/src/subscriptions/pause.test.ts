import { approvedPro, call, createTestContext, resetDatabase, seedMarket, signIn, signInAdmin, type Market, type TestContext } from '../../test/helpers.js';
import { addDays, settlePausesAfterPlanEnd } from './pause.js';
import { recordPaidMonth, subscriptionTick } from './service.js';

let t: TestContext;
let market: Market;
let customer: string;
let pro: { cookie: string; proId: string };
let planId: string;

/** The weekly plan with the extra costs €64 a month; one visit is worth €64 / 4.3 visits a month. */
const VISIT_VALUE = Math.round(6400 / 4.3);

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
      tasks: ['Mow', 'Edge'],
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
  pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening], firstName: 'Daniel' });
  customer = await signIn(t, '+4915100000001', 'customer', 'Sara');
});

interface Visit {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  pausedBy: string | null;
}

/** A Tuesday-morning weekly plan with the extra (€64 a month). */
async function subscribe(): Promise<{ id: string; visits: Visit[] }> {
  const response = await call(t, 'POST', '/subscriptions', {
    cookie: customer,
    body: { planId, size: 'M', days: [2], timeWindow: 'morning', address: '12 Linden Street', postcode: '10115', withAddon: true, acceptTerms: true },
  });
  expect(response.statusCode).toBe(201);
  return response.json().subscription;
}

const load = async (id: string) => (await call(t, 'GET', `/subscriptions/${id}`, { cookie: customer })).json().subscription;
const pause = (id: string, startsOn: string, weeks: number) =>
  call(t, 'POST', `/subscriptions/${id}/pause`, { cookie: customer, body: { startsOn, weeks } });
const options = async (id: string) => (await call(t, 'GET', `/subscriptions/${id}/pause-options`, { cookie: customer })).json();
const callOff = (id: string, pauseId: string) => call(t, 'POST', `/subscriptions/${id}/pause/${pauseId}/cancel`, { cookie: customer });
const inbox = async (kind: string) =>
  (await t.pool.query<{ user_id: string; body: string }>('SELECT user_id, body FROM inbox WHERE kind = $1 ORDER BY created_at', [kind])).rows;

async function today(): Promise<string> {
  const result = await t.pool.query<{ d: string }>("SELECT to_char((now() AT TIME ZONE 'Europe/Berlin')::date, 'YYYY-MM-DD') AS d");
  return result.rows[0]?.d ?? '';
}

/** The first Monday on or after `day`. */
function mondayFrom(day: string): string {
  let d = day;
  while (new Date(`${d}T12:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1);
  return d;
}

/** Local midnight of a day in Berlin, as an instant. */
async function midnight(day: string): Promise<number> {
  const result = await t.pool.query<{ at: Date }>("SELECT ($1::date)::timestamp AT TIME ZONE 'Europe/Berlin' AS at", [day]);
  return result.rows[0]?.at.getTime() ?? 0;
}

/** Ends a pause in the past (`weeksAgo` weeks ago), keeping the day it started on and so its year. */
const finishPause = (pauseId: string, weeksAgo: number) =>
  t.pool.query(
    'UPDATE subscription_pauses SET starts_at = now() - make_interval(weeks => $2 + 1), ends_at = now() - make_interval(weeks => $2) WHERE id = $1',
    [pauseId, weeksAgo],
  );

describe('pausing a plan (D78)', () => {
  it('needs the notice: one day short is refused, exactly the notice days are fine', async () => {
    const subscription = await subscribe();
    const now = await today();
    expect((await pause(subscription.id, addDays(now, 6), 1)).json()).toEqual({ error: 'pause_notice' });
    expect((await pause(subscription.id, now, 1)).json()).toEqual({ error: 'pause_notice' });
    const ok = await pause(subscription.id, addDays(now, 7), 1);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().subscription.pauses).toEqual([
      expect.objectContaining({ startsOn: addDays(now, 7), endsOn: addDays(now, 14), weeks: 1, status: 'upcoming' }),
    ]);
  });

  it('offers the earliest day, the weeks left, the credit per visit and the visit times', async () => {
    const subscription = await subscribe();
    const now = await today();
    const result = await options(subscription.id);
    const year = Number(now.slice(0, 4));
    expect(result).toMatchObject({
      reason: null,
      noticeDays: 7,
      maxPauseWeeks: 4,
      weeksLeftThisYear: 4,
      visitCreditCents: VISIT_VALUE,
      latestStartOn: `${year + 1}-12-31`,
    });
    expect(result.weeksLeft[String(year + 1)]).toBe(4);
    expect(result.earliestStartOn).toBe(addDays(now, 7));
    // Every visit time is a Tuesday on or after the earliest day.
    const first = await midnight(result.earliestStartOn);
    expect(result.visitStarts.length).toBeGreaterThan(40);
    expect(result.visitStarts.every((s: string) => new Date(s).getTime() >= first)).toBe(true);
    const weekdays = new Set(
      result.visitStarts.map((s: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', weekday: 'short' }).format(new Date(s))),
    );
    expect([...weekdays]).toEqual(['Tue']);
  });

  it('calls off the visits inside, leaves the others, credits them and tells the customer and the pro', async () => {
    const subscription = await subscribe();
    const startsOn = mondayFrom(addDays(await today(), 7));
    const from = await midnight(startsOn);
    const to = await midnight(addDays(startsOn, 7));
    const inside = subscription.visits.filter((v) => new Date(v.startsAt).getTime() >= from && new Date(v.startsAt).getTime() < to);
    expect(inside).toHaveLength(1);

    const response = await pause(subscription.id, startsOn, 1);
    expect(response.statusCode).toBe(200);
    const after = response.json().subscription;
    const [made] = after.pauses;
    expect(made).toMatchObject({ weeks: 1, status: 'upcoming', visitsCalledOff: 1, visitCreditCents: VISIT_VALUE, creditCents: VISIT_VALUE });
    for (const visit of after.visits as Visit[]) {
      const isInside = visit.id === inside[0]?.id;
      expect(visit.status).toBe(isInside ? 'cancelled' : 'planned');
      expect(visit.pausedBy).toBe(isInside ? made.id : null);
    }

    // The credit comes off the customer's next bill.
    const user = await t.pool.query<{ id: string; stripe_customer_id: string }>("SELECT id, stripe_customer_id FROM users WHERE phone = '+4915100000001'");
    expect(t.fake.balance).toEqual([
      expect.objectContaining({ kind: 'credit', customerRef: user.rows[0]?.stripe_customer_id, amountCents: VISIT_VALUE, idempotencyKey: `pause-credit-${made.id}` }),
    ]);
    const stored = await t.pool.query('SELECT credit_cents, credit_ref FROM subscription_pauses');
    expect(stored.rows).toEqual([{ credit_cents: VISIT_VALUE, credit_ref: t.fake.balance[0]?.id }]);

    const customerTold = await inbox('plan_paused');
    expect(customerTold.find((m) => m.user_id === user.rows[0]?.id)?.body).toMatch(
      /^MISK: your Lawn care is paused from \w{3} \d+ \w{3} to \w{3} \d+ \w{3}\. €14\.88 is credited to your next bill\.$/,
    );
    const proTold = customerTold.find((m) => m.user_id === pro.proId);
    expect(proTold?.body).toMatch(/Sara paused the Lawn care plan from .+ These visits are called off: Tue \d+ \w{3}, 08:00\./);
    const sms = await t.pool.query("SELECT 1 FROM notifications WHERE kind = 'plan_paused' AND user_id = $1 AND channel = 'sms'", [pro.proId]);
    expect(sms.rowCount).toBe(0);

    // The pro's schedule no longer has the visit.
    const until = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const proVisits = (await call(t, 'GET', `/pro/visits?to=${encodeURIComponent(until)}`, { cookie: pro.cookie })).json().visits as Visit[];
    expect(proVisits.map((v) => v.id)).not.toContain(inside[0]?.id);
  });

  it('withdraws a request to move a paused visit', async () => {
    const subscription = await subscribe();
    const startsOn = mondayFrom(addDays(await today(), 7));
    const from = await midnight(startsOn);
    const visit = subscription.visits.find((v) => new Date(v.startsAt).getTime() >= from);
    const choices = (await call(t, 'GET', `/subscriptions/${subscription.id}/visits/${visit?.id}/move-options`, { cookie: customer })).json();
    const asked = await call(t, 'POST', `/subscriptions/${subscription.id}/visits/${visit?.id}/move`, {
      cookie: customer,
      body: { startsAt: choices.options[0].startsAt },
    });
    expect(asked.statusCode).toBe(200);
    expect((await pause(subscription.id, startsOn, 1)).statusCode).toBe(200);
    expect((await t.pool.query('SELECT status FROM subscription_visit_moves')).rows).toEqual([{ status: 'withdrawn' }]);
    expect((await call(t, 'GET', '/pro/visit-moves', { cookie: pro.cookie })).json().moves).toEqual([]);
  });

  it('never plans a visit inside the pause again', async () => {
    const subscription = await subscribe();
    const startsOn = mondayFrom(addDays(await today(), 7));
    const made = (await pause(subscription.id, startsOn, 2)).json().subscription.pauses[0];
    expect(made.visitsCalledOff).toBe(2);
    // Even with the called-off visits gone, the planner leaves the paused weeks empty.
    await t.pool.query('DELETE FROM subscription_visits WHERE paused_by = $1', [made.id]);
    await subscriptionTick(t.deps);
    const inside = await t.pool.query(
      `SELECT 1 FROM subscription_visits v, subscription_pauses pz
       WHERE pz.id = $1 AND v.status IN ('pending', 'planned') AND v.starts_at >= pz.starts_at AND v.starts_at < pz.ends_at`,
      [made.id],
    );
    expect(inside.rowCount).toBe(0);
    const outside = await t.pool.query("SELECT count(*)::int AS n FROM subscription_visits WHERE status = 'planned'");
    expect(outside.rows[0].n).toBeGreaterThan(0);
  });

  it('counts the weeks per calendar year and allows one pause at a time', async () => {
    const subscription = await subscribe();
    const next = Number((await today()).slice(0, 4)) + 1;
    const first = mondayFrom(`${next}-03-01`);
    const one = await pause(subscription.id, first, 2);
    expect(one.statusCode).toBe(200);
    // Past the planning window the times the planner would plan are called off too: two Tuesdays.
    expect(one.json().subscription.pauses[0]).toMatchObject({ visitsCalledOff: 2, creditCents: 2 * VISIT_VALUE });
    expect((await pause(subscription.id, mondayFrom(`${next}-06-01`), 1)).json()).toEqual({ error: 'pause_already_planned' });
    expect((await options(subscription.id)).reason).toBe('pause_already_planned');

    await finishPause(one.json().subscription.pauses[0].id, 4);
    expect((await options(subscription.id)).weeksLeft[String(next)]).toBe(2);
    // Up to the limit is fine, one week over it is not.
    expect((await pause(subscription.id, mondayFrom(`${next}-06-01`), 3)).json()).toEqual({ error: 'pause_allowance' });
    const two = await pause(subscription.id, mondayFrom(`${next}-06-01`), 2);
    expect(two.statusCode).toBe(200);
    await finishPause(two.json().subscription.pauses[0].id, 1);
    expect((await pause(subscription.id, mondayFrom(`${next}-09-01`), 1)).json()).toEqual({ error: 'pause_allowance' });
    // This year's weeks are separate.
    expect((await options(subscription.id)).weeksLeftThisYear).toBe(4);
    expect((await pause(subscription.id, `${next + 1}-01-04`, 1)).json()).toEqual({ error: 'pause_too_far' });
  });

  it('refuses every pause on a plan with 0 paused weeks, and says so in the options (D85)', async () => {
    await t.pool.query('UPDATE plans SET max_pause_weeks = 0');
    const subscription = await subscribe();
    expect((await load(subscription.id)).maxPauseWeeks).toBe(0);
    const result = await options(subscription.id);
    expect(result).toMatchObject({ reason: 'pauses_not_allowed', maxPauseWeeks: 0, earliestStartOn: null });
    const response = await pause(subscription.id, addDays(await today(), 14), 1);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'pauses_not_allowed' });
    const stored = await t.pool.query('SELECT count(*)::int AS n FROM subscription_pauses');
    expect(stored.rows[0].n).toBe(0);
  });

  it('keeps the terms a plan was subscribed with when an admin later sets 0 weeks (D85)', async () => {
    const subscription = await subscribe();
    const now = await today();
    const planned = await pause(subscription.id, addDays(now, 14), 1);
    expect(planned.statusCode).toBe(200);
    await t.pool.query('UPDATE plans SET max_pause_weeks = 0');
    // The planned pause stays and the plan itself still pauses: it follows its own copied terms.
    expect((await load(subscription.id)).pauses).toHaveLength(1);
    expect((await options(subscription.id)).maxPauseWeeks).toBe(4);
    // Only a plan whose own terms say 0 refuses new requests.
    await t.pool.query('UPDATE subscriptions SET max_pause_weeks = 0');
    await callOff(subscription.id, planned.json().subscription.pauses[0].id);
    expect((await pause(subscription.id, addDays(now, 21), 1)).json()).toEqual({ error: 'pauses_not_allowed' });
    expect((await load(subscription.id)).pauses.filter((p: { status: string }) => p.status === 'upcoming')).toHaveLength(0);
  });

  it('accepts a pause that starts today when the notice is 0 days (D85)', async () => {
    await t.pool.query('UPDATE plans SET pause_notice_days = 0');
    const subscription = await subscribe();
    const now = await today();
    expect((await options(subscription.id)).earliestStartOn).toBe(now);
    expect((await pause(subscription.id, now, 1)).statusCode).toBe(200);
    // The copied terms have the same limits as the plan's.
    await expect(t.pool.query('UPDATE subscriptions SET max_pause_weeks = 9')).rejects.toThrow();
    await expect(t.pool.query('UPDATE subscriptions SET pause_notice_days = 31')).rejects.toThrow();
    await t.pool.query('UPDATE subscriptions SET max_pause_weeks = 0, pause_notice_days = 0');
  });

  it('creates nothing when the credit fails', async () => {
    const subscription = await subscribe();
    const before = await t.pool.query('SELECT id, status, paused_by FROM subscription_visits ORDER BY starts_at');
    t.fake.failures.add('credit');
    const response = await pause(subscription.id, mondayFrom(addDays(await today(), 7)), 2);
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: 'pause_credit_failed' });
    expect((await t.pool.query('SELECT 1 FROM subscription_pauses')).rowCount).toBe(0);
    expect((await t.pool.query('SELECT id, status, paused_by FROM subscription_visits ORDER BY starts_at')).rows).toEqual(before.rows);
    expect(await inbox('plan_paused')).toEqual([]);
    expect(t.fake.balance).toEqual([]);
  });

  it('refuses a plan that is not active', async () => {
    const subscription = await subscribe();
    await t.pool.query("UPDATE subscriptions SET status = 'cancelled', ends_at = now()");
    expect((await pause(subscription.id, mondayFrom(addDays(await today(), 7)), 1)).json()).toEqual({ error: 'pause_not_possible' });
    expect(await options(subscription.id)).toMatchObject({ reason: 'not_active', earliestStartOn: null });
    const other = await signIn(t, '+4915100000002', 'customer');
    expect((await call(t, 'GET', `/subscriptions/${subscription.id}/pause-options`, { cookie: other })).statusCode).toBe(404);
  });

  it('must end by the end of a cancelled plan during its notice', async () => {
    const subscription = await subscribe();
    await t.pool.query("UPDATE subscriptions SET billing_starts_at = now() - interval '4 months'");
    expect((await call(t, 'POST', `/subscriptions/${subscription.id}/cancel`, { cookie: customer })).statusCode).toBe(200);
    const startsOn = mondayFrom(addDays(await today(), 7));
    expect((await pause(subscription.id, startsOn, 4)).json()).toEqual({ error: 'pause_after_end' });
    const result = await options(subscription.id);
    const endsOn = (await t.pool.query<{ d: string }>("SELECT to_char((ends_at AT TIME ZONE 'Europe/Berlin')::date, 'YYYY-MM-DD') AS d FROM subscriptions")).rows[0]?.d ?? '';
    expect(result).toMatchObject({ reason: null, latestStartOn: addDays(endsOn, -7), latestEndOn: endsOn });
    expect((await pause(subscription.id, startsOn, 1)).statusCode).toBe(200);
  });

  it('takes back the credit for paused visits after the end when the plan is cancelled later', async () => {
    const subscription = await subscribe();
    const startsOn = mondayFrom(addDays(await today(), 24));
    const made = (await pause(subscription.id, startsOn, 2)).json().subscription.pauses[0];
    expect(made.visitsCalledOff).toBe(2);
    await t.pool.query("UPDATE subscriptions SET billing_starts_at = now() - interval '4 months'");
    await call(t, 'POST', `/subscriptions/${subscription.id}/cancel`, { cookie: customer });
    const afterEnd = await t.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM subscription_visits v JOIN subscriptions s ON s.id = v.subscription_id
       WHERE v.paused_by = $1 AND v.ends_at > s.ends_at`,
      [made.id],
    );
    const n = afterEnd.rows[0]?.n ?? 0;
    expect(n).toBeGreaterThanOrEqual(1);
    expect(t.fake.balance.filter((c) => c.kind === 'reversal').map((c) => c.amountCents)).toEqual([n * VISIT_VALUE]);
    // Running it again changes nothing.
    expect(await settlePausesAfterPlanEnd(t.deps)).toBe(0);
    expect(t.fake.balance.filter((c) => c.kind === 'reversal')).toHaveLength(1);

    // Keep my plan (D90): the plan goes on, so the credit taken back is given again, once.
    expect((await call(t, 'POST', `/subscriptions/${subscription.id}/keep`, { cookie: customer })).statusCode).toBe(200);
    expect(t.fake.balance.map((c) => [c.kind, c.amountCents])).toEqual([
      ['credit', 2 * VISIT_VALUE],
      ['reversal', n * VISIT_VALUE],
      ['credit', n * VISIT_VALUE],
    ]);
    expect(await settlePausesAfterPlanEnd(t.deps)).toBe(0);
    expect((await t.pool.query('SELECT reversed_cents FROM subscription_pauses')).rows).toEqual([{ reversed_cents: 0 }]);
    // Cancelling again takes it back again, as a new change.
    await call(t, 'POST', `/subscriptions/${subscription.id}/cancel`, { cookie: customer });
    expect(t.fake.balance.filter((c) => c.kind === 'reversal').map((c) => c.amountCents)).toEqual([n * VISIT_VALUE, n * VISIT_VALUE]);
  });

  it('pays the pro nothing for a month fully covered by credit', async () => {
    await subscribe();
    const stripeId = [...t.fake.subscriptions.keys()][0] ?? '';
    await recordPaidMonth(t.deps, { subscriptionId: stripeId, invoiceId: 'in_zero', amountCents: 0, periodEnd: new Date(Date.now() + 60 * 24 * 3600 * 1000) });
    expect((await t.pool.query("SELECT 1 FROM subscription_payouts WHERE invoice_id = 'in_zero'")).rowCount).toBe(0);
  });
});

describe('calling off a pause (D78)', () => {
  it('brings back the visits whose pro is still free, keeps the others and takes back their credit', async () => {
    const subscription = await subscribe();
    const startsOn = mondayFrom(addDays(await today(), 7));
    const made = (await pause(subscription.id, startsOn, 2)).json().subscription.pauses[0];
    const paused = (await t.pool.query<{ id: string; starts_at: Date }>('SELECT id, starts_at FROM subscription_visits WHERE paused_by = $1 ORDER BY starts_at', [made.id]))
      .rows;
    expect(paused).toHaveLength(2);
    const [free, busy] = paused;
    // The pro takes other work overlapping the second visit meanwhile.
    await t.pool.query(
      `INSERT INTO subscription_visits (subscription_id, pro_id, starts_at, ends_at, status)
       VALUES ($1, $2, $3::timestamptz + interval '30 minutes', $3::timestamptz + interval '90 minutes', 'planned')`,
      [subscription.id, pro.proId, busy?.starts_at],
    );
    const year = startsOn.slice(0, 4);
    const left = (await options(subscription.id)).weeksLeft[year];

    const response = await callOff(subscription.id, made.id);
    expect(response.statusCode).toBe(200);
    const after = response.json().subscription;
    const byId = new Map((after.visits as Visit[]).map((v) => [v.id, v]));
    expect(byId.get(free?.id ?? '')).toMatchObject({ status: 'planned', pausedBy: null });
    expect(byId.get(busy?.id ?? '')).toMatchObject({ status: 'cancelled', pausedBy: null });
    expect(after.pauses[0]).toMatchObject({ status: 'withdrawn', visitsRestored: 1, reversedCents: VISIT_VALUE, creditCents: 2 * VISIT_VALUE });
    expect(t.fake.balance.map((c) => [c.kind, c.amountCents])).toEqual([
      ['credit', 2 * VISIT_VALUE],
      ['reversal', VISIT_VALUE],
    ]);

    const customerTold = (await inbox('plan_pause_called_off')).filter((m) => m.user_id !== pro.proId);
    expect(customerTold[0]?.body).toMatch(/the pause of your Lawn care is called off\. Your pro is not free on Tue \d+ \w{3}, 08:00, so this visit stays cancelled and credited\. €14\.88 of the credit is taken back for the visits that take place\.$/);
    const proTold = (await inbox('plan_pause_called_off')).filter((m) => m.user_id === pro.proId);
    expect(proTold).toHaveLength(1);
    expect(proTold[0]?.body).toMatch(/Sara called off the pause of the Lawn care plan\. These visits are back: Tue \d+ \w{3}, 08:00\.$/);

    // The weeks count again, and the plan can be paused anew.
    expect((await options(subscription.id)).weeksLeft[year]).toBe((left ?? 0) + 2);
    expect((await callOff(subscription.id, made.id)).json()).toEqual({ error: 'pause_withdrawn' });
  });

  it('is refused once the pause has started', async () => {
    const subscription = await subscribe();
    const made = (await pause(subscription.id, mondayFrom(addDays(await today(), 7)), 1)).json().subscription.pauses[0];
    await t.pool.query("UPDATE subscription_pauses SET starts_at = now() - interval '1 hour'");
    expect((await callOff(subscription.id, made.id)).json()).toEqual({ error: 'pause_started' });
    expect((await load(subscription.id)).pauses[0].status).toBe('running');
    expect(t.fake.balance.filter((c) => c.kind === 'reversal')).toEqual([]);
  });
});
