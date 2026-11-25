import { approvedPro, call, createTestContext, resetDatabase, seedMarket, signIn, type Market, type TestContext } from '../../test/helpers.js';
import { localDayHour } from './availability.js';

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

/** The slots of a day for the lawn mowing job that are free for the customer, earliest first. */
async function freeSlots(days = 3, cookie = customer) {
  const slots = (await get(`/availability?serviceIds=${market.mowing}&postcode=10115`, cookie)).json().slots as {
    startsAt: string;
    endsAt: string;
    available: boolean;
  }[];
  return slots.filter((s) => s.available && localDayHour(new Date(s.startsAt), tz()).day === dayAhead(days));
}

async function book(startsAt: string, cookie = customer) {
  const created = await post('/bookings', { serviceIds: [market.mowing], size: 'M', address: '12 Linden Street', postcode: '10115', startsAt }, cookie);
  expect(created.statusCode).toBe(201);
  return created.json().booking.id as string;
}

/** A pro takes the job they were offered. */
async function accept(proCookie: string) {
  const offer = (await get('/pro/offers', proCookie)).json().offers[0];
  const accepted = await post(`/pro/offers/${offer.id}/accept`, {}, proCookie);
  expect(accepted.statusCode).toBe(200);
}

const inbox = async (userId: string, kind: string) =>
  (await t.pool.query<{ body: string }>('SELECT body FROM inbox WHERE user_id = $1 AND kind = $2 ORDER BY created_at', [userId, kind])).rows.map((r) => r.body);
const userId = async (phone: string) => (await t.pool.query<{ id: string }>('SELECT id FROM users WHERE phone = $1', [phone])).rows[0]?.id ?? '';

describe('customers move a booking (D75)', () => {
  it('moves a booking that is still searching to another free time and asks pros again', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const [first, second] = await freeSlots();
    if (!first || !second) throw new Error('Need two free slots');
    const id = await book(first.startsAt);
    expect((await get(`/bookings/${id}`)).json().booking.status).toBe('searching');

    const moved = await post(`/bookings/${id}/reschedule`, { startsAt: second.startsAt });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().booking).toMatchObject({ status: 'searching', startsAt: new Date(second.startsAt).toISOString(), endsAt: new Date(second.endsAt).toISOString() });
    const offers = await t.pool.query<{ pro_id: string; status: string }>('SELECT pro_id, status FROM booking_offers WHERE booking_id = $1', [id]);
    expect(offers.rows).toEqual([{ pro_id: pro.proId, status: 'pending' }]);
    const told = await inbox(await userId('+4915100000001'), 'booking_rescheduled');
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('Lawn mowing');
  });

  it('keeps the assigned pro when they are free at the new time, and tells them', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const [first, second] = await freeSlots();
    if (!first || !second) throw new Error('Need two free slots');
    const id = await book(first.startsAt);
    await accept(pro.cookie);

    const moved = await post(`/bookings/${id}/reschedule`, { startsAt: second.startsAt });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().booking).toMatchObject({
      status: 'accepted',
      startsAt: new Date(second.startsAt).toISOString(),
      pro: { id: pro.proId },
    });
    const told = await inbox(pro.proId, 'booking_rescheduled');
    expect(told).toHaveLength(1);
    expect(told[0]).toMatch(/Lawn mowing job has moved to/);
    expect(await inbox(pro.proId, 'booking_cancelled')).toEqual([]);
    expect(await inbox(await userId('+4915100000001'), 'booking_rescheduled')).toHaveLength(1);
  });

  it('can move to a time that overlaps its own old time with the same pro', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const [first] = await freeSlots();
    if (!first) throw new Error('Need a free slot');
    const id = await book(first.startsAt);
    await accept(pro.cookie);
    // The job is an hour long; a time of the next slot never overlaps, so stretch the old job over it first.
    await t.pool.query("UPDATE bookings SET ends_at = starts_at + interval '3 hours' WHERE id = $1", [id]);
    const next = (await freeSlots()).find((s) => s.startsAt !== first.startsAt && new Date(s.startsAt) > new Date(first.startsAt));
    if (!next) throw new Error('Need a later slot');
    const moved = await post(`/bookings/${id}/reschedule`, { startsAt: next.startsAt });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().booking.pro.id).toBe(pro.proId);
  });

  it('shows a time as free on the move page when only the booking being moved is in the way', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const [first] = await freeSlots();
    if (!first) throw new Error('Need a free slot');
    const id = await book(first.startsAt);
    await accept(pro.cookie);
    // The only pro's job now runs into the next time of the day.
    await t.pool.query("UPDATE bookings SET ends_at = starts_at + interval '3 hours' WHERE id = $1", [id]);
    const nextStart = new Date(new Date(first.startsAt).getTime() + 2 * 3600_000).toISOString();
    const query = `/availability?serviceIds=${market.mowing}&postcode=10115`;
    const plain = (await get(query)).json().slots as { startsAt: string; available: boolean }[];
    expect(plain.find((s) => new Date(s.startsAt).toISOString() === nextStart)?.available).toBe(false);
    const forMove = (await get(`${query}&bookingId=${id}`)).json().slots as { startsAt: string; available: boolean }[];
    expect(forMove.find((s) => new Date(s.startsAt).toISOString() === nextStart)?.available).toBe(true);
    // Only the customer's own booking can be named.
    const stranger = await signIn(t, '+4915100000002', 'customer');
    expect((await get(`${query}&bookingId=${id}`, stranger)).statusCode).toBe(404);
  });

  it('lets go of a busy pro, tells them, and finds another pro for the new time', async () => {
    const busy = await approvedPro(t, '+4915100000101', { trades: [market.gardening], firstName: 'Daniel' });
    const [first, second] = await freeSlots();
    if (!first || !second) throw new Error('Need two free slots');
    const id = await book(first.startsAt);
    await accept(busy.cookie);
    const other = await approvedPro(t, '+4915100000102', { trades: [market.gardening], firstName: 'Marta' });
    // Daniel has another job at the new time; Marta is free.
    const neighbour = await signIn(t, '+4915100000003', 'customer', 'Tom');
    const neighbourId = await userId('+4915100000003');
    await t.pool.query(
      `INSERT INTO bookings (customer_id, service_id, category_id, service_name, size, address, postcode, starts_at, ends_at,
         status, price_cents, fee_cents, pro_share_pct, pro_id)
       VALUES ($1, $2, $3, 'Lawn mowing', 'M', '1 Other Road', '10115', $4, $5, 'accepted', 4550, 290, 82, $6)`,
      [neighbourId, market.mowing, market.gardening, second.startsAt, second.endsAt, busy.proId],
    );
    expect(neighbour).toBeTruthy();

    const moved = await post(`/bookings/${id}/reschedule`, { startsAt: second.startsAt });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().booking).toMatchObject({ status: 'searching', pro: null, startsAt: new Date(second.startsAt).toISOString() });
    const cancelled = await inbox(busy.proId, 'booking_cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatch(/Lawn mowing job on .+ was cancelled/);
    expect(await inbox(busy.proId, 'booking_rescheduled')).toEqual([]);
    const offers = await t.pool.query<{ pro_id: string; status: string }>("SELECT pro_id, status FROM booking_offers WHERE booking_id = $1 AND status = 'pending'", [id]);
    expect(offers.rows).toEqual([{ pro_id: other.proId, status: 'pending' }]);
    const events = await t.pool.query<{ status: string }>('SELECT status FROM booking_events WHERE booking_id = $1 ORDER BY id', [id]);
    expect(events.rows.map((r) => r.status)).toEqual(['awaiting_payment', 'searching', 'accepted', 'searching']);
  });

  it('turns a flexible booking into a fixed time', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const created = await post('/bookings', {
      serviceIds: [market.mowing],
      size: 'M',
      address: '12 Linden Street',
      postcode: '10115',
      flexibleWindow: 'morning',
      day: dayAhead(3),
    });
    const id = created.json().booking.id as string;
    expect(created.json().booking).toMatchObject({ flexibleWindow: 'morning', timeConfirmed: false });
    const [slot] = await freeSlots(4);
    if (!slot) throw new Error('Need a free slot');
    const moved = await post(`/bookings/${id}/reschedule`, { startsAt: slot.startsAt });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().booking).toMatchObject({ timeConfirmed: true, startsAt: new Date(slot.startsAt).toISOString(), endsAt: new Date(slot.endsAt).toISOString() });
  });

  it('refuses within 24 hours of the start, and once the pro has set off', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const [first, second] = await freeSlots();
    if (!first || !second) throw new Error('Need two free slots');
    const id = await book(first.startsAt);
    await accept(pro.cookie);
    await t.pool.query("UPDATE bookings SET starts_at = now() + interval '20 hours', ends_at = now() + interval '21 hours' WHERE id = $1", [id]);
    expect((await post(`/bookings/${id}/reschedule`, { startsAt: second.startsAt })).json()).toEqual({ error: 'too_late_to_reschedule' });
    await t.pool.query("UPDATE bookings SET starts_at = now() + interval '3 days', ends_at = now() + interval '3 days 1 hour', status = 'on_the_way' WHERE id = $1", [id]);
    expect((await post(`/bookings/${id}/reschedule`, { startsAt: second.startsAt })).json()).toEqual({ error: 'too_late_to_reschedule' });
  });

  it('refuses the same time, a time that is not free and a booking of someone else', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const [first] = await freeSlots();
    if (!first) throw new Error('Need a free slot');
    const id = await book(first.startsAt);
    const same = await post(`/bookings/${id}/reschedule`, { startsAt: first.startsAt });
    expect(same.statusCode).toBe(400);
    expect(same.json()).toEqual({ error: 'same_time' });
    // Not a bookable start (09:30), and a start in the past.
    const odd = new Date(new Date(first.startsAt).getTime() + 30 * 60_000).toISOString();
    expect((await post(`/bookings/${id}/reschedule`, { startsAt: odd })).json()).toEqual({ error: 'slot_unavailable' });
    // A day before today is outside the booking horizon (D101).
    expect((await post(`/bookings/${id}/reschedule`, { startsAt: '2020-01-01T10:00:00.000Z' })).json()).toEqual({ error: 'date_out_of_range' });
    expect((await post(`/bookings/${id}/reschedule`, { startsAt: 'tomorrow' })).statusCode).toBe(400);

    const other = await signIn(t, '+4915100000002', 'customer', 'Tom');
    const [second] = (await freeSlots(3, other)).filter((s) => s.startsAt !== first.startsAt);
    if (!second) throw new Error('Need another slot');
    expect((await post(`/bookings/${id}/reschedule`, { startsAt: second.startsAt }, other)).statusCode).toBe(404);
    expect((await get(`/bookings/${id}`)).json().booking.startsAt).toBe(new Date(first.startsAt).toISOString());
  });

  it('refuses a time when every pro is busy then', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const [first, second] = await freeSlots();
    if (!first || !second) throw new Error('Need two free slots');
    const id = await book(first.startsAt);
    await accept(pro.cookie);
    const neighbourId = await userId((await signIn(t, '+4915100000003', 'customer', 'Tom'), '+4915100000003'));
    await t.pool.query(
      `INSERT INTO bookings (customer_id, service_id, category_id, service_name, size, address, postcode, starts_at, ends_at,
         status, price_cents, fee_cents, pro_share_pct, pro_id)
       VALUES ($1, $2, $3, 'Lawn mowing', 'M', '1 Other Road', '10115', $4, $5, 'accepted', 4550, 290, 82, $6)`,
      [neighbourId, market.mowing, market.gardening, second.startsAt, second.endsAt, pro.proId],
    );
    expect((await post(`/bookings/${id}/reschedule`, { startsAt: second.startsAt })).json()).toEqual({ error: 'slot_unavailable' });
    expect((await get(`/bookings/${id}`)).json().booking).toMatchObject({ status: 'accepted', pro: { id: pro.proId } });
  });

  it('says canReschedule in the list and the booking, only more than 24 hours ahead', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const [first] = await freeSlots();
    if (!first) throw new Error('Need a free slot');
    const id = await book(first.startsAt);
    await accept(pro.cookie);
    const listed = async () => (await get('/bookings')).json().bookings.find((b: { id: string }) => b.id === id);
    expect((await get(`/bookings/${id}`)).json().booking.canReschedule).toBe(true);
    expect((await listed()).canReschedule).toBe(true);
    await t.pool.query("UPDATE bookings SET starts_at = now() + interval '23 hours', ends_at = now() + interval '24 hours' WHERE id = $1", [id]);
    expect((await get(`/bookings/${id}`)).json().booking.canReschedule).toBe(false);
    expect((await listed()).canReschedule).toBe(false);
    await t.pool.query("UPDATE bookings SET starts_at = now() + interval '3 days', ends_at = now() + interval '3 days 1 hour', status = 'working' WHERE id = $1", [id]);
    expect((await get(`/bookings/${id}`)).json().booking.canReschedule).toBe(false);
    await t.pool.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [id]);
    expect((await listed()).canReschedule).toBe(false);
  });
});
