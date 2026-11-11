import {
  approvedPro,
  call,
  createTestContext,
  FILES,
  giveRating,
  resetDatabase,
  seedMarket,
  sessionCookie,
  signIn,
  signInAdmin,
  upload,
  type Market,
  type TestContext,
} from '../../test/helpers.js';
import { hashPassword } from '../auth/passwords.js';
import { addDays, marketToday, proNumbers } from './checks.js';
import { documentExpiryTick } from './management.js';

let t: TestContext;
let market: Market;
let admin: string;

beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(async () => {
  await resetDatabase(t.pool);
  t.fake.reset();
  market = await seedMarket(t.pool);
  admin = await signInAdmin(t);
});

const PRO_PHONE = '+4915111111111';
const KINDS = ['id', 'certificate', 'insurance', 'background'] as const;

async function applicant(phone = PRO_PHONE, firstName = 'Daniel') {
  const cookie = await signIn(t, phone, 'pro', firstName);
  await call(t, 'PATCH', '/pro/profile', {
    cookie,
    body: { trades: [market.gardening], homePostcode: '10115', radiusKm: 15, workingDays: [1, 2, 3] },
  });
  await upload(t, '/pro/documents/id?expiresOn=2031-05-01', cookie, FILES.jpeg, 'passport.jpg');
  await upload(t, '/pro/documents/certificate', cookie, FILES.pdf, 'gardener-certificate.pdf');
  await upload(t, '/pro/documents/insurance?expiresOn=2030-01-31', cookie, FILES.png, 'insurance.png');
  await upload(t, '/pro/documents/background', cookie, FILES.pdf, 'good-conduct.pdf');
  await call(t, 'POST', '/pro/submit', { cookie });
  const { id } = (await call(t, 'GET', '/auth/me', { cookie })).json().user as { id: string };
  return { cookie, id };
}

const post = (url: string, body?: unknown) => call(t, 'POST', url, { cookie: admin, ...(body === undefined ? {} : { body }) });
const get = (url: string) => call(t, 'GET', url, { cookie: admin });
const list = async (tab: string) => (await get(`/admin/pros?tab=${tab}`)).json().pros as { id: string; [key: string]: unknown }[];
const texts = async (userId: string) =>
  (await t.pool.query<{ body: string }>('SELECT body FROM notifications WHERE user_id = $1 ORDER BY created_at, id', [userId])).rows.map(
    (r) => r.body,
  );

async function acceptAll(id: string) {
  for (const kind of KINDS) {
    expect((await post(`/admin/pros/${id}/documents/${kind}/accept`, {})).statusCode).toBe(200);
  }
}

describe('applications on the overview', () => {
  const live = async (cookie = admin) => (await call(t, 'GET', '/admin/overview/live', { cookie })).json();

  it('counts waiting applications and lists documents uploaded and who can be approved straight away', async () => {
    const ready = await applicant(PRO_PHONE, 'Daniel');
    await acceptAll(ready.id);
    const open = await applicant('+4915111111112', 'Erion');
    await t.pool.query("DELETE FROM pro_documents WHERE pro_id = $1 AND kind = 'background'", [open.id]);

    const before = (await live()).applications;
    expect(before.waiting).toBe(2);
    expect(before.pros).toEqual([
      expect.objectContaining({
        id: ready.id,
        firstName: 'Daniel',
        trades: ['Gardening'],
        documentsUploaded: 4,
        documentsTotal: 4,
        ready: true,
      }),
      expect.objectContaining({ id: open.id, firstName: 'Erion', documentsUploaded: 3, documentsTotal: 4, ready: false }),
    ]);

    expect((await post(`/admin/pros/${ready.id}/approve`)).statusCode).toBe(200);
    expect((await texts(ready.id)).at(-1)).toContain('you are approved');
    const after = (await live()).applications;
    expect(after.waiting).toBe(1);
    expect(after.pros.map((p: { id: string }) => p.id)).toEqual([open.id]);
  });

  it('leaves applications out for team members who may not open Providers', async () => {
    await applicant();
    await t.pool.query(`INSERT INTO users (username, password_hash, role, admin_role) VALUES ('fiona', $1, 'admin', 'finance')`, [
      await hashPassword('a long teammate password'),
    ]);
    const finance = sessionCookie(
      await call(t, 'POST', '/auth/admin/login', { body: { username: 'fiona', password: 'a long teammate password' } }),
    );
    const seen = await live(finance);
    expect(seen.applications).toBeNull();
    expect(seen.bookings).toEqual([]);
    expect((await call(t, 'GET', '/admin/pros?tab=applications', { cookie: finance })).statusCode).toBe(403);
  });
});

describe('applications', () => {
  it('lists name, trade, when they applied and checks done, and marks complete ones Ready', async () => {
    const { id } = await applicant();
    let [row] = await list('applications');
    expect(row).toMatchObject({ id, firstName: 'Daniel', trades: ['Gardening'], checksDone: 0, checksTotal: 4, ready: false });
    expect(row?.submittedAt).toEqual(expect.any(String));

    await acceptAll(id);
    [row] = await list('applications');
    expect(row).toMatchObject({ checksDone: 4, ready: true });
    expect((await get('/admin/badges')).json()).toEqual({ applications: 1 });
  });

  it('shows travel distance, working days and each check with its state', async () => {
    const { id } = await applicant();
    await post(`/admin/pros/${id}/documents/id/accept`, {});
    await post(`/admin/pros/${id}/documents/certificate/reject`, { note: 'The photo is blurry' });
    const pro = (await get(`/admin/pros/${id}`)).json().pro;
    expect(pro).toMatchObject({ radiusKm: 15, workingDays: [1, 2, 3], homePostcode: '10115', allChecksOk: false });
    expect(pro.checks.map((c: { kind: string; ok: boolean; state: string }) => [c.kind, c.ok, c.state])).toEqual([
      ['id', true, 'valid'],
      ['certificate', false, 'rejected'],
      ['insurance', false, 'waiting_review'],
      ['background', false, 'waiting_review'],
    ]);
    expect(pro.checks[0].document).toMatchObject({ fileName: 'passport.jpg', expiresOn: '2031-05-01' });
    expect((await texts(id)).at(-1)).toContain('new copy of your trade certificate. The photo is blurry');
  });

  it('approves only when all four checks are OK, then moves the pro to Active and texts them', async () => {
    const { id } = await applicant();
    expect((await post(`/admin/pros/${id}/approve`)).json()).toEqual({ error: 'checks_open' });
    await acceptAll(id);
    const approved = await post(`/admin/pros/${id}/approve`);
    expect(approved.json().pro).toMatchObject({ status: 'approved' });
    expect(approved.json().pro.actions.map((a: { action: string }) => a.action)).toContain('approved');
    expect((await list('applications')).map((p) => p.id)).toEqual([]);
    expect((await list('active')).map((p) => p.id)).toEqual([id]);
    expect((await texts(id)).at(-1)).toContain('you are approved');
    expect((await post(`/admin/pros/${id}/approve`)).json()).toEqual({ error: 'invalid_status' });
  });

  it('asks for more information by text and marks the application', async () => {
    const { id, cookie } = await applicant();
    const asked = await post(`/admin/pros/${id}/request-info`, { message: 'Please send a sharper photo of your ID.' });
    expect(asked.json().pro).toMatchObject({ status: 'info_requested', reviewNote: 'Please send a sharper photo of your ID.' });
    expect((await list('applications'))[0]).toMatchObject({ status: 'info_requested' });
    expect((await texts(id)).at(-1)).toContain('Please send a sharper photo of your ID.');
    expect((await get('/admin/badges')).json()).toEqual({ applications: 0 });
    expect((await call(t, 'POST', '/pro/submit', { cookie })).json().profile.status).toBe('submitted');
    expect((await post(`/admin/pros/${id}/request-info`, { message: '  ' })).statusCode).toBe(400);
  });

  it('removes a rejected application from every list and tells the applicant', async () => {
    const { id } = await applicant();
    expect((await post(`/admin/pros/${id}/reject`, {})).statusCode).toBe(400);
    const rejected = await post(`/admin/pros/${id}/reject`, { note: 'We do not serve your area yet.' });
    expect(rejected.json().pro.status).toBe('rejected');
    for (const tab of ['applications', 'active', 'pending_approval', 'suspended']) {
      expect(await list(tab)).toEqual([]);
    }
    expect((await texts(id)).at(-1)).toContain('could not approve');
  });

  it('keeps the page for admins only', async () => {
    const { cookie } = await applicant();
    expect((await call(t, 'GET', '/admin/pros?tab=active', { cookie })).statusCode).toBe(403);
    expect((await get('/admin/pros?tab=everyone')).statusCode).toBe(400);
  });
});

describe('active pros', () => {
  it('works out acceptance, on-time rate and quality warnings from the last 30 days', () => {
    const base = { jobs30: 8, offers30: 10, accepted30: 8, timed30: 10, ontime30: 8, regulars: 2, rating_avg: 4.8, rating_count: 6 };
    expect(proNumbers(base)).toMatchObject({ acceptancePct: 80, onTimePct: 80, qualityReasons: ['low_acceptance', 'late'] });
    expect(proNumbers({ ...base, accepted30: 9, ontime30: 9 }).qualityReasons).toEqual([]);
    expect(proNumbers({ ...base, offers30: 3, accepted30: 1, timed30: 2, ontime30: 0 }).qualityReasons).toEqual([]);
    expect(proNumbers({ ...base, accepted30: 9, ontime30: 9, rating_avg: 3.6 }).qualityReasons).toEqual(['low_rating']);
    expect(proNumbers({ ...base, offers30: 0, timed30: 0 })).toMatchObject({ acceptancePct: null, onTimePct: null });
  });

  it('shows each pro with jobs, acceptance, on-time rate, regular customers and an expiring-document flag', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const customer = await signIn(t, '+4915100000001', 'customer', 'Sara');
    const customerId = (await call(t, 'GET', '/auth/me', { cookie: customer })).json().user.id;
    // Two finished jobs (one started 30 minutes late) and one declined offer.
    for (const late of [0, 30]) {
      const job = await t.pool.query<{ id: string }>(
        `INSERT INTO bookings (customer_id, service_id, category_id, service_name, size, address, postcode, starts_at, ends_at,
           status, price_cents, fee_cents, pro_share_pct, pro_id, completed_at, payment_status)
         VALUES ($1, $2, $3, 'Lawn mowing', 'M', '12 Linden Street', '10115', now() - interval '3 days',
           now() - interval '3 days' + interval '1 hour', 'completed', 4550, 290, 82, $4, now() - interval '3 days', 'captured')
         RETURNING id`,
        [customerId, market.mowing, market.gardening, pro.proId],
      );
      const jobId = job.rows[0]?.id;
      await t.pool.query(
        "INSERT INTO booking_events (booking_id, status, created_at) VALUES ($1, 'working', now() - interval '3 days' + make_interval(mins => $2))",
        [jobId, late],
      );
      await t.pool.query(
        "INSERT INTO booking_offers (booking_id, pro_id, status, offered_at, expires_at) VALUES ($1, $2, 'accepted', now() - interval '4 days', now())",
        [jobId, pro.proId],
      );
    }
    const declined = await t.pool.query<{ id: string }>(
      `INSERT INTO bookings (customer_id, service_id, category_id, service_name, size, address, postcode, starts_at, ends_at,
         status, price_cents, fee_cents, pro_share_pct, cancelled_by)
       VALUES ($1, $2, $3, 'Lawn mowing', 'M', '12 Linden Street', '10115', now() - interval '2 days',
         now() - interval '2 days' + interval '1 hour', 'cancelled', 4550, 290, 82, 'customer') RETURNING id`,
      [customerId, market.mowing, market.gardening],
    );
    await t.pool.query(
      "INSERT INTO booking_offers (booking_id, pro_id, status, offered_at, expires_at) VALUES ($1, $2, 'declined', now() - interval '2 days', now())",
      [declined.rows[0]?.id, pro.proId],
    );
    const stored = await t.pool.query<{ id: string }>(
      "INSERT INTO uploads (owner_id, kind, mime, size_bytes, storage_key) VALUES ($1, 'document', 'application/pdf', 1, 'k1') RETURNING id",
      [pro.proId],
    );
    await t.pool.query(
      "INSERT INTO pro_documents (pro_id, kind, upload_id, review_status, expires_on, valid_until) VALUES ($1, 'insurance', $2, 'accepted', $3::date, $3::date)",
      [pro.proId, stored.rows[0]?.id, addDays(marketToday(t.config.timezone), 10)],
    );

    const [row] = await list('active');
    expect(row).toMatchObject({
      id: pro.proId,
      jobs30: 2,
      acceptancePct: 67,
      onTimePct: 50,
      regularCustomers: 0,
      expiringDocument: true,
      qualityReasons: [],
    });
    const summary = (await get('/admin/pros/summary')).json();
    expect(summary.kpis).toMatchObject({ activePros: 1, avgAcceptancePct: 67, documentsExpiring: 1 });
    expect(summary.counts).toEqual({ applications: 0, active: 1, pending_approval: 0, suspended: 0 });
    expect(summary.inviteUrl).toBe('http://localhost:5173/signin?as=pro&method=phone');
    // The pro's own session was just used, so they count as online.
    expect(summary.kpis.onlineNow).toBe(1);
  });

  it('opens a profile with rating, earnings, bank last 4 digits, next payout, reviews and the log', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    await giveRating(t.pool, pro.proId, 4);
    const profile = (await get(`/admin/pros/${pro.proId}`)).json().pro;
    expect(profile).toMatchObject({
      ratingAverage: 4,
      ratingCount: 1,
      earnedThisMonthCents: 0,
      bank: { bankLast4: '3000', nextPayout: { amountCents: 12450 } },
      reviews: [expect.objectContaining({ stars: 4 })],
      regulars: [],
    });

    t.fake.failures.add('payoutDetails');
    const withoutBank = (await get(`/admin/pros/${pro.proId}`)).json().pro;
    expect(withoutBank.bank).toBeNull();
  });
});

describe('acting on a pro', () => {
  it('puts a pro on the watch list, books a coaching call, and logs both', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    await post(`/admin/pros/${pro.proId}/watch-list`, { on: true });
    const at = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
    const booked = await post(`/admin/pros/${pro.proId}/coaching`, { startsAt: at });
    expect(booked.json().pro).toMatchObject({ coachingCallAt: at, watchListAt: expect.any(String) });
    expect(booked.json().pro.actions.map((a: { action: string }) => a.action)).toEqual(['coaching_booked', 'watch_list_on']);
    expect((await texts(pro.proId)).at(-1)).toContain('short call');
    expect((await post(`/admin/pros/${pro.proId}/coaching`, { startsAt: '2020-01-01T10:00:00.000Z' })).json()).toEqual({
      error: 'time_in_past',
    });
    const off = await post(`/admin/pros/${pro.proId}/watch-list`, { on: false });
    expect(off.json().pro.watchListAt).toBeNull();
  });

  it('pauses new jobs until resumed', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const customer = await signIn(t, '+4915100000001', 'customer', 'Sara');
    const slotsFor = async () =>
      (await call(t, 'GET', `/availability?serviceId=${market.mowing}&postcode=10115`, { cookie: customer })).json().slots as {
        available: boolean;
      }[];
    expect((await slotsFor()).some((s) => s.available)).toBe(true);

    await post(`/admin/pros/${pro.proId}/pause`);
    expect((await slotsFor()).some((s) => s.available)).toBe(false);
    expect((await list('active'))[0]).toMatchObject({ jobsPaused: true });
    expect((await post(`/admin/pros/${pro.proId}/pause`)).json()).toEqual({ error: 'invalid_status' });

    const resumed = await post(`/admin/pros/${pro.proId}/resume`);
    expect(resumed.json().pro.jobsPausedAt).toBeNull();
    expect((await slotsFor()).some((s) => s.available)).toBe(true);
    expect(resumed.json().pro.actions.map((a: { action: string }) => a.action)).toEqual(['jobs_resumed', 'jobs_paused']);
  });

  it('suspends a pro, gives their booked jobs and plans to other pros, and reinstates them', async () => {
    const leaving = await approvedPro(t, '+4915100000101', { trades: [market.gardening], firstName: 'Leaving' });
    await giveRating(t.pool, leaving.proId, 5);
    const customer = await signIn(t, '+4915100000001', 'customer', 'Sara');

    // A booked one-off job.
    const slots = (await call(t, 'GET', `/availability?serviceId=${market.mowing}&postcode=10115`, { cookie: customer })).json().slots;
    const slot = slots.find((s: { available: boolean }) => s.available).startsAt;
    const booked = await call(t, 'POST', '/bookings', {
      cookie: customer,
      body: { serviceId: market.mowing, size: 'M', address: '12 Linden Street', postcode: '10115', startsAt: slot },
    });
    const bookingId = booked.json().booking.id;
    const offer = (await call(t, 'GET', '/pro/offers', { cookie: leaving.cookie })).json().offers[0];
    await call(t, 'POST', `/pro/offers/${offer.id}/accept`, { cookie: leaving.cookie });

    // A monthly plan with the same pro.
    const plan = await post('/admin/plans', {
      name: 'Lawn care',
      categoryId: market.gardening,
      priceCents: 4900,
      frequency: 'weekly',
      visitMinutes: 60,
      tasks: ['Mow'],
      addonName: null,
      addonPriceCents: null,
      seasonal: false,
      skipsPerMonth: 1,
      minTermMonths: 3,
      proSharePct: 70,
    });
    const planId = plan.json().plan.id;
    await post(`/admin/plans/${planId}/status`, { published: true });
    const subscribed = await call(t, 'POST', '/subscriptions', {
      cookie: customer,
      body: { planId, size: 'M', days: [4], timeWindow: 'afternoon', address: '12 Linden Street', postcode: '10115', withAddon: false },
    });
    expect(subscribed.json().subscription.proName).toBe('Leaving');

    const other = await approvedPro(t, '+4915100000102', { trades: [market.gardening], firstName: 'Jonas' });
    expect((await post(`/admin/pros/${leaving.proId}/suspend`, {})).statusCode).toBe(400);
    const suspended = await post(`/admin/pros/${leaving.proId}/suspend`, { reason: 'Three complaints about damage' });
    expect(suspended.json()).toMatchObject({
      pro: { status: 'suspended', suspendedReason: 'Three complaints about damage' },
      handOver: { bookings: 1, plans: 1, plansWithoutPro: 0 },
    });

    const job = (await call(t, 'GET', `/bookings/${bookingId}`, { cookie: customer })).json().booking;
    expect(job).toMatchObject({ status: 'searching', pro: null });
    expect((await call(t, 'GET', '/pro/offers', { cookie: other.cookie })).json().offers).toHaveLength(1);
    const mine = (await call(t, 'GET', '/subscriptions', { cookie: customer })).json().subscriptions[0];
    expect(mine.proName).toBe('Jonas');
    const leftVisits = await t.pool.query(
      "SELECT 1 FROM subscription_visits WHERE pro_id = $1 AND status = 'planned' AND starts_at > now()",
      [leaving.proId],
    );
    expect(leftVisits.rowCount).toBe(0);

    const [row] = await list('suspended');
    expect(row).toMatchObject({ id: leaving.proId, suspendedReason: 'Three complaints about damage', suspendedAt: expect.any(String) });

    const reinstated = await post(`/admin/pros/${leaving.proId}/reinstate`);
    expect(reinstated.json().pro).toMatchObject({ status: 'approved', suspendedReason: null });
    expect(reinstated.json().pro.actions.map((a: { action: string }) => a.action)).toEqual(['reinstated', 'suspended']);
  });
});

describe('documents that run out', () => {
  async function activeWithInsuranceUntil(validUntil: string) {
    const { id, cookie } = await applicant();
    await acceptAll(id);
    await post(`/admin/pros/${id}/approve`);
    await t.pool.query("UPDATE pro_profiles SET payouts_enabled = true, stripe_account_id = 'acct_test' WHERE user_id = $1", [id]);
    await t.pool.query("UPDATE pro_documents SET expires_on = $2, valid_until = $2 WHERE pro_id = $1 AND kind = 'insurance'", [
      id,
      validUntil,
    ]);
    return { id, cookie };
  }

  it('moves a pro to Pending approval when insurance runs out, and back to Active once a new copy is accepted', async () => {
    const today = marketToday(t.config.timezone);
    const { id, cookie } = await activeWithInsuranceUntil(addDays(today, -1));
    expect(await documentExpiryTick(t.deps)).toBe(1);
    expect((await list('pending_approval')).map((p) => p.id)).toEqual([id]);
    expect((await texts(id)).at(-1)).toContain('liability insurance ran out');

    const customer = await signIn(t, '+4915100000001', 'customer', 'Sara');
    const slots = (await call(t, 'GET', `/availability?serviceId=${market.mowing}&postcode=10115`, { cookie: customer })).json().slots;
    expect(slots.some((s: { available: boolean }) => s.available)).toBe(false);

    // The pro uploads the new policy; it waits for the team.
    await upload(t, `/pro/documents/insurance?expiresOn=${addDays(today, 365)}`, cookie, FILES.pdf, 'insurance-2027.pdf');
    const waiting = (await get(`/admin/pros/${id}`)).json().pro.checks.find((c: { kind: string }) => c.kind === 'insurance');
    expect(waiting).toMatchObject({ ok: false, state: 'waiting_review', document: { fileName: 'insurance-2027.pdf' } });

    const accepted = await post(`/admin/pros/${id}/documents/insurance/accept`, {});
    expect(accepted.json()).toMatchObject({ backToActive: true, pro: { status: 'approved' } });
    expect((await list('active')).map((p) => p.id)).toEqual([id]);
    expect((await texts(id)).at(-1)).toContain('You get new jobs again');
  });

  it('asks for a new copy when a document is rejected, and keeps the pro waiting', async () => {
    const today = marketToday(t.config.timezone);
    const { id, cookie } = await activeWithInsuranceUntil(addDays(today, -1));
    await documentExpiryTick(t.deps);
    await upload(t, `/pro/documents/insurance?expiresOn=${addDays(today, 365)}`, cookie, FILES.pdf, 'wrong.pdf');
    const rejected = await post(`/admin/pros/${id}/documents/insurance/reject`, { note: 'This is last year’s policy.' });
    expect(rejected.json().pro.status).toBe('pending_approval');
    expect((await texts(id)).at(-1)).toContain('upload a new copy of your liability insurance');
  });

  it('keeps a pro active while a renewal waits, if the old copy still covers them', async () => {
    const today = marketToday(t.config.timezone);
    const { id, cookie } = await activeWithInsuranceUntil(addDays(today, 5));
    await upload(t, `/pro/documents/insurance?expiresOn=${addDays(today, 400)}`, cookie, FILES.pdf, 'renewal.pdf');
    expect(await documentExpiryTick(t.deps)).toBe(0);
    expect((await list('active')).map((p) => p.id)).toEqual([id]);
  });

  it('sends a reminder for a missing or expiring document, at most once an hour', async () => {
    const today = marketToday(t.config.timezone);
    const { id } = await activeWithInsuranceUntil(addDays(today, 10));
    await t.pool.query("DELETE FROM pro_documents WHERE pro_id = $1 AND kind = 'background'", [id]);
    const missing = await post(`/admin/pros/${id}/documents/background/remind`);
    expect(missing.statusCode).toBe(200);
    expect((await texts(id)).at(-1)).toContain('upload your certificate of good conduct');
    expect((await post(`/admin/pros/${id}/documents/background/remind`)).json()).toEqual({ error: 'reminder_recent' });

    await post(`/admin/pros/${id}/documents/insurance/remind`);
    expect((await texts(id)).at(-1)).toContain(`runs out on ${addDays(today, 10)}`);
    expect((await post(`/admin/pros/${id}/documents/id/remind`)).json()).toEqual({ error: 'nothing_to_remind' });
  });

  it('refuses to accept an ID or insurance without a future expiry date', async () => {
    const { id } = await applicant();
    expect((await post(`/admin/pros/${id}/documents/insurance/accept`, { expiresOn: '2020-01-01' })).json()).toEqual({
      error: 'document_expired',
    });
    await t.pool.query("UPDATE pro_documents SET expires_on = NULL WHERE pro_id = $1 AND kind = 'id'", [id]);
    expect((await post(`/admin/pros/${id}/documents/id/accept`, {})).json()).toEqual({ error: 'expiry_required' });
    const corrected = await post(`/admin/pros/${id}/documents/id/accept`, { expiresOn: '2032-02-02' });
    expect(corrected.json().pro.checks[0].document).toMatchObject({ expiresOn: '2032-02-02', reviewStatus: 'accepted' });
  });
});
