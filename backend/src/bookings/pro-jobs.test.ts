import {
  approvedPro,
  call,
  createTestContext,
  FILES,
  resetDatabase,
  seedMarket,
  signIn,
  signInAdmin,
  upload,
  type Market,
  type TestContext,
} from '../../test/helpers.js';
import { dispatchTick, MISSED_OFFERS_LIMIT, setOfflineAfterMissedOffers } from './dispatch.js';

/** D86: the Jobs area of the pro app. */

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
  await t.pool.query("UPDATE services SET tasks = '{Mow the lawn,Edge the borders,Clear the clippings}' WHERE id = $1", [market.mowing]);
  customer = await signIn(t, '+4915100000001', 'customer', 'Sara');
});

const get = (url: string, cookie = customer) => call(t, 'GET', url, { cookie });
const post = (url: string, body?: unknown, cookie = customer) => call(t, 'POST', url, { cookie, ...(body === undefined ? {} : { body }) });
const put = (url: string, body: unknown, cookie: string) => call(t, 'PUT', url, { cookie, body });

async function book() {
  const slots = (await get(`/availability?serviceId=${market.mowing}&postcode=10115`)).json().slots as { startsAt: string; available: boolean }[];
  const free = slots.find((s) => s.available);
  if (!free) throw new Error('No free slot');
  const created = await post('/bookings', { serviceId: market.mowing, size: 'M', address: '12 Linden Street', postcode: '10115', startsAt: free.startsAt });
  expect(created.statusCode).toBe(201);
  return created.json().booking.id as string;
}

const daniel = () => approvedPro(t, '+4915100000101', { trades: [market.gardening], firstName: 'Daniel' });
const leon = () => approvedPro(t, '+4915100000102', { trades: [market.gardening], firstName: 'Leon' });

async function acceptFirstOffer(cookie: string) {
  const offer = (await get('/pro/offers', cookie)).json().offers[0] as { id: string; bookingId: string } | undefined;
  if (!offer) throw new Error('No offer');
  expect((await post(`/pro/offers/${offer.id}/accept`, undefined, cookie)).statusCode).toBe(200);
  return offer.bookingId;
}

async function assignedJob() {
  const pro = await daniel();
  const bookingId = await book();
  await acceptFirstOffer(pro.cookie);
  return { bookingId, pro };
}

async function working(job: { bookingId: string; pro: { cookie: string } }) {
  for (const status of ['on_the_way', 'working']) {
    expect((await post(`/pro/jobs/${job.bookingId}/status`, { status }, job.pro.cookie)).statusCode).toBe(200);
  }
}

async function startsIn(bookingId: string, hours: number) {
  await t.pool.query(
    `UPDATE bookings SET starts_at = now() + make_interval(hours => $2), ends_at = now() + make_interval(hours => $2, mins => 60) WHERE id = $1`,
    [bookingId, hours],
  );
}

async function notifications(userId: string) {
  const rows = await t.pool.query<{ kind: string; body: string }>('SELECT kind, body FROM notifications WHERE user_id = $1 ORDER BY id', [userId]);
  return rows.rows;
}

const customerId = async () => (await t.pool.query<{ id: string }>("SELECT id FROM users WHERE phone = '+4915100000001'")).rows[0]?.id ?? '';
const status = async (bookingId: string) =>
  (await t.pool.query<{ status: string; pro_id: string | null }>('SELECT status, pro_id FROM bookings WHERE id = $1', [bookingId])).rows[0];

describe('online switch', () => {
  it('shows the switch, the trade names and the rating on the profile, and turns it off and on', async () => {
    const pro = await daniel();
    const profile = (await get('/pro/profile', pro.cookie)).json().profile;
    expect(profile).toMatchObject({ online: true, tradeNames: ['Gardening'], offersPausedUntil: null });
    expect((await put('/pro/online', { online: false }, pro.cookie)).json()).toEqual({ online: false });
    expect((await get('/pro/profile', pro.cookie)).json().profile.online).toBe(false);
    expect((await put('/pro/online', { online: true }, pro.cookie)).json()).toEqual({ online: true });
    expect((await put('/pro/online', { online: 'yes' }, pro.cookie)).statusCode).toBe(400);
  });

  it('is only for approved pros', async () => {
    const applicant = await signIn(t, '+4915100000109', 'pro', 'Ana');
    expect((await put('/pro/online', { online: false }, applicant)).json()).toEqual({ error: 'not_approved' });
    expect((await put('/pro/online', { online: false }, customer)).statusCode).toBe(403);
  });

  it('gives an offline pro no new offers: the job waits for an online pro, and reaches them once they go online', async () => {
    const pro = await daniel();
    await put('/pro/online', { online: false }, pro.cookie);
    const bookingId = await book();
    expect((await get('/pro/offers', pro.cookie)).json().offers).toEqual([]);
    expect((await status(bookingId))?.status).toBe('searching');
    await dispatchTick(t.deps);
    expect((await status(bookingId))?.status).toBe('searching');

    await put('/pro/online', { online: true }, pro.cookie);
    await dispatchTick(t.deps);
    expect((await get('/pro/offers', pro.cookie)).json().offers).toHaveLength(1);
  });

  it('prefers an online pro, and passes an unanswered offer on when its pro goes offline', async () => {
    const first = await daniel();
    const second = await leon();
    const bookingId = await book();
    const offered = await t.pool.query<{ pro_id: string }>("SELECT pro_id FROM booking_offers WHERE booking_id = $1 AND status = 'pending'", [bookingId]);
    const holder = offered.rows[0]?.pro_id === first.proId ? first : second;
    const other = holder === first ? second : first;
    await put('/pro/online', { online: false }, holder.cookie);
    expect((await get('/pro/offers', holder.cookie)).json().offers).toEqual([]);
    expect((await get('/pro/offers', other.cookie)).json().offers).toHaveLength(1);
  });

  it('keeps accepted jobs when the pro goes offline', async () => {
    const job = await assignedJob();
    await put('/pro/online', { online: false }, job.pro.cookie);
    expect((await get(`/pro/jobs/${job.bookingId}`, job.pro.cookie)).json().job.status).toBe('accepted');
  });

  it(`sets a pro offline after ${MISSED_OFFERS_LIMIT} offers in a row ran out, and tells them`, async () => {
    const pro = await daniel();
    const bookingId = await book();
    // Two earlier offers that ran out, then the live one also runs out.
    for (let i = 0; i < 2; i += 1) {
      const other = await book();
      await t.pool.query("UPDATE booking_offers SET status = 'expired' WHERE booking_id = $1", [other]);
    }
    await t.pool.query("UPDATE booking_offers SET expires_at = now() - interval '1 second', offered_at = now() WHERE booking_id = $1", [bookingId]);
    await dispatchTick(t.deps);
    expect((await get('/pro/profile', pro.cookie)).json().profile.online).toBe(false);
    expect((await notifications(pro.proId)).map((n) => n.body)).toContainEqual(expect.stringContaining('you missed 3 job offers in a row'));
    // Going online starts a new run.
    await put('/pro/online', { online: true }, pro.cookie);
    expect(await setOfflineAfterMissedOffers(t.deps)).toBe(0);
  });

  it('does not count a declined offer as missed', async () => {
    const pro = await daniel();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push(await book());
    await t.pool.query("UPDATE booking_offers SET status = 'expired' WHERE booking_id = ANY($1)", [ids.slice(0, 2)]);
    await t.pool.query("UPDATE booking_offers SET status = 'declined' WHERE booking_id = $1", [ids[2]]);
    expect(await setOfflineAfterMissedOffers(t.deps)).toBe(0);
    expect((await get('/pro/profile', pro.cookie)).json().profile.online).toBe(true);
  });
});

describe('the job checklist', () => {
  it("lists the service's tasks and lets the pro tick them off only while working", async () => {
    const job = await assignedJob();
    const tasks = (await get(`/pro/jobs/${job.bookingId}`, job.pro.cookie)).json().job.tasks;
    expect(tasks).toEqual([
      { key: 't0', label: 'Mow the lawn', done: false },
      { key: 't1', label: 'Edge the borders', done: false },
      { key: 't2', label: 'Clear the clippings', done: false },
    ]);
    expect((await post(`/pro/jobs/${job.bookingId}/tasks`, { key: 't0', done: true }, job.pro.cookie)).json()).toEqual({ error: 'invalid_status' });
    await working(job);
    const ticked = await post(`/pro/jobs/${job.bookingId}/tasks`, { key: 't0', done: true }, job.pro.cookie);
    expect(ticked.json().job.tasks[0]).toEqual({ key: 't0', label: 'Mow the lawn', done: true });
    // Ticking twice is harmless; unticking works.
    await post(`/pro/jobs/${job.bookingId}/tasks`, { key: 't0', done: true }, job.pro.cookie);
    await post(`/pro/jobs/${job.bookingId}/tasks`, { key: 't1', done: true }, job.pro.cookie);
    const unticked = await post(`/pro/jobs/${job.bookingId}/tasks`, { key: 't1', done: false }, job.pro.cookie);
    expect(unticked.json().job.tasks.map((task: { done: boolean }) => task.done)).toEqual([true, false, false]);
    expect((await post(`/pro/jobs/${job.bookingId}/tasks`, { key: 't9', done: true }, job.pro.cookie)).json()).toEqual({ error: 'unknown_task' });
    // The customer sees the progress on their booking page.
    expect((await get(`/bookings/${job.bookingId}`)).json().booking.tasks.filter((task: { done: boolean }) => task.done)).toHaveLength(1);
  });

  it('keeps the tasks the booking was made with when the catalogue changes later', async () => {
    const job = await assignedJob();
    await t.pool.query("UPDATE services SET tasks = '{Something new}' WHERE id = $1", [market.mowing]);
    expect((await get(`/pro/jobs/${job.bookingId}`, job.pro.cookie)).json().job.tasks).toHaveLength(3);
  });

  it('uses the service name for a service without tasks, and refuses other pros', async () => {
    await t.pool.query("UPDATE services SET tasks = '{}' WHERE id = $1", [market.mowing]);
    const job = await assignedJob();
    expect((await get(`/pro/jobs/${job.bookingId}`, job.pro.cookie)).json().job.tasks).toEqual([{ key: 't0', label: 'Lawn mowing', done: false }]);
    const other = await leon();
    expect((await post(`/pro/jobs/${job.bookingId}/tasks`, { key: 't0', done: true }, other.cookie)).statusCode).toBe(404);
  });
});

describe('extra work from the MISK price list', () => {
  it('lists the other services of the trade at the job size and extra time at the job rate', async () => {
    const job = await assignedJob();
    const items = (await get(`/pro/jobs/${job.bookingId}/price-list`, job.pro.cookie)).json().items;
    // Hedge trimming €45 × 130% for a medium job; 30 minutes of a €45.50, 60-minute job.
    expect(items).toEqual([
      { id: `service:${market.hedge}`, name: 'Hedge trimming', priceCents: 5850, durationMinutes: 90 },
      { id: 'time:30', name: 'Extra 30 minutes of work', priceCents: 2275, durationMinutes: 30 },
    ]);
    const other = await leon();
    expect((await get(`/pro/jobs/${job.bookingId}/price-list`, other.cookie)).statusCode).toBe(404);
  });

  it("sends the item with the server's price and the note, and never takes a price from the app", async () => {
    const job = await assignedJob();
    expect(
      (await post(`/pro/jobs/${job.bookingId}/extras`, { itemId: 'time:30', priceCents: 100 }, job.pro.cookie)).statusCode,
    ).toBe(400);
    expect(
      (await post(`/pro/jobs/${job.bookingId}/extras`, { description: 'Trim', priceCents: 2000, durationMinutes: 30 }, job.pro.cookie)).statusCode,
    ).toBe(400);
    expect((await post(`/pro/jobs/${job.bookingId}/extras`, { itemId: `service:${market.mowing}` }, job.pro.cookie)).json()).toEqual({
      error: 'unknown_price_item',
    });
    const sent = await post(`/pro/jobs/${job.bookingId}/extras`, { itemId: `service:${market.hedge}`, note: ' The front hedge is overgrown ' }, job.pro.cookie);
    expect(sent.statusCode).toBe(201);
    expect(sent.json().job.extras).toEqual([
      expect.objectContaining({ description: 'Hedge trimming', priceCents: 5850, durationMinutes: 90, status: 'pending' }),
    ]);
    const stored = await t.pool.query('SELECT price_item, note FROM extra_requests WHERE booking_id = $1', [job.bookingId]);
    expect(stored.rows[0]).toEqual({ price_item: `service:${market.hedge}`, note: 'The front hedge is overgrown' });
    expect((await post(`/pro/jobs/${job.bookingId}/extras`, { itemId: 'time:30' }, job.pro.cookie)).json()).toEqual({ error: 'extra_already_pending' });

    // The customer approves it as before, and it joins the checklist.
    const extraId = sent.json().job.extras[0].id as string;
    expect((await post(`/bookings/${job.bookingId}/extras/${extraId}/approve`)).statusCode).toBe(200);
    const tasks = (await get(`/pro/jobs/${job.bookingId}`, job.pro.cookie)).json().job.tasks;
    expect(tasks.at(-1)).toEqual({ key: `x-${extraId}`, label: 'Hedge trimming', done: false });
  });
});

describe('reporting an issue on site', () => {
  it('reaches support under Needs action and in the booking log, once at a time, until the team resolves it', async () => {
    const job = await assignedJob();
    const admin = await signInAdmin(t);
    expect((await post(`/pro/jobs/${job.bookingId}/issue`, { reason: 'other' }, job.pro.cookie)).json()).toEqual({ error: 'details_required' });
    expect((await post(`/pro/jobs/${job.bookingId}/issue`, { reason: 'flood' }, job.pro.cookie)).statusCode).toBe(400);

    const reported = await post(`/pro/jobs/${job.bookingId}/issue`, { reason: 'customer_not_home', details: 'Rang twice' }, job.pro.cookie);
    expect(reported.statusCode).toBe(201);
    expect(reported.json().job.openIssue).toMatchObject({ reason: 'customer_not_home' });
    expect((await post(`/pro/jobs/${job.bookingId}/issue`, { reason: 'unsafe' }, job.pro.cookie)).json()).toEqual({ error: 'issue_already_open' });
    // The customer is told the pro is at the door, and sees that support is involved.
    expect((await notifications(await customerId())).map((n) => n.body)).toContainEqual(expect.stringContaining('Daniel is at 12 Linden Street'));
    expect((await get(`/bookings/${job.bookingId}`)).json().booking.proIssueOpen).toBe(true);

    const list = (await get('/admin/bookings?tab=needs_action', admin)).json();
    expect(list.bookings).toEqual([expect.objectContaining({ id: job.bookingId, proIssue: true })]);
    const drawer = (await get(`/admin/bookings/${job.bookingId}`, admin)).json().booking;
    expect(drawer.issues).toEqual([expect.objectContaining({ reason: 'customer_not_home', details: 'Rang twice', proName: 'Daniel', resolvedAt: null })]);
    expect(drawer.actions[0]).toMatchObject({ action: 'issue_reported', adminName: null, details: { proName: 'Daniel', reason: 'customer_not_home' } });

    const issueId = drawer.issues[0].id as string;
    const resolved = await post(`/admin/bookings/${job.bookingId}/issues/${issueId}/resolve`, undefined, admin);
    expect(resolved.json().booking.actions[0]).toMatchObject({ action: 'issue_resolved' });
    expect((await post(`/admin/bookings/${job.bookingId}/issues/${issueId}/resolve`, undefined, admin)).json()).toEqual({ error: 'issue_not_open' });
    expect((await get('/admin/bookings?tab=needs_action', admin)).json().bookings).toEqual([]);
    expect((await get(`/pro/jobs/${job.bookingId}`, job.pro.cookie)).json().job.openIssue).toBeNull();
    // A new issue can be reported after the first one was dealt with.
    expect((await post(`/pro/jobs/${job.bookingId}/issue`, { reason: 'unsafe' }, job.pro.cookie)).statusCode).toBe(201);
  });

  it('allows at most 5 reports per job, and none from another pro or once the job is done', async () => {
    const job = await assignedJob();
    for (let i = 0; i < 5; i += 1) {
      expect((await post(`/pro/jobs/${job.bookingId}/issue`, { reason: 'bigger_job' }, job.pro.cookie)).statusCode).toBe(201);
      await t.pool.query('UPDATE booking_issues SET resolved_at = now() WHERE booking_id = $1', [job.bookingId]);
    }
    expect((await post(`/pro/jobs/${job.bookingId}/issue`, { reason: 'bigger_job' }, job.pro.cookie)).json()).toEqual({ error: 'too_many_issues' });
    const other = await leon();
    expect((await post(`/pro/jobs/${job.bookingId}/issue`, { reason: 'unsafe' }, other.cookie)).statusCode).toBe(404);
    expect((await post(`/admin/bookings/${job.bookingId}/issues/${job.bookingId}/resolve`, undefined, job.pro.cookie)).statusCode).toBe(403);
  });
});

describe('a pro cancelling a job', () => {
  it('before 24 hours: sends the job back to other pros, tells the customer and logs it', async () => {
    const job = await assignedJob();
    const other = await leon();
    await startsIn(job.bookingId, 30);
    expect((await post(`/pro/jobs/${job.bookingId}/cancel`, { reason: 'other' }, job.pro.cookie)).json()).toEqual({ error: 'reason_note_required' });
    const cancelled = await post(`/pro/jobs/${job.bookingId}/cancel`, { reason: 'ill' }, job.pro.cookie);
    expect(cancelled.json()).toEqual({ cancelled: { reason: 'ill', late: false } });

    expect(await status(job.bookingId)).toEqual({ status: 'searching', pro_id: null });
    expect((await get(`/pro/jobs/${job.bookingId}`, job.pro.cookie)).statusCode).toBe(404);
    expect((await get('/pro/offers', other.cookie)).json().offers).toEqual([expect.objectContaining({ bookingId: job.bookingId })]);
    expect((await notifications(await customerId())).map((n) => n.body)).toContainEqual(
      expect.stringContaining('Daniel can no longer do your Lawn mowing'),
    );
    const customerView = (await get(`/bookings/${job.bookingId}`)).json().booking;
    expect(customerView).toMatchObject({ status: 'searching', pro: null });

    const admin = await signInAdmin(t);
    const drawer = (await get(`/admin/bookings/${job.bookingId}`, admin)).json().booking;
    expect(drawer.actions[0]).toMatchObject({ action: 'pro_cancelled', details: { proName: 'Daniel', reason: 'ill', late: false } });
    expect(drawer.proCancellations).toEqual([expect.objectContaining({ proName: 'Daniel', reason: 'ill', late: false })]);

    // The pro who gave it back is not offered it again.
    await post(`/pro/offers/${(await get('/pro/offers', other.cookie)).json().offers[0].id}/decline`, undefined, other.cookie);
    expect((await get('/pro/offers', job.pro.cookie)).json().offers).toEqual([]);
    expect((await status(job.bookingId))?.status).toBe('unassigned');
  });

  it("keeps the earlier pro's chat private from the next pro, while the customer sees all of it", async () => {
    const job = await assignedJob();
    const other = await leon();
    await startsIn(job.bookingId, 30);
    expect((await post(`/bookings/${job.bookingId}/messages`, { body: 'The gate code is 4711' })).statusCode).toBe(201);
    expect((await post(`/pro/jobs/${job.bookingId}/messages`, { body: 'Thanks, Daniel here' }, job.pro.cookie)).statusCode).toBe(201);
    expect((await post(`/pro/jobs/${job.bookingId}/cancel`, { reason: 'ill' }, job.pro.cookie)).statusCode).toBe(200);
    await acceptFirstOffer(other.cookie);

    const leonView = (await get(`/pro/jobs/${job.bookingId}/messages`, other.cookie)).json().messages as { body: string }[];
    expect(leonView).toEqual([]);
    expect((await get(`/pro/jobs/${job.bookingId}`, other.cookie)).json().job.unreadMessages ?? 0).toBe(0);
    expect((await post(`/pro/jobs/${job.bookingId}/messages`, { body: 'Leon here, see you soon' }, other.cookie)).statusCode).toBe(201);
    expect(((await get(`/pro/jobs/${job.bookingId}/messages`, other.cookie)).json().messages as { body: string }[]).map((m) => m.body)).toEqual([
      'Leon here, see you soon',
    ]);
    const customerView = (await get(`/bookings/${job.bookingId}/messages`)).json().messages as { body: string }[];
    expect(customerView.map((m) => m.body)).toEqual(['The gate code is 4711', 'Thanks, Daniel here', 'Leon here, see you soon']);
  });

  it('under 24 hours is late, and three late ones in 30 days pause new offers for a week', async () => {
    const pro = await daniel();
    for (let i = 0; i < 3; i += 1) {
      const bookingId = await book();
      await acceptFirstOffer(pro.cookie);
      await startsIn(bookingId, 5);
      expect((await post(`/pro/jobs/${bookingId}/cancel`, { reason: 'other', note: 'Van broke down' }, pro.cookie)).json()).toEqual({
        cancelled: { reason: 'other', late: true },
      });
      await t.pool.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [bookingId]);
    }
    expect((await get('/pro/profile', pro.cookie)).json().profile.offersPausedUntil).not.toBeNull();
    await book();
    expect((await get('/pro/offers', pro.cookie)).json().offers).toEqual([]);
    // A week later offers come again.
    await t.pool.query("UPDATE pro_cancellations SET created_at = created_at - interval '8 days'");
    await dispatchTick(t.deps);
    expect((await get('/pro/profile', pro.cookie)).json().profile.offersPausedUntil).toBeNull();
  });

  it('is not possible once work has started, and drops extra work the pro asked for', async () => {
    const job = await assignedJob();
    await startsIn(job.bookingId, 30);
    await post(`/pro/jobs/${job.bookingId}/extras`, { itemId: 'time:30' }, job.pro.cookie);
    await post(`/pro/jobs/${job.bookingId}/cancel`, { reason: 'vehicle' }, job.pro.cookie);
    const extras = await t.pool.query('SELECT status FROM extra_requests WHERE booking_id = $1', [job.bookingId]);
    expect(extras.rows).toEqual([{ status: 'cancelled' }]);

    await put('/pro/online', { online: false }, job.pro.cookie);
    const second = await assignedJobFor(await leon());
    await working(second);
    expect((await post(`/pro/jobs/${second.bookingId}/cancel`, { reason: 'ill' }, second.pro.cookie)).json()).toEqual({ error: 'job_started' });
  });
});

async function assignedJobFor(pro: { cookie: string; proId: string }) {
  await book();
  const bookingId = await acceptFirstOffer(pro.cookie);
  return { bookingId, pro };
}

describe('rating the customer', () => {
  async function completed(pro?: { cookie: string; proId: string }) {
    const job = pro ? await assignedJobFor(pro) : await assignedJob();
    await working(job);
    await upload(t, `/pro/jobs/${job.bookingId}/photos`, job.pro.cookie, FILES.png);
    expect((await post(`/pro/jobs/${job.bookingId}/complete`, undefined, job.pro.cookie)).statusCode).toBe(200);
    return job;
  }

  it('is only possible after the job, once, by its pro, and shows to admins and to the next pros', async () => {
    const early = await assignedJob();
    expect((await post(`/pro/jobs/${early.bookingId}/customer-rating`, { stars: 5 }, early.pro.cookie)).json()).toEqual({ error: 'customer_not_ratable' });
    await t.pool.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [early.bookingId]);

    const job = await completed(early.pro);
    expect((await get(`/pro/jobs/${job.bookingId}`, job.pro.cookie)).json().job.canRateCustomer).toBe(true);
    expect((await post(`/pro/jobs/${job.bookingId}/customer-rating`, { stars: 6 }, job.pro.cookie)).statusCode).toBe(400);
    expect((await post(`/pro/jobs/${job.bookingId}/customer-rating`, { stars: 4, tags: ['rude'] }, job.pro.cookie)).statusCode).toBe(400);
    const other = await leon();
    expect((await post(`/pro/jobs/${job.bookingId}/customer-rating`, { stars: 1 }, other.cookie)).statusCode).toBe(404);

    const rated = await post(`/pro/jobs/${job.bookingId}/customer-rating`, { stars: 4, tags: ['friendly', 'easy_access'] }, job.pro.cookie);
    expect(rated.statusCode).toBe(201);
    expect(rated.json().job).toMatchObject({ customerRating: { stars: 4, tags: ['friendly', 'easy_access'] }, canRateCustomer: false });
    expect((await post(`/pro/jobs/${job.bookingId}/customer-rating`, { stars: 5 }, job.pro.cookie)).json()).toEqual({ error: 'already_rated' });

    const admin = await signInAdmin(t);
    const profile = (await get(`/admin/bookings/${job.bookingId}`, admin)).json().booking.customerProfile;
    expect(profile).toMatchObject({ proRatingAverage: 4, proRatingCount: 1 });
    // The customer never sees it.
    expect(JSON.stringify((await get(`/bookings/${job.bookingId}`)).json())).not.toContain('customerRating');

    // The next pro sees the customer's stars on the offer.
    await book();
    const offers = [...(await get('/pro/offers', job.pro.cookie)).json().offers, ...(await get('/pro/offers', other.cookie)).json().offers];
    expect(offers).toEqual([expect.objectContaining({ customerRating: 4 })]);
  });

  it('closes 7 days after the job', async () => {
    const job = await completed();
    await t.pool.query("UPDATE bookings SET completed_at = now() - interval '8 days' WHERE id = $1", [job.bookingId]);
    expect((await get(`/pro/jobs/${job.bookingId}`, job.pro.cookie)).json().job.canRateCustomer).toBe(false);
    expect((await post(`/pro/jobs/${job.bookingId}/customer-rating`, { stars: 5 }, job.pro.cookie)).json()).toEqual({ error: 'customer_not_ratable' });
  });
});
