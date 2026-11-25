import {
  approvedPro,
  call,
  createTestContext,
  FILES,
  resetDatabase,
  seedMarket,
  signIn,
  signInAdmin,
  TIMEZONE,
  upload,
  type Market,
  type TestContext,
} from '../../test/helpers.js';
import { addDays, marketToday } from './checks.js';
import { documentReminderTick } from './document-reminders.js';
import { loadTaxStatement } from './bank-account.js';
import { topShare } from './performance.js';

let t: TestContext;
let market: Market;
let customer: string;
let customerId: string;

beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(async () => {
  await resetDatabase(t.pool);
  t.fake.reset();
  market = await seedMarket(t.pool);
  customer = await signIn(t, '+4915100000001', 'customer', 'Sara');
  customerId = (await call(t, 'GET', '/auth/me', { cookie: customer })).json().user.id;
});

const HOME = 'Hidden Lane 7';
const today = () => marketToday(TIMEZONE);
/** Midday in the market, so the daytime-only rule of the reminders never decides a test. */
const noon = (day: string) => new Date(`${day}T11:00:00Z`);

async function slotsFree(serviceId: string): Promise<boolean> {
  const response = await call(t, 'GET', `/availability?serviceId=${serviceId}&postcode=10115`, { cookie: customer });
  return (response.json().slots as { available: boolean }[]).some((s) => s.available);
}

async function bookFirst(serviceId: string) {
  const response = await call(t, 'GET', `/availability?serviceId=${serviceId}&postcode=10115`, { cookie: customer });
  const slot = (response.json().slots as { startsAt: string; available: boolean }[]).find((s) => s.available);
  if (!slot) throw new Error('No free slot');
  const created = await call(t, 'POST', '/bookings', {
    cookie: customer,
    body: { serviceId, size: 'M', address: '12 Linden Street', postcode: '10115', startsAt: slot.startsAt },
  });
  expect(created.statusCode).toBe(201);
  return created.json().booking as { id: string };
}

async function offerOf(cookie: string) {
  return (await call(t, 'GET', '/pro/offers', { cookie })).json().offers[0] as { id: string; bookingId: string } | undefined;
}

/**
 * A finished one-off job of `proId` for the test customer, `daysAgo` days back. `arrivedLateBy` adds the arrival
 * ("working") that many minutes after the start; `stars` adds the customer's rating.
 */
async function finishedJob(
  proId: string,
  options: { daysAgo?: number; arrivedLateBy?: number; stars?: number; tags?: string[]; review?: string; startsAt?: string } = {},
) {
  const startsAt = options.startsAt ?? new Date(Date.now() - (options.daysAgo ?? 2) * 86_400_000).toISOString();
  const booking = await t.pool.query<{ id: string }>(
    `INSERT INTO bookings (customer_id, service_id, category_id, service_name, size, address, postcode,
       starts_at, ends_at, status, price_cents, fee_cents, pro_share_pct, pro_id, completed_at)
     VALUES ($1, $2, $3, 'Lawn mowing', 'M', '12 Linden Street', '10115', $4::timestamptz, $4::timestamptz + interval '1 hour',
       'completed', 4000, 290, 82, $5, $4::timestamptz + interval '1 hour')
     RETURNING id`,
    [customerId, market.mowing, market.gardening, startsAt, proId],
  );
  const id = booking.rows[0]?.id ?? '';
  if (options.arrivedLateBy !== undefined) {
    await t.pool.query(
      `INSERT INTO booking_events (booking_id, status, created_at) VALUES ($1, 'working', $2::timestamptz + make_interval(mins => $3))`,
      [id, startsAt, options.arrivedLateBy],
    );
  }
  if (options.stars) {
    await t.pool.query('INSERT INTO ratings (booking_id, pro_id, customer_id, stars, tags, review) VALUES ($1, $2, $3, $4, $5, $6)', [
      id,
      proId,
      customerId,
      options.stars,
      options.tags ?? [],
      options.review ?? null,
    ]);
  }
  return id;
}

/** Offers in the last 30 days: `accepted` accepted and `declined` declined, each on a job of its own. */
async function offers(proId: string, accepted: number, declined: number) {
  for (let i = 0; i < accepted + declined; i += 1) {
    const bookingId = await finishedJob(proId, { daysAgo: 40 });
    await t.pool.query(
      `INSERT INTO booking_offers (booking_id, pro_id, status, offered_at, expires_at, responded_at)
       VALUES ($1, $2, $3, now() - interval '3 days', now() - interval '3 days' + interval '15 minutes', now() - interval '3 days')`,
      [bookingId, proId, i < accepted ? 'accepted' : 'declined'],
    );
  }
}

async function lateCancellation(proId: string) {
  const bookingId = await finishedJob(proId, { daysAgo: 45 });
  await t.pool.query("INSERT INTO pro_cancellations (booking_id, pro_id, reason, late, created_at) VALUES ($1, $2, 'ill', true, now() - interval '5 days')", [
    bookingId,
    proId,
  ]);
}

describe('Work information', () => {
  it('saves years of experience, a plain-text About you and the travel distance, within their limits', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const patch = (body: unknown) => call(t, 'PATCH', '/pro/profile', { cookie: pro.cookie, body });

    const saved = await patch({ yearsExperience: 8, about: '  Gardener   for 8 years.\n\n\n\n  Lawns and <b>hedges</b>  ', radiusKm: 30, homeAddress: HOME });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().profile).toMatchObject({
      yearsExperience: 8,
      about: 'Gardener for 8 years.\n\nLawns and <b>hedges</b>',
      radiusKm: 30,
      homeAddress: HOME,
    });

    expect((await patch({ yearsExperience: 61 })).statusCode).toBe(400);
    expect((await patch({ yearsExperience: -1 })).statusCode).toBe(400);
    expect((await patch({ about: 'x'.repeat(401) })).statusCode).toBe(400);
    expect((await patch({ radiusKm: 31 })).statusCode).toBe(400);
    expect((await patch({ radiusKm: 2 })).statusCode).toBe(400);
    const cleared = await patch({ about: '   ', yearsExperience: null });
    expect(cleared.json().profile).toMatchObject({ about: null, yearsExperience: null });
  });

  it('a new trade waits for the MISK check: no jobs in it until approved, and a declined one is removed', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    expect(await slotsFree(market.leak)).toBe(false);

    const added = await call(t, 'PATCH', '/pro/profile', { cookie: pro.cookie, body: { trades: [market.gardening, market.plumbing] } });
    expect(added.json().profile).toMatchObject({ trades: expect.arrayContaining([market.gardening, market.plumbing]), pendingTrades: [market.plumbing] });
    expect(added.json().profile.tradeNames).toEqual(['Gardening']);
    // Dispatch and the booking slots only use approved trades.
    expect(await slotsFree(market.leak)).toBe(false);
    expect(await slotsFree(market.mowing)).toBe(true);

    const admin = await signInAdmin(t);
    const detail = (await call(t, 'GET', `/admin/pros/${pro.proId}`, { cookie: admin })).json().pro;
    expect(detail.pendingTrades).toEqual([expect.objectContaining({ id: market.plumbing, name: 'Plumbing', needsCertificate: true })]);
    expect((await call(t, 'GET', '/admin/pros?tab=active', { cookie: admin })).json().pros[0]).toMatchObject({ pendingTrades: 1 });

    // Plumbing needs a trade certificate: approved only once one is accepted.
    const approve = () => call(t, 'POST', `/admin/pros/${pro.proId}/trades/${market.plumbing}/approve`, { cookie: admin });
    expect((await approve()).json().error).toBe('certificate_missing');
    expect((await upload(t, '/pro/documents/certificate', pro.cookie, FILES.pdf, 'plumber.pdf')).statusCode).toBe(201);
    await t.pool.query("UPDATE pro_documents SET review_status = 'accepted', valid_until = 'infinity' WHERE pro_id = $1", [pro.proId]);
    expect((await approve()).statusCode).toBe(200);
    expect((await approve()).json().error).toBe('trade_not_pending');
    expect(await slotsFree(market.leak)).toBe(true);
    const created = await bookFirst(market.leak);
    expect((await offerOf(pro.cookie))?.bookingId).toBe(created.id);

    // Taken off and added again: it waits again, and the team can decline it.
    await call(t, 'PATCH', '/pro/profile', { cookie: pro.cookie, body: { trades: [market.gardening] } });
    await call(t, 'PATCH', '/pro/profile', { cookie: pro.cookie, body: { trades: [market.gardening, market.plumbing] } });
    const declined = await call(t, 'POST', `/admin/pros/${pro.proId}/trades/${market.plumbing}/decline`, {
      cookie: admin,
      body: { note: 'Please send your plumbing certificate first' },
    });
    expect(declined.statusCode).toBe(200);
    const after = (await call(t, 'GET', '/pro/profile', { cookie: pro.cookie })).json().profile;
    expect(after).toMatchObject({ trades: [market.gardening], pendingTrades: [] });
    const told = await t.pool.query<{ body: string }>("SELECT body FROM inbox WHERE user_id = $1 AND kind = 'pro_account' ORDER BY created_at", [pro.proId]);
    expect(told.rows.map((r) => r.body)).toEqual([
      'MISK: Plumbing is now one of your trades. You get job offers in it from now on.',
      'MISK could not add Plumbing to your trades: Please send your plumbing certificate first. Questions? Contact pro support in the app.',
    ]);
    const log = await t.pool.query("SELECT action FROM pro_admin_actions WHERE pro_id = $1 AND action LIKE 'trade_%' ORDER BY id", [pro.proId]);
    expect(log.rows.map((r) => r.action)).toEqual(['trade_approved', 'trade_declined']);
  });

  it('keeps an accepted job when the pro takes its trade off, and only the team approves trades', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening, market.plumbing] });
    const created = await bookFirst(market.mowing);
    const offer = await offerOf(pro.cookie);
    expect((await call(t, 'POST', `/pro/offers/${offer?.id}/accept`, { cookie: pro.cookie })).statusCode).toBe(200);

    const changed = await call(t, 'PATCH', '/pro/profile', { cookie: pro.cookie, body: { trades: [market.plumbing] } });
    expect(changed.json().profile).toMatchObject({ trades: [market.plumbing], pendingTrades: [] });
    const job = (await call(t, 'GET', `/bookings/${created.id}`, { cookie: customer })).json().booking;
    expect(job).toMatchObject({ status: 'accepted', pro: { id: pro.proId } });
    expect(await slotsFree(market.mowing)).toBe(false);

    expect((await call(t, 'PATCH', '/pro/profile', { cookie: pro.cookie, body: { trades: [] } })).json().error).toBe('trades_missing');
    expect((await call(t, 'POST', `/admin/pros/${pro.proId}/trades/${market.plumbing}/approve`, { cookie: pro.cookie })).statusCode).toBe(403);
  });

  it('shows customers About you and the years of experience on their booking, never the home address', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    await call(t, 'PATCH', '/pro/profile', {
      cookie: pro.cookie,
      body: { yearsExperience: 12, about: 'Lawns, hedges and planting.', homeAddress: HOME },
    });
    const created = await bookFirst(market.mowing);
    const offer = await offerOf(pro.cookie);
    await call(t, 'POST', `/pro/offers/${offer?.id}/accept`, { cookie: pro.cookie });
    const response = await call(t, 'GET', `/bookings/${created.id}`, { cookie: customer });
    expect(response.json().booking.pro).toMatchObject({ about: 'Lawns, hedges and planting.', yearsExperience: 12 });
    expect(response.body).not.toContain(HOME);
  });
});

describe('Documents', () => {
  async function proWithDocuments() {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const id = addDays(today(), 400);
    const insurance = addDays(today(), 20);
    expect((await upload(t, `/pro/documents/id?expiresOn=${id}`, pro.cookie, FILES.jpeg, 'passport.jpg')).statusCode).toBe(201);
    expect((await upload(t, '/pro/documents/certificate', pro.cookie, FILES.pdf, 'gardener.pdf')).statusCode).toBe(201);
    expect((await upload(t, `/pro/documents/insurance?expiresOn=${insurance}`, pro.cookie, FILES.png, 'insurance.png')).statusCode).toBe(201);
    await t.pool.query(
      `UPDATE pro_documents SET review_status = 'accepted', valid_until = COALESCE(expires_on, 'infinity') WHERE pro_id = $1`,
      [pro.proId],
    );
    return { ...pro, id, insurance };
  }

  it('shows each document with its status and date; a new copy is "Being checked" while the old one still covers', async () => {
    const pro = await proWithDocuments();
    const list = async () => (await call(t, 'GET', '/pro/documents', { cookie: pro.cookie })).json().documents;
    expect(await list()).toEqual([
      expect.objectContaining({ kind: 'id', status: 'valid', expiresOn: pro.id, fileName: 'passport.jpg' }),
      expect.objectContaining({ kind: 'certificate', status: 'valid', expiresOn: null, expires: false }),
      expect.objectContaining({ kind: 'insurance', status: 'expiring', expiresOn: pro.insurance, expires: true }),
    ]);
    const overview = async () => (await call(t, 'GET', '/pro/profile/overview', { cookie: pro.cookie })).json().overview;
    expect((await overview()).documents).toEqual({ expiring: 1, expired: 0, checking: 0 });

    const renewed = addDays(today(), 380);
    expect((await upload(t, `/pro/documents/insurance?expiresOn=${renewed}`, pro.cookie, FILES.png, 'new-insurance.png')).statusCode).toBe(201);
    expect((await list())[2]).toMatchObject({ kind: 'insurance', status: 'checking', expiresOn: renewed, fileName: 'new-insurance.png' });
    expect((await overview()).documents).toEqual({ expiring: 0, expired: 0, checking: 1 });
    // The accepted older copy still covers the pro: they keep getting jobs.
    expect(await slotsFree(market.mowing)).toBe(true);

    await t.pool.query("UPDATE pro_documents SET review_status = 'accepted', valid_until = $2 WHERE pro_id = $1 AND kind = 'insurance'", [
      pro.proId,
      addDays(today(), -1),
    ]);
    expect((await list())[2]).toMatchObject({ status: 'expired' });
  });

  it('reminds the pro 30 days and 7 days before a document runs out, each once', async () => {
    const pro = await proWithDocuments();
    await t.pool.query("UPDATE pro_documents SET valid_until = $2 WHERE pro_id = $1 AND kind = 'insurance'", [pro.proId, addDays(today(), 30)]);
    const reminders = async () =>
      (await t.pool.query("SELECT 1 FROM inbox WHERE user_id = $1 AND kind = 'document_expiring'", [pro.proId])).rowCount;

    expect(await documentReminderTick(t.deps, noon(today()))).toBe(1);
    expect(await documentReminderTick(t.deps, noon(today()))).toBe(0);
    expect(await documentReminderTick(t.deps, noon(addDays(today(), 22)))).toBe(0);
    expect(await documentReminderTick(t.deps, noon(addDays(today(), 23)))).toBe(1);
    expect(await documentReminderTick(t.deps, noon(addDays(today(), 24)))).toBe(0);
    expect(await reminders()).toBe(2);
    const stages = await t.pool.query('SELECT days_before FROM document_reminders WHERE pro_id = $1 ORDER BY days_before DESC', [pro.proId]);
    expect(stages.rows.map((r) => r.days_before)).toEqual([30, 7]);
  });

  it('sends only the last reminder for a document first seen inside the last 7 days', async () => {
    const pro = await proWithDocuments();
    await t.pool.query("UPDATE pro_documents SET valid_until = $2 WHERE pro_id = $1 AND kind = 'insurance'", [pro.proId, addDays(today(), 5)]);
    expect(await documentReminderTick(t.deps, noon(today()))).toBe(1);
    expect(await documentReminderTick(t.deps, noon(addDays(today(), 1)))).toBe(0);
  });
});

describe('Bank account', () => {
  it('shows the account, the payout schedule set by MISK, and the next payout day and amount', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const job = await finishedJob(pro.proId);
    await t.pool.query(
      `INSERT INTO payouts (booking_id, pro_id, payment_intent_id, charge_id, amount_cents, status) VALUES ($1, $2, 'pi_bank_1', 'ch_1', 3280, 'sent')`,
      [job, pro.proId],
    );
    const bank = async () => (await call(t, 'GET', '/pro/bank', { cookie: pro.cookie })).json().bank;
    expect(await bank()).toMatchObject({
      hasPayoutAccount: true,
      bank: { last4: '3000', holderName: 'Daniel Keller', active: true },
      bankError: false,
      interval: 'weekly',
      nextPayoutOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      nextPayoutCents: 3280,
      statementYears: [Number(today().slice(0, 4))],
      defaultStatementYear: Number(today().slice(0, 4)),
    });
    expect((await call(t, 'GET', '/pro/profile/overview', { cookie: pro.cookie })).json().overview.bankLast4).toBe('3000');

    // A new account the provider is still checking.
    t.fake.setBank({ last4: '7788', holderName: 'Daniel Keller', active: false });
    expect((await bank()).bank).toEqual({ last4: '7788', holderName: 'Daniel Keller', active: false });
    t.fake.failures.add('payoutDetails');
    expect(await bank()).toMatchObject({ bank: null, bankError: true });
  });

  it('gives a link to change the bank account with the provider, only for a pro with a payout account', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const link = await call(t, 'POST', '/pro/bank/change-link', { cookie: pro.cookie });
    expect(link.json().url).toBe(`https://connect.example.com/express/acct_${pro.proId.slice(0, 8)}`);
    expect(t.fake.bankChangeLinks).toEqual([`acct_${pro.proId.slice(0, 8)}`]);

    await t.pool.query('UPDATE pro_profiles SET stripe_account_id = NULL WHERE user_id = $1', [pro.proId]);
    expect((await call(t, 'POST', '/pro/bank/change-link', { cookie: pro.cookie })).json().error).toBe('no_payout_account');
    expect((await call(t, 'POST', '/pro/bank/change-link', { cookie: customer })).statusCode).toBe(403);
  });

  it('downloads the yearly statement for taxes: job prices, commission, tips and net per month, last full year by default', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening], firstName: 'Daniel' });
    const lastYear = Number(today().slice(0, 4)) - 1;
    await t.pool.query("UPDATE pro_profiles SET created_at = now() - interval '2 years' WHERE user_id = $1", [pro.proId]);
    const job = await finishedJob(pro.proId, { startsAt: `${lastYear}-03-15T10:00:00Z` });
    await t.pool.query(
      `INSERT INTO payouts (booking_id, pro_id, payment_intent_id, charge_id, amount_cents, status) VALUES ($1, $2, 'pi_tax_job', 'ch_1', 3280, 'sent')`,
      [job, pro.proId],
    );
    await t.pool.query(
      `INSERT INTO tips (booking_id, amount_cents, pro_share_pct, pro_cents, payment_intent_id, status) VALUES ($1, 500, 82, 410, 'pi_tax_tip', 'captured')`,
      [job],
    );
    await t.pool.query(
      `INSERT INTO payouts (booking_id, pro_id, payment_intent_id, charge_id, amount_cents, status) VALUES ($1, $2, 'pi_tax_tip', 'ch_2', 410, 'sent')`,
      [job, pro.proId],
    );
    // A refunded job pays nothing and is left out.
    const refunded = await finishedJob(pro.proId, { startsAt: `${lastYear}-03-20T10:00:00Z` });
    await t.pool.query(
      `INSERT INTO payouts (booking_id, pro_id, payment_intent_id, charge_id, amount_cents, status) VALUES ($1, $2, 'pi_tax_back', 'ch_3', 3280, 'reversed')`,
      [refunded, pro.proId],
    );

    const statement = await loadTaxStatement(t.pool, pro.proId, lastYear, TIMEZONE);
    expect(statement.months[2]).toEqual({ month: 3, grossCents: 4000, commissionCents: 720, tipsCents: 410, netCents: 3690 });
    expect(statement.total).toEqual({ grossCents: 4000, commissionCents: 720, tipsCents: 410, netCents: 3690 });

    const pdf = await call(t, 'GET', '/pro/earnings/tax-statement', { cookie: pro.cookie });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toBe(`attachment; filename="misk-tax-statement-${lastYear}.pdf"`);
    const text = pdf.rawPayload.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    for (const part of [`Yearly statement for taxes \\267 ${lastYear}`, 'Daniel', 'March', '\\20040.00', '-\\2007.20', '\\2004.10', '\\20036.90', `Total ${lastYear}`]) {
      expect(text).toContain(part);
    }
    expect((await call(t, 'GET', `/pro/earnings/tax-statement?year=${lastYear - 2}`, { cookie: pro.cookie })).json().error).toBe('year_invalid');
    expect((await call(t, 'GET', '/pro/earnings/tax-statement?year=1999', { cookie: pro.cookie })).statusCode).toBe(400);
  });
});

describe('Ratings & reviews', () => {
  it('shows the average, a bar per star level, the most chosen tags and the latest reviews with first names only', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    await t.pool.query("UPDATE users SET last_name = 'Meier' WHERE id = $1", [customerId]);
    await finishedJob(pro.proId, { daysAgo: 9, stars: 5, tags: ['on_time', 'tidy'] });
    await finishedJob(pro.proId, { daysAgo: 8, stars: 5, tags: ['on_time'] });
    await finishedJob(pro.proId, { daysAgo: 7, stars: 4, tags: ['on_time', 'friendly'], review: 'Good work, arrived a bit late.' });
    await finishedJob(pro.proId, { daysAgo: 1, stars: 5, review: 'Lawn looks perfect, very tidy.' });

    const response = await call(t, 'GET', '/pro/reviews?limit=3', { cookie: pro.cookie });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.summary).toEqual({
      average: 4.8,
      count: 4,
      stars: [
        { stars: 5, count: 3, pct: 75 },
        { stars: 4, count: 1, pct: 25 },
        { stars: 3, count: 0, pct: 0 },
        { stars: 2, count: 0, pct: 0 },
        { stars: 1, count: 0, pct: 0 },
      ],
      tags: [
        { tag: 'on_time', count: 3 },
        { tag: 'friendly', count: 1 },
        { tag: 'tidy', count: 1 },
      ],
    });
    expect(body.reviews).toHaveLength(3);
    expect(body.hasMore).toBe(true);
    expect(body.reviews[0]).toMatchObject({ stars: 5, review: 'Lawn looks perfect, very tidy.', customerName: 'Sara', reply: null });
    expect(response.body).not.toContain('Meier');
    const next = (await call(t, 'GET', '/pro/reviews?limit=3&offset=3', { cookie: pro.cookie })).json();
    expect(next).toMatchObject({ hasMore: false, reviews: [expect.objectContaining({ tags: ['on_time', 'tidy'] })] });
    expect((await call(t, 'GET', '/pro/reviews', { cookie: customer })).statusCode).toBe(403);
  });

  it('lets the pro reply once to their own reviews; the customer and the team see the reply', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const other = await approvedPro(t, '+4915100000102', { trades: [market.gardening] });
    const bookingId = await finishedJob(pro.proId, { stars: 4, review: 'Good work.' });
    const reply = (cookie: string, text: string) => call(t, 'POST', `/pro/reviews/${bookingId}/reply`, { cookie, body: { text } });

    expect((await reply(pro.cookie, '   ')).statusCode).toBe(400);
    expect((await reply(pro.cookie, 'x'.repeat(501))).statusCode).toBe(400);
    expect((await reply(other.cookie, 'Not mine')).json().error).toBe('review_not_found');
    const sent = await reply(pro.cookie, '  Thank you, Sara! See you next time.  ');
    expect(sent.statusCode).toBe(200);
    expect(sent.json().review).toMatchObject({ bookingId, reply: 'Thank you, Sara! See you next time.', repliedAt: expect.any(String) });
    expect((await reply(pro.cookie, 'A second answer')).json().error).toBe('already_replied');

    const seen = (await call(t, 'GET', `/bookings/${bookingId}`, { cookie: customer })).json().booking.rating;
    expect(seen).toMatchObject({ stars: 4, review: 'Good work.', reply: 'Thank you, Sara! See you next time.' });
    const admin = await signInAdmin(t);
    const reviews = (await call(t, 'GET', `/admin/pros/${pro.proId}`, { cookie: admin })).json().pro.reviews;
    expect(reviews[0]).toMatchObject({ review: 'Good work.', reply: 'Thank you, Sara! See you next time.' });
  });
});

describe('Performance', () => {
  it('shows the last 30 days against their goals, below-goal numbers flagged', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    await offers(pro.proId, 8, 2);
    for (const late of [0, 5, 8, 25]) await finishedJob(pro.proId, { arrivedLateBy: late, stars: 4 });
    // A job closed without a recorded arrival is not judged for punctuality.
    await finishedJob(pro.proId);
    await lateCancellation(pro.proId);

    const performance = (await call(t, 'GET', '/pro/performance', { cookie: pro.cookie })).json().performance;
    expect(performance).toMatchObject({
      windowDays: 30,
      acceptance: { value: 80, goal: 85, belowGoal: true, basis: 10 },
      onTime: { value: 75, goal: 90, belowGoal: true, basis: 4 },
      completion: { value: 83, goal: 98, belowGoal: true, basis: 6 },
      lateCancellations: { value: 1, limit: 3, belowGoal: false },
      rating: { value: 4, goal: 4.5, belowGoal: true },
      rank: { trade: 'Gardening', pros: 1, topPercent: 10 },
    });

    await lateCancellation(pro.proId);
    const again = (await call(t, 'GET', '/pro/performance', { cookie: pro.cookie })).json().performance;
    expect(again.lateCancellations).toEqual({ value: 2, limit: 3, belowGoal: true });
  });

  it('a new pro without numbers shows no values and nothing below goal', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const performance = (await call(t, 'GET', '/pro/performance', { cookie: pro.cookie })).json().performance;
    expect(performance).toMatchObject({
      acceptance: { value: null, belowGoal: false },
      onTime: { value: null, belowGoal: false },
      completion: { value: null, belowGoal: false },
      lateCancellations: { value: 0, belowGoal: false },
      rating: { value: null, belowGoal: false },
    });
  });

  it('ranks pros in their trade and offers new jobs to the best performer first, before a better rating', async () => {
    const weak = await approvedPro(t, '+4915100000101', { trades: [market.gardening], firstName: 'Weak' });
    const strong = await approvedPro(t, '+4915100000102', { trades: [market.gardening], firstName: 'Strong' });
    await offers(weak.proId, 8, 2);
    for (const late of [0, 25, 30, 40]) await finishedJob(weak.proId, { arrivedLateBy: late, stars: 5 });
    await lateCancellation(weak.proId);
    await offers(strong.proId, 10, 0);
    await finishedJob(strong.proId, { arrivedLateBy: 0, stars: 4 });

    const rank = async (cookie: string) => (await call(t, 'GET', '/pro/performance', { cookie })).json().performance.rank;
    expect(await rank(strong.cookie)).toEqual({ trade: 'Gardening', pros: 2, topPercent: 10 });
    expect(await rank(weak.cookie)).toEqual({ trade: 'Gardening', pros: 2, topPercent: null });
    expect((await call(t, 'GET', '/pro/profile/overview', { cookie: strong.cookie })).json().overview.topPercent).toBe(10);

    const created = await bookFirst(market.mowing);
    expect((await offerOf(strong.cookie))?.bookingId).toBe(created.id);
    expect(await offerOf(weak.cookie)).toBeUndefined();
  });

  it('gives Help & support the real numbers from Settings and the rules', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    await t.pool.query("UPDATE settings SET no_show_fee_cents = 1800, payout_interval = 'monthly'");
    const help = (await call(t, 'GET', '/pro/help', { cookie: pro.cookie })).json().help;
    expect(help).toMatchObject({
      payoutInterval: 'monthly',
      releaseHours: 24,
      notHomeWaitMinutes: 15,
      callOutFeeCents: 1800,
      freeCancelHours: 24,
      lateCancelLimit: 3,
      lateCancelWindowDays: 30,
      lateCancelPauseDays: 7,
      goals: { acceptancePct: 85, onTimePct: 90, completionPct: 98, rating: 4.5 },
    });
    expect((await call(t, 'GET', '/pro/help', { cookie: customer })).statusCode).toBe(403);
  });

  it('puts at least the best pro of a small trade in the top 10%', () => {
    expect(topShare(0, 1)).toBe(10);
    expect(topShare(0, 20)).toBe(10);
    expect(topShare(2, 20)).toBe(25);
    expect(topShare(5, 20)).toBeNull();
    expect(topShare(1, 3)).toBeNull();
  });
});
