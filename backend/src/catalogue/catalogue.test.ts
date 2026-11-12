import { approvedPro, call, createTestContext, resetDatabase, seedMarket, signIn, signInAdmin, type TestContext } from '../../test/helpers.js';
import { jobPriceCents, proShareCents } from './pricing.js';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(() => resetDatabase(t.pool));

describe('pricing', () => {
  const service = { priceCents: 3500, sizeSmallPct: 100, sizeMediumPct: 130, sizeLargePct: 170, pricing: 'fixed' as const, durationMinutes: 60 };
  it('applies the size factor in whole cents', () => {
    expect(jobPriceCents(service, 'S')).toBe(3500);
    expect(jobPriceCents(service, 'M')).toBe(4550);
    expect(jobPriceCents(service, 'L')).toBe(5950);
    expect(jobPriceCents({ ...service, priceCents: 3333 }, 'M')).toBe(4333);
  });
  it('charges an hourly service its rate times the job length, whatever the size', () => {
    const hourly = { ...service, priceCents: 3800, pricing: 'hourly' as const, durationMinutes: 90 };
    expect(jobPriceCents(hourly, 'S')).toBe(5700);
    expect(jobPriceCents(hourly, 'L')).toBe(5700);
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

  it('starts a new trade as a draft that customers do not see until it is published', async () => {
    const admin = await signInAdmin(t);
    const created = await call(t, 'POST', '/admin/categories', { cookie: admin, body: { name: 'Pool Care & Spa', icon: 'sun' } });
    expect(created.json().category).toMatchObject({ slug: 'pool-care-spa', active: false });
    const again = await call(t, 'POST', '/admin/categories', { cookie: admin, body: { name: 'Pool care & spa', icon: 'sun' } });
    expect(again.json().category.slug).toBe('pool-care-spa-2');
    const id = created.json().category.id;
    await call(t, 'POST', '/admin/services', {
      cookie: admin,
      body: { categoryId: id, name: 'Pool cleaning', priceCents: 6900, durationMinutes: 90 },
    });
    const slugs = async () =>
      (await t.app.inject({ method: 'GET', url: '/catalogue' })).json().categories.map((c: { slug: string }) => c.slug);
    expect(await slugs()).toEqual([]);

    await call(t, 'PATCH', `/admin/categories/${id}`, { cookie: admin, body: { active: true } });
    expect(await slugs()).toEqual(['pool-care-spa']);
    const log = (await call(t, 'GET', '/admin/catalogue', { cookie: admin })).json().changes;
    expect(log.map((c: { action: string }) => c.action)).toEqual(['trade_published', 'service_added', 'trade_added', 'trade_added']);
  });

  it('removes a trade nothing depends on, with its services, and keeps a note of it in the activity log', async () => {
    const market = await seedMarket(t.pool);
    const admin = await signInAdmin(t);
    const id = (await call(t, 'POST', '/admin/categories', { cookie: admin, body: { name: 'Pool care', icon: 'sun' } })).json().category.id;
    await call(t, 'POST', '/admin/services', {
      cookie: admin,
      body: { categoryId: id, name: 'Pool cleaning', priceCents: 6900, durationMinutes: 90 },
    });
    await call(t, 'PATCH', `/admin/categories/${id}`, { cookie: admin, body: { active: true } });

    const removed = await call(t, 'DELETE', `/admin/categories/${id}`, { cookie: admin });
    expect(removed.statusCode).toBe(204);
    const catalogue = (await call(t, 'GET', '/admin/catalogue', { cookie: admin })).json();
    expect(catalogue.categories.map((c: { id: string }) => c.id)).not.toContain(id);
    expect(catalogue.services.map((s: { name: string }) => s.name)).not.toContain('Pool cleaning');
    expect((await t.app.inject({ method: 'GET', url: '/catalogue' })).json().categories.map((c: { slug: string }) => c.slug)).not.toContain(
      'pool-care',
    );
    const activity = (await call(t, 'GET', '/admin/activity', { cookie: admin })).json().activity;
    expect(activity[0]).toMatchObject({ area: 'catalogue', action: 'trade_removed', details: { name: 'Pool care' } });
    expect((await call(t, 'DELETE', `/admin/categories/${id}`, { cookie: admin })).statusCode).toBe(404);
    expect((await call(t, 'DELETE', `/admin/categories/${market.plumbing}`, { cookie: await signIn(t, '+4915100000009', 'customer') })).statusCode).toBe(403);
  });

  it('keeps a trade that bookings, plans or pros depend on', async () => {
    const market = await seedMarket(t.pool);
    const admin = await signInAdmin(t);
    const remove = async (id: string) => (await call(t, 'DELETE', `/admin/categories/${id}`, { cookie: admin })).json();

    await approvedPro(t, '+4915100000101', { trades: [market.plumbing] });
    expect(await remove(market.plumbing)).toEqual({ error: 'trade_has_pros' });

    await call(t, 'POST', '/admin/plans', {
      cookie: admin,
      body: {
        name: 'Garden care',
        categoryId: market.gardening,
        priceCents: 4900,
        frequency: 'weekly',
        visitMinutes: 60,
        tasks: ['Mow'],
        addonName: null,
        addonPriceCents: null,
        seasonal: false,
        skipsPerMonth: 2,
        minTermMonths: 3,
        proSharePct: 70,
      },
    });
    expect(await remove(market.gardening)).toEqual({ error: 'trade_has_plans' });

    const customer = await signIn(t, '+4915100000002', 'customer');
    const customerId = (await call(t, 'GET', '/auth/me', { cookie: customer })).json().user.id;
    const used = (await call(t, 'POST', '/admin/categories', { cookie: admin, body: { name: 'Moving help', icon: 'hammer' } })).json().category.id;
    const service = (
      await call(t, 'POST', '/admin/services', { cookie: admin, body: { categoryId: used, name: 'Carrying', priceCents: 4000, durationMinutes: 60 } })
    ).json().service.id;
    await t.pool.query(
      `INSERT INTO bookings (customer_id, service_id, category_id, service_name, size, address, postcode, starts_at, ends_at,
         price_cents, fee_cents, pro_share_pct, status, cancelled_by)
       VALUES ($1, $2, $3, 'Carrying', 'M', 'Invalidenstrasse 1', '10115', now() - interval '3 days', now() - interval '3 days' + interval '1 hour',
         4000, 290, 82, 'cancelled', 'customer')`,
      [customerId, service, used],
    );
    expect(await remove(used)).toEqual({ error: 'trade_has_bookings' });
    const still = (await call(t, 'GET', '/admin/catalogue', { cookie: admin })).json().categories.map((c: { id: string }) => c.id);
    expect(still).toEqual(expect.arrayContaining([market.plumbing, market.gardening, used]));
  });

  it('logs price changes, which only apply to new bookings', async () => {
    const admin = await signInAdmin(t);
    const market = await seedMarket(t.pool);
    const changed = await call(t, 'PATCH', `/admin/services/${market.mowing}`, { cookie: admin, body: { priceCents: 3900 } });
    expect(changed.json().service.priceCents).toBe(3900);
    const same = await call(t, 'PATCH', `/admin/services/${market.mowing}`, { cookie: admin, body: { priceCents: 3900 } });
    expect(same.statusCode).toBe(200);
    const catalogue = (await call(t, 'GET', '/admin/catalogue', { cookie: admin })).json();
    expect(catalogue.changes).toEqual([
      expect.objectContaining({ action: 'price_changed', serviceName: 'Lawn mowing', details: { from: 3500, to: 3900 }, adminName: 'admin' }),
    ]);
    expect(catalogue.proSharePct).toBe(82);
    expect(catalogue.appUrl).toBe('http://localhost:5173');
  });

  it('hides a service from customers and bookings, logs it, and shows it again', async () => {
    const admin = await signInAdmin(t);
    const market = await seedMarket(t.pool);
    const names = async () =>
      (await t.app.inject({ method: 'GET', url: '/catalogue' })).json().categories[0].services.map((s: { name: string }) => s.name);
    expect(await names()).toContain('Lawn mowing');
    await call(t, 'PATCH', `/admin/services/${market.mowing}`, { cookie: admin, body: { active: false } });
    expect(await names()).not.toContain('Lawn mowing');
    const customer = await signIn(t, '+4915100000001', 'customer');
    const booked = await call(t, 'POST', '/bookings', {
      cookie: customer,
      body: { serviceId: market.mowing, size: 'M', address: '12 Linden Street', postcode: '10115', startsAt: new Date(Date.now() + 86_400_000).toISOString() },
    });
    expect(booked.json()).toEqual({ error: 'service_not_found' });
    await call(t, 'PATCH', `/admin/services/${market.mowing}`, { cookie: admin, body: { active: true } });
    expect(await names()).toContain('Lawn mowing');
    const actions = (await call(t, 'GET', '/admin/catalogue', { cookie: admin })).json().changes.map((c: { action: string }) => c.action);
    expect(actions).toEqual(['service_shown', 'service_hidden']);
  });

  it('counts visible services, pros and verified pros per trade, and marks new services', async () => {
    const admin = await signInAdmin(t);
    const market = await seedMarket(t.pool);
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const applicant = await signIn(t, '+4915100000102', 'pro');
    await call(t, 'PATCH', '/pro/profile', { cookie: applicant, body: { trades: [market.gardening] } });
    await t.pool.query("UPDATE pro_profiles SET status = 'submitted' WHERE status = 'draft'");
    await call(t, 'PATCH', `/admin/services/${market.hedge}`, { cookie: admin, body: { active: false } });
    const added = await call(t, 'POST', '/admin/services', {
      cookie: admin,
      body: { categoryId: market.gardening, name: 'Gardener by the hour', priceCents: 3800, durationMinutes: 120, pricing: 'hourly' },
    });
    expect(added.json().service).toMatchObject({ isNew: true, pricing: 'hourly' });
    const catalogue = (await call(t, 'GET', '/admin/catalogue', { cookie: admin })).json();
    const gardening = catalogue.categories.find((c: { slug: string }) => c.slug === 'gardening');
    expect(gardening).toMatchObject({ visibleServices: 2, totalServices: 3, pros: 2, verifiedPros: 1, active: true });
    const app = (await t.app.inject({ method: 'GET', url: '/catalogue' })).json().categories[0].services;
    expect(app.find((s: { name: string }) => s.name === 'Gardener by the hour')).toMatchObject({ isNew: true, pricing: 'hourly' });
  });

  it('prices an hourly booking at the rate times the job length', async () => {
    const market = await seedMarket(t.pool);
    await t.pool.query("UPDATE services SET pricing = 'hourly', price_cents = 3800, duration_minutes = 90 WHERE id = $1", [market.mowing]);
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const customer = await signIn(t, '+4915100000001', 'customer');
    const slots = (await call(t, 'GET', `/availability?serviceId=${market.mowing}&postcode=10115`, { cookie: customer })).json().slots;
    const startsAt = slots.find((s: { available: boolean }) => s.available).startsAt;
    const booked = await call(t, 'POST', '/bookings', {
      cookie: customer,
      body: { serviceId: market.mowing, size: 'L', address: '12 Linden Street', postcode: '10115', startsAt },
    });
    expect(booked.json().booking).toMatchObject({ priceCents: 5700 });
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
