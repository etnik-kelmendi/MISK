import {
  approvedPro,
  call,
  createTestContext,
  lastCode,
  resetDatabase,
  seedMarket,
  signIn,
  signInAdmin,
  type Market,
  type TestContext,
} from '../../test/helpers.js';

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
    expect(suspended.json().user).toMatchObject({ status: 'suspended', suspendedReason: 'Repeated no-shows' });
    expect((await get('/auth/me', customer)).statusCode).toBe(401);
    const status = (await t.pool.query<{ status: string; cancelled_by: string }>('SELECT status, cancelled_by FROM bookings WHERE id = $1', [booking.id])).rows[0];
    expect(status).toEqual({ status: 'cancelled', cancelled_by: 'admin' });
    // Signing in again is refused with its own answer, after the right code.
    await call(t, 'POST', '/auth/phone/start', { body: { phone: CUSTOMER } });
    const again = await call(t, 'POST', '/auth/phone/verify', { body: { phone: CUSTOMER, code: lastCode(t, CUSTOMER) } });
    expect(again.statusCode).toBe(403);
    expect(again.json()).toEqual({ error: 'account_suspended' });
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
    expect((await get('/auth/me', pro.cookie)).statusCode).toBe(401);
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
