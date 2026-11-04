import { call, createTestContext, FILES, lastCode, resetDatabase, sessionCookie, upload, type TestContext } from '../../test/helpers.js';
import { DEMO_ADMIN, DEMO_CUSTOMER_PASSWORD, seedDemoData, type SeedSummary } from './demo-data.js';
import { emptyDatabase } from './reset.js';

let t: TestContext;
let summary: SeedSummary;

beforeAll(async () => {
  t = await createTestContext();
  await resetDatabase(t.pool);
  summary = await seedDemoData(t.pool, t.storage, { timezone: t.config.timezone });
  t.fake.addIntents(summary.intents);
}, 120_000);
afterAll(() => t.close());

async function adminCookie() {
  const response = await call(t, 'POST', '/auth/admin/login', { body: { username: DEMO_ADMIN.username, password: DEMO_ADMIN.password } });
  return sessionCookie(response);
}

async function phoneCookie(phone: string) {
  await call(t, 'POST', '/auth/phone/start', { body: { phone } });
  return sessionCookie(await call(t, 'POST', '/auth/phone/verify', { body: { phone, code: lastCode(t, phone) } }));
}

describe('demo data', () => {
  it('fills every part of the marketplace', async () => {
    expect(summary).toMatchObject({ postcodes: 8, categories: 6, services: 18, plans: 4, pros: 9, customers: 9 });
    expect(summary.bookings).toBeGreaterThan(60);
    expect(summary.ratings).toBeGreaterThan(40);
    const statuses = await t.pool.query<{ status: string }>('SELECT DISTINCT status FROM bookings ORDER BY status');
    expect(statuses.rows.map((r) => r.status)).toEqual([
      'accepted',
      'awaiting_payment',
      'cancelled',
      'completed',
      'on_the_way',
      'searching',
      'unassigned',
      'working',
    ]);
    const proStates = await t.pool.query<{ status: string }>('SELECT DISTINCT status FROM pro_profiles ORDER BY status');
    expect(proStates.rows.map((r) => r.status)).toEqual(['approved', 'draft', 'rejected', 'submitted']);
  });

  it('gives the admin overview real numbers and things needing attention', async () => {
    const overview = (await call(t, 'GET', '/admin/overview?days=30', { cookie: await adminCookie() })).json();
    expect(overview.kpis.completed).toBeGreaterThan(20);
    expect(overview.kpis.grossCents).toBeGreaterThan(overview.kpis.payoutCents);
    expect(overview.kpis.ratingAverage).toBeGreaterThan(4);
    expect(overview.weekly.filter((w: { bookings: number }) => w.bookings > 0).length).toBeGreaterThan(4);
    expect(overview.attention).toMatchObject({ pendingApplications: 1, unassigned: 1 });
  });

  it('signs in the demo customers by email and by phone, with their bookings', async () => {
    const byEmail = await call(t, 'POST', '/auth/login', { body: { email: 'anna@example.com', password: DEMO_CUSTOMER_PASSWORD } });
    expect(byEmail.statusCode).toBe(200);
    const bookings = (await call(t, 'GET', '/bookings', { cookie: sessionCookie(byEmail) })).json().bookings;
    expect(bookings.length).toBeGreaterThan(3);

    const sara = await phoneCookie('+4915100000001');
    const saraBookings = (await call(t, 'GET', '/bookings', { cookie: sara })).json().bookings as { status: string }[];
    expect(saraBookings.some((b) => b.status === 'working')).toBe(true);
  });

  it('leaves free slots, so new bookings can be made straight away', async () => {
    const anna = sessionCookie(await call(t, 'POST', '/auth/login', { body: { email: 'anna@example.com', password: DEMO_CUSTOMER_PASSWORD } }));
    const service = await t.pool.query<{ id: string }>("SELECT id FROM services WHERE name = 'Lawn mowing'");
    const slots = (await call(t, 'GET', `/availability?serviceId=${service.rows[0]?.id}&postcode=10115`, { cookie: anna })).json().slots;
    expect(slots.some((s: { available: boolean }) => s.available)).toBe(true);
  });

  it('lets the pro finish the job in progress, taking the payment and paying them', async () => {
    const daniel = await phoneCookie('+4915200000001');
    const working = await t.pool.query<{ id: string }>("SELECT id FROM bookings WHERE status = 'working'");
    const id = working.rows[0]?.id ?? '';
    expect((await upload(t, `/pro/jobs/${id}/photos`, daniel, FILES.png)).statusCode).toBe(201);
    const done = await call(t, 'POST', `/pro/jobs/${id}/complete`, { cookie: daniel });
    expect(done.json().job.status).toBe('completed');
    const paid = await t.pool.query("SELECT payment_status FROM bookings WHERE id = $1", [id]);
    expect(paid.rows[0].payment_status).toBe('captured');
  });

  it('serves the seeded documents and photos', async () => {
    const admin = await adminCookie();
    const doc = await t.pool.query<{ upload_id: string }>('SELECT upload_id FROM pro_documents LIMIT 1');
    const file = await call(t, 'GET', `/files/${doc.rows[0]?.upload_id}`, { cookie: admin });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    const photo = await t.pool.query<{ upload_id: string }>("SELECT upload_id FROM booking_photos WHERE kind = 'completion' LIMIT 1");
    expect((await call(t, 'GET', `/files/${photo.rows[0]?.upload_id}`, { cookie: admin })).headers['content-type']).toBe('image/png');
  });

  it('refuses to seed a database that already has data, and seeds again once emptied', async () => {
    const storage = t.storage;
    await expect(seedDemoData(t.pool, storage, { timezone: t.config.timezone })).rejects.toThrow('already has users');
    await emptyDatabase(t.pool);
    const again = await seedDemoData(t.pool, storage, { timezone: t.config.timezone });
    expect(again.bookings).toBe(summary.bookings);
  }, 120_000);
});
