import {
  approvedPro,
  call,
  createTestContext,
  resetDatabase,
  seedMarket,
  signIn,
  signInAdmin,
  TIMEZONE,
  type Market,
  type TestContext,
} from '../../test/helpers.js';
import { dispatchTick } from '../bookings/dispatch.js';
import { pdfString } from '../bookings/pdf.js';
import { nextPayoutDate } from '../payments/payouts.js';
import { addDays, marketToday } from './checks.js';
import { paySubscriptionPayouts, recordPaidMonth } from '../subscriptions/service.js';
import { queueStandInPayouts } from '../subscriptions/stand-ins.js';
import { recordBankPayouts } from './earnings.js';
import { MAX_DAYS_OFF } from './working-hours.js';

/** D99: the pro Week, Availability and Earnings pages. */

let t: TestContext;
let market: Market;
let customer: string;
let customerId: string;
let planId: string;

beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(async () => {
  await resetDatabase(t.pool);
  t.fake.reset();
  market = await seedMarket(t.pool);
  customer = await signIn(t, '+4915100000001', 'customer', 'Sara');
  customerId = (await t.pool.query<{ id: string }>("SELECT id FROM users WHERE phone = '+4915100000001'")).rows[0]?.id ?? '';
  const admin = await signInAdmin(t);
  const plan = await call(t, 'POST', '/admin/plans', {
    cookie: admin,
    body: {
      name: 'Lawn care',
      categoryId: market.gardening,
      priceCents: 4300,
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
});

const get = (url: string, cookie: string) => call(t, 'GET', url, { cookie });
const post = (url: string, cookie: string, body?: unknown) => call(t, 'POST', url, { cookie, ...(body === undefined ? {} : { body }) });
const put = (url: string, cookie: string, body: unknown) => call(t, 'PUT', url, { cookie, body });
const del = (url: string, cookie: string) => call(t, 'DELETE', url, { cookie });

const daniel = () => approvedPro(t, '+4915100000101', { trades: [market.gardening], firstName: 'Daniel' });
const leon = () => approvedPro(t, '+4915100000102', { trades: [market.gardening], firstName: 'Leon' });

const today = () => marketToday(TIMEZONE);
/** The local day of a moment in the market, "YYYY-MM-DD". */
const localDay = (iso: string | Date) => marketToday(TIMEZONE, new Date(iso));

async function firstFreeSlot(): Promise<string> {
  const slots = (await get(`/availability?serviceId=${market.mowing}&postcode=10115`, customer)).json().slots as { startsAt: string; available: boolean }[];
  const free = slots.find((slot) => slot.available);
  if (!free) throw new Error('No free slot');
  return free.startsAt;
}

async function book(startsAt: string): Promise<string> {
  const created = await post('/bookings', customer, { serviceId: market.mowing, size: 'M', address: '12 Linden Street', postcode: '10115', startsAt });
  expect(created.statusCode).toBe(201);
  return created.json().booking.id as string;
}

const pendingOfferPros = async (bookingId: string) =>
  (await t.pool.query<{ pro_id: string }>("SELECT pro_id FROM booking_offers WHERE booking_id = $1 AND status = 'pending'", [bookingId])).rows.map((r) => r.pro_id);

/** An active plan of the customer with `proId` as regular pro, and one planned visit at 10:00 local on `day`. */
async function planVisit(proId: string, day: string): Promise<{ subscriptionId: string; visitId: string }> {
  const sub = await t.pool.query<{ id: string }>(
    `INSERT INTO subscriptions (customer_id, plan_id, category_id, plan_name, tasks, size, frequency, days, time_window, visit_minutes,
       address, postcode, with_addon, price_cents, pro_share_pct, seasonal, skips_per_month, min_term_months, pro_id, status, started_at)
     VALUES ($1, $2, $3, 'Lawn care', '{Mow,Edge}', 'M', 'weekly', '{2}', 'morning', 60, '12 Linden Street', '10115', false, 4300, 70,
       false, 2, 3, $4, 'active', now()) RETURNING id`,
    [customerId, planId, market.gardening, proId],
  );
  const subscriptionId = sub.rows[0]?.id ?? '';
  const visit = await t.pool.query<{ id: string }>(
    `INSERT INTO subscription_visits (subscription_id, pro_id, starts_at, ends_at, status)
     SELECT $1, $2, at, at + interval '1 hour', 'planned' FROM (SELECT ($3::date + time '10:00') AT TIME ZONE $4 AS at) x RETURNING id`,
    [subscriptionId, proId, day, TIMEZONE],
  );
  return { subscriptionId, visitId: visit.rows[0]?.id ?? '' };
}

const notificationsOf = async (userId: string, kind: string) =>
  (await t.pool.query<{ body: string }>('SELECT body FROM notifications WHERE user_id = $1 AND kind = $2 ORDER BY id', [userId, kind])).rows.map((r) => r.body);

describe('days off (D99)', () => {
  it('adds, lists and removes single days off, from today on, once each and at most 60', async () => {
    const pro = await daniel();
    const other = await leon();
    const day = addDays(today(), 10);
    const added = await post('/pro/days-off', pro.cookie, { day });
    expect(added.statusCode).toBe(201);
    const [entry] = added.json().availability.daysOff as { id: string; day: string }[];
    expect(entry).toMatchObject({ day });

    expect((await post('/pro/days-off', pro.cookie, { day })).json()).toEqual({ error: 'day_off_exists' });
    expect((await post('/pro/days-off', pro.cookie, { day: addDays(today(), -1) })).json()).toEqual({ error: 'day_off_invalid' });
    expect((await post('/pro/days-off', pro.cookie, { day: addDays(today(), 400) })).json()).toEqual({ error: 'day_off_invalid' });
    expect((await post('/pro/days-off', pro.cookie, { day: 'tomorrow' })).statusCode).toBe(400);

    // Only the pro's own days off can be removed.
    expect((await del(`/pro/days-off/${entry?.id}`, other.cookie)).statusCode).toBe(404);
    const removed = await del(`/pro/days-off/${entry?.id}`, pro.cookie);
    expect(removed.statusCode).toBe(200);
    expect(removed.json().availability.daysOff).toEqual([]);

    await t.pool.query(
      'INSERT INTO pro_days_off (pro_id, day) SELECT $1, $2::date + n FROM generate_series(1, $3) AS n',
      [pro.proId, today(), MAX_DAYS_OFF],
    );
    expect((await post('/pro/days-off', pro.cookie, { day: addDays(today(), MAX_DAYS_OFF + 5) })).json()).toEqual({ error: 'too_many_days_off' });
  });

  it('makes the pro offline today with the reason "day off"', async () => {
    const pro = await daniel();
    const availability = (await post('/pro/days-off', pro.cookie, { day: today() })).json().availability;
    expect(availability).toMatchObject({ onlineNow: false, autoOffline: { reason: 'day_off', until: null } });
  });

  it('offers no job for a day off: the job goes to a pro who works that day', async () => {
    const first = await daniel();
    const second = await leon();
    const startsAt = await firstFreeSlot();
    expect((await post('/pro/days-off', first.cookie, { day: localDay(startsAt) })).statusCode).toBe(201);
    const bookingId = await book(startsAt);
    await dispatchTick(t.deps);
    expect(await pendingOfferPros(bookingId)).toEqual([second.proId]);
    expect((await get('/pro/offers', first.cookie)).json().offers).toEqual([]);
  });

  it('offers no job during a holiday, and "I\'m going on holiday" off ends every coming holiday', async () => {
    const first = await daniel();
    const second = await leon();
    const startsAt = await firstFreeSlot();
    const holiday = await post('/pro/holidays', first.cookie, { startsOn: localDay(startsAt), endsOn: addDays(localDay(startsAt), 3) });
    expect(holiday.statusCode).toBe(201);
    const bookingId = await book(startsAt);
    await dispatchTick(t.deps);
    expect(await pendingOfferPros(bookingId)).toEqual([second.proId]);

    await post('/pro/holidays', first.cookie, { startsOn: addDays(today(), 30), endsOn: addDays(today(), 32) });
    const cleared = await del('/pro/holidays', first.cookie);
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().availability.holidays).toEqual([]);
  });

  it('keeps accepted jobs when the working hours and days change; only new offers follow them', async () => {
    const pro = await daniel();
    const bookingId = await book(await firstFreeSlot());
    const offer = (await get('/pro/offers', pro.cookie)).json().offers[0] as { id: string };
    expect((await post(`/pro/offers/${offer.id}/accept`, pro.cookie)).statusCode).toBe(200);

    const days = await put('/pro/working-days', pro.cookie, { workingDays: [7, 1] });
    expect(days.json().availability.workingDays).toEqual([1, 7]);
    expect((await put('/pro/working-days', pro.cookie, { workingDays: [] })).statusCode).toBe(400);
    expect((await put('/pro/working-days', pro.cookie, { workingDays: [8] })).statusCode).toBe(400);
    expect((await put('/pro/working-hours', pro.cookie, { workStart: '05:00', workEnd: '06:00' })).statusCode).toBe(200);

    const job = await t.pool.query('SELECT status, pro_id FROM bookings WHERE id = $1', [bookingId]);
    expect(job.rows[0]).toEqual({ status: 'accepted', pro_id: pro.proId });
    const jobs = (await get('/pro/jobs', pro.cookie)).json().jobs as { id: string }[];
    expect(jobs.map((j) => j.id)).toContain(bookingId);
  });

  it('lists an accepted one-off job on a new day off: it stays the pro\'s', async () => {
    const pro = await daniel();
    const startsAt = await firstFreeSlot();
    const bookingId = await book(startsAt);
    const offer = (await get('/pro/offers', pro.cookie)).json().offers[0] as { id: string };
    await post(`/pro/offers/${offer.id}/accept`, pro.cookie);
    const availability = (await post('/pro/days-off', pro.cookie, { day: localDay(startsAt) })).json().availability;
    expect(availability.jobsOnDaysOff).toEqual([expect.objectContaining({ id: bookingId, serviceName: 'Lawn mowing' })]);
    expect((await t.pool.query('SELECT status FROM bookings WHERE id = $1', [bookingId])).rows[0]?.status).toBe('accepted');
  });
});

describe('plan visits on a day off (D99)', () => {
  // Three weeks ahead, so every day of the visit's week is still to come, whatever day the test runs.
  const visitDay = () => addDays(today(), 21);

  it('lists the visit, and the pro moves it to another free day of the same week; the customer is told', async () => {
    const pro = await daniel();
    const { visitId } = await planVisit(pro.proId, visitDay());
    const added = (await post('/pro/days-off', pro.cookie, { day: visitDay() })).json().availability;
    expect(added.visitsOnDaysOff).toEqual([expect.objectContaining({ id: visitId, planName: 'Lawn care', customerName: 'Sara', teamAsked: false })]);

    const days = (await get(`/pro/visits/${visitId}/move-days`, pro.cookie)).json().days as { startsAt: string }[];
    expect(days.length).toBeGreaterThan(0);
    expect(days.every((d) => localDay(d.startsAt) !== visitDay())).toBe(true);

    // Not into the day off itself, nor any time that is not offered.
    const original = (await t.pool.query<{ starts_at: Date }>('SELECT starts_at FROM subscription_visits WHERE id = $1', [visitId])).rows[0]?.starts_at;
    expect((await post(`/pro/visits/${visitId}/move`, pro.cookie, { startsAt: original?.toISOString() })).json()).toEqual({ error: 'day_not_free' });

    const target = days[0]?.startsAt ?? '';
    const moved = await post(`/pro/visits/${visitId}/move`, pro.cookie, { startsAt: target });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().availability.visitsOnDaysOff).toEqual([]);
    const row = await t.pool.query<{ starts_at: Date; moved_from: Date }>('SELECT starts_at, moved_from FROM subscription_visits WHERE id = $1', [visitId]);
    expect(row.rows[0]?.starts_at.toISOString()).toBe(new Date(target).toISOString());
    expect(row.rows[0]?.moved_from.toISOString()).toBe(original?.toISOString());
    expect(await notificationsOf(customerId, 'visit_move_answered')).toEqual([expect.stringContaining('Daniel is off on')]);
  });

  it('gives the visit to a free stand-in, and tells the customer and the stand-in', async () => {
    const pro = await daniel();
    const standIn = await leon();
    const { visitId } = await planVisit(pro.proId, visitDay());
    await post('/pro/days-off', pro.cookie, { day: visitDay() });

    const handed = await post(`/pro/visits/${visitId}/hand-over`, pro.cookie);
    expect(handed.statusCode).toBe(200);
    expect(handed.json()).toMatchObject({ outcome: 'reassigned', standInName: 'Leon', availability: { visitsOnDaysOff: [] } });
    const row = await t.pool.query('SELECT pro_id, stand_in_for FROM subscription_visits WHERE id = $1', [visitId]);
    expect(row.rows[0]).toEqual({ pro_id: standIn.proId, stand_in_for: pro.proId });
    // The plan keeps its regular pro.
    expect((await t.pool.query('SELECT pro_id FROM subscriptions')).rows[0]?.pro_id).toBe(pro.proId);
    expect(await notificationsOf(customerId, 'plan_pro_changed')).toEqual([expect.stringContaining('Leon, a verified MISK pro')]);
    expect(await notificationsOf(standIn.proId, 'plan_pro_changed')).toEqual([expect.stringContaining('standing in for another pro')]);
    // The stand-in sees it in their week; the regular pro no longer can act on it.
    const range = `from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 30 * 86_400_000).toISOString())}`;
    expect(((await get(`/pro/visits?${range}`, standIn.cookie)).json().visits as { id: string }[]).map((v) => v.id)).toEqual([visitId]);
    expect((await post(`/pro/visits/${visitId}/hand-over`, pro.cookie)).statusCode).toBe(404);
  });

  it('asks the team under Needs action when no stand-in is free, until the day off is removed', async () => {
    const pro = await daniel();
    const { visitId } = await planVisit(pro.proId, visitDay());
    const dayOff = (await post('/pro/days-off', pro.cookie, { day: visitDay() })).json().availability.daysOff[0] as { id: string };

    const handed = (await post(`/pro/visits/${visitId}/hand-over`, pro.cookie)).json();
    expect(handed).toMatchObject({ outcome: 'team_asked', availability: { visitsOnDaysOff: [expect.objectContaining({ id: visitId, teamAsked: true })] } });
    const admin = await signInAdmin(t);
    const listed = (await get('/admin/bookings?tab=needs_action', admin)).json().bookings as { id: string; alerts: { key: string }[] }[];
    expect(listed.find((item) => item.id === visitId)?.alerts).toEqual([{ level: 'problem', key: 'standInNeeded' }]);

    await del(`/pro/days-off/${dayOff.id}`, pro.cookie);
    const after = (await get('/admin/bookings?tab=needs_action', admin)).json().bookings as { id: string }[];
    expect(after.some((item) => item.id === visitId)).toBe(false);
  });

  it('refuses visits that are not on a day off, and visits of other pros', async () => {
    const pro = await daniel();
    const other = await leon();
    const { visitId } = await planVisit(pro.proId, visitDay());
    expect((await post(`/pro/visits/${visitId}/hand-over`, pro.cookie)).json()).toEqual({ error: 'visit_not_on_day_off' });
    expect((await get(`/pro/visits/${visitId}/move-days`, pro.cookie)).json()).toEqual({ error: 'visit_not_on_day_off' });
    await post('/pro/days-off', pro.cookie, { day: visitDay() });
    expect((await post(`/pro/visits/${visitId}/hand-over`, other.cookie)).statusCode).toBe(404);
    expect((await get(`/pro/visits/${visitId}/move-days`, other.cookie)).statusCode).toBe(404);
  });

  it('covers holidays the same way', async () => {
    const pro = await daniel();
    const { visitId } = await planVisit(pro.proId, visitDay());
    const holiday = (await post('/pro/holidays', pro.cookie, { startsOn: addDays(visitDay(), -1), endsOn: addDays(visitDay(), 1) })).json();
    expect(holiday.availability.visitsOnDaysOff).toEqual([expect.objectContaining({ id: visitId })]);
  });
});

describe('earnings (D99)', () => {
  let seq = 0;
  /** A one-off job of the pro, finished `hoursAgo` hours ago, with the money in the given state. */
  async function job(
    proId: string,
    options: {
      hoursAgo: number;
      payment?: string;
      problem?: boolean;
      payout?: 'none' | 'sent' | 'paid' | 'reversed';
      priceCents?: number;
      sharePct?: number;
      service?: string;
    },
  ): Promise<string> {
    seq += 1;
    const intent = `pi_test_${seq}`;
    const price = options.priceCents ?? 5000;
    const pct = options.sharePct ?? 82;
    const created = await t.pool.query<{ id: string }>(
      `INSERT INTO bookings (customer_id, service_id, category_id, service_name, size, address, postcode, starts_at, ends_at, status,
         price_cents, fee_cents, pro_share_pct, pro_id, completed_at, payment_intent_id, payment_status, problem_reported_at)
       VALUES ($1, $2, $3, $4, 'M', '12 Linden Street', '10115', now() - make_interval(hours => $5 + 1), now() - make_interval(hours => $5),
         'completed', $6, 290, $7, $8, now() - make_interval(hours => $5), $9, $10, CASE WHEN $11 THEN now() END) RETURNING id`,
      [customerId, market.hedge, market.gardening, options.service ?? 'Hedge trimming', options.hoursAgo, price, pct, proId, intent,
        options.payment ?? 'held', options.problem ?? false],
    );
    const id = created.rows[0]?.id ?? '';
    if (options.payout && options.payout !== 'none') {
      const payout = await t.pool.query<{ id: string }>(
        `INSERT INTO payouts (booking_id, pro_id, payment_intent_id, charge_id, amount_cents, status, transfer_id)
         VALUES ($1, $2, $3, 'ch_x', $4, $5, 'tr_x') RETURNING id`,
        [id, proId, intent, Math.floor((price * pct) / 100), options.payout === 'reversed' ? 'reversed' : 'sent'],
      );
      if (options.payout === 'paid') {
        const bank = await t.pool.query<{ id: string }>(
          `INSERT INTO pro_bank_payouts (pro_id, paid_on, amount_cents, bank_last4) VALUES ($1, $2, $3, '3000')
           ON CONFLICT (pro_id, paid_on) DO UPDATE SET amount_cents = pro_bank_payouts.amount_cents + EXCLUDED.amount_cents RETURNING id`,
          [proId, today(), Math.floor((price * pct) / 100)],
        );
        await t.pool.query('UPDATE payouts SET bank_payout_id = $2 WHERE id = $1', [payout.rows[0]?.id, bank.rows[0]?.id]);
      }
    }
    return id;
  }

  /** A finished plan visit `hoursAgo` hours ago: €43 a month at 70% over 4.3 visits = €7.00 a visit. */
  async function doneVisit(proId: string, hoursAgo: number): Promise<string> {
    const { visitId } = await planVisit(proId, addDays(today(), 40 + seq++));
    await t.pool.query(
      `UPDATE subscription_visits SET status = 'completed', starts_at = now() - make_interval(hours => $2 + 1),
         ends_at = now() - make_interval(hours => $2), completed_at = now() - make_interval(hours => $2) WHERE id = $1`,
      [visitId, hoursAgo],
    );
    return visitId;
  }

  type Item = { id: string; status: string; youGetCents: number; kind: string; customerName: string; breakdown: unknown };
  const earnings = async (cookie: string, query = '') => (await get(`/pro/earnings${query}`, cookie)).json();

  it('marks each job Pending, On hold, Ready or Paid, totals them and breaks one-off jobs down from stored values', async () => {
    const pro = await daniel();
    const pending = await job(pro.proId, { hoursAgo: 2 });
    await t.pool.query(
      "INSERT INTO extra_requests (booking_id, description, price_cents, status, payment_status) VALUES ($1, 'Extra 30 minutes of work', 1000, 'approved', 'held')",
      [pending],
    );
    await t.pool.query("INSERT INTO tips (booking_id, amount_cents, pro_share_pct, pro_cents, status) VALUES ($1, 500, 82, 410, 'captured')", [pending]);
    const onHold = await job(pro.proId, { hoursAgo: 30, problem: true });
    const ready = await job(pro.proId, { hoursAgo: 50, payment: 'captured', payout: 'sent', priceCents: 3000 });
    const paid = await job(pro.proId, { hoursAgo: 200, payment: 'captured', payout: 'paid', priceCents: 4000 });
    await job(pro.proId, { hoursAgo: 60, payment: 'refunded', payout: 'reversed' });
    const visitPending = await doneVisit(pro.proId, 3);
    const visitReady = await doneVisit(pro.proId, 48);
    // Changing the commission now never changes past jobs.
    await t.pool.query('UPDATE settings SET pro_share_pct = 70');

    const all = await earnings(pro.cookie);
    const byId = new Map((all.items as Item[]).map((item) => [item.id, item]));
    expect(all.items).toHaveLength(6);
    expect(byId.get(pending)).toMatchObject({
      kind: 'job',
      status: 'pending',
      customerName: 'Sara',
      youGetCents: 4100 + 820 + 410,
      breakdown: {
        type: 'job',
        lines: [
          { kind: 'job', label: 'Hedge trimming', cents: 5000 },
          { kind: 'extra', label: 'Extra 30 minutes of work', cents: 1000 },
        ],
        commissionPct: 18,
        commissionCents: 6000 - 4100 - 820,
        tipCents: 410,
      },
    });
    expect(byId.get(onHold)).toMatchObject({ status: 'on_hold', youGetCents: 4100 });
    expect(byId.get(ready)).toMatchObject({ status: 'ready', youGetCents: 2460 });
    expect(byId.get(paid)).toMatchObject({ status: 'paid', youGetCents: 3280 });
    expect(byId.get(visitPending)).toMatchObject({ kind: 'visit', status: 'pending', youGetCents: 700, breakdown: null });
    expect(byId.get(visitReady)).toMatchObject({ kind: 'visit', status: 'ready', youGetCents: 700 });
    expect(all.summary).toMatchObject({
      readyCents: 2460 + 700,
      pendingCents: 5330 + 4100 + 700,
      paidThisMonthCents: 3280,
      interval: 'weekly',
      nextPayoutOn: nextPayoutDate('weekly', today()),
      bankLast4: '3000',
    });
    expect(all.payouts).toEqual([{ id: expect.any(String), paidOn: today(), amountCents: 3280, bankLast4: '3000' }]);

    const ids = (items: Item[]) => items.map((item) => item.id).sort();
    expect(ids((await earnings(pro.cookie, '?status=pending')).items)).toEqual([pending, onHold, visitPending].sort());
    expect(ids((await earnings(pro.cookie, '?status=ready')).items)).toEqual([ready, visitReady].sort());
    expect(ids((await earnings(pro.cookie, '?status=paid')).items)).toEqual([paid]);
    expect((await get('/pro/earnings?status=refunded', pro.cookie)).statusCode).toBe(400);

    const firstPage = await earnings(pro.cookie, '?limit=4');
    expect(firstPage).toMatchObject({ hasMore: true });
    expect(firstPage.items).toHaveLength(4);
    expect((await earnings(pro.cookie, '?limit=4&offset=4')).items).toHaveLength(2);

    // Only the pro's own earnings.
    const other = await leon();
    expect((await earnings(other.cookie)).items).toEqual([]);
    expect((await get('/pro/earnings', customer)).statusCode).toBe(403);
  });

  it('records each payout to the bank on the payout day, once, and the jobs and visits in it become Paid', async () => {
    const pro = await daniel();
    const ready = await job(pro.proId, { hoursAgo: 50, payment: 'captured', payout: 'sent', priceCents: 3000 });
    const visit = await doneVisit(pro.proId, 48);
    const friday = nextPayoutDate('weekly', today());
    expect(await recordBankPayouts(t.deps, addDays(friday, 1))).toBe(0);
    expect(await recordBankPayouts(t.deps, friday)).toBe(1);
    expect(await recordBankPayouts(t.deps, friday)).toBe(0);

    const after = await earnings(pro.cookie);
    expect((after.items as Item[]).map((item) => [item.id, item.status]).sort()).toEqual([[ready, 'paid'], [visit, 'paid']].sort());
    expect(after.payouts).toEqual([{ id: expect.any(String), paidOn: friday, amountCents: 2460 + 700, bankLast4: '3000' }]);
    expect(after.summary.readyCents).toBe(0);
  });

  it('downloads a month\'s statement as a PDF with every job, the commission, tips, totals and payouts', async () => {
    const pro = await daniel();
    const paid = await job(pro.proId, { hoursAgo: 200, payment: 'captured', payout: 'paid', priceCents: 4000, service: 'Garden clean-up' });
    await doneVisit(pro.proId, 200);
    const startsAt = (await t.pool.query<{ starts_at: Date }>('SELECT starts_at FROM bookings WHERE id = $1', [paid])).rows[0]?.starts_at ?? new Date();
    const month = localDay(startsAt).slice(0, 7);
    // The payout falls in the same month as the job, whatever day the test runs.
    await t.pool.query('UPDATE pro_bank_payouts SET paid_on = $2 WHERE pro_id = $1', [pro.proId, localDay(startsAt)]);

    const response = await get(`/pro/earnings/statement?month=${month}`, pro.cookie);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-disposition']).toBe(`attachment; filename="misk-statement-${month}.pdf"`);
    const pdf = response.rawPayload.toString('latin1');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    for (const text of ['Garden clean-up', 'Sara', 'Paid', '€40.00', '-€7.20', '€32.80', 'MISK commission 18%', 'Plan visit · fixed payout per visit', 'To •••• 3000']) {
      expect(pdf).toContain(pdfString(text).slice(1, -1));
    }

    // This month by default; never a future or malformed month.
    const current = await get('/pro/earnings/statement', pro.cookie);
    expect(current.headers['content-disposition']).toBe(`attachment; filename="misk-statement-${today().slice(0, 7)}.pdf"`);
    const [year = 0, mon = 0] = today().split('-').map(Number);
    const next = mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, '0')}`;
    expect((await get(`/pro/earnings/statement?month=${next}`, pro.cookie)).json()).toEqual({ error: 'month_invalid' });
    expect((await get('/pro/earnings/statement?month=2026-13', pro.cookie)).statusCode).toBe(400);
    expect((await get('/pro/earnings/statement', customer)).statusCode).toBe(403);
  });
});

describe('stand-in visits pay the stand-in (D99)', () => {
  /** Daniel's plan visit that Leon did as a stand-in, finished `hoursAgo` hours ago. Per visit: €43 × 70% / 4.3 = €7. */
  async function standInVisit(status: 'completed' | 'skipped' | 'cancelled' = 'completed', hoursAgo = 30) {
    const regular = await daniel();
    const standIn = await leon();
    const { subscriptionId, visitId } = await planVisit(regular.proId, addDays(today(), 50));
    await t.pool.query("UPDATE subscriptions SET stripe_subscription_id = 'sub_standin' WHERE id = $1", [subscriptionId]);
    await t.pool.query(
      `UPDATE subscription_visits SET pro_id = $2, stand_in_for = $3, status = $4, starts_at = now() - make_interval(hours => $5 + 1),
         ends_at = now() - make_interval(hours => $5), completed_at = CASE WHEN $4 = 'completed' THEN now() - make_interval(hours => $5) END
       WHERE id = $1`,
      [visitId, standIn.proId, regular.proId, status, hoursAgo],
    );
    return { regular, standIn, subscriptionId, visitId };
  }
  const account = async (proId: string) =>
    (await t.pool.query<{ stripe_account_id: string }>('SELECT stripe_account_id FROM pro_profiles WHERE user_id = $1', [proId])).rows[0]
      ?.stripe_account_id;
  const paidMonth = (invoiceId: string) =>
    recordPaidMonth(t.deps, { subscriptionId: 'sub_standin', invoiceId, amountCents: 4300, periodEnd: new Date(Date.now() + 30 * 86_400_000) });
  const monthly = async (invoiceId: string) =>
    (await t.pool.query('SELECT pro_id, amount_cents, deducted_cents FROM subscription_payouts WHERE invoice_id = $1', [invoiceId])).rows;

  it("pays the stand-in once for the visit and takes it off the regular pro's next monthly payout, once", async () => {
    const { regular, standIn, visitId } = await standInVisit();

    expect(await queueStandInPayouts(t.deps)).toBe(1);
    expect(await queueStandInPayouts(t.deps)).toBe(0);
    await paySubscriptionPayouts(t.deps);
    await paySubscriptionPayouts(t.deps);
    expect(t.fake.transfers).toEqual([expect.objectContaining({ accountId: await account(standIn.proId), amountCents: 700 })]);
    const row = await t.pool.query('SELECT pro_id, amount_cents, status FROM subscription_payouts WHERE visit_id = $1', [visitId]);
    expect(row.rows).toEqual([{ pro_id: standIn.proId, amount_cents: 700, status: 'sent' }]);

    // The next paid month: €43 × 70% = €30.10, minus the €7 visit. The same invoice again changes nothing.
    await paidMonth('in_standin_1');
    await paidMonth('in_standin_1');
    expect(await monthly('in_standin_1')).toEqual([{ pro_id: regular.proId, amount_cents: 2310, deducted_cents: 700 }]);
    const regularAccount = await account(regular.proId);
    expect(t.fake.transfers.filter((tr) => tr.accountId === regularAccount)).toEqual([expect.objectContaining({ amountCents: 2310 })]);
    // A later month is not cut again.
    await paidMonth('in_standin_2');
    expect(await monthly('in_standin_2')).toEqual([{ pro_id: regular.proId, amount_cents: 3010, deducted_cents: 0 }]);
  });

  it('shows the visit to the stand-in with its amount and to the regular pro as done by a stand-in, in lists, totals and statements', async () => {
    const { regular, standIn, visitId } = await standInVisit();
    const standInView = (await get('/pro/earnings', standIn.cookie)).json();
    expect(standInView.items).toEqual([expect.objectContaining({ id: visitId, kind: 'visit', status: 'ready', youGetCents: 700 })]);
    expect(standInView.summary).toMatchObject({ readyCents: 700, pendingCents: 0 });
    const regularView = (await get('/pro/earnings', regular.cookie)).json();
    expect(regularView.items).toEqual([expect.objectContaining({ id: visitId, kind: 'stand_in', status: 'stand_in', youGetCents: 0, breakdown: null })]);
    expect(regularView.summary).toMatchObject({ readyCents: 0, pendingCents: 0 });
    expect((await get('/pro/earnings?status=ready', regular.cookie)).json().items).toEqual([]);

    // Into the stand-in's payout to the bank only once the stand-in's own transfer went out.
    const friday = nextPayoutDate('weekly', today());
    expect(await recordBankPayouts(t.deps, friday)).toBe(0);
    await queueStandInPayouts(t.deps);
    await paySubscriptionPayouts(t.deps);
    expect(await recordBankPayouts(t.deps, friday)).toBe(1);
    expect((await get('/pro/earnings', standIn.cookie)).json().payouts).toEqual([expect.objectContaining({ amountCents: 700 })]);

    const startsAt = (await t.pool.query<{ starts_at: Date }>('SELECT starts_at FROM subscription_visits WHERE id = $1', [visitId])).rows[0]?.starts_at;
    const month = localDay(startsAt ?? new Date()).slice(0, 7);
    const regularPdf = (await get(`/pro/earnings/statement?month=${month}`, regular.cookie)).rawPayload.toString('latin1');
    expect(regularPdf).toContain(pdfString('Done by a stand-in · not paid to you').slice(1, -1));
    expect(regularPdf).not.toContain(pdfString('€7.00').slice(1, -1));
    const standInPdf = (await get(`/pro/earnings/statement?month=${month}`, standIn.cookie)).rawPayload.toString('latin1');
    expect(standInPdf).toContain(pdfString('Plan visit · fixed payout per visit').slice(1, -1));
    expect(standInPdf).toContain(pdfString('€7.00').slice(1, -1));
  });

  it.each(['skipped', 'cancelled'] as const)('pays neither pro for a %s visit (D90 skip, D78 pause credit)', async (status) => {
    const { regular, standIn } = await standInVisit(status);
    expect(await queueStandInPayouts(t.deps)).toBe(0);
    await paidMonth('in_standin_3');
    expect(await monthly('in_standin_3')).toEqual([{ pro_id: regular.proId, amount_cents: 3010, deducted_cents: 0 }]);
    expect((await get('/pro/earnings', standIn.cookie)).json().items).toEqual([]);
    expect((await get('/pro/earnings', regular.cookie)).json().items).toEqual([]);
  });
});

describe('the team assigns a stand-in for one visit (D99)', () => {
  async function visitNeedingStandIn() {
    const regular = await daniel();
    const day = addDays(today(), 21);
    const { visitId } = await planVisit(regular.proId, day);
    await post('/pro/days-off', regular.cookie, { day });
    expect((await post(`/pro/visits/${visitId}/hand-over`, regular.cookie)).json().outcome).toBe('team_asked');
    // A pro who joins later is free then.
    const standIn = await leon();
    return { regular, standIn, visitId };
  }

  it('lists free pros nearby, and confirming makes one the stand-in, tells everyone, logs it and clears Needs action', async () => {
    const { regular, standIn, visitId } = await visitNeedingStandIn();
    const admin = await signInAdmin(t);
    expect((await get(`/admin/visits/${visitId}`, admin)).json().visit).toMatchObject({ standInNeeded: true, standInFor: null });
    const candidates = (await get(`/admin/visits/${visitId}/stand-in-candidates`, admin)).json().candidates;
    expect(candidates).toEqual([{ id: standIn.proId, firstName: 'Leon', distanceKm: 0, ratingAverage: null }]);

    // Only a free candidate can be confirmed.
    expect((await post(`/admin/visits/${visitId}/stand-in`, admin, { proId: regular.proId })).json()).toEqual({ error: 'pro_not_free' });
    const confirmed = await post(`/admin/visits/${visitId}/stand-in`, admin, { proId: standIn.proId });
    expect(confirmed.statusCode).toBe(204);

    const row = await t.pool.query('SELECT pro_id, stand_in_for, handover_requested_at FROM subscription_visits WHERE id = $1', [visitId]);
    expect(row.rows[0]).toEqual({ pro_id: standIn.proId, stand_in_for: regular.proId, handover_requested_at: null });
    expect(await notificationsOf(customerId, 'plan_pro_changed')).toEqual([expect.stringContaining('Leon, a verified MISK pro')]);
    expect(await notificationsOf(standIn.proId, 'plan_pro_changed')).toEqual([expect.stringContaining('standing in for another pro')]);
    expect(await notificationsOf(regular.proId, 'plan_pro_changed')).toEqual([expect.stringContaining('Leon stands in for you')]);
    const logged = await t.pool.query("SELECT area, details->>'name' AS name FROM admin_activity WHERE action = 'visit_stand_in_assigned'");
    expect(logged.rows).toEqual([{ area: 'plans', name: expect.stringMatching(/^Leon · V-\d+$/) }]);
    const needs = (await get('/admin/bookings?tab=needs_action', admin)).json().bookings as { id: string }[];
    expect(needs.some((item) => item.id === visitId)).toBe(false);
    expect((await get(`/admin/visits/${visitId}`, admin)).json().visit).toMatchObject({ standInNeeded: false, standInFor: { firstName: 'Daniel' } });

    // Done: nothing more to assign.
    expect((await post(`/admin/visits/${visitId}/stand-in`, admin, { proId: standIn.proId })).json()).toEqual({ error: 'stand_in_not_needed' });
    expect((await get(`/admin/visits/${visitId}/stand-in-candidates`, admin)).json()).toEqual({ error: 'stand_in_not_needed' });
  });

  it('is refused for a visit that needs no stand-in, and for anyone but the team', async () => {
    const regular = await daniel();
    const standIn = await leon();
    const { visitId } = await planVisit(regular.proId, addDays(today(), 21));
    const admin = await signInAdmin(t);
    expect((await post(`/admin/visits/${visitId}/stand-in`, admin, { proId: standIn.proId })).json()).toEqual({ error: 'stand_in_not_needed' });
    expect((await post(`/admin/visits/${visitId}/stand-in`, regular.cookie, { proId: standIn.proId })).statusCode).toBe(403);
  });
});
