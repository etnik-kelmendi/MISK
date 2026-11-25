import { approvedPro, call, createTestContext, resetDatabase, seedMarket, signIn, signInAdmin, type Market, type TestContext } from '../../test/helpers.js';
import { localDayHour, monthEnd } from './availability.js';
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

/** Today in the market's time zone, "YYYY-MM-DD". */
const today = () => localDayHour(new Date(), tz()).day;
/** A calendar day `n` days after `day`, counted on the calendar so clock changes never shift it. */
function plusDays(day: string, n: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}
const ahead = (n: number) => plusDays(today(), n);
const dayOf = (iso: string) => localDayHour(new Date(iso), tz()).day;
const localTime = (iso: string) => {
  const { hour, minute } = localDayHour(new Date(iso), tz());
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

interface SlotRow {
  startsAt: string;
  endsAt: string;
  available: boolean;
}

async function availability(query: string, cookie = customer) {
  return get(`/availability?serviceIds=${market.mowing}&postcode=10115${query}`, cookie);
}
async function slotsOn(day: string, cookie = customer): Promise<SlotRow[]> {
  const response = await availability(`&from=${day}&days=1`, cookie);
  expect(response.statusCode).toBe(200);
  return response.json().slots as SlotRow[];
}

const fixedBooking = (startsAt: string) => ({ serviceIds: [market.mowing], size: 'M', address: '12 Linden Street', postcode: '10115', startsAt });

describe('the booking horizon setting (D101)', () => {
  it('starts at 60 days, takes 7 to 180, and logs each change', async () => {
    const admin = await signInAdmin(t);
    const settings = async () => (await call(t, 'GET', '/admin/settings', { cookie: admin })).json().settings;
    expect((await settings()).bookingHorizonDays).toBe(60);
    for (const bookingHorizonDays of [6, 181, 30.5]) {
      expect((await call(t, 'PATCH', '/admin/settings', { cookie: admin, body: { bookingHorizonDays } })).statusCode).toBe(400);
    }
    const saved = await call(t, 'PATCH', '/admin/settings', { cookie: admin, body: { bookingHorizonDays: 90 } });
    expect(saved.json().settings.bookingHorizonDays).toBe(90);
    const log = (await call(t, 'GET', '/admin/activity', { cookie: admin })).json().activity as { action: string; details: unknown }[];
    expect(log.map((a) => [a.action, a.details])).toEqual([['booking_horizon', { from: 60, to: 90 }]]);
    // Customers cannot change it.
    expect((await call(t, 'PATCH', '/admin/settings', { cookie: customer, body: { bookingHorizonDays: 7 } })).statusCode).toBe(403);
  });
});

describe('availability for any week inside the horizon (D101)', () => {
  it('lists only the requested days, and says which days can be booked', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const response = await availability(`&from=${ahead(20)}&days=7`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.range).toEqual({ today: today(), lastDay: ahead(59), horizonDays: 60 });
    expect(body.window).toEqual({ from: ahead(20), days: 7 });
    const days = [...new Set((body.slots as SlotRow[]).map((s) => dayOf(s.startsAt)))];
    expect(days).toEqual([20, 21, 22, 23, 24, 25, 26].map(ahead));
    expect((body.slots as SlotRow[]).every((s) => s.available)).toBe(true);

    // Without from and days: today and the next six days, as before (D74).
    const week = (await availability('')).json();
    expect(week.window).toEqual({ from: today(), days: 7 });
    const weekDays = new Set((week.slots as SlotRow[]).map((s) => dayOf(s.startsAt)));
    expect(weekDays.has(ahead(6))).toBe(true);
    expect(weekDays.has(ahead(7))).toBe(false);
  });

  it('stops at the last bookable day and refuses days outside the horizon', async () => {
    const last = await availability(`&from=${ahead(59)}&days=7`);
    expect(last.statusCode).toBe(200);
    expect(new Set((last.json().slots as SlotRow[]).map((s) => dayOf(s.startsAt)))).toEqual(new Set([ahead(59)]));
    expect((await availability(`&from=${ahead(60)}`)).json()).toEqual({ error: 'date_out_of_range' });
    expect((await availability(`&from=${ahead(-1)}`)).json()).toEqual({ error: 'date_out_of_range' });
    expect((await availability(`&from=${ahead(3)}&days=14`)).statusCode).toBe(200);
    for (const bad of ['&days=15', '&days=0', '&from=2026-02-30x', '&from=tomorrow']) {
      expect((await availability(bad)).statusCode).toBe(400);
    }

    // A shorter horizon set by the team applies straight away.
    await t.pool.query('UPDATE settings SET booking_horizon_days = 7');
    expect((await availability(`&from=${ahead(10)}`)).json()).toEqual({ error: 'date_out_of_range' });
    expect((await availability('')).json().range).toEqual({ today: today(), lastDay: ahead(6), horizonDays: 7 });
  });

  it('marks the days of a month that have a pro working at the postcode', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening], days: [1, 2, 3, 4, 5] });
    const target = ahead(20);
    const month = target.slice(0, 7);
    // A day off on a weekday that would otherwise be open (D99).
    const offDay = [20, 21, 22, 23, 24, 25, 26].map(ahead).find((d) => new Date(`${d}T12:00:00Z`).getUTCDay() === 3) ?? '';
    await t.pool.query('INSERT INTO pro_days_off (pro_id, day) VALUES ($1, $2)', [pro.proId, offDay]);
    const response = await get(`/availability/calendar?serviceIds=${market.mowing}&postcode=10115&month=${month}`);
    expect(response.statusCode).toBe(200);
    const { days, range } = response.json() as { days: { day: string; open: boolean }[]; range: { lastDay: string } };
    expect(range.lastDay).toBe(ahead(59));
    // Only days of that month inside the horizon.
    expect(days[0]?.day).toBe(month === today().slice(0, 7) ? today() : `${month}-01`);
    expect(days.at(-1)?.day).toBe(monthEnd(month) < ahead(59) ? monthEnd(month) : ahead(59));
    const open = (day: string) => days.find((d) => d.day === day)?.open;
    for (const day of [20, 21, 22, 23, 24, 25, 26].map(ahead).filter((d) => d.slice(0, 7) === month)) {
      const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
      expect(open(day)).toBe(weekday !== 0 && weekday !== 6 && day !== offDay);
    }

    expect((await get(`/availability/calendar?serviceIds=${market.mowing}&postcode=10115&month=${ahead(200).slice(0, 7)}`)).json()).toEqual({
      error: 'date_out_of_range',
    });
    expect((await get(`/availability/calendar?serviceIds=${market.mowing}&postcode=10115&month=2026-13`)).statusCode).toBe(400);
    // Another trade without pros: nothing is open.
    const plumbing = (await get(`/availability/calendar?serviceIds=${market.leak}&postcode=10115&month=${month}`)).json();
    expect(plumbing.days.some((d: { open: boolean }) => d.open)).toBe(false);
  });
});

describe('booking far ahead (D101)', () => {
  it('books a time weeks ahead and refuses one past the horizon', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const far = (await slotsOn(ahead(45))).find((s) => s.available);
    if (!far) throw new Error('No free slot 45 days ahead');
    expect((await post('/bookings', fixedBooking(far.startsAt))).statusCode).toBe(201);

    // The same time once the team shortens the horizon to 30 days.
    const later = (await slotsOn(ahead(45))).find((s) => s.available);
    if (!later) throw new Error('No second free slot');
    await t.pool.query('UPDATE settings SET booking_horizon_days = 30');
    expect((await post('/bookings', fixedBooking(later.startsAt))).json()).toEqual({ error: 'date_out_of_range' });
    const flexibleLate = { serviceIds: [market.mowing], size: 'M', address: '12 Linden Street', postcode: '10115', flexibleWindow: 'any', day: ahead(45) };
    expect((await post('/bookings', flexibleLate)).json()).toEqual({ error: 'date_out_of_range' });
    expect((await post('/bookings', fixedBooking(new Date(Date.now() - 2 * 24 * 3600_000).toISOString()))).json()).toEqual({ error: 'date_out_of_range' });
  });

  it('books a flexible window on a far date with the pro confirming by 18:00 the day before', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const day = ahead(30);
    const created = await post('/bookings', { serviceIds: [market.mowing], size: 'M', address: '12 Linden Street', postcode: '10115', flexibleWindow: 'afternoon', day });
    expect(created.statusCode).toBe(201);
    const booked = created.json().booking;
    expect(dayOf(booked.startsAt)).toBe(day);
    expect([localTime(booked.startsAt), localTime(booked.endsAt)]).toEqual(['12:00', '17:00']);
    expect(dayOf(booked.confirmBy)).toBe(ahead(29));
    expect(localTime(booked.confirmBy)).toBe('18:00');
  });

  it('moves a booking to a far date, but not past the horizon', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const near = (await slotsOn(ahead(3))).find((s) => s.available);
    const far = (await slotsOn(ahead(40))).find((s) => s.available);
    if (!near || !far) throw new Error('Need free slots');
    const id = (await post('/bookings', fixedBooking(near.startsAt))).json().booking.id as string;
    // The page asks for the far week with the booking left out of the count (D75).
    const moving = await availability(`&from=${ahead(40)}&days=7&bookingId=${id}`);
    expect(moving.statusCode).toBe(200);
    expect((moving.json().slots as SlotRow[]).some((s) => s.startsAt === far.startsAt && s.available)).toBe(true);

    const moved = await post(`/bookings/${id}/reschedule`, { startsAt: far.startsAt });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().booking.startsAt).toBe(new Date(far.startsAt).toISOString());

    const beyond = new Date(new Date(far.startsAt).getTime() + 30 * 24 * 3600_000).toISOString();
    expect((await post(`/bookings/${id}/reschedule`, { startsAt: beyond })).json()).toEqual({ error: 'date_out_of_range' });
  });
});

describe('the waiting list on a far date (D101)', () => {
  it('waits for a full time weeks ahead, then holds it for 15 minutes when it frees up', async () => {
    const day = ahead(20);
    // No pros yet: every time is full.
    const full = (await slotsOn(day))[0];
    if (!full) throw new Error('No slot 20 days ahead');
    expect(full.available).toBe(false);
    const joined = await post('/time-waitlist', { serviceIds: [market.mowing], postcode: '10115', day, startsAt: full.startsAt });
    expect(joined.statusCode).toBe(201);
    expect((await post('/time-waitlist', { serviceIds: [market.mowing], postcode: '10115', day: ahead(21) })).statusCode).toBe(201);
    for (const outside of [ahead(60), ahead(-1)]) {
      expect((await post('/time-waitlist', { serviceIds: [market.mowing], postcode: '10115', day: outside })).json()).toEqual({ error: 'date_out_of_range' });
    }
    // The entries show with any week, so the page can list them all.
    const listed = (await availability('')).json().waitlist as { day: string; startsAt: string | null }[];
    expect(listed.map((w) => [w.day, w.startsAt])).toEqual([
      [day, full.startsAt],
      [ahead(21), null],
    ]);

    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    expect(await timeWaitlistTick(t.deps)).toBe(2);
    const told = await t.pool.query<{ body: string }>("SELECT body FROM inbox WHERE kind = 'time_free'");
    expect(told.rows).toHaveLength(2);
    expect(told.rows[0]?.body).toMatch(/^MISK: Lawn mowing on .+ is free\. We hold it for you until \d\d:\d\d\. Book it in the app\.$/);

    const held = (await availability('')).json().held as { startsAt: string; expiresAt: string }[];
    expect(held.map((h) => dayOf(h.startsAt))).toEqual([day, ahead(21)]);
    expect(held[0]?.startsAt).toBe(full.startsAt);
    const minutes = (new Date(held[0]?.expiresAt ?? 0).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);

    // Nobody else can take the held time, and the customer who waited can.
    const other = await signIn(t, '+4915100000002', 'customer');
    expect((await slotsOn(day, other)).find((s) => s.startsAt === full.startsAt)?.available).toBe(false);
    expect((await post('/bookings', fixedBooking(full.startsAt), other)).json()).toEqual({ error: 'slot_unavailable' });
    expect((await slotsOn(day)).find((s) => s.startsAt === full.startsAt)?.available).toBe(true);
    expect((await post('/bookings', fixedBooking(full.startsAt))).statusCode).toBe(201);
  });

  it('does not hold a time past a shortened horizon', async () => {
    const day = ahead(40);
    expect((await post('/time-waitlist', { serviceIds: [market.mowing], postcode: '10115', day })).statusCode).toBe(201);
    await t.pool.query('UPDATE settings SET booking_horizon_days = 30');
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    expect(await timeWaitlistTick(t.deps)).toBe(0);
    expect((await t.pool.query('SELECT 1 FROM slot_holds')).rowCount).toBe(0);
  });
});
