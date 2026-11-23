import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  upload,
  type Market,
  type TestContext,
} from '../../test/helpers.js';
import { MAX_ADDRESSES } from './addresses.js';

/** D89: the customer Home page — saved addresses, plans banner, top-rated pros, trade order, picked pro. */

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
const patch = (url: string, body: unknown, cookie = customer) => call(t, 'PATCH', url, { cookie, body });
const del = (url: string, cookie = customer) => call(t, 'DELETE', url, { cookie });

async function addAddress(body: Record<string, unknown>, cookie = customer) {
  const response = await post('/addresses', body, cookie);
  expect(response.statusCode).toBe(201);
  return response.json().address as { id: string; selected: boolean };
}

describe('saved addresses', () => {
  it('adds, edits, selects and removes addresses, keeping one selected', async () => {
    expect((await get('/addresses')).json()).toEqual({ addresses: [], max: MAX_ADDRESSES });

    const home = await addAddress({ label: ' Home ', address: ' 12 Linden Street ', postcode: ' 10115 ' });
    // The first address is selected straight away.
    expect(home).toMatchObject({ label: 'Home', address: '12 Linden Street', postcode: '10115', areaName: 'Mitte', served: true, selected: true });
    const work = await addAddress({ label: 'Work', address: '5 Unter den Linden', postcode: '10117' });
    expect(work.selected).toBe(false);
    const stored = await t.pool.query('SELECT lat, lng FROM customer_addresses WHERE id = $1', [work.id]);
    expect(stored.rows[0]).toEqual({ lat: 52.517, lng: 13.3889 });

    expect((await post(`/addresses/${work.id}/select`)).json().address.selected).toBe(true);
    const list = (await get('/addresses')).json().addresses as { id: string; selected: boolean }[];
    expect(list.map((a) => [a.id, a.selected])).toEqual([
      [home.id, false],
      [work.id, true],
    ]);

    const edited = await patch(`/addresses/${home.id}`, { label: '', address: '14 Linden Street', postcode: '14167' });
    expect(edited.json().address).toMatchObject({ label: null, address: '14 Linden Street', postcode: '14167', areaName: 'Zehlendorf' });

    // Removing the selected address selects the one left.
    expect((await del(`/addresses/${work.id}`)).statusCode).toBe(204);
    expect((await get('/addresses')).json().addresses).toEqual([expect.objectContaining({ id: home.id, selected: true })]);
    expect((await del(`/addresses/${home.id}`)).statusCode).toBe(204);
    expect((await get('/addresses')).json().addresses).toEqual([]);
  });

  it('checks the address and postcode, and only takes postcodes MISK serves', async () => {
    expect((await post('/addresses', { address: '12 Linden Street', postcode: '!!' })).json()).toEqual({ error: 'postcode_invalid' });
    expect((await post('/addresses', { address: '12 Linden Street', postcode: '99999' })).json()).toEqual({ error: 'postcode_not_served' });
    await t.pool.query("UPDATE postcodes SET active = false WHERE code = '14167'");
    expect((await post('/addresses', { address: '12 Linden Street', postcode: '14167' })).json()).toEqual({ error: 'postcode_not_served' });
    expect((await post('/addresses', { address: '  ', postcode: '10115' })).statusCode).toBe(400);
    expect((await post('/addresses', { address: '12 Linden Street', postcode: '10115', label: 'x'.repeat(31) })).statusCode).toBe(400);
    expect((await post('/addresses', { address: '12 Linden Street', postcode: '10115', extra: true })).statusCode).toBe(400);
    const saved = await addAddress({ address: '12 Linden Street', postcode: '10115' });
    expect((await patch(`/addresses/${saved.id}`, { postcode: '99999' })).json()).toEqual({ error: 'postcode_not_served' });
    expect((await patch(`/addresses/${saved.id}`, {})).statusCode).toBe(400);
    expect((await get('/addresses')).json().addresses).toHaveLength(1);
  });

  it(`keeps at most ${MAX_ADDRESSES} addresses`, async () => {
    for (let i = 1; i <= MAX_ADDRESSES; i += 1) await addAddress({ address: `${i} Linden Street`, postcode: '10115' });
    expect((await post('/addresses', { address: '99 Linden Street', postcode: '10115' })).json()).toEqual({ error: 'address_limit' });
    const rows = await t.pool.query('SELECT count(*)::int AS n, count(*) FILTER (WHERE is_selected)::int AS selected FROM customer_addresses');
    expect(rows.rows[0]).toEqual({ n: MAX_ADDRESSES, selected: 1 });
  });

  it("never shows or changes another customer's address", async () => {
    const mine = await addAddress({ address: '12 Linden Street', postcode: '10115' });
    const other = await signIn(t, '+4915100000002', 'customer', 'Tom');
    expect((await get('/addresses', other)).json().addresses).toEqual([]);
    expect((await patch(`/addresses/${mine.id}`, { address: 'Hacked Road 1' }, other)).statusCode).toBe(404);
    expect((await post(`/addresses/${mine.id}/select`, undefined, other)).statusCode).toBe(404);
    expect((await del(`/addresses/${mine.id}`, other)).statusCode).toBe(404);
    expect((await get('/addresses')).json().addresses).toEqual([expect.objectContaining({ address: '12 Linden Street' })]);
    expect((await get('/addresses', '')).statusCode).toBe(401);
    expect((await get(`/addresses/${randomUUID()}`)).statusCode).toBe(404);
  });

  it("saves a customer's first booking address and selects it", async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const slots = (await get(`/availability?serviceId=${market.mowing}&postcode=10115`)).json().slots as { startsAt: string; available: boolean }[];
    const free = slots.find((s) => s.available);
    const booked = await post('/bookings', { serviceId: market.mowing, size: 'M', address: '12 Linden Street', postcode: '10115', startsAt: free?.startsAt });
    expect(booked.statusCode).toBe(201);
    expect((await get('/addresses')).json().addresses).toEqual([
      expect.objectContaining({ address: '12 Linden Street', postcode: '10115', selected: true }),
    ]);
  });

  it('starts existing customers with the address of their latest booking or plan (migration 0042)', async () => {
    const migration = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', '0042_home_page.sql'), 'utf8');
    const backfill = migration.slice(migration.indexOf('INSERT INTO customer_addresses'), migration.indexOf(';', migration.indexOf('INSERT INTO customer_addresses')));
    const users = await t.pool.query<{ id: string }>(
      "INSERT INTO users (phone, role, first_name) VALUES ('+4915000099001', 'customer', 'Old'), ('+4915000099002', 'customer', 'New') RETURNING id",
    );
    const [old, fresh] = users.rows.map((row) => row.id);
    for (const [address, postcode, daysAgo] of [
      ['1 First Street', '10115', 30],
      ['2 Latest Street', '10117', 2],
    ] as const) {
      await t.pool.query(
        `INSERT INTO bookings (customer_id, service_id, category_id, service_name, size, address, postcode, starts_at, ends_at,
           status, price_cents, fee_cents, pro_share_pct, created_at)
         VALUES ($1, $2, $3, 'Lawn mowing', 'M', $4, $5, now(), now() + interval '1 hour', 'cancelled', 3500, 290, 82,
           now() - make_interval(days => $6))`,
        [old, market.mowing, market.gardening, address, postcode, daysAgo],
      );
    }
    await t.pool.query(backfill);
    const rows = await t.pool.query('SELECT customer_id, label, address, postcode, is_selected FROM customer_addresses ORDER BY customer_id');
    expect(rows.rows).toEqual([{ customer_id: old, label: 'Home', address: '2 Latest Street', postcode: '10117', is_selected: true }]);
    expect(rows.rows.some((row) => row.customer_id === fresh)).toBe(false);
  });
});

describe('Home', () => {
  async function plan(name: string, priceCents: number, status: 'draft' | 'published' = 'published', categoryId = market.gardening) {
    await t.pool.query(
      `INSERT INTO plans (name, category_id, price_cents, frequency, visit_minutes, tasks, status, published_at)
       VALUES ($1, $2, $3, 'weekly', 60, '{Mow}', $4, CASE WHEN $4 = 'published' THEN now() END)`,
      [name, categoryId, priceCents, status],
    );
  }

  it('shows the published plan with the lowest starting price in the banner', async () => {
    expect((await get('/home')).json().plan).toBeNull();
    await plan('Lawn care', 5800);
    await plan('Cheap draft', 1000, 'draft');
    await plan('Plumbing check', 4900, 'published', market.plumbing);
    await t.pool.query('UPDATE categories SET active = false WHERE id = $1', [market.plumbing]);
    // A small garden is 15% less than the plan price: €58 → €49.30.
    expect((await get('/home')).json().plan).toEqual({ id: expect.any(String), name: 'Lawn care', categoryId: market.gardening, fromCents: 4930 });
  });

  it('ranks the pros working at the selected address, with the favourite flag, and leaves out others', async () => {
    // No address: no "near you".
    expect((await get('/home')).json().pros).toEqual([]);
    await addAddress({ address: '12 Linden Street', postcode: '10115' });

    const top = await approvedPro(t, '+4915100000101', { trades: [market.gardening, market.plumbing], firstName: 'Daniel' });
    const few = await approvedPro(t, '+4915100000102', { trades: [market.gardening], firstName: 'Arta' });
    const good = await approvedPro(t, '+4915100000103', { trades: [market.plumbing], firstName: 'Ben' });
    const far = await approvedPro(t, '+4915100000104', { trades: [market.gardening], firstName: 'Far', postcode: '14167', radiusKm: 3 });
    const suspended = await approvedPro(t, '+4915100000105', { trades: [market.gardening], firstName: 'Gent' });
    const disabled = await approvedPro(t, '+4915100000106', { trades: [market.gardening], firstName: 'Ilir' });
    for (const stars of [5, 5, 5]) await giveRating(t.pool, top.proId, stars);
    for (const stars of [4, 4, 4]) await giveRating(t.pool, good.proId, stars);
    // Two perfect ratings are not enough to outrank pros with three or more.
    for (const stars of [5, 5]) await giveRating(t.pool, few.proId, stars);
    for (const stars of [5, 5, 5]) await giveRating(t.pool, far.proId, stars);
    await t.pool.query("UPDATE pro_profiles SET status = 'suspended' WHERE user_id = $1", [suspended.proId]);
    await t.pool.query('UPDATE users SET disabled_at = now() WHERE id = $1', [disabled.proId]);
    await t.pool.query("UPDATE users SET last_name = 'Krasniqi' WHERE id = $1", [top.proId]);
    await t.pool.query('INSERT INTO customer_favourite_pros (customer_id, pro_id) SELECT id, $1 FROM users WHERE phone = $2', [
      good.proId,
      '+4915100000001',
    ]);

    const pros = (await get('/home')).json().pros as Record<string, unknown>[];
    expect(pros.map((p) => p.firstName)).toEqual(['Daniel', 'Ben', 'Arta']);
    expect(pros[0]).toEqual({
      id: top.proId,
      firstName: 'Daniel',
      photoId: null,
      trades: [
        { id: market.gardening, slug: 'gardening', name: 'Gardening', icon: 'leaf' },
        { id: market.plumbing, slug: 'plumbing', name: 'Plumbing', icon: 'drop' },
      ],
      ratingAverage: 5,
      ratingCount: 3,
      jobsDone: 3,
      isFavourite: false,
    });
    // No surname or phone number leaves the API.
    expect(JSON.stringify(pros)).not.toMatch(/Krasniqi|\+49/);
    expect(pros[1]).toMatchObject({ firstName: 'Ben', isFavourite: true });

    // Another address moves "near you": only the pro who works in Zehlendorf.
    const south = await addAddress({ address: '5 Ash Road', postcode: '14167', select: true });
    expect(south.selected).toBe(true);
    expect(((await get('/home')).json().pros as { firstName: string }[]).map((p) => p.firstName)).toEqual(['Far']);
  });

  it("shows an approved pro's photo to customers in the pro's area only", async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening], postcode: '10115', radiusKm: 3 });
    const photoId = (await upload(t, '/pro/photo', pro.cookie, FILES.png, 'me.png')).json().profile.photoId as string;
    expect((await get(`/files/${photoId}`)).statusCode).toBe(404);
    await addAddress({ address: '5 Ash Road', postcode: '14167' });
    expect((await get(`/files/${photoId}`)).statusCode).toBe(404);
    await addAddress({ address: '12 Linden Street', postcode: '10115' });
    expect((await get(`/files/${photoId}`)).statusCode).toBe(200);
    await t.pool.query("UPDATE pro_profiles SET status = 'suspended' WHERE user_id = $1", [pro.proId]);
    expect((await get(`/files/${photoId}`)).statusCode).toBe(404);
  });

  it('gives one bookable pro card for the Services page', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening], firstName: 'Daniel' });
    expect((await get(`/home/pros/${pro.proId}`)).json().pro).toMatchObject({ id: pro.proId, firstName: 'Daniel', trades: [expect.objectContaining({ slug: 'gardening' })] });
    await t.pool.query("UPDATE pro_profiles SET status = 'suspended' WHERE user_id = $1", [pro.proId]);
    expect((await get(`/home/pros/${pro.proId}`)).json()).toEqual({ error: 'pro_not_found' });
    expect((await get(`/home/pros/${randomUUID()}`)).statusCode).toBe(404);
  });
});

describe('trades in the order the team sets', () => {
  it('lets the team reorder all trades, and the app follows that order and only shows published ones', async () => {
    const admin = await signInAdmin(t);
    const draft = await call(t, 'POST', '/admin/categories', { cookie: admin, body: { name: 'Pool care', icon: 'sun' } });
    // A new trade goes to the end, as a draft.
    expect(draft.json().category).toMatchObject({ sortOrder: 3, active: false });
    const draftId = draft.json().category.id as string;
    expect(((await get('/catalogue')).json().categories as { slug: string }[]).map((c) => c.slug)).toEqual(['gardening', 'plumbing']);

    const order = (ids: string[]) => call(t, 'PUT', '/admin/categories/order', { cookie: admin, body: { ids } });
    const reordered = await order([draftId, market.plumbing, market.gardening]);
    expect(reordered.statusCode).toBe(200);
    expect((reordered.json().categories as { id: string }[]).map((c) => c.id)).toEqual([draftId, market.plumbing, market.gardening]);
    expect(((await get('/catalogue')).json().categories as { slug: string }[]).map((c) => c.slug)).toEqual(['plumbing', 'gardening']);
    await call(t, 'PATCH', `/admin/categories/${draftId}`, { cookie: admin, body: { active: true } });
    expect(((await get('/catalogue')).json().categories as { slug: string }[]).map((c) => c.slug)).toEqual(['pool-care', 'plumbing', 'gardening']);

    // A list that misses or repeats a trade is refused, and so is anyone but the team.
    expect((await order([market.plumbing, market.gardening])).json()).toEqual({ error: 'trade_list_changed' });
    expect((await order([market.plumbing, market.gardening, randomUUID()])).json()).toEqual({ error: 'trade_list_changed' });
    expect((await order([market.plumbing, market.plumbing, market.gardening])).statusCode).toBe(400);
    expect((await call(t, 'PUT', '/admin/categories/order', { cookie: customer, body: { ids: [market.plumbing] } })).statusCode).toBe(403);
    const log = await t.pool.query("SELECT action FROM admin_activity WHERE area = 'catalogue'");
    expect(log.rows).toEqual([{ action: 'trades_reordered' }]);
  });
});

describe('booking a pro picked on Home', () => {
  async function freeSlot(proId?: string) {
    const response = await get(`/availability?serviceId=${market.mowing}&postcode=10115${proId ? `&proId=${proId}` : ''}`);
    expect(response.statusCode).toBe(200);
    return response.json() as { slots: { startsAt: string; available: boolean; preferredFree?: boolean }[]; preferredPro: unknown };
  }

  async function book(preferredProId: string, startsAt: string) {
    const created = await post('/bookings', { serviceId: market.mowing, size: 'M', address: '12 Linden Street', postcode: '10115', startsAt, preferredProId });
    expect(created.statusCode).toBe(201);
    return created.json().booking as { id: string; preferredPro: unknown };
  }

  const offers = async (cookie: string) => (await get('/pro/offers', cookie)).json().offers as { id: string }[];

  it('offers the job to the picked pro first, then to the others when they decline', async () => {
    const best = await approvedPro(t, '+4915100000101', { trades: [market.gardening], firstName: 'Arben' });
    const picked = await approvedPro(t, '+4915100000102', { trades: [market.gardening], firstName: 'Daniel' });
    for (const stars of [5, 5, 5]) await giveRating(t.pool, best.proId, stars);
    await giveRating(t.pool, picked.proId, 3);

    const availability = await freeSlot(picked.proId);
    expect(availability.preferredPro).toEqual({ id: picked.proId, firstName: 'Daniel' });
    const slot = availability.slots.find((s) => s.available && s.preferredFree);
    expect(slot).toBeDefined();
    // Without a pick, times carry nothing extra.
    expect((await freeSlot()).slots[0]).not.toHaveProperty('preferredFree');

    const booking = await book(picked.proId, slot?.startsAt ?? '');
    expect(booking.preferredPro).toEqual({ id: picked.proId, firstName: 'Daniel' });
    expect(await offers(best.cookie)).toEqual([]);
    const [offer] = await offers(picked.cookie);
    expect(offer).toBeDefined();

    expect((await post(`/pro/offers/${offer?.id}/decline`, undefined, picked.cookie)).statusCode).toBe(204);
    expect(await offers(best.cookie)).toHaveLength(1);

    // The team sees who the customer asked for; other pros never do.
    const admin = await signInAdmin(t);
    const seen = (await call(t, 'GET', `/admin/bookings/${booking.id}`, { cookie: admin })).json().booking;
    expect(seen.preferredPro).toEqual({ id: picked.proId, firstName: 'Daniel' });
  });

  it('goes straight to normal dispatch when the picked pro is offline, and marks their times as not free', async () => {
    const best = await approvedPro(t, '+4915100000101', { trades: [market.gardening], firstName: 'Arben' });
    const picked = await approvedPro(t, '+4915100000102', { trades: [market.gardening], firstName: 'Daniel' });
    await t.pool.query('UPDATE pro_profiles SET online = false WHERE user_id = $1', [picked.proId]);
    const availability = await freeSlot(picked.proId);
    expect(availability.slots.some((s) => s.preferredFree)).toBe(false);
    const slot = availability.slots.find((s) => s.available);
    await book(picked.proId, slot?.startsAt ?? '');
    expect(await offers(best.cookie)).toHaveLength(1);
  });

  it('ignores a pick that is not a pro of this trade', async () => {
    await approvedPro(t, '+4915100000101', { trades: [market.gardening], firstName: 'Arben' });
    const plumber = await approvedPro(t, '+4915100000103', { trades: [market.plumbing], firstName: 'Ben' });
    expect((await freeSlot(plumber.proId)).preferredPro).toBeNull();
    const slot = (await freeSlot()).slots.find((s) => s.available);
    const booking = await book(plumber.proId, slot?.startsAt ?? '');
    expect(booking.preferredPro).toBeNull();
    expect((await t.pool.query('SELECT preferred_pro_id FROM bookings WHERE id = $1', [booking.id])).rows[0]).toEqual({ preferred_pro_id: null });
  });
});
