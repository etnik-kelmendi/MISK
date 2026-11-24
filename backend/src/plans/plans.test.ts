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
  pauseNoticeDays: 7,
  maxPauseWeeks: 4,
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
  pauseNoticeDays: 7,
  maxPauseWeeks: 4,
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

  it('lists only published plans of active trades, with the price of every frequency and size (D90)', async () => {
    const live = (await call(t, 'POST', '/admin/plans', { cookie: admin, body: { ...plan(), frequency: 'twice_weekly', priceCents: 9000 } })).json().plan;
    await call(t, 'POST', `/admin/plans/${live.id}/status`, { cookie: admin, body: { published: true } });
    await call(t, 'POST', '/admin/plans', { cookie: admin, body: { ...plan(), name: 'Still a draft' } });
    const plans = (await t.app.inject({ method: 'GET', url: '/plans' })).json().plans;
    expect(plans.map((p: { name: string }) => p.name)).toEqual(['Weekly lawn care']);
    // The plan's own frequency and a medium home cost its price; small is 15% less ("from"), large 35% more.
    expect(plans[0]).toMatchObject({ fromCents: 7650, prices: { twice_weekly: { S: 7650, M: 9000, L: 12150 }, weekly: { M: 5000 } } });
    expect(plans[0].prices.every_2_weeks).toEqual({ S: 2550, M: 3000, L: 4050 });
    expect(plans[0].prices.three_times_weekly).toEqual({ S: 10625, M: 12500, L: 16875 });

    await t.pool.query('UPDATE categories SET active = false WHERE id = $1', [market.gardening]);
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

  it('takes a minimum term of 1, 3, 6 or 12 months only (D77)', async () => {
    for (const months of [0, 2, 4, 13]) {
      const response = await call(t, 'POST', '/admin/plans', { cookie: admin, body: { ...plan(), minTermMonths: months } });
      expect(response.statusCode).toBe(400);
    }
    for (const months of [1, 3, 6, 12]) {
      const response = await call(t, 'POST', '/admin/plans', { cookie: admin, body: { ...plan(), minTermMonths: months } });
      expect(response.statusCode).toBe(201);
      expect(response.json().plan.minTermMonths).toBe(months);
    }
    // Skips are no longer a plan rule.
    const withSkips = await call(t, 'POST', '/admin/plans', { cookie: admin, body: { ...plan(), skipsPerMonth: 2 } });
    expect(withSkips.statusCode).toBe(400);
    const created = (await call(t, 'POST', '/admin/plans', { cookie: admin, body: plan() })).json().plan;
    expect(created).not.toHaveProperty('skipsPerMonth');
  });

  it('stores the pause rules: notice 1 to 30 days, 0 to 8 paused weeks a year (D77, D85, D95)', async () => {
    const created = (await call(t, 'POST', '/admin/plans', { cookie: admin, body: { ...plan(), pauseNoticeDays: 14, maxPauseWeeks: 8 } })).json().plan;
    expect(created).toMatchObject({ pauseNoticeDays: 14, maxPauseWeeks: 8 });
    // The ends of both ranges are fine: no pauses at all with no notice, and the longest rules.
    for (const body of [{ maxPauseWeeks: 0, pauseNoticeDays: 1 }, { maxPauseWeeks: 8, pauseNoticeDays: 30 }, { maxPauseWeeks: 1, pauseNoticeDays: 1 }]) {
      const response = await call(t, 'POST', '/admin/plans', { cookie: admin, body: { ...plan(), ...body } });
      expect(response.statusCode).toBe(201);
      expect(response.json().plan).toMatchObject(body);
    }
    const refused = [
      { maxPauseWeeks: -1 },
      { maxPauseWeeks: 9 },
      { maxPauseWeeks: 10 },
      { maxPauseWeeks: 1.5 },
      { maxPauseWeeks: '4' },
      { pauseNoticeDays: -1 },
      { pauseNoticeDays: 0 },
      { pauseNoticeDays: 31 },
      { pauseNoticeDays: 60 },
      { pauseNoticeDays: 7.5 },
      { pauseNoticeDays: '7' },
    ];
    for (const body of refused) {
      expect((await call(t, 'POST', '/admin/plans', { cookie: admin, body: { ...plan(), ...body } })).statusCode).toBe(400);
    }
    // Changing an existing plan follows the same ranges.
    const id = created.id;
    expect((await call(t, 'PUT', `/admin/plans/${id}`, { cookie: admin, body: { ...plan(), maxPauseWeeks: 0 } })).json().plan).toMatchObject({ maxPauseWeeks: 0 });
    expect((await call(t, 'PUT', `/admin/plans/${id}`, { cookie: admin, body: { ...plan(), maxPauseWeeks: 9 } })).statusCode).toBe(400);
    expect((await call(t, 'PUT', `/admin/plans/${id}`, { cookie: admin, body: { ...plan(), pauseNoticeDays: 31 } })).statusCode).toBe(400);
    const withoutPause: Partial<ReturnType<typeof plan>> = plan();
    delete withoutPause.pauseNoticeDays;
    delete withoutPause.maxPauseWeeks;
    expect((await call(t, 'POST', '/admin/plans', { cookie: admin, body: withoutPause })).statusCode).toBe(400);
    // Older rows and direct inserts get the defaults: 7 days' notice, 4 weeks a year.
    const row = await t.pool.query<{ pause_notice_days: number; max_pause_weeks: number }>(
      `INSERT INTO plans (name, category_id, price_cents, frequency, visit_minutes, tasks) VALUES ('Old', $1, 4900, 'weekly', 60, '{Mow}')
       RETURNING pause_notice_days, max_pause_weeks`,
      [market.gardening],
    );
    expect(row.rows[0]).toEqual({ pause_notice_days: 7, max_pause_weeks: 4 });
    await expect(t.pool.query('UPDATE plans SET min_term_months = 0')).rejects.toThrow();
    // The database refuses what the API refuses.
    await expect(t.pool.query('UPDATE plans SET max_pause_weeks = 9')).rejects.toThrow();
    await expect(t.pool.query('UPDATE plans SET pause_notice_days = 31')).rejects.toThrow();
    await expect(t.pool.query('UPDATE plans SET pause_notice_days = 0')).rejects.toThrow();
    await expect(t.pool.query('UPDATE plans SET max_pause_weeks = -1')).rejects.toThrow();
  });

  it('keeps plan building to admins', async () => {
    const customer = await signIn(t, '+4915100000001', 'customer');
    expect((await call(t, 'POST', '/admin/plans', { cookie: customer, body: plan() })).statusCode).toBe(403);
    expect((await call(t, 'GET', '/admin/plans', { cookie: customer })).statusCode).toBe(403);
    const id = (await call(t, 'POST', '/admin/plans', { cookie: admin, body: plan() })).json().plan.id;
    expect((await call(t, 'DELETE', `/admin/plans/${id}`, { cookie: customer })).statusCode).toBe(403);
  });
});

describe('deleting a plan', () => {
  const create = async (body: Record<string, unknown> = plan()) =>
    (await call(t, 'POST', '/admin/plans', { cookie: admin, body })).json().plan.id as string;
  const remove = (id: string) => call(t, 'DELETE', `/admin/plans/${id}`, { cookie: admin });

  it('deletes a draft and a live plan nobody has subscribed to', async () => {
    const draft = await create(empty);
    const live = await create();
    await call(t, 'POST', `/admin/plans/${live}/status`, { cookie: admin, body: { published: true } });
    expect((await t.app.inject({ method: 'GET', url: '/plans' })).json().plans).toHaveLength(1);

    expect((await remove(draft)).statusCode).toBe(204);
    expect((await remove(live)).statusCode).toBe(204);
    expect((await call(t, 'GET', '/admin/plans', { cookie: admin })).json().plans).toEqual([]);
    expect((await t.app.inject({ method: 'GET', url: '/plans' })).json().plans).toEqual([]);
    expect((await call(t, 'GET', `/admin/plans/${live}`, { cookie: admin })).statusCode).toBe(404);
    expect((await remove(live)).statusCode).toBe(404);
  });

  async function subscribe(planId: string, status: string, phone = '+4915100000002') {
    const customer = await signIn(t, phone, 'customer');
    const customerId = (await call(t, 'GET', '/auth/me', { cookie: customer })).json().user.id;
    const inserted = await t.pool.query<{ id: string }>(
      `INSERT INTO subscriptions (customer_id, plan_id, category_id, plan_name, tasks, size, frequency, days, time_window,
         visit_minutes, address, postcode, with_addon, price_cents, pro_share_pct, seasonal, skips_per_month, min_term_months, status)
       VALUES ($1, $2, $3, 'Weekly lawn care', '{Mow}', 'M', 'weekly', '{2}', 'morning', 60, 'Invalidenstrasse 1', '10115',
         false, 4900, 70, false, 2, 3, $4) RETURNING id`,
      [customerId, planId, market.gardening, status],
    );
    return inserted.rows[0]?.id ?? '';
  }
  const activity = async () =>
    ((await call(t, 'GET', '/admin/activity', { cookie: admin })).json().activity as { area: string; action: string; details: { name?: string } }[]).filter(
      (a) => a.area === 'plans',
    );

  it('refuses to delete a plan with active subscribers, and says how many (D66)', async () => {
    const id = await create();
    await subscribe(id, 'active');
    await subscribe(id, 'past_due', '+4915100000003');
    const listed = (await call(t, 'GET', '/admin/plans', { cookie: admin })).json().plans[0];
    expect(listed).toMatchObject({ subscribers: 2, visitInProgress: false });
    const refused = await remove(id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'plan_in_use' });
    expect((await call(t, 'GET', `/admin/plans/${id}`, { cookie: admin })).statusCode).toBe(200);
  });

  it('refuses to delete a plan while one of its visits is happening', async () => {
    const id = await create();
    const subscriptionId = await subscribe(id, 'cancelled');
    const pro = await signIn(t, '+4915100000101', 'pro');
    const proId = (await call(t, 'GET', '/auth/me', { cookie: pro })).json().user.id;
    await t.pool.query(
      `INSERT INTO subscription_visits (subscription_id, pro_id, starts_at, ends_at, status)
       VALUES ($1, $2, now() - interval '10 minutes', now() + interval '50 minutes', 'planned')`,
      [subscriptionId, proId],
    );
    expect((await call(t, 'GET', `/admin/plans/${id}`, { cookie: admin })).json().plan).toMatchObject({ subscribers: 0, visitInProgress: true });
    expect((await remove(id)).json()).toEqual({ error: 'plan_in_use' });
  });

  it('hides a plan nobody uses any more, keeps it and its records with the name, and logs it', async () => {
    const id = await create();
    await call(t, 'POST', `/admin/plans/${id}/status`, { cookie: admin, body: { published: true } });
    const subscriptionId = await subscribe(id, 'cancelled');
    expect((await remove(id)).statusCode).toBe(204);
    expect((await call(t, 'GET', '/admin/plans', { cookie: admin })).json().plans).toEqual([]);
    expect((await t.app.inject({ method: 'GET', url: '/plans' })).json().plans).toEqual([]);
    expect((await call(t, 'GET', `/admin/plans/${id}`, { cookie: admin })).statusCode).toBe(404);
    // Not erased: the plan row stays, and the subscription still names it.
    const kept = await t.pool.query<{ name: string; status: string; deleted: boolean }>(
      'SELECT name, status, deleted_at IS NOT NULL AS deleted FROM plans WHERE id = $1',
      [id],
    );
    expect(kept.rows[0]).toEqual({ name: 'Weekly lawn care', status: 'draft', deleted: true });
    const record = await t.pool.query<{ plan_name: string }>('SELECT plan_name FROM subscriptions WHERE id = $1', [subscriptionId]);
    expect(record.rows[0]?.plan_name).toBe('Weekly lawn care');
    expect((await activity()).map((a) => [a.action, a.details.name])).toEqual([
      ['plan_deleted', 'Weekly lawn care'],
      ['plan_published', 'Weekly lawn care'],
    ]);
  });

  it('unpublishes a plan in use: hidden from new customers, current subscribers keep it, and logged', async () => {
    const id = await create();
    await call(t, 'POST', `/admin/plans/${id}/status`, { cookie: admin, body: { published: true } });
    const subscriptionId = await subscribe(id, 'active');
    expect((await call(t, 'POST', `/admin/plans/${id}/status`, { cookie: admin, body: { published: false } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/plans' })).json().plans).toEqual([]);
    const still = await t.pool.query<{ status: string }>('SELECT status FROM subscriptions WHERE id = $1', [subscriptionId]);
    expect(still.rows[0]?.status).toBe('active');
    expect((await activity())[0]).toMatchObject({ action: 'plan_unpublished', details: { name: 'Weekly lawn care' } });
  });

  it('refuses an id that is not a plan id', async () => {
    expect((await remove('not-a-uuid')).statusCode).toBe(400);
  });
});
