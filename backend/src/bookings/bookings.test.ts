import type { LightMyRequestResponse } from 'fastify';
import {
  approvedPro,
  call,
  createTestContext,
  FILES,
  giveRating,
  resetDatabase,
  seedMarket,
  signIn,
  signInAdmin,
  TIMEZONE,
  upload,
  type Market,
  type TestContext,
} from '../../test/helpers.js';
import { dispatchTick } from './dispatch.js';
import { expireUnpaid, settleTick } from './lifecycle.js';

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

interface SlotJson {
  startsAt: string;
  available: boolean;
}

async function slots(cookie: string, serviceId: string, postcode = '10115'): Promise<SlotJson[]> {
  const response = await call(t, 'GET', `/availability?serviceId=${serviceId}&postcode=${postcode}`, { cookie });
  expect(response.statusCode).toBe(200);
  return response.json().slots;
}

async function firstFreeSlot(cookie: string, serviceId: string): Promise<string> {
  const free = (await slots(cookie, serviceId)).find((s) => s.available);
  if (!free) {
    throw new Error('No free slot');
  }
  return free.startsAt;
}

function book(cookie: string, startsAt: string, serviceId = market.mowing, extra: Record<string, unknown> = {}) {
  return call(t, 'POST', '/bookings', {
    cookie,
    body: { serviceId, size: 'M', address: '12 Linden Street', postcode: '10115', notes: 'Gate code 4411', startsAt, ...extra },
  });
}

async function bookFirst(cookie = customer, serviceId = market.mowing) {
  const response = await book(cookie, await firstFreeSlot(cookie, serviceId), serviceId);
  expect(response.statusCode).toBe(201);
  return response.json().booking as { id: string; status: string; totalCents: number };
}

async function pendingOffer(proCookie: string) {
  const response = await call(t, 'GET', '/pro/offers', { cookie: proCookie });
  return response.json().offers[0] as { id: string; bookingId: string; earningsCents: number } | undefined;
}

async function booking(id: string, cookie = customer) {
  return (await call(t, 'GET', `/bookings/${id}`, { cookie })).json().booking;
}

function weekdayIn(timezone: string, iso: string) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short' }).format(new Date(iso));
}

function hourIn(timezone: string, iso: string) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(iso)));
}

async function walkToWorking(proCookie: string, bookingId: string) {
  for (const status of ['on_the_way', 'working']) {
    const response = await call(t, 'POST', `/pro/jobs/${bookingId}/status`, { cookie: proCookie, body: { status } });
    expect(response.statusCode).toBe(200);
  }
}

async function acceptFirstOffer(proCookie: string) {
  const offer = await pendingOffer(proCookie);
  if (!offer) {
    throw new Error('No offer');
  }
  const accepted = await call(t, 'POST', `/pro/offers/${offer.id}/accept`, { cookie: proCookie });
  expect(accepted.statusCode).toBe(200);
  return offer.bookingId;
}

/** Moves a finished job's completion 25 hours back and runs the settlement worker, as if a day had passed. */
async function afterChargeDelay(bookingId: string) {
  await t.pool.query("UPDATE bookings SET completed_at = now() - interval '25 hours' WHERE id = $1", [bookingId]);
  await settleTick(t.deps);
}

function errorOf(response: LightMyRequestResponse) {
  return response.json().error;
}

describe('availability', () => {
  it('offers no slot when no pro can come', async () => {
    const all = await slots(customer, market.mowing);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((s) => !s.available)).toBe(true);
  });

  it('offers slots in a pro trade and travel distance only', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening], radiusKm: 5 });
    expect((await slots(customer, market.mowing)).some((s) => s.available)).toBe(true);
    // Zehlendorf is about 14 km from the pro's home.
    expect((await slots(customer, market.mowing, '14167')).every((s) => !s.available)).toBe(true);
    expect((await slots(customer, market.leak)).every((s) => !s.available)).toBe(true);
  });

  it('only offers the pro working days, in the market time zone', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening], days: [3] });
    const free = (await slots(customer, market.mowing)).filter((s) => s.available);
    expect(free.every((s) => weekdayIn(TIMEZONE, s.startsAt) === 'Wed')).toBe(true);
  });

  it('starts slots at 08:00 to 18:00 and fits long jobs before 20:00', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const short = new Set((await slots(customer, market.mowing)).map((s) => hourIn(TIMEZONE, s.startsAt)));
    expect([...short].every((h) => [8, 10, 12, 14, 16, 18].includes(h))).toBe(true);
    const long = await t.pool.query<{ id: string }>(
      `INSERT INTO services (category_id, name, price_cents, duration_minutes) VALUES ($1, 'Full day', 20000, 480) RETURNING id`,
      [market.gardening],
    );
    const hours = new Set((await slots(customer, long.rows[0]?.id ?? '')).map((s) => hourIn(TIMEZONE, s.startsAt)));
    expect([...hours].every((h) => h <= 12)).toBe(true);
  });

  it('refuses unserved postcodes', async () => {
    const response = await call(t, 'GET', `/availability?serviceId=${market.mowing}&postcode=99999`, { cookie: customer });
    expect(errorOf(response)).toBe('postcode_not_served');
  });
});

describe('booking and dispatch', () => {
  it('holds the full price and offers the job to the best-rated free pro', async () => {
    const good = await approvedPro(t, '+4915100000101', { trades: [market.gardening], firstName: 'Ok' });
    const best = await approvedPro(t, '+4915100000102', { trades: [market.gardening], firstName: 'Best' });
    await giveRating(t.pool, good.proId, 3);
    await giveRating(t.pool, best.proId, 5);

    const created = await bookFirst();
    expect(created).toMatchObject({ status: 'searching', totalCents: 4550 + 290 });
    const intent = [...t.fake.intents.values()][0];
    expect(intent).toMatchObject({ amountCents: 4840, status: 'held' });

    const offer = await pendingOffer(best.cookie);
    expect(offer).toMatchObject({ bookingId: created.id, earningsCents: Math.floor(4550 * 0.82) });
    expect(await pendingOffer(good.cookie)).toBeUndefined();
    const texts = await t.pool.query("SELECT kind FROM notifications ORDER BY created_at");
    expect(texts.rows.map((r) => r.kind)).toEqual(['booking_confirmed', 'job_offer']);
  });

  it('never sells the same last pro twice', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const startsAt = await firstFreeSlot(customer, market.mowing);
    expect((await book(customer, startsAt)).statusCode).toBe(201);

    const other = await signIn(t, '+4915100000002', 'customer');
    expect((await slots(other, market.mowing)).find((s) => s.startsAt === startsAt)?.available).toBe(false);
    const second = await book(other, startsAt);
    expect(second.statusCode).toBe(409);
    expect(errorOf(second)).toBe('slot_unavailable');
  });

  it('refuses times that are not real slots', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const startsAt = new Date(new Date(await firstFreeSlot(customer, market.mowing)).getTime() + 15 * 60_000).toISOString();
    expect(errorOf(await book(customer, startsAt))).toBe('slot_unavailable');
  });

  it('moves to the next pro on decline, and to the admins when nobody is left', async () => {
    const first = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const second = await approvedPro(t, '+4915100000102', { trades: [market.gardening] });
    const created = await bookFirst();

    for (const pro of [first, second]) {
      const offer = (await pendingOffer(pro.cookie)) ?? (await pendingOffer(pro === first ? second.cookie : first.cookie));
      const owner = (await pendingOffer(first.cookie)) ? first : second;
      expect(offer).toBeDefined();
      expect((await call(t, 'POST', `/pro/offers/${offer?.id}/decline`, { cookie: owner.cookie })).statusCode).toBe(204);
    }
    expect((await booking(created.id)).status).toBe('unassigned');
    const texts = await t.pool.query("SELECT 1 FROM notifications WHERE kind = 'booking_unassigned'");
    expect(texts.rowCount).toBe(1);
  });

  it('passes the job on when a pro does not answer in time', async () => {
    const first = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    await giveRating(t.pool, first.proId, 5);
    const second = await approvedPro(t, '+4915100000102', { trades: [market.gardening] });
    await bookFirst();
    expect(await pendingOffer(first.cookie)).toBeDefined();

    await t.pool.query("UPDATE booking_offers SET expires_at = now() - interval '1 second'");
    await dispatchTick(t.deps);
    expect(await pendingOffer(first.cookie)).toBeUndefined();
    expect(await pendingOffer(second.cookie)).toBeDefined();
    const late = await t.pool.query<{ id: string }>("SELECT id FROM booking_offers WHERE status = 'expired'");
    const lateAccept = await call(t, 'POST', `/pro/offers/${late.rows[0]?.id}/accept`, { cookie: first.cookie });
    expect(errorOf(lateAccept)).toBe('offer_expired');
  });

  it('assigns the pro who accepts, and only that pro', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening], firstName: 'Daniel' });
    const other = await approvedPro(t, '+4915100000102', { trades: [market.gardening] });
    const created = await bookFirst();
    const offer = (await pendingOffer(pro.cookie)) ?? (await pendingOffer(other.cookie));
    const owner = (await pendingOffer(pro.cookie)) ? pro : other;
    const stranger = owner === pro ? other : pro;
    expect((await call(t, 'POST', `/pro/offers/${offer?.id}/accept`, { cookie: stranger.cookie })).statusCode).toBe(404);
    expect((await call(t, 'POST', `/pro/offers/${offer?.id}/accept`, { cookie: owner.cookie })).statusCode).toBe(200);

    const seen = await booking(created.id);
    expect(seen.status).toBe('accepted');
    expect(seen.pro).toMatchObject({ id: owner.proId });
    expect(seen.pro.phone).toBeUndefined();
  });

  it('refuses an accept that would double-book the pro and passes the job on', async () => {
    const p1 = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    await giveRating(t.pool, p1.proId, 5);
    const p2 = await approvedPro(t, '+4915100000102', { trades: [market.gardening] });
    const p3 = await approvedPro(t, '+4915100000103', { trades: [market.gardening] });
    const startsAt = await firstFreeSlot(customer, market.mowing);
    const b1 = (await book(customer, startsAt)).json().booking;
    const other = await signIn(t, '+4915100000002', 'customer');
    const b2 = (await book(other, startsAt)).json().booking;
    expect((await pendingOffer(p1.cookie))?.bookingId).toBe(b1.id);

    const admin = await signInAdmin(t);
    const reassigned = await call(t, 'POST', `/admin/bookings/${b2.id}/reassign`, { cookie: admin, body: { proId: p1.proId } });
    expect(reassigned.json().booking.status).toBe('accepted');

    const offer = await pendingOffer(p1.cookie);
    const response = await call(t, 'POST', `/pro/offers/${offer?.id}/accept`, { cookie: p1.cookie });
    expect(errorOf(response)).toBe('schedule_conflict');
    const next = [await pendingOffer(p2.cookie), await pendingOffer(p3.cookie)].filter(Boolean);
    expect(next.map((o) => o?.bookingId)).toContain(b1.id);
  });

  it('shows a pending offer its photos, and nobody else', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const created = await bookFirst();
    const photo = await upload(t, `/bookings/${created.id}/photos`, customer, FILES.jpeg);
    expect(photo.statusCode).toBe(201);
    const photoId = photo.json().booking.photos[0].id;
    expect((await call(t, 'GET', `/files/${photoId}`, { cookie: pro.cookie })).statusCode).toBe(200);
    const stranger = await approvedPro(t, '+4915100000109', { trades: [market.plumbing] });
    expect((await call(t, 'GET', `/files/${photoId}`, { cookie: stranger.cookie })).statusCode).toBe(404);
    const otherCustomer = await signIn(t, '+4915100000002', 'customer');
    expect((await call(t, 'GET', `/bookings/${created.id}`, { cookie: otherCustomer })).statusCode).toBe(404);
  });
});

describe('doing the job', () => {
  it('walks accepted → on the way → working → done, then takes the money and pays the pro', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    await bookFirst();
    const bookingId = await acceptFirstOffer(pro.cookie);

    const skip = await call(t, 'POST', `/pro/jobs/${bookingId}/status`, { cookie: pro.cookie, body: { status: 'working' } });
    expect(errorOf(skip)).toBe('invalid_status');
    await walkToWorking(pro.cookie, bookingId);

    const noPhotos = await call(t, 'POST', `/pro/jobs/${bookingId}/complete`, { cookie: pro.cookie });
    expect(errorOf(noPhotos)).toBe('photos_required');
    expect((await upload(t, `/pro/jobs/${bookingId}/photos`, pro.cookie, FILES.png)).statusCode).toBe(201);
    const done = await call(t, 'POST', `/pro/jobs/${bookingId}/complete`, { cookie: pro.cookie });
    expect(done.json().job).toMatchObject({ status: 'completed', earningsCents: 3731 });

    const justDone = await booking(bookingId);
    expect(justDone).toMatchObject({ status: 'completed', paymentStatus: 'held', canRate: true, canReportProblem: true });
    expect(new Date(justDone.chargeAt).getTime() - new Date(justDone.completedAt).getTime()).toBe(24 * 3600 * 1000);
    await settleTick(t.deps);
    expect(t.fake.transfers).toEqual([]);

    await afterChargeDelay(bookingId);
    const seen = await booking(bookingId);
    expect(seen).toMatchObject({ status: 'completed', paymentStatus: 'captured', canRate: true, canReportProblem: false });
    expect(seen.events.map((e: { status: string }) => e.status)).toEqual([
      'awaiting_payment',
      'searching',
      'accepted',
      'on_the_way',
      'working',
      'completed',
    ]);
    expect(t.fake.transfers).toEqual([expect.objectContaining({ amountCents: 3731, accountId: expect.stringMatching(/^acct_/) })]);
    const earnings = (await call(t, 'GET', '/pro/earnings', { cookie: pro.cookie })).json().earnings;
    expect(earnings).toMatchObject({ sentCents: 3731, pendingCents: 0 });
  });

  it('charges approved extra work only, and pays the pro their share of it', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    await bookFirst();
    const bookingId = await acceptFirstOffer(pro.cookie);
    await walkToWorking(pro.cookie, bookingId);

    const ask = (description: string, priceCents: number) =>
      call(t, 'POST', `/pro/jobs/${bookingId}/extras`, { cookie: pro.cookie, body: { description, priceCents } });
    expect((await ask('Trim the front hedge', 2000)).statusCode).toBe(201);
    expect(errorOf(await ask('Water the pots', 500))).toBe('extra_already_pending');

    const [hedge] = (await booking(bookingId)).extras;
    const approved = await call(t, 'POST', `/bookings/${bookingId}/extras/${hedge.id}/approve`, { cookie: customer });
    expect(approved.json().booking).toMatchObject({ extrasCents: 2000, totalCents: 4840 + 2000 });
    expect(approved.json().payment).toBeNull();

    expect((await ask('Water the pots', 500)).statusCode).toBe(201);
    const pots = (await booking(bookingId)).extras[1];
    await call(t, 'POST', `/bookings/${bookingId}/extras/${pots.id}/decline`, { cookie: customer });
    expect((await ask('Clean the gutter', 1500)).statusCode).toBe(201);

    await upload(t, `/pro/jobs/${bookingId}/photos`, pro.cookie, FILES.png);
    await call(t, 'POST', `/pro/jobs/${bookingId}/complete`, { cookie: pro.cookie });
    await afterChargeDelay(bookingId);

    const seen = await booking(bookingId);
    expect(seen.extras.map((e: { status: string }) => e.status)).toEqual(['approved', 'declined', 'cancelled']);
    expect(seen.totalCents).toBe(6840);
    expect(t.fake.transfers.map((x) => x.amountCents).sort()).toEqual([1640, 3731]);
  });

  it('tries again later when the payment provider fails at charge time', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    await bookFirst();
    const bookingId = await acceptFirstOffer(pro.cookie);
    await walkToWorking(pro.cookie, bookingId);
    await upload(t, `/pro/jobs/${bookingId}/photos`, pro.cookie, FILES.png);
    const done = await call(t, 'POST', `/pro/jobs/${bookingId}/complete`, { cookie: pro.cookie });
    expect(done.json().job.status).toBe('completed');
    t.fake.failures.add('capture');
    await afterChargeDelay(bookingId);
    expect((await booking(bookingId)).paymentStatus).toBe('held');

    t.fake.failures.clear();
    await settleTick(t.deps);
    expect((await booking(bookingId)).paymentStatus).toBe('captured');
    expect(t.fake.transfers).toHaveLength(1);
  });

  it('takes one rating per finished job', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    await bookFirst();
    const bookingId = await acceptFirstOffer(pro.cookie);
    const early = await call(t, 'POST', `/bookings/${bookingId}/rating`, { cookie: customer, body: { stars: 5 } });
    expect(errorOf(early)).toBe('not_ratable');

    await walkToWorking(pro.cookie, bookingId);
    await upload(t, `/pro/jobs/${bookingId}/photos`, pro.cookie, FILES.png);
    await call(t, 'POST', `/pro/jobs/${bookingId}/complete`, { cookie: pro.cookie });
    const rated = await call(t, 'POST', `/bookings/${bookingId}/rating`, {
      cookie: customer,
      body: { stars: 5, tags: ['on_time', 'tidy'] },
    });
    expect(rated.json().booking).toMatchObject({ rating: { stars: 5, tags: ['on_time', 'tidy'] }, canRate: false });
    const again = await call(t, 'POST', `/bookings/${bookingId}/rating`, { cookie: customer, body: { stars: 1 } });
    expect(errorOf(again)).toBe('already_rated');
    const badTag = await call(t, 'POST', `/bookings/${bookingId}/rating`, { cookie: customer, body: { stars: 4, tags: ['rude'] } });
    expect(badTag.statusCode).toBe(400);
  });

  it('holds the charge when the customer reports a problem within 24 hours', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    await bookFirst();
    const bookingId = await acceptFirstOffer(pro.cookie);
    const early = await call(t, 'POST', `/bookings/${bookingId}/problem`, { cookie: customer, body: { note: 'Not done yet' } });
    expect(errorOf(early)).toBe('too_late_to_report');

    await walkToWorking(pro.cookie, bookingId);
    await upload(t, `/pro/jobs/${bookingId}/photos`, pro.cookie, FILES.png);
    await call(t, 'POST', `/pro/jobs/${bookingId}/complete`, { cookie: pro.cookie });
    const empty = await call(t, 'POST', `/bookings/${bookingId}/problem`, { cookie: customer, body: { note: '   ' } });
    expect(empty.statusCode).toBe(400);
    const reported = await call(t, 'POST', `/bookings/${bookingId}/problem`, {
      cookie: customer,
      body: { note: 'The back lawn was not mowed' },
    });
    expect(reported.json().booking).toMatchObject({ problemNote: 'The back lawn was not mowed', canReportProblem: false });
    const twice = await call(t, 'POST', `/bookings/${bookingId}/problem`, { cookie: customer, body: { note: 'Again' } });
    expect(errorOf(twice)).toBe('too_late_to_report');

    await afterChargeDelay(bookingId);
    expect((await booking(bookingId)).paymentStatus).toBe('held');
    expect(t.fake.transfers).toEqual([]);
  });

  it('lets nobody report a problem once the 24 hours are over', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    await bookFirst();
    const bookingId = await acceptFirstOffer(pro.cookie);
    await walkToWorking(pro.cookie, bookingId);
    await upload(t, `/pro/jobs/${bookingId}/photos`, pro.cookie, FILES.png);
    await call(t, 'POST', `/pro/jobs/${bookingId}/complete`, { cookie: pro.cookie });
    await t.pool.query("UPDATE bookings SET completed_at = now() - interval '25 hours' WHERE id = $1", [bookingId]);
    const late = await call(t, 'POST', `/bookings/${bookingId}/problem`, { cookie: customer, body: { note: 'Too late' } });
    expect(errorOf(late)).toBe('too_late_to_report');
  });
});

describe('cancelling', () => {
  it('lets the customer cancel before a pro is assigned, releasing the hold', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const created = await bookFirst();
    const cancelled = await call(t, 'POST', `/bookings/${created.id}/cancel`, { cookie: customer });
    expect(cancelled.json().booking).toMatchObject({ status: 'cancelled', paymentStatus: 'released', canCancel: false });
    expect(await pendingOffer(pro.cookie)).toBeUndefined();
    expect([...t.fake.intents.values()][0]?.status).toBe('released');
  });

  it('lets the customer cancel an assigned job for free until 24 hours before', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    await bookFirst();
    const bookingId = await acceptFirstOffer(pro.cookie);
    await t.pool.query("UPDATE bookings SET starts_at = now() + interval '30 hours', ends_at = now() + interval '31 hours'");
    expect((await booking(bookingId)).lateCancelCents).toBeNull();
    const cancelled = await call(t, 'POST', `/bookings/${bookingId}/cancel`, { cookie: customer });
    expect(cancelled.json().booking).toMatchObject({ status: 'cancelled', paymentStatus: 'released', lateCancel: false });
    const proText = await t.pool.query("SELECT 1 FROM notifications WHERE kind = 'booking_cancelled'");
    expect(proText.rowCount).toBe(1);
  });

  it('charges the full price for a late cancellation, once accepted, and pays the pro their share', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    await bookFirst();
    const bookingId = await acceptFirstOffer(pro.cookie);
    await t.pool.query("UPDATE bookings SET starts_at = now() + interval '10 hours', ends_at = now() + interval '11 hours'");
    expect((await booking(bookingId)).lateCancelCents).toBe(4840);
    expect(errorOf(await call(t, 'POST', `/bookings/${bookingId}/cancel`, { cookie: customer }))).toBe('late_cancel_charge');
    const bad = await call(t, 'POST', `/bookings/${bookingId}/cancel`, { cookie: customer, body: { acceptLateCharge: 'yes' } });
    expect(bad.statusCode).toBe(400);

    const cancelled = await call(t, 'POST', `/bookings/${bookingId}/cancel`, { cookie: customer, body: { acceptLateCharge: true } });
    expect(cancelled.json().booking).toMatchObject({ status: 'cancelled', paymentStatus: 'captured', lateCancel: true });
    // The pro gets 82% of the job price; MISK keeps the rest and the service fee.
    expect(t.fake.transfers).toEqual([expect.objectContaining({ amountCents: 3731 })]);
    const texts = await t.pool.query<{ body: string }>("SELECT body FROM notifications WHERE kind = 'booking_cancelled' ORDER BY created_at");
    expect(texts.rows.map((r) => r.body).join(' ')).toContain('€48.40 was charged');
    expect(texts.rows.map((r) => r.body).join(' ')).toContain('You still earn €37.31');
  });

  it('takes a tip on the saved card and gives the pro their share of it', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    await bookFirst();
    const bookingId = await acceptFirstOffer(pro.cookie);
    expect(errorOf(await call(t, 'POST', `/bookings/${bookingId}/tip`, { cookie: customer, body: { amountCents: 500 } }))).toBe('not_tippable');
    await walkToWorking(pro.cookie, bookingId);
    await upload(t, `/pro/jobs/${bookingId}/photos`, pro.cookie, FILES.png);
    await call(t, 'POST', `/pro/jobs/${bookingId}/complete`, { cookie: pro.cookie });
    expect((await booking(bookingId)).canTip).toBe(true);
    await t.pool.query('UPDATE settings SET pro_share_pct = 80');

    const tipped = await call(t, 'POST', `/bookings/${bookingId}/tip`, { cookie: customer, body: { amountCents: 500 } });
    expect(tipped.statusCode).toBe(201);
    expect(tipped.json().booking).toMatchObject({ tip: { amountCents: 500, proCents: 400, status: 'captured' }, canTip: false });
    expect(errorOf(await call(t, 'POST', `/bookings/${bookingId}/tip`, { cookie: customer, body: { amountCents: 500 } }))).toBe('already_tipped');
    expect((await call(t, 'POST', `/bookings/${bookingId}/tip`, { cookie: customer, body: { amountCents: 50 } })).statusCode).toBe(400);

    // Paid with the job, a day later; a refund of the job leaves the tip with the pro.
    await afterChargeDelay(bookingId);
    expect(t.fake.transfers.map((x) => x.amountCents).sort()).toEqual([3731, 400]);
    const admin = await signInAdmin(t);
    await call(t, 'POST', `/admin/bookings/${bookingId}/refund`, { cookie: admin });
    const tipTransfer = t.fake.transfers.find((x) => x.amountCents === 400);
    expect(tipTransfer?.reversed).toBe(false);
    const payoutTexts = await t.pool.query("SELECT 1 FROM notifications WHERE kind = 'payout_sent'");
    expect(payoutTexts.rowCount).toBeGreaterThanOrEqual(1);
  });

  it('lets admins cancel a job in progress', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    await bookFirst();
    const bookingId = await acceptFirstOffer(pro.cookie);
    await walkToWorking(pro.cookie, bookingId);
    const admin = await signInAdmin(t);
    const response = await call(t, 'POST', `/admin/bookings/${bookingId}/cancel`, { cookie: admin });
    expect(response.json().booking).toMatchObject({ status: 'cancelled', cancelledBy: 'admin', paymentStatus: 'released' });
  });
});

describe('card payments that need the customer', () => {
  beforeEach(() => t.fake.setInstantHolds(false));

  function webhook(eventId: string, event: unknown, signature = 'fake-signature') {
    return t.app.inject({
      method: 'POST',
      url: '/payments/webhook',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload: JSON.stringify({ eventId, event }),
    });
  }

  it('waits for the signed webhook before looking for a pro', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const response = await book(customer, await firstFreeSlot(customer, market.mowing));
    const { booking: created, payment } = response.json();
    expect(created.status).toBe('awaiting_payment');
    expect(payment.clientSecret).toMatch(/_secret$/);
    expect((await call(t, 'GET', `/bookings/${created.id}/payment`, { cookie: customer })).json().payment.clientSecret).toBe(
      payment.clientSecret,
    );
    expect(await pendingOffer(pro.cookie)).toBeUndefined();

    const intentId = [...t.fake.intents.keys()][0] ?? '';
    expect((await webhook('evt_1', { kind: 'hold_confirmed', intentId }, 'forged')).statusCode).toBe(400);
    expect((await webhook('evt_1', { kind: 'hold_confirmed', intentId })).statusCode).toBe(200);
    expect((await webhook('evt_1', { kind: 'hold_confirmed', intentId })).statusCode).toBe(200);
    expect((await booking(created.id)).status).toBe('searching');
    expect(await pendingOffer(pro.cookie)).toBeDefined();
    const offers = await t.pool.query('SELECT 1 FROM booking_offers');
    expect(offers.rowCount).toBe(1);
  });

  it('records a refused card and drops the booking after 30 minutes unpaid', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const { booking: created } = (await book(customer, await firstFreeSlot(customer, market.mowing))).json();
    const intentId = [...t.fake.intents.keys()][0] ?? '';
    await webhook('evt_2', { kind: 'payment_failed', intentId });
    expect((await booking(created.id)).paymentStatus).toBe('failed');

    await t.pool.query("UPDATE bookings SET created_at = now() - interval '31 minutes'");
    expect(await expireUnpaid(t.deps)).toBe(1);
    expect((await booking(created.id)).status).toBe('cancelled');
  });

  it('cancels the booking when the payment provider is down', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    t.fake.failures.add('hold');
    const response = await book(customer, await firstFreeSlot(customer, market.mowing));
    expect(response.statusCode).toBe(502);
    expect(errorOf(response)).toBe('payment_unavailable');
    const status = await t.pool.query('SELECT status, cancelled_by FROM bookings');
    expect(status.rows[0]).toEqual({ status: 'cancelled', cancelled_by: 'system' });
  });
});

describe('admin booking actions', () => {
  async function completedJob() {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    await bookFirst();
    const bookingId = await acceptFirstOffer(pro.cookie);
    await walkToWorking(pro.cookie, bookingId);
    await upload(t, `/pro/jobs/${bookingId}/photos`, pro.cookie, FILES.png);
    await call(t, 'POST', `/pro/jobs/${bookingId}/complete`, { cookie: pro.cookie });
    return { bookingId, pro };
  }

  async function chargedJob() {
    const job = await completedJob();
    await afterChargeDelay(job.bookingId);
    return job;
  }

  it('reports bookings, money and ratings on the overview', async () => {
    const { bookingId } = await chargedJob();
    await call(t, 'POST', `/bookings/${bookingId}/rating`, { cookie: customer, body: { stars: 4 } });
    const admin = await signInAdmin(t);
    const overview = (await call(t, 'GET', '/admin/overview?days=7', { cookie: admin })).json();
    expect(overview.kpis).toMatchObject({
      bookings: 1,
      completed: 1,
      grossCents: 4840,
      payoutCents: 3731,
      miskShareCents: 1109,
      ratingAverage: 4,
    });
    expect(overview.weekly).toHaveLength(8);
    const detail = (await call(t, 'GET', `/admin/bookings/${bookingId}`, { cookie: admin })).json().booking;
    expect(detail.customer.phone).toBe('+4915100000001');
    expect(detail.payouts).toEqual([expect.objectContaining({ amountCents: 3731, status: 'sent' })]);
    expect(detail.split).toEqual({ proCents: 3731, miskCents: 4840 - 3731 });
    expect(detail.number).toMatch(/^B-\d+$/);
  });

  it('refunds a finished job and takes the payout back', async () => {
    const { bookingId } = await chargedJob();
    const admin = await signInAdmin(t);
    const refunded = await call(t, 'POST', `/admin/bookings/${bookingId}/refund`, { cookie: admin });
    expect(refunded.json().booking).toMatchObject({ paymentStatus: 'refunded' });
    expect(refunded.json().booking.payouts[0].status).toBe('reversed');
    expect(refunded.json().booking.actions).toEqual([
      expect.objectContaining({ action: 'refunded', details: { amountCents: 4840, wasCharged: true }, adminName: 'admin' }),
    ]);
    expect(t.fake.transfers[0]?.reversed).toBe(true);
    expect(errorOf(await call(t, 'POST', `/admin/bookings/${bookingId}/refund`, { cookie: admin }))).toBe('not_refundable');
  });

  it('restarts the search for an unassigned booking', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const created = await bookFirst();
    const offer = await pendingOffer(pro.cookie);
    await call(t, 'POST', `/pro/offers/${offer?.id}/decline`, { cookie: pro.cookie });
    expect((await booking(created.id)).status).toBe('unassigned');

    const admin = await signInAdmin(t);
    const list = (await call(t, 'GET', '/admin/bookings?tab=needs_action', { cookie: admin })).json().bookings;
    expect(list.map((b: { id: string }) => b.id)).toEqual([created.id]);
    const restarted = await call(t, 'POST', `/admin/bookings/${created.id}/reassign`, { cookie: admin, body: {} });
    expect(restarted.json().booking.status).toBe('searching');
    expect(restarted.json().booking.actions.map((a: { action: string }) => a.action)).toEqual(['restarted_search']);
    expect(await pendingOffer(pro.cookie)).toBeDefined();
  });

  it('gives a job nobody took to a chosen pro and tells both sides', async () => {
    const first = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const created = await bookFirst();
    const offer = await pendingOffer(first.cookie);
    await call(t, 'POST', `/pro/offers/${offer?.id}/decline`, { cookie: first.cookie });
    const second = await approvedPro(t, '+4915100000102', { trades: [market.gardening], firstName: 'Jonas' });

    const admin = await signInAdmin(t);
    const candidates = (await call(t, 'GET', `/admin/bookings/${created.id}/candidates`, { cookie: admin })).json().candidates;
    expect(candidates.map((c: { id: string }) => c.id)).toContain(second.proId);
    const assigned = await call(t, 'POST', `/admin/bookings/${created.id}/reassign`, { cookie: admin, body: { proId: second.proId } });
    expect(assigned.json().booking).toMatchObject({ status: 'accepted', pro: { id: second.proId } });
    expect(assigned.json().booking.actions[0]).toMatchObject({ action: 'assigned', details: { proId: second.proId } });
    const toPro = await t.pool.query("SELECT body FROM notifications WHERE user_id = $1 AND body LIKE '%team gave you%'", [second.proId]);
    expect(toPro.rowCount).toBe(1);
    const toCustomer = await t.pool.query("SELECT body FROM notifications WHERE kind = 'pro_assigned' AND body LIKE 'MISK: Jonas%'");
    expect(toCustomer.rowCount).toBe(1);
  });

  it('moves a booking to a new time, keeping its length, and refuses past times', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const created = await bookFirst();
    const bookingId = await acceptFirstOffer(pro.cookie);
    const before = await booking(bookingId);
    const admin = await signInAdmin(t);
    const later = new Date(new Date(before.startsAt).getTime() + 3 * 24 * 3600 * 1000).toISOString();
    const moved = await call(t, 'POST', `/admin/bookings/${created.id}/reschedule`, { cookie: admin, body: { startsAt: later } });
    expect(moved.statusCode).toBe(200);
    const after = moved.json().booking;
    expect(after.startsAt).toBe(later);
    expect(new Date(after.endsAt).getTime() - new Date(after.startsAt).getTime()).toBe(
      new Date(before.endsAt).getTime() - new Date(before.startsAt).getTime(),
    );
    expect(after.actions[0]).toMatchObject({ action: 'rescheduled', details: { from: before.startsAt, to: later } });
    const past = await call(t, 'POST', `/admin/bookings/${created.id}/reschedule`, {
      cookie: admin,
      body: { startsAt: new Date(Date.now() - 3600 * 1000).toISOString() },
    });
    expect(errorOf(past)).toBe('time_in_past');
  });

  it('refuses a new time that double-books the pro', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const first = await bookFirst();
    await acceptFirstOffer(pro.cookie);
    const second = await bookFirst();
    await acceptFirstOffer(pro.cookie);
    const firstSeen = await booking(first.id);
    const admin = await signInAdmin(t);
    const clash = await call(t, 'POST', `/admin/bookings/${second.id}/reschedule`, {
      cookie: admin,
      body: { startsAt: firstSeen.startsAt },
    });
    expect(errorOf(clash)).toBe('pro_busy');
  });

  it('gives held money back on a finished job before it is charged', async () => {
    const { bookingId } = await completedJob();
    const admin = await signInAdmin(t);
    const refunded = await call(t, 'POST', `/admin/bookings/${bookingId}/refund`, { cookie: admin });
    expect(refunded.json().booking).toMatchObject({ paymentStatus: 'released' });
    expect(refunded.json().booking.actions[0]).toMatchObject({ action: 'refunded', details: { wasCharged: false } });
    await afterChargeDelay(bookingId);
    expect(t.fake.transfers).toEqual([]);
  });

  it('charges a job after the team settles the reported problem', async () => {
    const { bookingId } = await completedJob();
    await call(t, 'POST', `/bookings/${bookingId}/problem`, { cookie: customer, body: { note: 'Missed a corner' } });
    const admin = await signInAdmin(t);
    const listed = (await call(t, 'GET', '/admin/bookings?tab=needs_action', { cookie: admin })).json();
    expect(listed.bookings).toEqual([expect.objectContaining({ id: bookingId, problem: true })]);

    await t.pool.query("UPDATE bookings SET completed_at = now() - interval '25 hours' WHERE id = $1", [bookingId]);
    const charged = await call(t, 'POST', `/admin/bookings/${bookingId}/charge`, { cookie: admin });
    expect(charged.json().booking).toMatchObject({ paymentStatus: 'captured' });
    expect(charged.json().booking.actions[0].action).toBe('charged_after_problem');
    expect(errorOf(await call(t, 'POST', `/admin/bookings/${bookingId}/charge`, { cookie: admin }))).toBe('nothing_to_charge');
  });

  it('lists bookings by tab with counts, search and filters', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const upcoming = await bookFirst();
    await acceptFirstOffer(pro.cookie);
    const live = await bookFirst();
    await acceptFirstOffer(pro.cookie);
    await walkToWorking(pro.cookie, live.id);
    const admin = await signInAdmin(t);

    const all = (await call(t, 'GET', '/admin/bookings', { cookie: admin })).json();
    expect(all.counts).toEqual({ all: 2, needs_action: 0, live: 1, upcoming: 1, done: 0 });
    const row = all.bookings.find((b: { id: string }) => b.id === upcoming.id);
    expect(row).toMatchObject({
      kind: 'booking',
      number: expect.stringMatching(/^B-\d+$/),
      service: expect.any(String),
      trade: expect.any(String),
      customer: 'Sara',
      pro: expect.any(String),
      status: 'accepted',
      valueCents: 4840,
      paymentStatus: 'held',
      tab: 'upcoming',
    });

    const liveOnly = (await call(t, 'GET', '/admin/bookings?tab=live', { cookie: admin })).json();
    expect(liveOnly.bookings.map((b: { id: string }) => b.id)).toEqual([live.id]);
    expect(liveOnly.counts.all).toBe(2);

    const byNumber = (await call(t, 'GET', `/admin/bookings?q=${encodeURIComponent(row.number.toLowerCase())}`, { cookie: admin })).json();
    expect(byNumber.bookings.map((b: { id: string }) => b.id)).toEqual([upcoming.id]);
    const byAddress = (await call(t, 'GET', '/admin/bookings?q=linden', { cookie: admin })).json();
    expect(byAddress.counts.all).toBe(2);
    const nobody = (await call(t, 'GET', '/admin/bookings?q=zzzz', { cookie: admin })).json();
    expect(nobody).toMatchObject({ bookings: [], counts: { all: 0 } });

    const visitsOnly = (await call(t, 'GET', '/admin/bookings?type=visit', { cookie: admin })).json();
    expect(visitsOnly.counts.all).toBe(0);
    const otherTrade = (await call(t, 'GET', `/admin/bookings?trade=${market.plumbing}`, { cookie: admin })).json();
    expect(otherTrade.counts.all).toBe(0);
    expect((await call(t, 'GET', '/admin/bookings?tab=nope', { cookie: admin })).statusCode).toBe(400);
    expect((await call(t, 'GET', '/admin/bookings', { cookie: pro.cookie })).statusCode).toBe(403);
  });
});
