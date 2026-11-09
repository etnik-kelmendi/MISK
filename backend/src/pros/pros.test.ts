import {
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

let t: TestContext;
let market: Market;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(async () => {
  await resetDatabase(t.pool);
  market = await seedMarket(t.pool);
});

const PRO_PHONE = '+4915111111111';

async function completeApplication(cookie: string) {
  await call(t, 'PATCH', '/pro/profile', {
    cookie,
    body: { trades: [market.gardening], homePostcode: '10115', radiusKm: 15, workingDays: [1, 2, 3] },
  });
  await upload(t, '/pro/documents/id?expiresOn=2031-05-01', cookie, FILES.jpeg, 'id.jpg');
  await upload(t, '/pro/documents/certificate', cookie, FILES.pdf, 'cert.pdf');
  await upload(t, '/pro/documents/insurance?expiresOn=2030-01-31', cookie, FILES.png, 'insurance.png');
  await upload(t, '/pro/documents/background', cookie, FILES.pdf, 'good-conduct.pdf');
}

describe('pro application', () => {
  it('saves trades, area and working days', async () => {
    const cookie = await signIn(t, PRO_PHONE, 'pro', 'Daniel');
    const response = await call(t, 'PATCH', '/pro/profile', {
      cookie,
      body: { trades: [market.gardening], homePostcode: ' 10115 ', radiusKm: 15, workingDays: [5, 1, 3] },
    });
    expect(response.json().profile).toMatchObject({
      trades: [market.gardening],
      homePostcode: '10115',
      radiusKm: 15,
      workingDays: [1, 3, 5],
    });
  });

  it('refuses postcodes MISK does not serve and unknown trades', async () => {
    const cookie = await signIn(t, PRO_PHONE, 'pro');
    const postcode = await call(t, 'PATCH', '/pro/profile', { cookie, body: { homePostcode: '99999' } });
    expect(postcode.json()).toEqual({ error: 'postcode_not_served' });
    const trade = await call(t, 'PATCH', '/pro/profile', {
      cookie,
      body: { trades: ['00000000-0000-4000-8000-000000000000'] },
    });
    expect(trade.json()).toEqual({ error: 'unknown_trade' });
    const radius = await call(t, 'PATCH', '/pro/profile', { cookie, body: { radiusKm: 100 } });
    expect(radius.statusCode).toBe(400);
  });

  it('accepts documents only as PDF, JPEG or PNG, judged by content', async () => {
    const cookie = await signIn(t, PRO_PHONE, 'pro');
    const text = await upload(t, '/pro/documents/id?expiresOn=2031-01-01', cookie, FILES.text, 'id.png');
    expect(text.json()).toEqual({ error: 'file_type_not_allowed' });
    const pdf = await upload(t, '/pro/documents/id?expiresOn=2031-01-01', cookie, FILES.pdf, 'id.pdf');
    expect(pdf.statusCode).toBe(201);
    expect(pdf.json().profile.documents.id).not.toBeNull();
    const replaced = await upload(t, '/pro/documents/id?expiresOn=2031-01-01', cookie, FILES.png);
    expect(replaced.json().profile.documents.id.uploadId).not.toBe(pdf.json().profile.documents.id.uploadId);
    const count = await t.pool.query("SELECT count(*)::int AS n FROM uploads WHERE kind = 'document'");
    expect(count.rows[0].n).toBe(1);
  });

  it('refuses files over 8 MB', async () => {
    const cookie = await signIn(t, PRO_PHONE, 'pro');
    const big = Buffer.concat([FILES.pdf, Buffer.alloc(8 * 1024 * 1024)]);
    const response = await upload(t, '/pro/documents/certificate', cookie, big);
    expect(response.statusCode).toBe(413);
  });

  it('only submits a complete application', async () => {
    const cookie = await signIn(t, PRO_PHONE, 'pro');
    const early = await call(t, 'POST', '/pro/submit', { cookie });
    expect(early.json()).toEqual({ error: 'application_incomplete' });
    await completeApplication(cookie);
    const submitted = await call(t, 'POST', '/pro/submit', { cookie });
    expect(submitted.json().profile.status).toBe('submitted');
    const again = await call(t, 'POST', '/pro/submit', { cookie });
    expect(again.json()).toEqual({ error: 'already_submitted' });
    const trades = await call(t, 'PATCH', '/pro/profile', { cookie, body: { trades: [market.plumbing] } });
    expect(trades.json()).toEqual({ error: 'trades_locked' });
  });
});

describe('pro documents', () => {
  it('needs the expiry date of an ID and insurance, refuses ones already expired, and keeps a safe file name', async () => {
    const cookie = await signIn(t, PRO_PHONE, 'pro');
    const noDate = await upload(t, '/pro/documents/insurance', cookie, FILES.pdf, 'insurance.pdf');
    expect(noDate.json()).toEqual({ error: 'expiry_required' });
    const old = await upload(t, '/pro/documents/insurance?expiresOn=2020-01-01', cookie, FILES.pdf);
    expect(old.json()).toEqual({ error: 'document_expired' });
    const bad = await upload(t, '/pro/documents/insurance?expiresOn=tomorrow', cookie, FILES.pdf);
    expect(bad.statusCode).toBe(400);

    const ok = await upload(t, '/pro/documents/insurance?expiresOn=2030-06-30', cookie, FILES.pdf, '../../Allianz policy 2026.pdf');
    expect(ok.statusCode).toBe(201);
    expect(ok.json().profile.documents.insurance).toMatchObject({
      fileName: 'Allianz policy 2026.pdf',
      expiresOn: '2030-06-30',
      reviewStatus: 'pending',
      state: 'waiting_review',
    });
    const noExpiryNeeded = await upload(t, '/pro/documents/background', cookie, FILES.pdf, 'conduct.pdf');
    expect(noExpiryNeeded.json().profile.documents.background).toMatchObject({ expiresOn: null, fileName: 'conduct.pdf' });
  });

  it('lets a pro asked for more information change and send the application again', async () => {
    const cookie = await signIn(t, PRO_PHONE, 'pro');
    await completeApplication(cookie);
    await call(t, 'POST', '/pro/submit', { cookie });
    await t.pool.query("UPDATE pro_profiles SET status = 'info_requested', review_note = 'Which hedge trimmer do you use?'");
    const profile = (await call(t, 'GET', '/pro/profile', { cookie })).json().profile;
    expect(profile).toMatchObject({ status: 'info_requested', reviewNote: 'Which hedge trimmer do you use?' });
    const trades = await call(t, 'PATCH', '/pro/profile', { cookie, body: { trades: [market.gardening, market.plumbing] } });
    expect(trades.statusCode).toBe(200);
    expect((await call(t, 'POST', '/pro/submit', { cookie })).json().profile).toMatchObject({ status: 'submitted', reviewNote: null });
  });

  it('shows documents only to their owner and admins', async () => {
    const cookie = await signIn(t, PRO_PHONE, 'pro');
    const uploaded = await upload(t, '/pro/documents/id?expiresOn=2031-01-01', cookie, FILES.pdf);
    const fileId = uploaded.json().profile.documents.id.uploadId;
    const own = await call(t, 'GET', `/files/${fileId}`, { cookie });
    expect(own.statusCode).toBe(200);
    expect(own.headers['content-type']).toBe('application/pdf');
    expect(own.headers['x-content-type-options']).toBe('nosniff');

    const admin = await signInAdmin(t);
    expect((await call(t, 'GET', `/files/${fileId}`, { cookie: admin })).statusCode).toBe(200);
    const stranger = await signIn(t, '+4915122222222', 'customer');
    expect((await call(t, 'GET', `/files/${fileId}`, { cookie: stranger })).statusCode).toBe(404);
  });
});

describe('payouts', () => {
  it('opens Stripe onboarding only for approved pros and records when payouts work', async () => {
    const cookie = await signIn(t, PRO_PHONE, 'pro');
    const early = await call(t, 'POST', '/pro/payouts/link', { cookie });
    expect(early.json()).toEqual({ error: 'not_approved' });

    await t.pool.query("UPDATE pro_profiles SET status = 'approved'");
    const link = await call(t, 'POST', '/pro/payouts/link', { cookie });
    expect(link.json().url).toBe('http://localhost:5173/pro/profile?payouts=return');
    const refreshed = await call(t, 'POST', '/pro/payouts/refresh', { cookie });
    expect(refreshed.json().profile).toMatchObject({ payoutsEnabled: true, hasPayoutAccount: true });
  });
});
