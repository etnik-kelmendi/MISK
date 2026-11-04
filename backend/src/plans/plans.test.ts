import { call, createTestContext, resetDatabase, seedMarket, signIn, signInAdmin, type Market, type TestContext } from '../../test/helpers.js';

let t: TestContext;
let market: Market;
let admin: string;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(async () => {
  await resetDatabase(t.pool);
  market = await seedMarket(t.pool);
  admin = await signInAdmin(t);
});

const plan = () => ({
  name: 'Weekly lawn care',
  categoryId: market.gardening,
  priceCents: 4900,
  frequency: 'weekly',
  visitMinutes: 60,
  tasks: ['Mow', 'Edge', 'Blow paths'],
  addonName: 'Hedge trimming',
  addonPriceCents: 1500,
  seasonal: true,
  seasonFrom: 4,
  seasonTo: 10,
  skipsPerMonth: 2,
  minTermMonths: 3,
  proSharePct: 70,
});

describe('plans', () => {
  it('lets admins create a draft, edit it and publish it for customers', async () => {
    const created = await call(t, 'POST', '/admin/plans', { cookie: admin, body: plan() });
    expect(created.statusCode).toBe(201);
    const draft = created.json().plan;
    expect(draft).toMatchObject({ name: 'Weekly lawn care', categoryName: 'Gardening', status: 'draft', seasonFrom: 4 });
    expect((await t.app.inject({ method: 'GET', url: '/plans' })).json().plans).toEqual([]);

    const edited = await call(t, 'PUT', `/admin/plans/${draft.id}`, {
      cookie: admin,
      body: { ...plan(), priceCents: 5500, tasks: ['Mow', 'Edge', 'Blow paths', 'Rake'] },
    });
    expect(edited.json().plan).toMatchObject({ priceCents: 5500, tasks: ['Mow', 'Edge', 'Blow paths', 'Rake'] });

    const published = await call(t, 'POST', `/admin/plans/${draft.id}/status`, { cookie: admin, body: { published: true } });
    expect(published.json().plan.status).toBe('published');
    expect(published.json().plan.publishedAt).not.toBeNull();
    const again = await call(t, 'POST', `/admin/plans/${draft.id}/status`, { cookie: admin, body: { published: true } });
    expect(again.json()).toEqual({ error: 'already_published' });
    expect((await t.app.inject({ method: 'GET', url: '/plans' })).json().plans).toHaveLength(1);

    await call(t, 'POST', `/admin/plans/${draft.id}/status`, { cookie: admin, body: { published: false } });
    expect((await t.app.inject({ method: 'GET', url: '/plans' })).json().plans).toEqual([]);
  });

  it('stores a year-round plan without season months and a plan without an extra', async () => {
    const created = await call(t, 'POST', '/admin/plans', {
      cookie: admin,
      body: { ...plan(), seasonal: false, addonName: null, addonPriceCents: null },
    });
    expect(created.json().plan).toMatchObject({ seasonal: false, seasonFrom: null, seasonTo: null, addonName: null });
  });

  it('refuses incomplete or invalid plans', async () => {
    const refuse = async (body: Record<string, unknown>, error?: string) => {
      const response = await call(t, 'POST', '/admin/plans', { cookie: admin, body: { ...plan(), ...body } });
      expect(response.statusCode).toBe(error === 'category_not_found' ? 404 : 400);
      if (error) {
        expect(response.json()).toEqual({ error });
      }
    };
    await refuse({ addonPriceCents: null }, 'addon_incomplete');
    await refuse({ seasonFrom: null }, 'season_incomplete');
    await refuse({ tasks: ['Mow', 'mow'] }, 'duplicate_task');
    await refuse({ tasks: [] });
    await refuse({ priceCents: 100 });
    await refuse({ proSharePct: 95 });
    await refuse({ visitMinutes: 50 });
    await refuse({ frequency: 'daily' });
    await refuse({ categoryId: '00000000-0000-4000-8000-000000000000' }, 'category_not_found');
  });

  it('keeps plan building to admins', async () => {
    const customer = await signIn(t, '+4915100000001', 'customer');
    expect((await call(t, 'POST', '/admin/plans', { cookie: customer, body: plan() })).statusCode).toBe(403);
    expect((await call(t, 'GET', '/admin/plans', { cookie: customer })).statusCode).toBe(403);
  });
});
