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
  skipsPerMonth: 2,
  minTermMonths: 3,
  proSharePct: 70,
});

const empty = {
  name: null,
  categoryId: null,
  priceCents: null,
  frequency: 'weekly',
  visitMinutes: 60,
  tasks: [],
  addonName: null,
  addonPriceCents: null,
  seasonal: false,
  skipsPerMonth: 2,
  minTermMonths: 3,
  proSharePct: 70,
};

describe('plans', () => {
  it('lets admins create a draft, edit it and publish it for customers', async () => {
    const created = await call(t, 'POST', '/admin/plans', { cookie: admin, body: plan() });
    expect(created.statusCode).toBe(201);
    const draft = created.json().plan;
    expect(draft).toMatchObject({ name: 'Weekly lawn care', categoryName: 'Gardening', status: 'draft', subscribers: 0 });
    expect((await t.app.inject({ method: 'GET', url: '/plans' })).json().plans).toEqual([]);

    const edited = await call(t, 'PUT', `/admin/plans/${draft.id}`, {
      cookie: admin,
      body: { ...plan(), priceCents: 5500, tasks: ['Mow', 'Edge', 'Blow paths', 'Rake'] },
    });
    expect(edited.json().plan).toMatchObject({ priceCents: 5500, tasks: ['Mow', 'Edge', 'Blow paths', 'Rake'] });

    const published = await call(t, 'POST', `/admin/plans/${draft.id}/status`, { cookie: admin, body: { published: true } });
    expect(published.json().plan.status).toBe('published');
    const again = await call(t, 'POST', `/admin/plans/${draft.id}/status`, { cookie: admin, body: { published: true } });
    expect(again.json()).toEqual({ error: 'already_published' });
    expect((await t.app.inject({ method: 'GET', url: '/plans' })).json().plans).toHaveLength(1);

    await call(t, 'POST', `/admin/plans/${draft.id}/status`, { cookie: admin, body: { published: false } });
    expect((await t.app.inject({ method: 'GET', url: '/plans' })).json().plans).toEqual([]);
  });

  it('runs seasonal plans from April to October', async () => {
    const created = (await call(t, 'POST', '/admin/plans', { cookie: admin, body: plan() })).json().plan;
    expect(created).toMatchObject({ seasonal: true, seasonFrom: 4, seasonTo: 10 });
    const yearRound = (await call(t, 'POST', '/admin/plans', { cookie: admin, body: { ...plan(), seasonal: false } })).json().plan;
    expect(yearRound).toMatchObject({ seasonal: false, seasonFrom: null, seasonTo: null });
  });

  it('saves a draft however incomplete, and cleans its tasks', async () => {
    const created = await call(t, 'POST', '/admin/plans', { cookie: admin, body: { ...empty, tasks: [' Mow ', 'mow', 'Edge'] } });
    expect(created.statusCode).toBe(201);
    expect(created.json().plan).toMatchObject({ name: null, categoryId: null, priceCents: null, tasks: ['Mow', 'Edge'], status: 'draft' });
    const list = (await call(t, 'GET', '/admin/plans', { cookie: admin })).json().plans;
    expect(list).toHaveLength(1);
  });

  it('refuses to publish an incomplete plan, and says what is missing', async () => {
    const draft = (await call(t, 'POST', '/admin/plans', { cookie: admin, body: { ...empty, addonName: 'Extra' } })).json().plan;
    const refused = await call(t, 'POST', `/admin/plans/${draft.id}/status`, { cookie: admin, body: { published: true } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ error: 'plan_incomplete', missing: ['name', 'category', 'price', 'tasks', 'addonPrice'] });

    const cheap = (await call(t, 'POST', '/admin/plans', { cookie: admin, body: { ...plan(), priceCents: 100 } })).json().plan;
    const tooCheap = await call(t, 'POST', `/admin/plans/${cheap.id}/status`, { cookie: admin, body: { published: true } });
    expect(tooCheap.json().missing).toEqual(['price']);
  });

  it('keeps a live plan complete', async () => {
    const live = (await call(t, 'POST', '/admin/plans', { cookie: admin, body: plan() })).json().plan;
    await call(t, 'POST', `/admin/plans/${live.id}/status`, { cookie: admin, body: { published: true } });
    const broken = await call(t, 'PUT', `/admin/plans/${live.id}`, { cookie: admin, body: { ...plan(), tasks: [] } });
    expect(broken.json()).toEqual({ error: 'plan_incomplete', missing: ['tasks'] });
  });

  it('refuses invalid values and unknown categories', async () => {
    const refuse = async (body: Record<string, unknown>, status = 400) => {
      const response = await call(t, 'POST', '/admin/plans', { cookie: admin, body: { ...plan(), ...body } });
      expect(response.statusCode).toBe(status);
    };
    await refuse({ proSharePct: 95 });
    await refuse({ visitMinutes: 50 });
    await refuse({ frequency: 'daily' });
    await refuse({ categoryId: '00000000-0000-4000-8000-000000000000' }, 404);
  });

  it('keeps plan building to admins', async () => {
    const customer = await signIn(t, '+4915100000001', 'customer');
    expect((await call(t, 'POST', '/admin/plans', { cookie: customer, body: plan() })).statusCode).toBe(403);
    expect((await call(t, 'GET', '/admin/plans', { cookie: customer })).statusCode).toBe(403);
  });
});
