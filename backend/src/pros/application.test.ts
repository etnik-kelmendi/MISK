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
import { applicationTimeline, type Check, type CheckState, type DocumentKind } from './checks.js';

let t: TestContext;
let market: Market;
let admin: string;
let cleaning: string;

beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(async () => {
  await resetDatabase(t.pool);
  market = await seedMarket(t.pool);
  admin = await signInAdmin(t);
  const inserted = await t.pool.query<{ id: string }>(
    `INSERT INTO categories (slug, name, icon, sort_order, active, needs_certificate)
     VALUES ('cleaning', 'Cleaning', 'sparkle', 3, true, false) RETURNING id`,
  );
  cleaning = inserted.rows[0]?.id ?? '';
});

const PRO_PHONE = '+4915111111111';
const ADDRESS = 'Secret Lane 7';

const patch = (cookie: string, body: object) => call(t, 'PATCH', '/pro/profile', { cookie, body });
const submit = (cookie: string) => call(t, 'POST', '/pro/submit', { cookie });
const post = (url: string, body?: unknown) => call(t, 'POST', url, { cookie: admin, ...(body === undefined ? {} : { body }) });
const application = async (cookie: string) => (await call(t, 'GET', '/pro/application', { cookie })).json();
const messagesOf = async (userId: string) =>
  (
    await t.pool.query<{ body: string; link: string | null }>(
      'SELECT body, link FROM inbox WHERE user_id = $1 ORDER BY created_at, id',
      [userId],
    )
  ).rows;

async function proId(cookie: string): Promise<string> {
  return (await call(t, 'GET', '/auth/me', { cookie })).json().user.id as string;
}

async function uploadDocuments(cookie: string, kinds: DocumentKind[] = ['id', 'certificate', 'insurance']) {
  if (kinds.includes('id')) await upload(t, '/pro/documents/id?expiresOn=2031-05-01', cookie, FILES.jpeg, 'id.jpg');
  if (kinds.includes('certificate')) await upload(t, '/pro/documents/certificate', cookie, FILES.pdf, 'cert.pdf');
  if (kinds.includes('insurance')) await upload(t, '/pro/documents/insurance?expiresOn=2030-01-31', cookie, FILES.png, 'insurance.png');
}

/** A complete gardening application, sent. */
async function sent(phone = PRO_PHONE) {
  const cookie = await signIn(t, phone, 'pro', 'Daniel');
  await patch(cookie, { trades: [market.gardening], homePostcode: '10115', homeAddress: ADDRESS, radiusKm: 10, backgroundConsent: true });
  await uploadDocuments(cookie);
  expect((await submit(cookie)).statusCode).toBe(200);
  return { cookie, id: await proId(cookie) };
}

describe('the application form', () => {
  it('starts with Monday to Friday and the address empty, and keeps the travel distance between 3 and 30 km', async () => {
    const cookie = await signIn(t, PRO_PHONE, 'pro');
    const profile = (await call(t, 'GET', '/pro/profile', { cookie })).json().profile;
    expect(profile).toMatchObject({ workingDays: [1, 2, 3, 4, 5], homeAddress: null, backgroundConsentAt: null, editable: true });
    for (const radiusKm of [2, 31, 12.5]) {
      expect((await patch(cookie, { radiusKm })).statusCode).toBe(400);
    }
    expect((await patch(cookie, { radiusKm: 3 })).json().profile.radiusKm).toBe(3);
    expect((await patch(cookie, { radiusKm: 30 })).json().profile.radiusKm).toBe(30);
  });

  it('saves the home address tidied, and refuses an empty one', async () => {
    const cookie = await signIn(t, PRO_PHONE, 'pro');
    expect((await patch(cookie, { homeAddress: '  Secret   Lane 7 ' })).json().profile.homeAddress).toBe(ADDRESS);
    expect((await patch(cookie, { homeAddress: '   ' })).statusCode).toBe(400);
    expect((await patch(cookie, { homeAddress: 'x'.repeat(201) })).statusCode).toBe(400);
  });

  it('records when the pro agreed to the background check, and lets them take it back only before sending', async () => {
    const cookie = await signIn(t, PRO_PHONE, 'pro');
    const agreed = (await patch(cookie, { backgroundConsent: true })).json().profile;
    expect(agreed.backgroundConsentAt).toEqual(expect.any(String));
    expect((await patch(cookie, { backgroundConsent: false })).json().profile.backgroundConsentAt).toBeNull();

    const other = await sent('+4915111111112');
    expect((await patch(other.cookie, { backgroundConsent: false })).json()).toEqual({ error: 'consent_locked' });
  });

  it('says exactly what is missing before an application can be sent, in the order of the page', async () => {
    const cookie = await signIn(t, PRO_PHONE, 'pro');
    expect((await submit(cookie)).json()).toEqual({ error: 'trades_missing' });
    await patch(cookie, { trades: [market.gardening] });
    expect((await submit(cookie)).json()).toEqual({ error: 'home_address_missing' });
    await patch(cookie, { homePostcode: '10115' });
    expect((await submit(cookie)).json()).toEqual({ error: 'home_address_missing' });
    await patch(cookie, { homeAddress: ADDRESS });
    expect((await submit(cookie)).json()).toEqual({ error: 'documents_missing' });
    await uploadDocuments(cookie, ['id', 'insurance']);
    // Gardening needs the trade certificate.
    expect((await submit(cookie)).json()).toEqual({ error: 'documents_missing' });
    await uploadDocuments(cookie, ['certificate']);
    expect((await submit(cookie)).json()).toEqual({ error: 'background_consent_missing' });
    await patch(cookie, { backgroundConsent: true, workingDays: [] });
    expect((await submit(cookie)).json()).toEqual({ error: 'working_days_missing' });
    await patch(cookie, { workingDays: [6, 7] });
    const done = await submit(cookie);
    expect(done.json().profile).toMatchObject({ status: 'submitted', editable: false });
    // Sending starts the background check: it waits for the partner's result.
    expect(done.json().profile.documents.background).toMatchObject({ uploadId: null, state: 'waiting_review' });
  });

  it('needs no trade certificate when every chosen trade is cleaning', async () => {
    const cookie = await signIn(t, PRO_PHONE, 'pro');
    const chosen = await patch(cookie, {
      trades: [cleaning],
      homePostcode: '10115',
      homeAddress: ADDRESS,
      backgroundConsent: true,
    });
    expect(chosen.json().profile.certificateRequired).toBe(false);
    await uploadDocuments(cookie, ['id', 'insurance']);
    expect((await patch(cookie, { trades: [cleaning, market.gardening] })).json().profile.certificateRequired).toBe(true);
    expect((await submit(cookie)).json()).toEqual({ error: 'documents_missing' });
    await patch(cookie, { trades: [cleaning] });
    expect((await submit(cookie)).json().profile.status).toBe('submitted');

    // The team can approve without a certificate, and the list counts three checks.
    const id = await proId(cookie);
    const listed = (await call(t, 'GET', '/admin/pros?tab=applications', { cookie: admin })).json().pros[0];
    expect(listed).toMatchObject({ checksTotal: 3, checksDone: 0 });
    for (const kind of ['id', 'insurance', 'background']) {
      expect((await post(`/admin/pros/${id}/documents/${kind}/accept`, {})).statusCode).toBe(200);
    }
    const detail = (await call(t, 'GET', `/admin/pros/${id}`, { cookie: admin })).json().pro;
    expect(detail).toMatchObject({ allChecksOk: true, certificateRequired: false });
    expect((await post(`/admin/pros/${id}/approve`)).json().pro.status).toBe('approved');
  });
});

describe('the home address is private', () => {
  it('is shown to the pro and the team, never in what customers get', async () => {
    const pro = await approvedPro(t, PRO_PHONE, { trades: [market.gardening] });
    await t.pool.query('UPDATE pro_profiles SET home_address = $2 WHERE user_id = $1', [pro.proId, ADDRESS]);
    const customer = await signIn(t, '+4915122222222', 'customer');
    const customerId = await proId(customer);
    const booking = await t.pool.query<{ id: string }>(
      `INSERT INTO bookings (customer_id, service_id, category_id, service_name, size, address, postcode,
         starts_at, ends_at, status, price_cents, fee_cents, pro_share_pct, pro_id, completed_at)
       SELECT $1, s.id, s.category_id, s.name, 'M', 'Garden Road 1', '10115',
         now() - interval '2 days', now() - interval '2 days' + interval '1 hour', 'completed', 3500, 0, 82, $2, now() - interval '2 days'
       FROM services s WHERE s.id = $3 RETURNING id`,
      [customerId, pro.proId, market.mowing],
    );
    const bookingId = booking.rows[0]?.id ?? '';

    expect((await call(t, 'GET', '/pro/profile', { cookie: pro.cookie })).json().profile.homeAddress).toBe(ADDRESS);
    expect((await call(t, 'GET', `/admin/pros/${pro.proId}`, { cookie: admin })).json().pro.homeAddress).toBe(ADDRESS);

    const seen = await call(t, 'GET', `/bookings/${bookingId}`, { cookie: customer });
    expect(seen.statusCode).toBe(200);
    expect(seen.body).toContain(pro.proId);
    for (const url of ['/bookings', `/bookings/${bookingId}`, '/home', `/home/pros/${pro.proId}`, '/favourites/pros', '/catalogue']) {
      const response = await call(t, 'GET', url, { cookie: customer });
      expect(response.body).not.toContain('Secret Lane');
    }
  });
});

describe('the application status', () => {
  it('maps the checks to the four steps', () => {
    const check = (kind: DocumentKind, state: CheckState, required = true): Check => ({
      kind,
      state,
      ok: state === 'valid' || state === 'expiring',
      document: null,
      required,
    });
    const checks = (id: CheckState, certificate: CheckState, insurance: CheckState, background: CheckState, certificateNeeded = true) => [
      check('id', id),
      check('certificate', certificate, certificateNeeded),
      check('insurance', insurance),
      check('background', background),
    ];
    const states = (status: string, list: Check[], requested: string[] = []) => {
      const timeline = applicationTimeline(status, list, requested);
      return timeline && [timeline.steps.map((s) => s.state), timeline.current];
    };
    expect(applicationTimeline('draft', [], [])).toBeNull();
    expect(states('submitted', checks('waiting_review', 'waiting_review', 'valid', 'waiting_review'))).toEqual([
      ['done', 'current', 'upcoming', 'upcoming'],
      'documents',
    ]);
    expect(states('info_requested', checks('valid', 'waiting_review', 'valid', 'waiting_review'), ['certificate'])).toEqual([
      ['done', 'attention', 'upcoming', 'upcoming'],
      'documents',
    ]);
    // A certificate the trades do not need does not hold the documents step back.
    expect(states('submitted', checks('valid', 'missing', 'valid', 'waiting_review', false))).toEqual([
      ['done', 'done', 'current', 'upcoming'],
      'background',
    ]);
    expect(states('submitted', checks('valid', 'valid', 'valid', 'valid'))).toEqual([['done', 'done', 'done', 'current'], 'decision']);
    expect(states('rejected', checks('valid', 'valid', 'valid', 'rejected'))).toEqual([['done', 'done', 'failed', 'failed'], 'decision']);
    expect(states('approved', checks('valid', 'valid', 'valid', 'valid'))).toEqual([['done', 'done', 'done', 'done'], 'decision']);
  });

  it('is only the pro’s own, and shows the support contact', async () => {
    const { cookie } = await sent();
    const view = await application(cookie);
    expect(view.timeline.current).toBe('documents');
    expect(view.profile).toMatchObject({ status: 'submitted', homeAddress: ADDRESS, radiusKm: 10 });
    expect(view.support).toEqual({ email: null, phone: null });
    const customer = await signIn(t, '+4915122222222', 'customer');
    expect((await call(t, 'GET', '/pro/application', { cookie: customer })).statusCode).toBe(403);
    expect((await call(t, 'GET', '/pro/application', {})).statusCode).toBe(401);
  });

  it('sends a message with a link to the status page at every change of status', async () => {
    const { id } = await sent();
    for (const kind of ['id', 'certificate', 'insurance']) {
      await post(`/admin/pros/${id}/documents/${kind}/accept`, {});
    }
    await post(`/admin/pros/${id}/documents/background/accept`, {});
    await post(`/admin/pros/${id}/approve`);
    const inbox = await messagesOf(id);
    expect(inbox.map((m) => m.body)).toEqual([
      expect.stringContaining('we got your application'),
      expect.stringContaining('your documents are checked'),
      expect.stringContaining('your background check is back'),
      expect.stringContaining('you are approved'),
    ]);
    expect(inbox.every((m) => m.link === '/pro/application')).toBe(true);
  });

  it('asks for a named document, and the review carries on once it is uploaded, without a new application', async () => {
    const { id, cookie } = await sent();
    const before = (await call(t, 'GET', `/admin/pros/${id}`, { cookie: admin })).json().pro.submittedAt;
    await post(`/admin/pros/${id}/documents/id/accept`, {});
    const asked = await post(`/admin/pros/${id}/request-info`, {
      message: 'Your trade certificate photo is too blurry to read.',
      documents: ['certificate'],
    });
    expect(asked.json().pro).toMatchObject({ status: 'info_requested', requestedDocuments: ['certificate'] });
    expect((await post(`/admin/pros/${id}/request-info`, { message: 'Again', documents: ['background'] })).statusCode).toBe(400);

    const view = await application(cookie);
    expect(view.profile).toMatchObject({ reviewNote: 'Your trade certificate photo is too blurry to read.', requestedDocuments: ['certificate'] });
    expect(view.timeline.steps[1]).toEqual({ key: 'documents', state: 'attention' });
    expect((await messagesOf(id)).at(-1)?.body).toContain('Your trade certificate photo is too blurry to read.');

    await upload(t, '/pro/documents/certificate', cookie, FILES.pdf, 'sharper.pdf');
    const after = await application(cookie);
    expect(after.profile).toMatchObject({ status: 'submitted', requestedDocuments: [], reviewNote: null });
    // Where it stopped: the accepted ID stays accepted, and the place in the queue is kept.
    expect(after.profile.documents.id.state).toBe('valid');
    const detail = (await call(t, 'GET', `/admin/pros/${id}`, { cookie: admin })).json().pro;
    expect(detail.submittedAt).toBe(before);
    expect(detail.actions.map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining(['info_requested', 'info_provided', 'document_accepted']),
    );
    expect((await messagesOf(id)).at(-1)?.body).toContain('carries on where it stopped');
  });

  it('turns an application down with the reason, and lets the pro apply again only after 6 months', async () => {
    const { id, cookie } = await sent();
    await post(`/admin/pros/${id}/documents/background/reject`, { note: 'Not clear' });
    await post(`/admin/pros/${id}/reject`, { note: 'Your background check did not meet our requirements.' });
    const view = await application(cookie);
    expect(view.profile).toMatchObject({
      status: 'rejected',
      reviewNote: 'Your background check did not meet our requirements.',
      editable: false,
      reapplyOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(view.timeline.current).toBe('decision');
    expect((await messagesOf(id)).at(-1)?.body).toContain('You can apply again from');

    expect((await patch(cookie, { radiusKm: 20 })).json()).toEqual({ error: 'reapply_not_yet' });
    expect((await upload(t, '/pro/documents/certificate', cookie, FILES.pdf)).json()).toEqual({ error: 'reapply_not_yet' });
    expect((await submit(cookie)).json()).toEqual({ error: 'reapply_not_yet' });

    await t.pool.query("UPDATE pro_profiles SET rejected_at = now() - interval '6 months 1 day' WHERE user_id = $1", [id]);
    expect((await call(t, 'GET', '/pro/profile', { cookie })).json().profile.editable).toBe(true);
    expect((await patch(cookie, { radiusKm: 20 })).statusCode).toBe(200);
    const again = await submit(cookie);
    expect(again.json().profile.status).toBe('submitted');
    // A new application gets a new background check.
    expect(again.json().profile.documents.background.state).toBe('waiting_review');
  });
});
