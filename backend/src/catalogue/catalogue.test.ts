import { call, createTestContext, resetDatabase, seedMarket, signIn, signInAdmin, type TestContext } from '../../test/helpers.js';
import { jobPriceCents, proShareCents } from './pricing.js';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(() => resetDatabase(t.pool));

describe('pricing', () => {
  const service = { priceCents: 3500, sizeSmallPct: 100, sizeMediumPct: 130, sizeLargePct: 170 };
  it('applies the size factor in whole cents', () => {
    expect(jobPriceCents(service, 'S')).toBe(3500);
    expect(jobPriceCents(service, 'M')).toBe(4550);
    expect(jobPriceCents(service, 'L')).toBe(5950);
    expect(jobPriceCents({ ...service, priceCents: 3333 }, 'M')).toBe(4333);
  });
  it('rounds the pro share down so MISK never pays out more than it took', () => {
    expect(proShareCents(4550, 82)).toBe(3731);
    expect(proShareCents(1, 82)).toBe(0);
  });
});

describe('catalogue', () => {
  it('shows active categories and services to anyone, with the service fee', async () => {
    const market = await seedMarket(t.pool);
    await t.pool.query('UPDATE services SET active = false WHERE id = $1', [market.hedge]);
    const response = await t.app.inject({ method: 'GET', url: '/catalogue' });
    const body = response.json();
    expect(body.feeCents).toBe(290);
    expect(body.timezone).toBe('Europe/Berlin');
    expect(body.categories.map((c: { slug: string }) => c.slug)).toEqual(['gardening', 'plumbing']);
    expect(body.categories[0].services.map((s: { name: string }) => s.name)).toEqual(['Lawn mowing']);
    expect(body.categories[0].approvedPros).toBe(0);
  });

  it('lets admins create and edit categories and services', async () => {
    const admin = await signInAdmin(t);
    const created = await call(t, 'POST', '/admin/categories', {
      cookie: admin,
      body: { slug: 'painting', name: 'Painting', icon: 'brush' },
    });
    expect(created.statusCode).toBe(201);
    const categoryId = created.json().category.id;

    const duplicate = await call(t, 'POST', '/admin/categories', {
      cookie: admin,
      body: { slug: 'painting', name: 'Again', icon: 'brush' },
    });
    expect(duplicate.json()).toEqual({ error: 'slug_taken' });

    const service = await call(t, 'POST', '/admin/services', {
      cookie: admin,
      body: { categoryId, name: 'Room painting', priceCents: 18900, durationMinutes: 480 },
    });
    expect(service.statusCode).toBe(201);
    expect(service.json().service).toMatchObject({ sizeMediumPct: 130, active: true });

    const edited = await call(t, 'PATCH', `/admin/services/${service.json().service.id}`, {
      cookie: admin,
      body: { priceCents: 19900, active: false },
    });
    expect(edited.json().service).toMatchObject({ priceCents: 19900, active: false });
  });

  it('validates prices and durations', async () => {
    const admin = await signInAdmin(t);
    const market = await seedMarket(t.pool);
    for (const body of [
      { categoryId: market.gardening, name: 'Free', priceCents: 0, durationMinutes: 60 },
      { categoryId: market.gardening, name: 'Odd', priceCents: 1000, durationMinutes: 50 },
      { categoryId: market.gardening, name: 'Cents', priceCents: 10.5, durationMinutes: 60 },
    ]) {
      expect((await call(t, 'POST', '/admin/services', { cookie: admin, body })).statusCode).toBe(400);
    }
    const unknown = await call(t, 'POST', '/admin/services', {
      cookie: admin,
      body: { categoryId: '00000000-0000-4000-8000-000000000000', name: 'X', priceCents: 1000, durationMinutes: 60 },
    });
    expect(unknown.json()).toEqual({ error: 'category_not_found' });
  });

  it('lets admins manage served postcodes and fees', async () => {
    const admin = await signInAdmin(t);
    const saved = await call(t, 'PUT', '/admin/postcodes/sw1a 1aa', {
      cookie: admin,
      body: { name: 'Westminster', lat: 51.501, lng: -0.1416 },
    });
    expect(saved.json().postcode).toMatchObject({ code: 'SW1A 1AA', active: true });
    const listed = await t.app.inject({ method: 'GET', url: '/postcodes' });
    expect(listed.json().postcodes).toEqual([{ code: 'SW1A 1AA', name: 'Westminster' }]);

    const settings = await call(t, 'PATCH', '/admin/settings', { cookie: admin, body: { proSharePct: 80 } });
    expect(settings.json().settings).toEqual({ serviceFeeCents: 290, proSharePct: 80 });
    const tooHigh = await call(t, 'PATCH', '/admin/settings', { cookie: admin, body: { proSharePct: 99 } });
    expect(tooHigh.statusCode).toBe(400);
  });

  it('keeps catalogue editing to admins', async () => {
    const customer = await signIn(t, '+4915112345678', 'customer');
    const response = await call(t, 'POST', '/admin/categories', {
      cookie: customer,
      body: { slug: 'x', name: 'X', icon: 'leaf' },
    });
    expect(response.statusCode).toBe(403);
  });
});
