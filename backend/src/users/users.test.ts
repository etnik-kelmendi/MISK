import {
  approvedPro,
  call,
  createTestContext,
  lastCode,
  resetDatabase,
  seedMarket,
  sessionCookie,
  signIn,
  signInAdmin,
  type Market,
  type TestContext,
} from '../../test/helpers.js';
import { hashPassword } from '../auth/passwords.js';
import { phoneSearchDigits } from './admin-routes.js';

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

const CUSTOMER = '+4915100000001';
const get = (url: string, cookie = admin) => call(t, 'GET', url, { cookie });
const post = (url: string, body?: unknown, cookie = admin) => call(t, 'POST', url, { cookie, ...(body === undefined ? {} : { body }) });

async function bookMowing(cookie: string) {
  const slots = (await get(`/availability?serviceId=${market.mowing}&postcode=10115`, cookie)).json().slots as { startsAt: string; available: boolean }[];
  const free = slots.find((s) => s.available);
  if (!free) throw new Error('No free slot');
  const response = await post(
    '/bookings',
    { serviceId: market.mowing, size: 'M', address: '12 Linden Street', postcode: '10115', startsAt: free.startsAt },
    cookie,
  );
  expect(response.statusCode).toBe(201);
  return response.json().booking as { id: string };
}

async function userId(phone: string) {
  return (await t.pool.query<{ id: string }>('SELECT id FROM users WHERE phone = $1', [phone])).rows[0]?.id ?? '';
}

type ListRow = { id: string; firstName: string | null; types: string[]; status: string; email: string | null; phone: string | null };
const list = async (query = '') => (await get(`/admin/users${query}`)).json() as { users: ListRow[]; matching: number; total: number };

describe('pros who also book (D64)', () => {
  it('lets a pro book as a customer with the same account, and never offers them their own job', async () => {
    const booker = await approvedPro(t, '+4915100000101', { trades: [market.gardening], firstName: 'Daniel' });
    const other = await approvedPro(t, '+4915100000102', { trades: [market.gardening], firstName: 'Arben' });
    const booking = await bookMowing(booker.cookie);
    const offers = await t.pool.query<{ pro_id: string }>('SELECT pro_id FROM booking_offers WHERE booking_id = $1', [booking.id]);
    expect(offers.rows.map((o) => o.pro_id)).toEqual([other.proId]);
    expect((await get('/bookings', booker.cookie)).json().bookings.map((b: { id: string }) => b.id)).toEqual([booking.id]);

    // The team cannot give the pro their own job either; the database refuses it too.
    expect((await post(`/admin/bookings/${booking.id}/reassign`, { proId: booker.proId })).json()).toEqual({ error: 'pro_is_customer' });
    const candidates = (await get(`/admin/bookings/${booking.id}/candidates`)).json().candidates as { id: string }[];
    expect(candidates.map((c) => c.id)).not.toContain(booker.proId);
    await expect(t.pool.query('UPDATE bookings SET pro_id = customer_id WHERE id = $1', [booking.id])).rejects.toThrow(/bookings_pro_is_not_customer/);

    // On the Users page the pro is one row with both types.
    const rows = (await list()).users.filter((u) => u.id === booker.proId);
    expect(rows).toEqual([expect.objectContaining({ types: ['customer', 'pro'], status: 'active' })]);
  });

  it('counts a pro as free only for other people\x27s bookings', async () => {
    const solo = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    // The only gardener cannot be booked by themselves: no free slot.
    const slots = (await get(`/availability?serviceId=${market.mowing}&postcode=10115`, solo.cookie)).json().slots as { available: boolean }[];
    expect(slots.some((s) => s.available)).toBe(false);
    const customer = await signIn(t, CUSTOMER, 'customer');
    const theirs = (await get(`/availability?serviceId=${market.mowing}&postcode=10115`, customer)).json().slots as { available: boolean }[];
    expect(theirs.some((s) => s.available)).toBe(true);
  });
});

describe('the Users page (D65)', () => {
  it('lists customers and pros once each with name, email, phone, type, status, joined and last active', async () => {
    await signIn(t, CUSTOMER, 'customer', 'Sara');
    await t.pool.query("UPDATE users SET last_name = 'Meier', email = 'sara@example.com' WHERE phone = $1", [CUSTOMER]);
    await approvedPro(t, '+4915100000101', { trades: [market.gardening], firstName: 'Daniel' });
    const result = await list();
    expect(result.total).toBe(2);
    expect(result.matching).toBe(2);
    const sara = result.users.find((u) => u.phone === CUSTOMER);
    expect(sara).toMatchObject({ firstName: 'Sara', lastName: 'Meier', email: 'sara@example.com', types: ['customer'], status: 'active' });
    expect(sara).toHaveProperty('joinedAt');
    expect(sara).toHaveProperty('lastActive');
    expect(result.users.find((u) => u.phone === '+4915100000101')?.types).toEqual(['pro']);
    // Admins are not users here.
    expect(result.users.some((u) => u.firstName === null && u.phone === null)).toBe(false);
  });

  it('searches name, email and phone, and filters by type and status', async () => {
    await signIn(t, CUSTOMER, 'customer', 'Sara');
    await t.pool.query("UPDATE users SET email = 'sara@example.com' WHERE phone = $1", [CUSTOMER]);
    await signIn(t, '+4915100000002', 'customer', 'Tom');
    await approvedPro(t, '+4915100000101', { trades: [market.gardening], firstName: 'Daniel' });

    expect((await list('?q=sar')).users.map((u) => u.firstName)).toEqual(['Sara']);
    expect((await list('?q=SARA%40EXAMPLE')).users.map((u) => u.firstName)).toEqual(['Sara']);
    expect((await list('?q=0151%2000000002')).users.map((u) => u.firstName)).toEqual(['Tom']);
    const pros = await list('?type=pro');
    expect(pros.users.map((u) => u.firstName)).toEqual(['Daniel']);
    expect(pros).toMatchObject({ matching: 1, total: 3 });
    expect((await list('?type=customer')).matching).toBe(2);

    await post(`/admin/users/${await userId('+4915100000002')}/suspend`, { reason: 'Abusive messages' });
    expect((await list('?status=suspended')).users.map((u) => u.firstName)).toEqual(['Tom']);
    expect((await list('?status=active')).matching).toBe(2);
    expect((await list('?status=deleted')).matching).toBe(0);
    expect((await get('/admin/users?type=admin')).statusCode).toBe(400);
  });

  it('shows details with bookings, active plans and, for pros, rating and documents', async () => {
    const customer = await signIn(t, CUSTOMER, 'customer', 'Sara');
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    await bookMowing(customer);
    const sara = (await get(`/admin/users/${await userId(CUSTOMER)}`)).json().user;
    expect(sara).toMatchObject({ firstName: 'Sara', types: ['customer'], bookings: { total: 1, upcoming: 1, completed: 0, cancelled: 0 }, activePlans: [], pro: null });

    const pro = (await get(`/admin/users/${await userId('+4915100000101')}`)).json().user;
    expect(pro.pro).toMatchObject({ status: 'approved', ratingAverage: null, ratingCount: 0, jobsDone: 0 });
    expect(pro.pro.documents.map((d: { kind: string }) => d.kind)).toEqual(['id', 'certificate', 'insurance', 'background']);
  });

  it('sends a message from the team and logs it', async () => {
    await signIn(t, CUSTOMER, 'customer', 'Sara');
    const id = await userId(CUSTOMER);
    const sent = await post(`/admin/users/${id}/message`, { text: '  Please call us about your booking.  ' });
    expect(sent.statusCode).toBe(200);
    const texts = await t.pool.query<{ channel: string; body: string }>("SELECT channel, body FROM notifications WHERE user_id = $1 AND kind = 'team_message'", [id]);
    expect(texts.rows).toEqual([{ channel: 'sms', body: 'MISK team: Please call us about your booking.' }]);
    expect((await t.pool.query("SELECT 1 FROM inbox WHERE user_id = $1 AND kind = 'team_message'", [id])).rowCount).toBe(1);
    expect(sent.json().user.actions[0]).toMatchObject({ action: 'messaged', details: { text: 'Please call us about your booking.' }, adminName: 'admin' });
    expect((await post(`/admin/users/${id}/message`, { text: '   ' })).statusCode).toBe(400);
  });

  it('suspends a customer: signed out, cannot sign in, upcoming bookings cancelled; reinstating lets them back', async () => {
    const customer = await signIn(t, CUSTOMER, 'customer', 'Sara');
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const booking = await bookMowing(customer);
    const id = await userId(CUSTOMER);

    expect((await post(`/admin/users/${id}/suspend`, {})).statusCode).toBe(400);
    const suspended = await post(`/admin/users/${id}/suspend`, { reason: 'Repeated no-shows' });
    expect(suspended.json().user).toMatchObject({ status: 'suspended', suspendedReason: 'Repeated no-shows', suspendedMessage: null });
    // Signed out at once: the session no longer works, and says why (D87).
    const me = await get('/auth/me', customer);
    expect(me.statusCode).toBe(403);
    expect(me.json()).toEqual({ error: 'account_suspended', message: null, support: { email: null, phone: null } });
    const status = (await t.pool.query<{ status: string; cancelled_by: string }>('SELECT status, cancelled_by FROM bookings WHERE id = $1', [booking.id])).rows[0];
    expect(status).toEqual({ status: 'cancelled', cancelled_by: 'admin' });
    // Signing in again is refused with its own answer, after the right code.
    await call(t, 'POST', '/auth/phone/start', { body: { phone: CUSTOMER } });
    const again = await call(t, 'POST', '/auth/phone/verify', { body: { phone: CUSTOMER, code: lastCode(t, CUSTOMER) } });
    expect(again.statusCode).toBe(403);
    expect(again.json()).toMatchObject({ error: 'account_suspended', message: null });
    expect(again.cookies).toEqual([]);
    expect((await post(`/admin/users/${id}/suspend`, { reason: 'Again' })).json()).toEqual({ error: 'already_suspended' });

    const back = await post(`/admin/users/${id}/reinstate`);
    expect(back.json().user.status).toBe('active');
    expect(back.json().user.actions.map((a: { action: string }) => a.action)).toEqual(['reinstated', 'suspended']);
    expect(back.json().user.actions[1].details).toMatchObject({ reason: 'Repeated no-shows', cancelledBookings: 1, endedPlans: 0 });
    expect((await post(`/admin/users/${id}/reinstate`)).json()).toEqual({ error: 'not_suspended' });
  });

  it('suspends a pro the same way their Providers suspension works, and reinstates them as Active', async () => {
    const pro = await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    await post(`/admin/users/${pro.proId}/suspend`, { reason: 'Damage reports' });
    expect((await t.pool.query<{ status: string }>('SELECT status FROM pro_profiles WHERE user_id = $1', [pro.proId])).rows[0]?.status).toBe('suspended');
    expect((await get('/auth/me', pro.cookie)).json().error).toBe('account_suspended');
    expect((await get('/pro/jobs', pro.cookie)).statusCode).toBe(403);
    const log = await t.pool.query("SELECT action FROM pro_admin_actions WHERE pro_id = $1 AND action = 'suspended'", [pro.proId]);
    expect(log.rowCount).toBe(1);
    await post(`/admin/users/${pro.proId}/reinstate`);
    expect((await t.pool.query<{ status: string }>('SELECT status FROM pro_profiles WHERE user_id = $1', [pro.proId])).rows[0]?.status).toBe('approved');
  });

  it('closes an account for good: details removed, bookings kept, nobody can sign in with it', async () => {
    const customer = await signIn(t, CUSTOMER, 'customer', 'Sara');
    await t.pool.query("UPDATE users SET email = 'sara@example.com', last_name = 'Meier' WHERE phone = $1", [CUSTOMER]);
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    const booking = await bookMowing(customer);
    const id = await userId(CUSTOMER);
    expect((await post(`/admin/users/${id}/delete`, { reason: ' ' })).statusCode).toBe(400);

    const closed = await post(`/admin/users/${id}/delete`, { reason: 'Asked to be removed' });
    expect(closed.json().user).toMatchObject({
      status: 'deleted',
      firstName: null,
      lastName: null,
      email: null,
      phone: null,
      deletedReason: 'Asked to be removed',
    });
    expect((await get('/auth/me', customer)).statusCode).toBe(401);
    const kept = await t.pool.query<{ status: string; customer_id: string }>('SELECT status, customer_id FROM bookings WHERE id = $1', [booking.id]);
    expect(kept.rows[0]).toEqual({ status: 'cancelled', customer_id: id });
    expect(closed.json().user.actions[0]).toMatchObject({ action: 'deleted', details: { reason: 'Asked to be removed', name: 'Sara Meier', cancelledBookings: 1 } });
    expect((await list('?status=deleted')).matching).toBe(1);
    // Nothing more can be done to a closed account.
    for (const path of ['suspend', 'delete']) {
      expect((await post(`/admin/users/${id}/${path}`, { reason: 'x' })).json()).toEqual({ error: 'account_deleted' });
    }
    expect((await post(`/admin/users/${id}/message`, { text: 'Hello' })).json()).toEqual({ error: 'account_deleted' });
  });

  it('puts every change in the team\x27s activity log, and is open to the roles that help people', async () => {
    await signIn(t, CUSTOMER, 'customer', 'Sara');
    const id = await userId(CUSTOMER);
    await post(`/admin/users/${id}/suspend`, { reason: 'Spam' });
    const feed = (await get('/admin/activity')).json().activity as { area: string; action: string; subject: string }[];
    expect(feed[0]).toMatchObject({ area: 'users', action: 'user_suspended', subject: 'Sara' });

    const make = async (username: string, role: string) => {
      const cookie = await signInAdmin(t, username);
      await t.pool.query('UPDATE users SET admin_role = $2 WHERE username = $1', [username, role]);
      return cookie;
    };
    expect((await get('/admin/users', await make('sam', 'support'))).statusCode).toBe(200);
    expect((await get('/admin/users', await make('fiona', 'finance'))).statusCode).toBe(403);
  });
});

const PASSWORD = 'garden42';

/** A customer who signed up with email and password and has no phone, like anna@example.com in the demo. */
async function emailCustomer(email = 'anna@example.com', firstName = 'Anna') {
  const created = await t.pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, first_name, last_name, role, email_verified_at, terms_accepted_at)
     VALUES ($1, $2, $3, 'Schmidt', 'customer', now(), now()) RETURNING id`,
    [email, await hashPassword(PASSWORD), firstName],
  );
  const login = await call(t, 'POST', '/auth/login', { body: { email, password: PASSWORD } });
  return { id: created.rows[0]?.id ?? '', cookie: sessionCookie(login) };
}

type Sent = { channel: string; phone: string | null; email: string | null; subject: string | null; body: string };
const sentTo = async (id: string, kind: string) =>
  (
    await t.pool.query<Sent>('SELECT channel, phone, email, subject, body FROM notifications WHERE user_id = $1 AND kind = $2 ORDER BY channel', [
      id,
      kind,
    ])
  ).rows;

describe('finding people by phone, however the number is typed (D87)', () => {
  it('turns typed numbers into the digits to look for', () => {
    expect(phoneSearchDigits('+49 (0)151 00000001')).toEqual(['4915100000001']);
    expect(phoneSearchDigits('+49 (0) 151-000 00001')).toEqual(['4915100000001']);
    expect(phoneSearchDigits('0049 151 00000001')).toEqual(['4915100000001']);
    expect(phoneSearchDigits('+49 0151 00000001')).toEqual(['49015100000001', '4915100000001']);
    expect(phoneSearchDigits('0151 / 000 000 01')).toEqual(['15100000001']);
    expect(phoneSearchDigits('(0151) 00000001')).toEqual(['15100000001']);
    // Too short, or not a number at all.
    expect(phoneSearchDigits('015')).toEqual([]);
    expect(phoneSearchDigits('user1234')).toEqual([]);
    expect(phoneSearchDigits('')).toEqual([]);
  });

  it('finds a customer by every common way of writing their number, and nobody for a short or wrong one', async () => {
    await signIn(t, CUSTOMER, 'customer', 'Sara');
    await signIn(t, '+4915100000002', 'customer', 'Tom');
    const typedNumbers = [
      '+49 (0)151 00000002',
      '+49 (0) 151-000 00002',
      '0049 151 00000002',
      '+49 0151 00000002',
      '0151/000 000 02',
      '15100000002',
      '+4915100000002',
    ];
    for (const typed of typedNumbers) {
      expect((await list(`?q=${encodeURIComponent(typed)}`)).users.map((u) => u.firstName), typed).toEqual(['Tom']);
    }
    // Part of a number finds everyone whose number has it.
    expect((await list(`?q=${encodeURIComponent('0151 0000000')}`)).matching).toBe(2);
    expect((await list('?q=000')).matching).toBe(0);
    expect((await list(`?q=${encodeURIComponent('+44 151 00000002')}`)).matching).toBe(0);
  });

  it('finds an email customer by phone once they added one to their account', async () => {
    const anna = await emailCustomer();
    expect((await list(`?q=${encodeURIComponent('0151 00000009')}`)).matching).toBe(0);
    await call(t, 'POST', '/account/phone/start', { cookie: anna.cookie, body: { phone: '+49 151 00000009' } });
    const added = await call(t, 'POST', '/account/phone/verify', {
      cookie: anna.cookie,
      body: { phone: '+4915100000009', code: lastCode(t, '+4915100000009') },
    });
    expect(added.statusCode).toBe(200);
    expect((await list(`?q=${encodeURIComponent('0151 00000009')}`)).users.map((u) => u.firstName)).toEqual(['Anna']);
  });
});

describe('telling people about their account outside the app (D87)', () => {
  it('emails a suspended email customer, shares only the message the admin chose, and explains it after the right password', async () => {
    const anna = await emailCustomer();
    await approvedPro(t, '+4915100000101', { trades: [market.gardening] });
    await bookMowing(anna.cookie);

    const suspended = await post(`/admin/users/${anna.id}/suspend`, {
      reason: 'Chargeback fraud suspected',
      message: '  Please call us about your last payment.  ',
    });
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json().delivery).toEqual({ inApp: true, channels: ['email'], notSetUp: [] });
    expect(suspended.json().user).toMatchObject({
      suspendedReason: 'Chargeback fraud suspected',
      suspendedMessage: 'Please call us about your last payment.',
    });

    const notices = await sentTo(anna.id, 'account');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ channel: 'email', email: 'anna@example.com', subject: 'Your MISK account is suspended' });
    expect(notices[0]?.body).toContain('Hello Anna,');
    expect(notices[0]?.body).toContain('1 upcoming booking was cancelled; any money held on your card is released.');
    expect(notices[0]?.body).toContain('Message from the MISK team: Please call us about your last payment.');
    // The internal reason never leaves the control panel.
    const everything = await t.pool.query<{ body: string }>('SELECT body FROM notifications UNION ALL SELECT body FROM inbox');
    expect(everything.rows.some((row) => row.body.includes('Chargeback'))).toBe(false);

    // The open session explains it.
    const me = await get('/auth/me', anna.cookie);
    expect(me.statusCode).toBe(403);
    expect(me.json()).toEqual({
      error: 'account_suspended',
      message: 'Please call us about your last payment.',
      support: { email: null, phone: null },
    });
    // Logging in: a wrong password or an unknown email reveals nothing; the right password explains it.
    const login = (email: string, password: string) => call(t, 'POST', '/auth/login', { body: { email, password } });
    expect((await login('anna@example.com', 'wrong-password1')).json()).toEqual({ error: 'invalid_login' });
    expect((await login('nobody@example.com', PASSWORD)).json()).toEqual({ error: 'invalid_login' });
    const right = await login('anna@example.com', PASSWORD);
    expect(right.statusCode).toBe(403);
    expect(right.json()).toMatchObject({ error: 'account_suspended', message: 'Please call us about your last payment.' });
    expect(right.cookies).toEqual([]);

    expect(suspended.json().user.actions[0]).toMatchObject({
      action: 'suspended',
      details: { reason: 'Chargeback fraud suspected', message: 'Please call us about your last payment.', channels: ['email'] },
    });
  });

  it('texts and emails a person with both, names the support contact, and tells them when they are back', async () => {
    const before = t.config.support;
    t.config.support = { email: 'help@example.com', phone: '+493012345678' };
    try {
      const customer = await signIn(t, CUSTOMER, 'customer', 'Sara');
      await t.pool.query("UPDATE users SET email = 'sara@example.com' WHERE phone = $1", [CUSTOMER]);
      const id = await userId(CUSTOMER);

      const suspended = await post(`/admin/users/${id}/suspend`, { reason: 'Abusive messages' });
      expect(suspended.json().delivery.channels).toEqual(['sms', 'email']);
      const notices = await sentTo(id, 'account');
      expect(notices.map((n) => n.channel)).toEqual(['email', 'sms']);
      const text = notices.find((n) => n.channel === 'sms')?.body ?? '';
      expect(text).toBe(
        'MISK: your account is suspended, so you cannot sign in for now. Questions? Contact the MISK team at help@example.com or +493012345678.',
      );
      expect((await get('/auth/me', customer)).json()).toEqual({
        error: 'account_suspended',
        message: null,
        support: { email: 'help@example.com', phone: '+493012345678' },
      });

      const back = await post(`/admin/users/${id}/reinstate`);
      expect(back.json().delivery).toEqual({ inApp: true, channels: ['sms', 'email'], notSetUp: [] });
      const reinstated = (await sentTo(id, 'account')).filter((n) => !notices.some((old) => old.channel === n.channel && old.body === n.body));
      expect(reinstated.map((n) => n.channel)).toEqual(['email', 'sms']);
      expect(reinstated.find((n) => n.channel === 'email')?.subject).toBe('Your MISK account is active again');
      const inbox = await t.pool.query<{ body: string }>("SELECT body FROM inbox WHERE user_id = $1 AND kind = 'account' ORDER BY created_at", [id]);
      expect(inbox.rows.map((r) => r.body)).toEqual([text, 'MISK: your account is active again. You can sign in as before.']);
      // The session from before the suspension is over; signing in again works.
      expect((await get('/auth/me', customer)).statusCode).toBe(401);
      expect((await get('/auth/me', await signIn(t, CUSTOMER))).statusCode).toBe(200);
    } finally {
      t.config.support = before;
    }
  });

  it('tells a closed account by text and email before its details are removed', async () => {
    await signIn(t, CUSTOMER, 'customer', 'Sara');
    await t.pool.query("UPDATE users SET email = 'sara@example.com' WHERE phone = $1", [CUSTOMER]);
    const id = await userId(CUSTOMER);
    const closed = await post(`/admin/users/${id}/delete`, { reason: 'Asked to be removed' });
    expect(closed.json().delivery.channels).toEqual(['sms', 'email']);
    expect(await sentTo(id, 'account')).toEqual([
      expect.objectContaining({ channel: 'email', email: 'sara@example.com', subject: 'Your MISK account has been closed' }),
      expect.objectContaining({ channel: 'sms', phone: CUSTOMER }),
    ]);
    expect(closed.json().user.actions[0].details.channels).toEqual(['sms', 'email']);
  });

  it('sends a team message by text and email to a person with both, and says which channels the server cannot use yet', async () => {
    await signIn(t, CUSTOMER, 'customer', 'Sara');
    await t.pool.query("UPDATE users SET email = 'sara@example.com' WHERE phone = $1", [CUSTOMER]);
    const id = await userId(CUSTOMER);
    // A phone with the app's notifications on; push is not set up on this test server.
    await t.pool.query("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, 'https://push.example.com/1', 'key', 'auth')", [id]);
    const sent = await post(`/admin/users/${id}/message`, { text: 'Your invoice is ready.' });
    expect(sent.json().delivery).toEqual({ inApp: true, channels: ['push', 'sms', 'email'], notSetUp: ['push'] });
    const messages = await sentTo(id, 'team_message');
    expect(messages.map((m) => m.channel)).toEqual(['email', 'push', 'sms']);
    expect(messages.find((m) => m.channel === 'email')).toMatchObject({ subject: 'A message from the MISK team' });
    expect(messages.find((m) => m.channel === 'email')?.body).toContain('Your invoice is ready.');
    expect(sent.json().user.actions[0].details).toEqual({ text: 'Your invoice is ready.', channels: ['push', 'sms', 'email'] });

    // Someone without a phone gets it by email and in the app.
    const anna = await emailCustomer();
    const toAnna = await post(`/admin/users/${anna.id}/message`, { text: 'Hello Anna' });
    expect(toAnna.json().delivery.channels).toEqual(['email']);
    expect((await sentTo(anna.id, 'team_message')).map((m) => m.channel)).toEqual(['email']);
  });
});

describe('the unread count in the app (D87)', () => {
  it('says how many messages are unread and which is newest, without loading the list', async () => {
    const customer = await signIn(t, CUSTOMER, 'customer', 'Sara');
    const id = await userId(CUSTOMER);
    expect((await get('/inbox/unread', customer)).json()).toEqual({ unread: 0, newestId: null });
    await post(`/admin/users/${id}/message`, { text: 'First' });
    await post(`/admin/users/${id}/message`, { text: 'Second' });
    const inbox = (await get('/inbox', customer)).json();
    expect(inbox.messages[0]).toMatchObject({ kind: 'team_message', body: 'MISK team: Second' });
    expect((await get('/inbox/unread', customer)).json()).toEqual({ unread: 2, newestId: inbox.messages[0].id });
    expect((await post('/inbox/read', undefined, customer)).statusCode).toBe(204);
    expect((await get('/inbox/unread', customer)).json()).toEqual({ unread: 0, newestId: inbox.messages[0].id });
    expect((await call(t, 'GET', '/inbox/unread')).statusCode).toBe(401);
  });
});
