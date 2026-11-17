import { approvedPro, call, createTestContext, resetDatabase, seedMarket, signIn, type Market, type TestContext } from '../../test/helpers.js';
import { localDayHour } from './availability.js';
import { dispatchTick } from './dispatch.js';
import { reminderTick } from './reminders.js';
import { timeWaitlistTick } from './time-waitlist.js';

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
const tz = () => t.config.timezone;

/** Local day (YYYY-MM-DD) `days` days from today, in the market's time zone. */
function dayAhead(days: number): string {
  return localDayHour(new Date(Date.now() + days * 24 * 3600 * 1000), tz()).day;
}

/** The local time of a moment, e.g. "10:00". */
function localTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

const flexibleBooking = (window: string, day: string) => ({
  serviceIds: [market.mowing],
  size: 'M',
  address: '12 Linden Street',
  postcode: '10115',
  flexibleWindow: window,
  day,
});

describe('flexible bookings (D70)', () => {
  it('covers the window until the pro picks a start they are free for', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening], firstName: 'Daniel' });
    // The day after tomorrow, so the 18:00 deadline the evening before is always still ahead.
    const day = dayAhead(2);
    const created = await post('/bookings', flexibleBooking('morning', day));
    expect(created.statusCode).toBe(201);
    const booked = created.json().booking;
    expect(booked).toMatchObject({ flexibleWindow: 'morning', timeConfirmed: false });
    // Morning starts are 08:00 and 10:00; a one-hour job ends by 11:00.
    expect([localTime(booked.startsAt), localTime(booked.endsAt)]).toEqual(['08:00', '11:00']);
    expect(localTime(booked.confirmBy)).toBe('18:00');
    expect(localDayHour(new Date(booked.confirmBy), tz()).day).toBe(dayAhead(1));

    const offer = (await get('/pro/offers', pro.cookie)).json().offers[0];
    expect(offer.flexibleWindow).toBe('morning');
    expect(offer.startOptions.map(localTime)).toEqual(['08:00', '10:00']);
    const offerText = await t.pool.query<{ body: string }>("SELECT body FROM inbox WHERE kind = 'job_offer'");
    expect(offerText.rows[0]?.body).toMatch(/flexible job, Lawn mowing on .+ \(morning\), you pick the time/);

    expect((await post(`/pro/offers/${offer.id}/accept`, {}, pro.cookie)).json()).toEqual({ error: 'start_required' });
    const nineOClock = new Date(new Date(offer.startOptions[0]).getTime() + 3600_000).toISOString();
    expect((await post(`/pro/offers/${offer.id}/accept`, { startsAt: nineOClock }, pro.cookie)).json()).toEqual({ error: 'start_not_free' });

    const accepted = await post(`/pro/offers/${offer.id}/accept`, { startsAt: offer.startOptions[1] }, pro.cookie);
    expect(accepted.statusCode).toBe(200);
    expect([localTime(accepted.json().job.startsAt), localTime(accepted.json().job.endsAt)]).toEqual(['10:00', '11:00']);
    const mine = (await get(`/bookings/${booked.id}`)).json().booking;
    expect(mine).toMatchObject({ status: 'accepted', timeConfirmed: true, flexibleWindow: 'morning' });
    const told = await t.pool.query<{ body: string }>("SELECT body FROM inbox WHERE kind = 'pro_assigned'");
    expect(told.rows[0]?.body).toContain('10:00');
  });

  it('confirms the booking by day and window, not by a time that is not set yet', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    await post('/bookings', flexibleBooking('afternoon', dayAhead(2)));
    const confirmed = await t.pool.query<{ body: string }>("SELECT body FROM inbox WHERE kind = 'booking_confirmed'");
    expect(confirmed.rows[0]?.body).toMatch(/\(afternoon\)/);
    expect(confirmed.rows[0]?.body).not.toMatch(/\d\d:\d\d/);
  });

  it('cannot start today, because a pro picks the time by the evening before', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    expect((await post('/bookings', flexibleBooking('any', dayAhead(0)))).json()).toEqual({ error: 'too_late_for_flexible' });
    expect((await post('/bookings', { ...flexibleBooking('any', dayAhead(2)), flexibleWindow: 'night' })).statusCode).toBe(400);
    const noTime = { serviceIds: [market.mowing], size: 'M', address: '12 Linden Street', postcode: '10115' };
    expect((await post('/bookings', noTime)).json()).toEqual({ error: 'time_missing' });
  });

  it('goes to the team and tells the customer when no pro has picked a time by the deadline', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const id = (await post('/bookings', flexibleBooking('morning', dayAhead(2)))).json().booking.id as string;
    await t.pool.query("UPDATE bookings SET confirm_by = now() - interval '1 minute' WHERE id = $1", [id]);
    await dispatchTick(t.deps);
    expect((await get(`/bookings/${id}`)).json().booking.status).toBe('unassigned');
    const offers = await t.pool.query("SELECT status FROM booking_offers WHERE booking_id = $1 AND status = 'pending'", [id]);
    expect(offers.rowCount).toBe(0);
    const told = await t.pool.query<{ body: string }>("SELECT body FROM inbox WHERE kind = 'booking_unassigned'");
    expect(told.rows[0]?.body).toMatch(/\(morning\)/);
  });

  it('sends no evening reminder for a flexible job whose time is not set', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const id = (await post('/bookings', flexibleBooking('morning', dayAhead(2)))).json().booking.id as string;
    // Pretend the job is tomorrow and it is after 18:00.
    await t.pool.query(
      `UPDATE bookings SET starts_at = date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2 + interval '1 day 8 hours' WHERE id = $1`,
      [id, tz()],
    );
    const hour = localDayHour(new Date(), tz()).hour;
    if (hour >= 18) {
      expect(await reminderTick(t.deps)).toBe(0);
    }
    const sent = await t.pool.query('SELECT reminder_sent_at FROM bookings WHERE id = $1 AND reminder_sent_at IS NOT NULL', [id]);
    expect(sent.rowCount).toBe(0);
  });
});

describe('waiting list for full times (D70)', () => {
  async function firstSlot() {
    const slots = (await get(`/availability?serviceIds=${market.mowing}&postcode=10115`)).json().slots as { startsAt: string; available: boolean }[];
    const slot = slots.find((s) => localDayHour(new Date(s.startsAt), tz()).day === dayAhead(2));
    if (!slot) throw new Error('No slot two days ahead');
    return slot;
  }

  it('waits for a full time or a whole day, and tells the customer once a pro is free', async () => {
    // No pros yet: every time is full.
    const slot = await firstSlot();
    expect(slot.available).toBe(false);
    const day = dayAhead(2);
    const one = await post('/time-waitlist', { serviceIds: [market.mowing], postcode: '10115', day, startsAt: slot.startsAt });
    expect(one.statusCode).toBe(201);
    expect((await post('/time-waitlist', { serviceIds: [market.mowing], postcode: '10115', day })).statusCode).toBe(201);
    expect((await post('/time-waitlist', { serviceIds: [market.mowing], postcode: '10115', day })).json()).toEqual({ error: 'already_waiting' });

    const listed = (await get(`/availability?serviceIds=${market.mowing}&postcode=10115`)).json().waitlist as { day: string; startsAt: string | null }[];
    expect(listed.map((w) => [w.day, w.startsAt === null])).toEqual([
      [day, true],
      [day, false],
    ]);
    expect(await timeWaitlistTick(t.deps)).toBe(0);

    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    expect(await timeWaitlistTick(t.deps)).toBe(2);
    expect(await timeWaitlistTick(t.deps)).toBe(0);
    const told = await t.pool.query<{ body: string }>("SELECT body FROM inbox WHERE kind = 'time_free' ORDER BY body");
    expect(told.rows).toHaveLength(2);
    expect(told.rows[0]?.body).toMatch(/^MISK: a pro is now free for Lawn mowing on /);
  });

  it('can be left again, only by its customer, and refuses a time on another day', async () => {
    const slot = await firstSlot();
    const entry = (await post('/time-waitlist', { serviceIds: [market.mowing], postcode: '10115', day: dayAhead(2), startsAt: slot.startsAt })).json().entry;
    const other = await signIn(t, '+4915100000002', 'customer');
    expect((await call(t, 'DELETE', `/time-waitlist/${entry.id}`, { cookie: other })).statusCode).toBe(404);
    expect((await call(t, 'DELETE', `/time-waitlist/${entry.id}`, { cookie: customer })).statusCode).toBe(204);
    expect((await post('/time-waitlist', { serviceIds: [market.mowing], postcode: '10115', day: dayAhead(3), startsAt: slot.startsAt })).json()).toEqual({
      error: 'time_not_on_day',
    });
    expect((await post('/time-waitlist', { serviceIds: [market.mowing], postcode: '10115', day: dayAhead(30) })).json()).toEqual({ error: 'day_not_bookable' });
    expect((await post('/time-waitlist', { serviceIds: [market.mowing, market.leak], postcode: '10115', day: dayAhead(2) })).json()).toEqual({
      error: 'invalid_services',
    });
  });
});
