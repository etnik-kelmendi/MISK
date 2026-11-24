import {
  approvedPro,
  call,
  createTestContext,
  FILES,
  resetDatabase,
  seedMarket,
  signIn,
  signInAdmin,
  TIMEZONE,
  upload,
  type Market,
  type TestContext,
} from '../../test/helpers.js';
import { nextPayoutDate } from '../payments/payouts.js';
import { addDays, marketToday } from '../pros/checks.js';
import { dispatchTick } from './dispatch.js';
import { settleTick } from './lifecycle.js';
import { lateWarningTick, NO_SHOW_WAIT_MINUTES } from './on-site.js';

/** D94: the pro Jobs area keeps its promises. */

let t: TestContext;
let market: Market;
let customer: string;

beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(async () => {
  await resetDatabase(t.pool);
  t.fake.reset();
  market = await seedMarket(t.pool);
  customer = await signIn(t, '+4915100000001', 'customer', 'Sara');
});

const get = (url: string, cookie = customer) => call(t, 'GET', url, { cookie });
const post = (url: string, body?: unknown, cookie = customer) => call(t, 'POST', url, { cookie, ...(body === undefined ? {} : { body }) });
const put = (url: string, body: unknown, cookie: string) => call(t, 'PUT', url, { cookie, body });
const del = (url: string, cookie: string) => call(t, 'DELETE', url, { cookie });

async function book() {
  const slots = (await get(`/availability?serviceId=${market.mowing}&postcode=10115`)).json().slots as { startsAt: string; available: boolean }[];
  const free = slots.find((s) => s.available);
  if (!free) throw new Error('No free slot');
  const created = await post('/bookings', { serviceId: market.mowing, size: 'M', address: '12 Linden Street', postcode: '10115', startsAt: free.startsAt });
  expect(created.statusCode).toBe(201);
  return created.json().booking.id as string;
}

const daniel = () => approvedPro(t, '+4915100000101', { trades: [market.gardening], firstName: 'Daniel' });
const leon = () => approvedPro(t, '+4915100000102', { trades: [market.gardening], firstName: 'Leon' });

async function acceptFirstOffer(cookie: string) {
  const offer = (await get('/pro/offers', cookie)).json().offers[0] as { id: string; bookingId: string } | undefined;
  if (!offer) throw new Error('No offer');
  expect((await post(`/pro/offers/${offer.id}/accept`, undefined, cookie)).statusCode).toBe(200);
  return offer.bookingId;
}

async function assignedJob() {
  const pro = await daniel();
  const bookingId = await book();
  await acceptFirstOffer(pro.cookie);
  return { bookingId, pro };
}

/** Moves a job so it started `minutes` ago (negative: starts later). */
async function startedAgo(bookingId: string, minutes: number) {
  await t.pool.query(
    `UPDATE bookings SET starts_at = now() - make_interval(mins => $2), ends_at = now() - make_interval(mins => $2) + interval '1 hour'
     WHERE id = $1`,
    [bookingId, minutes],
  );
}

async function notifications(userId: string) {
  const rows = await t.pool.query<{ kind: string; body: string }>('SELECT kind, body FROM notifications WHERE user_id = $1 ORDER BY id', [userId]);
  return rows.rows;
}

const customerId = async () => (await t.pool.query<{ id: string }>("SELECT id FROM users WHERE phone = '+4915100000001'")).rows[0]?.id ?? '';

/** The local hour now in the market, 0 to 23. */
const localHour = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
/** Today's ISO weekday in the market, 1 (Monday) to 7. */
const localWeekday = () => {
  const day = new Date(`${marketToday(TIMEZONE)}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
};
/** Working hours that never include the current local time. */
function hoursExcludingNow() {
  const hour = localHour();
  return hour >= 1 ? { workStart: '00:00', workEnd: `${String(hour).padStart(2, '0')}:00` } : { workStart: '01:00', workEnd: '24:00' };
}

const backdateIssue = (bookingId: string, minutes: number) =>
  t.pool.query("UPDATE booking_issues SET created_at = now() - make_interval(mins => $2) WHERE booking_id = $1 AND resolved_at IS NULL", [
    bookingId,
    minutes,
  ]);

describe('auto-offline: working hours, days off and holidays', () => {
  it('sets the pro offline outside their working hours, and "Go online" overrides it until the end of the day', async () => {
    const pro = await daniel();
    const hours = await put('/pro/working-hours', hoursExcludingNow(), pro.cookie);
    expect(hours.statusCode).toBe(200);
    expect(hours.json().availability).toMatchObject({ ...hoursExcludingNow(), onlineNow: false, autoOffline: { reason: 'outside_hours' } });

    const bookingId = await book();
    await dispatchTick(t.deps);
    expect((await get('/pro/offers', pro.cookie)).json().offers).toEqual([]);
    expect((await t.pool.query('SELECT status FROM bookings WHERE id = $1', [bookingId])).rows[0]?.status).toBe('searching');

    const online = (await put('/pro/online', { online: true }, pro.cookie)).json();
    expect(online.availability).toMatchObject({ onlineNow: true, autoOffline: null });
    // The override ends at midnight in the market time zone.
    const until = new Date(online.availability.overrideUntil as string);
    expect(marketToday(TIMEZONE, new Date(until.getTime() - 1000))).toBe(marketToday(TIMEZONE));
    expect(marketToday(TIMEZONE, until)).toBe(addDays(marketToday(TIMEZONE), 1));
    await dispatchTick(t.deps);
    expect((await get('/pro/offers', pro.cookie)).json().offers).toHaveLength(1);

    // Switching off ends the override.
    expect((await put('/pro/online', { online: false }, pro.cookie)).json().availability.overrideUntil).toBeNull();
  });

  it('sets the pro offline on a day off, and passes their unanswered offers on to an online pro', async () => {
    const first = await daniel();
    const second = await leon();
    const bookingId = await book();
    const offered = await t.pool.query<{ pro_id: string }>("SELECT pro_id FROM booking_offers WHERE booking_id = $1 AND status = 'pending'", [bookingId]);
    const holder = offered.rows[0]?.pro_id === first.proId ? first : second;
    const other = holder === first ? second : first;
    const today = localWeekday();
    await t.pool.query('UPDATE pro_profiles SET working_days = $2 WHERE user_id = $1', [holder.proId, [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== today)]);

    const profile = (await get('/pro/profile', holder.cookie)).json().profile;
    expect(profile.online).toBe(true);
    expect(profile.availability).toMatchObject({ onlineNow: false, autoOffline: { reason: 'day_off', until: null } });
    await dispatchTick(t.deps);
    expect((await get('/pro/offers', holder.cookie)).json().offers).toEqual([]);
    expect((await get('/pro/offers', other.cookie)).json().offers).toEqual([expect.objectContaining({ bookingId })]);
  });

  it('sets the pro offline on holiday, offers no jobs on holiday days, and keeps accepted jobs', async () => {
    const job = await assignedJob();
    const today = marketToday(TIMEZONE);
    const added = await post('/pro/holidays', { startsOn: today, endsOn: addDays(today, 2) }, job.pro.cookie);
    expect(added.statusCode).toBe(201);
    expect(added.json().availability).toMatchObject({
      onlineNow: false,
      autoOffline: { reason: 'holiday', until: addDays(today, 2) },
      holidays: [expect.objectContaining({ startsOn: today, endsOn: addDays(today, 2) })],
    });
    // The accepted job stays in the schedule.
    expect((await get(`/pro/jobs/${job.bookingId}`, job.pro.cookie)).json().job.status).toBe('accepted');
    // No slot on a holiday day is offered with this pro, the only one.
    const slots = (await get(`/availability?serviceId=${market.mowing}&postcode=10115`)).json().slots as { startsAt: string; available: boolean }[];
    const onHoliday = slots.filter((s) => [today, addDays(today, 1), addDays(today, 2)].includes(marketToday(TIMEZONE, new Date(s.startsAt))));
    expect(onHoliday.every((s) => !s.available)).toBe(true);

    const holidayId = added.json().availability.holidays[0].id as string;
    const other = await leon();
    expect((await del(`/pro/holidays/${holidayId}`, other.cookie)).statusCode).toBe(404);
    expect((await del(`/pro/holidays/${holidayId}`, job.pro.cookie)).json().availability.holidays).toEqual([]);
  });

  it('checks working hours and holidays', async () => {
    const pro = await daniel();
    expect((await put('/pro/working-hours', { workStart: '18:00', workEnd: '08:00' }, pro.cookie)).json()).toEqual({ error: 'hours_invalid' });
    expect((await put('/pro/working-hours', { workStart: '8:00', workEnd: '18:00' }, pro.cookie)).statusCode).toBe(400);
    expect((await put('/pro/working-hours', { workStart: '08:00', workEnd: '24:00' }, pro.cookie)).statusCode).toBe(200);
    const today = marketToday(TIMEZONE);
    expect((await post('/pro/holidays', { startsOn: addDays(today, -1), endsOn: today }, pro.cookie)).json()).toEqual({ error: 'holiday_invalid' });
    expect((await post('/pro/holidays', { startsOn: addDays(today, 3), endsOn: addDays(today, 2) }, pro.cookie)).json()).toEqual({
      error: 'holiday_invalid',
    });
    expect((await post('/pro/holidays', { startsOn: today, endsOn: addDays(today, 100) }, pro.cookie)).json()).toEqual({ error: 'holiday_too_long' });
    expect((await put('/pro/working-hours', { workStart: '08:00', workEnd: '18:00' }, customer)).statusCode).toBe(403);
  });
});

describe('a new job offer', () => {
  it('says how long the job takes', async () => {
    const pro = await daniel();
    await book();
    const minutes = (await t.pool.query<{ m: number }>('SELECT duration_minutes AS m FROM services WHERE id = $1', [market.mowing])).rows[0]?.m;
    expect((await get('/pro/offers', pro.cookie)).json().offers[0]).toMatchObject({ durationMinutes: minutes });
  });
});

describe('warning the customer when the pro runs late', () => {
  it('tells the customer once, from the worker, when the pro has not set off 10 minutes after the start', async () => {
    const job = await assignedJob();
    await startedAgo(job.bookingId, 5);
    expect(await lateWarningTick(t.deps)).toBe(0);
    await startedAgo(job.bookingId, 15);
    expect(await lateWarningTick(t.deps)).toBe(1);
    expect(await lateWarningTick(t.deps)).toBe(0);
    const sent = (await notifications(await customerId())).filter((n) => n.body.includes('running about'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'pro_on_the_way' });
    const admin = await signInAdmin(t);
    const actions = (await get(`/admin/bookings/${job.bookingId}`, admin)).json().booking.actions as { action: string }[];
    expect(actions.filter((a) => a.action === 'late_warning')).toHaveLength(1);
  });

  it('tells the customer when a position shows the pro will be more than 10 minutes late', async () => {
    const job = await assignedJob();
    expect((await post(`/pro/jobs/${job.bookingId}/status`, { status: 'on_the_way' }, job.pro.cookie)).statusCode).toBe(200);
    await startedAgo(job.bookingId, -5);
    // About 25 km away: far more than 10 minutes late.
    expect((await post(`/pro/jobs/${job.bookingId}/location`, { lat: 52.75, lng: 13.6 }, job.pro.cookie)).statusCode).toBe(204);
    const sent = (await notifications(await customerId())).filter((n) => n.body.includes('running about'));
    expect(sent).toHaveLength(1);
    expect((await t.pool.query('SELECT late_warned_at FROM bookings WHERE id = $1', [job.bookingId])).rows[0]?.late_warned_at).not.toBeNull();
  });
});

describe('reporting an issue reaches MISK support', () => {
  it('alerts the team by email, and an unsafe report stops the job and goes to the top of Needs action', async () => {
    const job = await assignedJob();
    const admin = await signInAdmin(t);
    await t.pool.query("UPDATE users SET email = 'team@example.com' WHERE username = 'admin'");
    const adminId = (await t.pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'admin'")).rows[0]?.id ?? '';
    // A second booking under Needs action, which the unsafe one goes above.
    const other = await book();
    await t.pool.query("UPDATE bookings SET status = 'unassigned' WHERE id = $1", [other]);

    expect((await post(`/pro/jobs/${job.bookingId}/status`, { status: 'on_the_way' }, job.pro.cookie)).statusCode).toBe(200);
    const reported = await post(`/pro/jobs/${job.bookingId}/issue`, { reason: 'unsafe' }, job.pro.cookie);
    expect(reported.json().job).toMatchObject({ stopped: true, openIssue: { reason: 'unsafe' } });
    expect(await notifications(adminId)).toEqual([expect.objectContaining({ kind: 'support_alert', body: expect.stringContaining('URGENT') })]);

    const list = (await get('/admin/bookings?tab=needs_action', admin)).json().bookings as { id: string; urgent: boolean }[];
    expect(list[0]).toMatchObject({ id: job.bookingId, urgent: true });
    expect(list.slice(1).every((b) => !b.urgent)).toBe(true);

    expect((await post(`/pro/jobs/${job.bookingId}/status`, { status: 'working' }, job.pro.cookie)).json()).toEqual({ error: 'job_stopped' });
    const issueId = (await get(`/admin/bookings/${job.bookingId}`, admin)).json().booking.issues[0].id as string;
    await post(`/admin/bookings/${job.bookingId}/issues/${issueId}/resolve`, undefined, admin);
    expect((await post(`/pro/jobs/${job.bookingId}/status`, { status: 'working' }, job.pro.cookie)).json().job).toMatchObject({
      status: 'working',
      stopped: false,
    });
  });

  it('keeps details optional except for "Something else"', async () => {
    const job = await assignedJob();
    expect((await post(`/pro/jobs/${job.bookingId}/issue`, { reason: 'other' }, job.pro.cookie)).json()).toEqual({ error: 'details_required' });
    expect((await post(`/pro/jobs/${job.bookingId}/issue`, { reason: 'bigger_job' }, job.pro.cookie)).statusCode).toBe(201);
  });
});

describe('customer not home: leaving with the call-out fee', () => {
  it(`is offered ${NO_SHOW_WAIT_MINUTES} minutes after the report, takes the fee only, pays the pro and tells the customer`, async () => {
    const job = await assignedJob();
    expect((await post(`/pro/jobs/${job.bookingId}/no-show`, undefined, job.pro.cookie)).json()).toEqual({ error: 'no_door_issue' });
    const reported = await post(`/pro/jobs/${job.bookingId}/issue`, { reason: 'customer_not_home' }, job.pro.cookie);
    const leaveAt = new Date(reported.json().job.leaveAt as string).getTime();
    expect(leaveAt - Date.now()).toBeGreaterThan((NO_SHOW_WAIT_MINUTES - 1) * 60_000);
    expect(reported.json().job.callOutFeeCents).toBe(1500);
    expect((await post(`/pro/jobs/${job.bookingId}/no-show`, undefined, job.pro.cookie)).json()).toEqual({ error: 'wait_longer' });

    await backdateIssue(job.bookingId, NO_SHOW_WAIT_MINUTES + 1);
    const other = await leon();
    expect((await post(`/pro/jobs/${job.bookingId}/no-show`, undefined, other.cookie)).statusCode).toBe(404);
    const left = await post(`/pro/jobs/${job.bookingId}/no-show`, undefined, job.pro.cookie);
    expect(left.statusCode).toBe(200);
    expect(left.json().job).toMatchObject({ status: 'cancelled', earningsCents: 1500, noShow: { chargeCents: 1500, waitingCents: 0 } });

    const booking = (await t.pool.query<{ payment_intent_id: string; payment_status: string }>(
      'SELECT payment_intent_id, payment_status FROM bookings WHERE id = $1',
      [job.bookingId],
    )).rows[0];
    expect(booking?.payment_status).toBe('captured');
    expect(t.fake.intents.get(booking?.payment_intent_id ?? '')).toMatchObject({ status: 'captured', capturedCents: 1500 });
    const payouts = await t.pool.query('SELECT amount_cents, status FROM payouts WHERE booking_id = $1', [job.bookingId]);
    expect(payouts.rows).toEqual([{ amount_cents: 1500, status: 'sent' }]);
    expect((await notifications(await customerId())).map((n) => n.body)).toContainEqual(expect.stringContaining('call-out fee of €15'));

    // The customer sees why and gets a receipt for the fee only.
    const view = (await get(`/bookings/${job.bookingId}`)).json().booking;
    expect(view).toMatchObject({ status: 'cancelled', totalCents: 1500, noShow: { chargeCents: 1500 } });
    const receipt = (await get(`/bookings/${job.bookingId}/receipt`)).json().receipt;
    expect(receipt.lines).toEqual([expect.objectContaining({ label: 'Call-out fee: the pro could not get in', cents: 1500 })]);
    expect(receipt.totalCents).toBe(1500);

    // Doing it again changes nothing.
    expect((await post(`/pro/jobs/${job.bookingId}/no-show`, undefined, job.pro.cookie)).statusCode).toBe(200);
    expect((await t.pool.query('SELECT 1 FROM payouts WHERE booking_id = $1', [job.bookingId])).rowCount).toBe(1);
    const admin = await signInAdmin(t);
    const actions = (await get(`/admin/bookings/${job.bookingId}`, admin)).json().booking.actions as { action: string }[];
    expect(actions.filter((a) => a.action === 'no_show')).toHaveLength(1);
  });

  it('uses the fee from Settings, adds paid waiting for a locked door, and is finished by the worker after a failed capture', async () => {
    const admin = await signInAdmin(t);
    expect((await call(t, 'PATCH', '/admin/settings', { cookie: admin, body: { noShowFeeCents: 2000, waitingCapMinutes: 20 } })).json().settings).toMatchObject({
      noShowFeeCents: 2000,
      waitingCapMinutes: 20,
    });
    const job = await assignedJob();
    expect((await get(`/bookings/${job.bookingId}`)).json().booking.callOutFeeCents).toBe(2000);
    await post(`/pro/jobs/${job.bookingId}/issue`, { reason: 'no_access' }, job.pro.cookie);
    await backdateIssue(job.bookingId, 45);
    t.fake.failures.add('capture');
    const left = await post(`/pro/jobs/${job.bookingId}/no-show`, undefined, job.pro.cookie);
    expect(left.statusCode).toBe(200);
    const row = (await t.pool.query<{ price_cents: number; payment_status: string; no_show_waiting_cents: number }>(
      'SELECT price_cents, payment_status, no_show_waiting_cents FROM bookings WHERE id = $1',
      [job.bookingId],
    )).rows[0];
    expect(row?.payment_status).toBe('held');
    const minutes = (await t.pool.query<{ m: number }>('SELECT sum(duration_minutes)::int AS m FROM booking_services WHERE booking_id = $1', [job.bookingId])).rows[0]?.m ?? 60;
    // Capped at 20 minutes of the job's own rate.
    expect(row?.no_show_waiting_cents).toBe(Math.round(((row?.price_cents ?? 0) * 20) / minutes));

    t.fake.failures.delete('capture');
    await settleTick(t.deps);
    const after = (await t.pool.query<{ payment_status: string; payment_intent_id: string }>(
      'SELECT payment_status, payment_intent_id FROM bookings WHERE id = $1',
      [job.bookingId],
    )).rows[0];
    expect(after?.payment_status).toBe('captured');
    expect(t.fake.intents.get(after?.payment_intent_id ?? '')?.capturedCents).toBe(2000 + (row?.no_show_waiting_cents ?? 0));
  });
});

describe("can't get in: paid waiting time", () => {
  async function waitedAtDoor(minutes: number, cardRefuses = false) {
    const job = await assignedJob();
    expect((await post(`/pro/jobs/${job.bookingId}/status`, { status: 'on_the_way' }, job.pro.cookie)).statusCode).toBe(200);
    await post(`/pro/jobs/${job.bookingId}/issue`, { reason: 'no_access' }, job.pro.cookie);
    await backdateIssue(job.bookingId, minutes);
    if (cardRefuses) t.fake.failures.add('hold');
    const started = await post(`/pro/jobs/${job.bookingId}/status`, { status: 'working' }, job.pro.cookie);
    expect(started.statusCode).toBe(200);
    const price = (await t.pool.query<{ price_cents: number; m: number }>(
      `SELECT b.price_cents, (SELECT sum(duration_minutes)::int FROM booking_services WHERE booking_id = b.id) AS m FROM bookings b WHERE b.id = $1`,
      [job.bookingId],
    )).rows[0];
    return { job, started: started.json().job, priceCents: price?.price_cents ?? 0, jobMinutes: price?.m ?? 60 };
  }

  it('charges the waiting to the customer at the job rate, capped, and adds it to the pro earnings', async () => {
    const { job, started, priceCents, jobMinutes } = await waitedAtDoor(50);
    const cents = Math.round((priceCents * 30) / jobMinutes);
    expect(started.openIssue).toBeNull();
    expect(started.extras).toEqual([expect.objectContaining({ kind: 'waiting', status: 'approved', priceCents: cents, fundedBy: 'customer' })]);
    expect(started.tasks.some((task: { key: string }) => task.key.startsWith('x-'))).toBe(false);
    const share = (await t.pool.query<{ pct: number }>('SELECT pro_share_pct AS pct FROM bookings WHERE id = $1', [job.bookingId])).rows[0]?.pct ?? 0;
    expect(started.earningsCents).toBe(Math.floor((priceCents * share) / 100) + Math.floor((cents * share) / 100));
    const customerView = (await get(`/bookings/${job.bookingId}`)).json().booking;
    expect(customerView.extrasCents).toBe(cents);
    expect((await notifications(await customerId())).map((n) => n.body)).toContainEqual(expect.stringContaining('waited 30 minutes'));
  });

  it('is paid by MISK when the customer card refuses it, and settled without a charge', async () => {
    const { job, started } = await waitedAtDoor(12, true);
    t.fake.failures.delete('hold');
    expect(started.extras).toEqual([expect.objectContaining({ kind: 'waiting', status: 'approved', fundedBy: 'misk' })]);
    const customerView = (await get(`/bookings/${job.bookingId}`)).json().booking;
    expect(customerView.extrasCents).toBe(0);
    // The customer neither pays nor sees the line MISK pays for.
    expect(customerView.extras).toEqual([]);

    await upload(t, `/pro/jobs/${job.bookingId}/photos`, job.pro.cookie, FILES.png);
    expect((await post(`/pro/jobs/${job.bookingId}/complete`, undefined, job.pro.cookie)).statusCode).toBe(200);
    await t.pool.query("UPDATE bookings SET completed_at = now() - interval '25 hours' WHERE id = $1", [job.bookingId]);
    await settleTick(t.deps);
    const payouts = await t.pool.query<{ payment_intent_id: string; charge_id: string | null; status: string }>(
      'SELECT payment_intent_id, charge_id, status FROM payouts WHERE booking_id = $1 ORDER BY payment_intent_id',
      [job.bookingId],
    );
    const misk = payouts.rows.find((p) => p.payment_intent_id.startsWith('misk-waiting-'));
    expect(misk).toMatchObject({ charge_id: null, status: 'sent' });
    expect(payouts.rows).toHaveLength(2);
  });
});

describe('completing and the earnings', () => {
  it('needs a photo, then shows the real next payout day', async () => {
    const job = await assignedJob();
    await post(`/pro/jobs/${job.bookingId}/status`, { status: 'on_the_way' }, job.pro.cookie);
    await post(`/pro/jobs/${job.bookingId}/status`, { status: 'working' }, job.pro.cookie);
    expect((await post(`/pro/jobs/${job.bookingId}/complete`, undefined, job.pro.cookie)).json()).toEqual({ error: 'photos_required' });
    await upload(t, `/pro/jobs/${job.bookingId}/photos`, job.pro.cookie, FILES.png);
    const done = (await post(`/pro/jobs/${job.bookingId}/complete`, undefined, job.pro.cookie)).json().job;
    const released = new Date(new Date(done.completedAt as string).getTime() + 24 * 3600 * 1000);
    expect(done.payoutOn).toBe(nextPayoutDate('weekly', marketToday(TIMEZONE, released)));
  });

  it('keeps an optional comment with the rating of the customer', async () => {
    const job = await assignedJob();
    await post(`/pro/jobs/${job.bookingId}/status`, { status: 'on_the_way' }, job.pro.cookie);
    await post(`/pro/jobs/${job.bookingId}/status`, { status: 'working' }, job.pro.cookie);
    await upload(t, `/pro/jobs/${job.bookingId}/photos`, job.pro.cookie, FILES.png);
    await post(`/pro/jobs/${job.bookingId}/complete`, undefined, job.pro.cookie);
    expect((await post(`/pro/jobs/${job.bookingId}/customer-rating`, { stars: 4, comment: 'x'.repeat(501) }, job.pro.cookie)).statusCode).toBe(400);
    const rated = await post(`/pro/jobs/${job.bookingId}/customer-rating`, { stars: 4, comment: '  Dog was friendly ' }, job.pro.cookie);
    expect(rated.json().job.customerRating).toMatchObject({ stars: 4, comment: 'Dog was friendly' });
  });
});

describe('the "You cancelled this job" card', () => {
  it('names the pro the job was offered to next, can be closed, and is kept for 24 hours', async () => {
    const job = await assignedJob();
    const next = await leon();
    await put('/pro/online', { online: false }, next.cookie);
    await t.pool.query(
      "UPDATE bookings SET starts_at = now() + interval '30 hours', ends_at = now() + interval '31 hours' WHERE id = $1",
      [job.bookingId],
    );
    expect((await post(`/pro/jobs/${job.bookingId}/cancel`, { reason: 'ill' }, job.pro.cookie)).statusCode).toBe(200);
    // Nobody else online yet: "Finding another pro".
    let cards = (await get('/pro/cancellations', job.pro.cookie)).json().cancellations;
    expect(cards).toEqual([expect.objectContaining({ bookingId: job.bookingId, reason: 'ill', nextProName: null })]);

    await put('/pro/online', { online: true }, next.cookie);
    await dispatchTick(t.deps);
    cards = (await get('/pro/cancellations', job.pro.cookie)).json().cancellations;
    expect(cards[0]).toMatchObject({ nextProName: 'Leon' });
    expect((await get('/pro/cancellations', next.cookie)).json().cancellations).toEqual([]);

    expect((await post(`/pro/cancellations/${cards[0].id}/dismiss`, undefined, next.cookie)).statusCode).toBe(404);
    expect((await post(`/pro/cancellations/${cards[0].id}/dismiss`, undefined, job.pro.cookie)).statusCode).toBe(204);
    expect((await get('/pro/cancellations', job.pro.cookie)).json().cancellations).toEqual([]);

    await t.pool.query("UPDATE pro_cancellations SET dismissed_at = NULL, created_at = now() - interval '25 hours'");
    expect((await get('/pro/cancellations', job.pro.cookie)).json().cancellations).toEqual([]);
  });
});
