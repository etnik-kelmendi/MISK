import { randomUUID } from 'node:crypto';
import {
  approvedPro,
  call,
  createTestContext,
  FILES,
  giveRating,
  resetDatabase,
  seedMarket,
  signIn,
  upload,
  type Market,
  type TestContext,
} from '../../test/helpers.js';
import { dispatchOnce } from '../notifications/outbox.js';
import type { PushMessage } from '../notifications/push.js';
import { BUFFER_MINUTES, computeArrival, distanceKm, travelMinutes } from './arrival.js';
import { pdfString } from './pdf.js';

/** D83: the gaps of the customer booking pages (pro photo, live arrival, chat photos, favourites, receipt). */

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
  t.emails.length = 0;
  market = await seedMarket(t.pool);
  customer = await signIn(t, '+4915100000001', 'customer', 'Sara');
});

const get = (url: string, cookie = customer) => call(t, 'GET', url, { cookie });
const post = (url: string, body?: unknown, cookie = customer) => call(t, 'POST', url, { cookie, ...(body === undefined ? {} : { body }) });
const view = async (bookingId: string) => (await get(`/bookings/${bookingId}`)).json().booking;

async function book() {
  const slots = (await get(`/availability?serviceId=${market.mowing}&postcode=10115`)).json().slots as { startsAt: string; available: boolean }[];
  const free = slots.find((s) => s.available);
  if (!free) throw new Error('No free slot');
  const created = await post('/bookings', { serviceId: market.mowing, size: 'M', address: '12 Linden Street', postcode: '10115', startsAt: free.startsAt });
  expect(created.statusCode).toBe(201);
  return created.json().booking.id as string;
}

async function assignedJob() {
  const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening], firstName: 'Daniel' });
  const bookingId = await book();
  const offer = (await get('/pro/offers', pro.cookie)).json().offers[0] as { id: string };
  expect((await post(`/pro/offers/${offer.id}/accept`, undefined, pro.cookie)).statusCode).toBe(200);
  return { bookingId, pro };
}

async function completedJob() {
  const job = await assignedJob();
  for (const status of ['on_the_way', 'working']) await post(`/pro/jobs/${job.bookingId}/status`, { status }, job.pro.cookie);
  await upload(t, `/pro/jobs/${job.bookingId}/photos`, job.pro.cookie, FILES.png);
  expect((await post(`/pro/jobs/${job.bookingId}/complete`, undefined, job.pro.cookie)).statusCode).toBe(200);
  return job;
}

/** Moves the booked start, keeping the job one hour long. */
async function startsIn(bookingId: string, minutes: number) {
  await t.pool.query(
    `UPDATE bookings SET starts_at = now() + make_interval(mins => $2), ends_at = now() + make_interval(mins => $2 + 60) WHERE id = $1`,
    [bookingId, minutes],
  );
}

describe("the pro's photo and number of jobs (D83)", () => {
  it('lets a pro upload, replace and remove a photo that only their customers can see', async () => {
    const { bookingId, pro } = await assignedJob();
    expect((await get('/pro/profile', pro.cookie)).json().profile.photoId).toBeNull();
    expect((await upload(t, '/pro/photo', pro.cookie, FILES.text, 'me.txt')).json()).toEqual({ error: 'file_type_not_allowed' });

    const first = await upload(t, '/pro/photo', pro.cookie, FILES.png, 'me.png');
    expect(first.statusCode).toBe(201);
    const firstId = first.json().profile.photoId as string;
    expect(firstId).toEqual(expect.any(String));
    expect((await view(bookingId)).pro).toMatchObject({ photoId: firstId, firstName: 'Daniel' });
    expect((await get(`/files/${firstId}`)).statusCode).toBe(200);
    const stranger = await signIn(t, '+4915100000002', 'customer');
    expect((await get(`/files/${firstId}`, stranger)).statusCode).toBe(404);

    // A new photo replaces the old one, whose file is gone.
    const second = (await upload(t, '/pro/photo', pro.cookie, FILES.jpeg, 'me.jpg')).json().profile.photoId as string;
    expect(second).not.toBe(firstId);
    expect((await get(`/files/${firstId}`, pro.cookie)).statusCode).toBe(404);
    expect((await t.pool.query('SELECT 1 FROM uploads WHERE id = $1', [firstId])).rowCount).toBe(0);

    const removed = await call(t, 'DELETE', '/pro/photo', { cookie: pro.cookie });
    expect(removed.json().profile.photoId).toBeNull();
    expect((await view(bookingId)).pro.photoId).toBeNull();
    expect((await t.pool.query('SELECT 1 FROM uploads WHERE id = $1', [second])).rowCount).toBe(0);
    // Customers cannot use the pro's photo route.
    expect((await upload(t, '/pro/photo', customer, FILES.png)).statusCode).toBe(403);
  });

  it("counts the pro's finished jobs", async () => {
    const { bookingId, pro } = await assignedJob();
    expect((await view(bookingId)).pro.jobsDone).toBe(0);
    await giveRating(t.pool, pro.proId, 5);
    await giveRating(t.pool, pro.proId, 4);
    expect((await view(bookingId)).pro).toMatchObject({ jobsDone: 2, ratingCount: 2, ratingAverage: 4.5 });
  });
});

describe('arrival time (D83)', () => {
  const destination = { lat: 52.5323, lng: 13.3846 };
  const start = new Date('2026-11-19T10:00:00Z');

  it('drives the straight-line distance times 1.4 at 25 km/h, plus 3 minutes, from a recent position', () => {
    const position = { lat: 52.418, lng: 13.26, at: new Date('2026-11-19T09:59:00Z') };
    const now = new Date('2026-11-19T10:00:00Z');
    const arrival = computeArrival({ status: 'on_the_way', startsAt: start, now, position, destination });
    const minutes = ((distanceKm(position, destination) * 1.4) / 25) * 60 + BUFFER_MINUTES;
    expect(travelMinutes(position, destination)).toBeCloseTo(minutes, 6);
    expect(arrival).toMatchObject({ source: 'live', proPosition: position, destination, lateMinutes: Math.round(minutes) });
    expect(Math.abs((arrival?.expectedAt.getTime() ?? 0) - (now.getTime() + minutes * 60_000))).toBeLessThan(1);
    // About 15 km away: well over half an hour late.
    expect(arrival?.lateMinutes).toBeGreaterThan(30);
  });

  it('uses the booked start without a recent position, and counts a pro who has not set off after the start', () => {
    const stale = { lat: 52.53, lng: 13.38, at: new Date('2026-11-19T09:40:00Z') };
    const early = computeArrival({ status: 'on_the_way', startsAt: start, now: new Date('2026-11-19T09:46:00Z'), position: stale, destination });
    expect(early).toEqual({ expectedAt: start, lateMinutes: 0, source: 'booked', destination });

    const notSetOff = computeArrival({ status: 'accepted', startsAt: start, now: new Date('2026-11-19T10:15:00Z'), position: null, destination });
    expect(notSetOff).toMatchObject({ source: 'booked', lateMinutes: 15, expectedAt: new Date('2026-11-19T10:15:00Z') });
    expect(notSetOff?.proPosition).toBeUndefined();

    expect(computeArrival({ status: 'working', startsAt: start, now: start, position: null, destination })).toBeNull();
    expect(computeArrival({ status: 'searching', startsAt: start, now: start, position: null, destination })).toBeNull();
  });
});

describe("the pro's live location (D83)", () => {
  it('is shared by the job pro only while on the way, checked, shown to the customer and cleared afterwards', async () => {
    const { bookingId, pro } = await assignedJob();
    const share = (body: unknown, cookie = pro.cookie) => post(`/pro/jobs/${bookingId}/location`, body, cookie);
    expect((await share({ lat: 52.52, lng: 13.39, accuracy: 20 })).json()).toEqual({ error: 'invalid_status' });

    await post(`/pro/jobs/${bookingId}/status`, { status: 'on_the_way' }, pro.cookie);
    expect((await share({ lat: 91, lng: 13.39 })).statusCode).toBe(400);
    expect((await share({ lat: 52.52, lng: -181 })).statusCode).toBe(400);
    expect((await share({ lat: 52.52, lng: 13.39, accuracy: -1 })).statusCode).toBe(400);
    expect((await share({ lat: '52.5', lng: 13.39 })).statusCode).toBe(400);
    expect((await share({ lat: 52.52, lng: 13.39, speed: 3 })).statusCode).toBe(400);
    const otherPro = await approvedPro(t, '+4915100000102', { trades: [market.gardening] });
    expect((await share({ lat: 52.52, lng: 13.39 }, otherPro.cookie)).statusCode).toBe(404);
    expect((await share({ lat: 52.52, lng: 13.39 }, customer)).statusCode).toBe(403);

    expect((await share({ lat: 52.52, lng: 13.39, accuracy: 15 })).statusCode).toBe(204);
    const arrival = (await view(bookingId)).arrival;
    expect(arrival).toMatchObject({
      source: 'live',
      proPosition: { lat: 52.52, lng: 13.39, at: expect.any(String) },
      destination: { lat: 52.5323, lng: 13.3846 },
    });
    const minutes = (new Date(arrival.expectedAt).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(3);
    expect(minutes).toBeLessThan(10);

    // A second point within 5 seconds is accepted but ignored, so the app cannot flood the server.
    expect((await share({ lat: 52.6, lng: 13.5 })).statusCode).toBe(204);
    expect((await view(bookingId)).arrival.proPosition).toMatchObject({ lat: 52.52, lng: 13.39 });

    // An old position is not shown: the booked start counts again.
    await t.pool.query("UPDATE bookings SET pro_location_at = now() - interval '6 minutes' WHERE id = $1", [bookingId]);
    const stale = (await view(bookingId)).arrival;
    expect(stale.source).toBe('booked');
    expect(stale.proPosition).toBeUndefined();

    // Once the pro arrives, the position is deleted.
    await share({ lat: 52.53, lng: 13.38 });
    await post(`/pro/jobs/${bookingId}/status`, { status: 'working' }, pro.cookie);
    const stored = await t.pool.query('SELECT pro_lat, pro_lng, pro_location_at FROM bookings WHERE id = $1', [bookingId]);
    expect(stored.rows[0]).toEqual({ pro_lat: null, pro_lng: null, pro_location_at: null });
    expect((await view(bookingId)).arrival).toBeNull();
    expect((await share({ lat: 52.53, lng: 13.38 })).json()).toEqual({ error: 'invalid_status' });
  });

  it('is deleted when the job is cancelled on the way', async () => {
    const { bookingId, pro } = await assignedJob();
    // Two days ahead, so cancelling is free.
    await startsIn(bookingId, 48 * 60);
    await post(`/pro/jobs/${bookingId}/status`, { status: 'on_the_way' }, pro.cookie);
    await post(`/pro/jobs/${bookingId}/location`, { lat: 52.52, lng: 13.39 }, pro.cookie);
    await post(`/bookings/${bookingId}/cancel`, {});
    const stored = await t.pool.query('SELECT status, pro_lat FROM bookings WHERE id = $1', [bookingId]);
    expect(stored.rows[0]).toEqual({ status: 'cancelled', pro_lat: null });
  });
});

describe('cancelling when the pro is late (D83)', () => {
  it('is free when the pro is more than 30 minutes late, without accepting a charge', async () => {
    const { bookingId } = await assignedJob();
    // The pro has not set off, 40 minutes after the start.
    await startsIn(bookingId, -40);
    const before = await view(bookingId);
    expect(before.arrival.lateMinutes).toBeGreaterThanOrEqual(40);
    expect(before).toMatchObject({ canCancel: true, lateCancelCents: null, freeCancelProLate: true });

    const intent = (await t.pool.query<{ payment_intent_id: string }>('SELECT payment_intent_id FROM bookings WHERE id = $1', [bookingId])).rows[0];
    const cancelled = await post(`/bookings/${bookingId}/cancel`, {});
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().booking).toMatchObject({ status: 'cancelled', lateCancel: false });
    expect(t.fake.intents.get(intent?.payment_intent_id ?? '')?.status).toBe('released');
  });

  it('is free when a live position puts the pro more than 30 minutes behind', async () => {
    const { bookingId, pro } = await assignedJob();
    await startsIn(bookingId, 0);
    await post(`/pro/jobs/${bookingId}/status`, { status: 'on_the_way' }, pro.cookie);
    // Zehlendorf to Mitte: about 15 km, so about 53 minutes.
    await post(`/pro/jobs/${bookingId}/location`, { lat: 52.418, lng: 13.26 }, pro.cookie);
    expect((await view(bookingId)).arrival.lateMinutes).toBeGreaterThan(30);
    expect((await post(`/bookings/${bookingId}/cancel`, {})).json().booking).toMatchObject({ status: 'cancelled', lateCancel: false });
  });

  it('still costs the full price less than 24 hours ahead when the pro is not that late', async () => {
    const { bookingId } = await assignedJob();
    await startsIn(bookingId, -20);
    const late = await view(bookingId);
    expect(late.arrival.lateMinutes).toBeGreaterThanOrEqual(20);
    expect(late.arrival.lateMinutes).toBeLessThanOrEqual(30);
    expect(late.freeCancelProLate).toBe(false);
    expect(late.lateCancelCents).toBe(late.priceCents + late.feeCents);
    expect((await post(`/bookings/${bookingId}/cancel`, {})).json()).toEqual({ error: 'late_cancel_charge' });

    await startsIn(bookingId, 120);
    expect((await post(`/bookings/${bookingId}/cancel`, {})).json()).toEqual({ error: 'late_cancel_charge' });
    expect((await post(`/bookings/${bookingId}/cancel`, { acceptLateCharge: true })).json().booking).toMatchObject({ lateCancel: true });
  });
});

describe('chat photos and read-only chat (D83)', () => {
  it('sends photos both ways that only the two sides can open, and links the message to the chat', async () => {
    const { bookingId, pro } = await assignedJob();
    await t.pool.query(
      "INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, 'https://push.example.com/pro', 'BKey', 'auth1')",
      [pro.proId],
    );
    expect((await upload(t, `/bookings/${bookingId}/messages/photo`, customer, FILES.text, 'note.txt')).json()).toEqual({
      error: 'file_type_not_allowed',
    });
    const sent = await upload(t, `/bookings/${bookingId}/messages/photo`, customer, FILES.png, 'gate.png');
    expect(sent.statusCode).toBe(201);
    const message = sent.json().message;
    expect(message).toMatchObject({ from: 'customer', body: null, photoId: expect.any(String) });

    const proView = (await get(`/pro/jobs/${bookingId}/messages`, pro.cookie)).json();
    expect(proView.messages).toEqual([expect.objectContaining({ photoId: message.photoId, body: null })]);
    expect((await get(`/files/${message.photoId}`, pro.cookie)).statusCode).toBe(200);
    expect((await get(`/files/${message.photoId}`)).statusCode).toBe(200);
    const stranger = await signIn(t, '+4915100000002', 'customer');
    expect((await get(`/files/${message.photoId}`, stranger)).statusCode).toBe(404);
    const otherPro = await approvedPro(t, '+4915100000102', { trades: [market.gardening] });
    expect((await get(`/files/${message.photoId}`, otherPro.cookie)).statusCode).toBe(404);
    expect((await upload(t, `/bookings/${bookingId}/messages/photo`, stranger, FILES.png)).statusCode).toBe(404);

    // The pro is told in the app and by push, with the way into their chat.
    const proInbox = (await get('/inbox', pro.cookie)).json().messages;
    expect(proInbox[0]).toMatchObject({ kind: 'chat_message', body: 'MISK: Sara sent a photo about Lawn mowing.', link: `/pro/jobs/${bookingId}/chat` });
    const pushed: PushMessage[] = [];
    await dispatchOnce(
      t.pool,
      {
        sms: null,
        email: null,
        push: async (_target, push) => {
          pushed.push(push);
        },
      },
      { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    );
    expect(pushed).toEqual([{ title: 'MISK', body: 'MISK: Sara sent a photo about Lawn mowing.', url: `/pro/jobs/${bookingId}/chat` }]);

    // And the other way round, text too.
    expect((await upload(t, `/pro/jobs/${bookingId}/messages/photo`, pro.cookie, FILES.jpeg, 'hedge.jpg')).statusCode).toBe(201);
    await post(`/pro/jobs/${bookingId}/messages`, { body: 'This hedge?' }, pro.cookie);
    const mine = (await get('/inbox')).json().messages as { body: string; link: string | null }[];
    expect(mine.slice(0, 2)).toEqual([
      expect.objectContaining({ body: 'MISK: Daniel about Lawn mowing: This hedge?', link: `/bookings/${bookingId}/chat` }),
      expect.objectContaining({ body: 'MISK: Daniel sent a photo about Lawn mowing.', link: `/bookings/${bookingId}/chat` }),
    ]);
    const all = (await get(`/bookings/${bookingId}/messages`)).json().messages as { photoId: string | null }[];
    expect(all.map((m) => m.photoId !== null)).toEqual([true, true, false]);
  });

  it('is read-only once the job is done or cancelled, while the messages stay readable', async () => {
    const job = await assignedJob();
    await post(`/bookings/${job.bookingId}/messages`, { body: 'See you at 10' });
    for (const status of ['on_the_way', 'working']) await post(`/pro/jobs/${job.bookingId}/status`, { status }, job.pro.cookie);
    // Still open while working.
    expect((await get(`/bookings/${job.bookingId}/messages`)).json().canWrite).toBe(true);
    await upload(t, `/pro/jobs/${job.bookingId}/photos`, job.pro.cookie, FILES.png);
    await post(`/pro/jobs/${job.bookingId}/complete`, undefined, job.pro.cookie);

    const after = (await get(`/bookings/${job.bookingId}/messages`)).json();
    expect(after).toMatchObject({ canWrite: false, messages: [expect.objectContaining({ body: 'See you at 10' })] });
    expect((await get(`/pro/jobs/${job.bookingId}/messages`, job.pro.cookie)).json().canWrite).toBe(false);
    expect((await post(`/bookings/${job.bookingId}/messages`, { body: 'Thanks!' })).json()).toEqual({ error: 'chat_closed' });
    expect((await post(`/pro/jobs/${job.bookingId}/messages`, { body: 'Bye' }, job.pro.cookie)).json()).toEqual({ error: 'chat_closed' });
    expect((await upload(t, `/bookings/${job.bookingId}/messages/photo`, customer, FILES.png)).json()).toEqual({ error: 'chat_closed' });
  });
});

describe('extra work duration (D83)', () => {
  it('needs how long the extra work takes, from 5 minutes to 8 hours, and shows it to the customer', async () => {
    const { bookingId, pro } = await assignedJob();
    const ask = (body: Record<string, unknown>) => post(`/pro/jobs/${bookingId}/extras`, body, pro.cookie);
    expect((await ask({ description: 'Trim the hedge', priceCents: 2000 })).statusCode).toBe(400);
    expect((await ask({ description: 'Trim the hedge', priceCents: 2000, durationMinutes: 4 })).statusCode).toBe(400);
    expect((await ask({ description: 'Trim the hedge', priceCents: 2000, durationMinutes: 481 })).statusCode).toBe(400);
    expect((await ask({ description: 'Trim the hedge', priceCents: 2000, durationMinutes: 30.5 })).statusCode).toBe(400);
    expect((await ask({ description: 'Trim the hedge', priceCents: 2000, durationMinutes: 30 })).statusCode).toBe(201);
    expect((await view(bookingId)).extras).toEqual([expect.objectContaining({ description: 'Trim the hedge', durationMinutes: 30, status: 'pending' })]);

    // Requests from before have no duration.
    await call(t, 'POST', `/bookings/${bookingId}/extras/${(await view(bookingId)).extras[0].id}/decline`, { cookie: customer });
    await t.pool.query("INSERT INTO extra_requests (booking_id, description, price_cents, status) VALUES ($1, 'Old request', 500, 'declined')", [bookingId]);
    const extras = (await view(bookingId)).extras as { description: string; durationMinutes: number | null }[];
    expect(extras.find((e) => e.description === 'Old request')?.durationMinutes).toBeNull();
  });
});

describe('favourite pros (D83)', () => {
  it('saves only a pro who did a job for the customer, toggles, and lists them', async () => {
    const { bookingId, pro } = await assignedJob();
    const save = (proId: string, cookie = customer) => call(t, 'PUT', `/favourites/pros/${proId}`, { cookie });
    // Booked, but no job done yet.
    expect((await save(pro.proId)).json()).toEqual({ error: 'not_your_pro' });
    expect((await view(bookingId)).pro.isFavourite).toBe(false);

    for (const status of ['on_the_way', 'working']) await post(`/pro/jobs/${bookingId}/status`, { status }, pro.cookie);
    await upload(t, `/pro/jobs/${bookingId}/photos`, pro.cookie, FILES.png);
    await post(`/pro/jobs/${bookingId}/complete`, undefined, pro.cookie);

    expect((await save(pro.proId)).json()).toEqual({ favourite: true });
    expect((await save(pro.proId)).json()).toEqual({ favourite: true });
    expect((await view(bookingId)).pro.isFavourite).toBe(true);
    expect((await get('/favourites/pros')).json().pros).toEqual([
      expect.objectContaining({ id: pro.proId, firstName: 'Daniel', photoId: null, savedAt: expect.any(String) }),
    ]);

    // Another customer cannot save this pro, nor a made-up one.
    const stranger = await signIn(t, '+4915100000002', 'customer');
    expect((await save(pro.proId, stranger)).statusCode).toBe(404);
    expect((await save(randomUUID())).statusCode).toBe(404);
    // A pro booking help for their own home is a customer too (D64), but not their own customer.
    expect((await save(pro.proId, pro.cookie)).statusCode).toBe(404);
    expect((await call(t, 'PUT', '/favourites/pros/not-a-uuid', { cookie: customer })).statusCode).toBe(400);

    expect((await call(t, 'DELETE', `/favourites/pros/${pro.proId}`, { cookie: customer })).json()).toEqual({ favourite: false });
    expect((await call(t, 'DELETE', `/favourites/pros/${pro.proId}`, { cookie: customer })).json()).toEqual({ favourite: false });
    expect((await view(bookingId)).pro.isFavourite).toBe(false);
    expect((await get('/favourites/pros')).json().pros).toEqual([]);
  });
});

describe('the payment method on the receipt (D83)', () => {
  it('shows the card, caches it, and puts it in the PDF and the email', async () => {
    const { bookingId } = await completedJob();
    const receipt = (await get(`/bookings/${bookingId}/receipt`)).json().receipt;
    expect(receipt.paymentMethod).toEqual({ brand: 'visa', last4: '4242', wallet: null, label: 'Visa •••• 4242' });
    await get(`/bookings/${bookingId}/receipt`);
    // Asked once, then read from the booking.
    expect(t.fake.methodLookups).toHaveLength(1);

    const pdf = (await get(`/bookings/${bookingId}/receipt.pdf`)).rawPayload.toString('latin1');
    expect(pdf).toContain(pdfString('Payment method: Visa •••• 4242'));

    await t.pool.query("UPDATE users SET email = 'sara@example.com' WHERE phone = '+4915100000001'");
    await post(`/bookings/${bookingId}/receipt/email`);
    expect(t.emails.at(-1)?.text).toContain('Payment method: Visa •••• 4242');
  });

  it('names the wallet, and leaves the method out when the provider cannot say', async () => {
    const { bookingId } = await completedJob();
    const intentId = (await t.pool.query<{ payment_intent_id: string }>('SELECT payment_intent_id FROM bookings WHERE id = $1', [bookingId]))
      .rows[0]?.payment_intent_id;
    t.fake.failures.add('paymentMethod');
    expect((await get(`/bookings/${bookingId}/receipt`)).json().receipt.paymentMethod).toBeNull();

    t.fake.failures.delete('paymentMethod');
    t.fake.setPaymentMethod(intentId ?? '', { brand: 'visa', last4: '4242', wallet: 'apple_pay' });
    expect((await get(`/bookings/${bookingId}/receipt`)).json().receipt.paymentMethod.label).toBe('Apple Pay · Visa •••• 4242');
  });

  it('writes the bullet into the PDF in its WinAnsi code', () => {
    expect(pdfString('•••• 4242')).toBe('(\\225\\225\\225\\225 4242)');
  });
});
