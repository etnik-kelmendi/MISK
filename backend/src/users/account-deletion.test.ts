import { call, createTestContext, resetDatabase, seedMarket, sessionCookie, signIn, type Market, type TestContext } from '../../test/helpers.js';
import { hashPassword } from '../auth/passwords.js';
import { MAX_DELETE_TRIES_PER_ACCOUNT, SELF_DELETE_REASON } from './account-deletion.js';

let t: TestContext;
let market: Market;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(async () => {
  await resetDatabase(t.pool);
  t.fake.reset();
  t.emails.length = 0;
  market = await seedMarket(t.pool);
});

const PASSWORD = 'garden42';

async function emailCustomer(email = 'anna@example.com') {
  const created = await t.pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, first_name, last_name, phone, role, email_verified_at, terms_accepted_at)
     VALUES ($1, $2, 'Anna', 'Meier', '+4915100000001', 'customer', now(), now()) RETURNING id`,
    [email, await hashPassword(PASSWORD)],
  );
  const login = await call(t, 'POST', '/auth/login', { body: { email, password: PASSWORD } });
  return { id: created.rows[0]?.id ?? '', cookie: sessionCookie(login) };
}

let pros = 0;
async function proUser() {
  pros += 1;
  const created = await t.pool.query<{ id: string }>(`INSERT INTO users (phone, role, first_name) VALUES ($1, 'pro', 'Daniel') RETURNING id`, [
    `+4915200000${String(pros).padStart(3, '0')}`,
  ]);
  return created.rows[0]?.id ?? '';
}

/** A booking of the customer, starting `hours` from now (negative: in the past). */
async function booking(
  customerId: string,
  input: { status: string; hours: number; proId?: string | null; paymentStatus?: string; problem?: boolean },
): Promise<string> {
  const created = await t.pool.query<{ id: string }>(
    `INSERT INTO bookings (customer_id, service_id, category_id, service_name, size, address, postcode, starts_at, ends_at, status,
       price_cents, fee_cents, pro_share_pct, pro_id, payment_status, problem_reported_at, completed_at)
     SELECT $1, s.id, s.category_id, s.name, 'M', '12 Linden Street', '10115',
       now() + make_interval(mins => $2), now() + make_interval(mins => $2) + interval '1 hour', $3, 3500, 290, 82, $4, $5,
       CASE WHEN $6 THEN now() END, CASE WHEN $3 = 'completed' THEN now() END
     FROM services s WHERE s.id = $7 RETURNING id`,
    [customerId, Math.round(input.hours * 60), input.status, input.proId ?? null, input.paymentStatus ?? 'pending', input.problem ?? false, market.mowing],
  );
  return created.rows[0]?.id ?? '';
}

async function plan(customerId: string, endsInDays: number | null) {
  const planRow = await t.pool.query<{ id: string }>(
    `INSERT INTO plans (name, category_id, price_cents, frequency, visit_minutes, tasks) VALUES ('Lawn care', $1, 4900, 'weekly', 60, '{Mow}') RETURNING id`,
    [market.gardening],
  );
  const created = await t.pool.query<{ id: string }>(
    `INSERT INTO subscriptions (customer_id, plan_id, category_id, plan_name, tasks, size, frequency, days, time_window,
       visit_minutes, address, postcode, with_addon, price_cents, pro_share_pct, seasonal, skips_per_month, min_term_months, status, ends_at)
     VALUES ($1, $2, $3, 'Lawn care', '{Mow}', 'M', 'weekly', '{2}', 'morning', 60, '12 Linden Street', '10115',
       false, 4900, 70, false, 2, 3, 'active', CASE WHEN $4::int IS NULL THEN NULL ELSE now() + make_interval(days => $4::int) END)
     RETURNING id`,
    [customerId, planRow.rows[0]?.id, market.gardening, endsInDays],
  );
  return created.rows[0]?.id ?? '';
}

const preview = (cookie: string) => call(t, 'GET', '/account/deletion', { cookie });
const remove = (cookie: string, body: Record<string, unknown>) => call(t, 'POST', '/account/delete', { cookie, body });
const account = async (id: string) =>
  (await t.pool.query<{ email: string | null; phone: string | null; first_name: string | null; password_hash: string | null; disabled: boolean; deleted_reason: string | null }>(
    `SELECT email, phone, first_name, password_hash, disabled_at IS NOT NULL AS disabled, deleted_reason FROM users WHERE id = $1`,
    [id],
  )).rows[0];

describe('deleting one\x27s own account (D97)', () => {
  it('lists what can be deleted right away', async () => {
    const anna = await emailCustomer();
    expect((await preview(anna.cookie)).json()).toEqual({ pro: false, allowed: true, confirmWith: 'password', blockers: [], upcomingBookings: 0 });
  });

  it('refuses while something is open, and names each thing', async () => {
    const anna = await emailCustomer();
    const proA = await proUser();
    const proB = await proUser();
    const running = await plan(anna.id, null);
    const ending = await plan(anna.id, 20);
    const working = await booking(anna.id, { status: 'working', hours: -0.5, proId: proA });
    const soon = await booking(anna.id, { status: 'accepted', hours: 3, proId: proB });
    const problem = await booking(anna.id, { status: 'completed', hours: -30, proId: proA, paymentStatus: 'refunded', problem: true });
    const held = await booking(anna.id, { status: 'completed', hours: -50, proId: proA, paymentStatus: 'held' });
    const due = await booking(anna.id, { status: 'completed', hours: -70, proId: proA, paymentStatus: 'failed' });
    // Not blocking: a booking with no pro yet, starting soon, is cancelled for free.
    await booking(anna.id, { status: 'searching', hours: 2 });

    const shown = (await preview(anna.cookie)).json() as { allowed: boolean; blockers: { kind: string; id: string; at: string | null }[] };
    expect(shown.allowed).toBe(false);
    expect(shown.blockers.map((b) => [b.kind, b.id])).toEqual([
      ['plan', running],
      ['plan', ending],
      ['booking_in_progress', working],
      ['booking_soon', soon],
      ['problem_open', problem],
      ['money_held', held],
      ['payment_due', due],
    ]);
    // A cancelled plan shows when it ends; one still running has no end yet.
    expect(shown.blockers[0]?.at).toBeNull();
    expect(shown.blockers[1]?.at).toEqual(expect.any(String));

    const refused = await remove(anna.cookie, { password: PASSWORD });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('account_has_open_items');
    expect(refused.json().blockers).toHaveLength(7);
    expect(await account(anna.id)).toMatchObject({ email: 'anna@example.com', disabled: false });
    expect((await call(t, 'GET', '/auth/me', { cookie: anna.cookie })).statusCode).toBe(200);
  });

  it.each([
    ['plan', async (id: string) => void (await plan(id, null))],
    ['booking_in_progress', async (id: string) => void (await booking(id, { status: 'on_the_way', hours: 0.5, proId: await proUser() }))],
    ['booking_soon', async (id: string) => void (await booking(id, { status: 'accepted', hours: 23, proId: await proUser() }))],
    ['problem_open', async (id: string) => void (await booking(id, { status: 'completed', hours: -30, proId: await proUser(), paymentStatus: 'refunded', problem: true }))],
    ['money_held', async (id: string) => void (await booking(id, { status: 'completed', hours: -30, proId: await proUser(), paymentStatus: 'held' }))],
    ['payment_due', async (id: string) => void (await booking(id, { status: 'completed', hours: -30, proId: await proUser(), paymentStatus: 'failed' }))],
  ])('refuses with only an open %s', async (kind, add) => {
    const anna = await emailCustomer();
    await add(anna.id);
    const refused = await remove(anna.cookie, { password: PASSWORD });
    expect(refused.statusCode).toBe(409);
    expect((refused.json().blockers as { kind: string }[]).map((b) => b.kind)).toEqual([kind]);
  });

  it('cancels upcoming bookings, closes the account like the team does, ends every session and says goodbye', async () => {
    const anna = await emailCustomer();
    const pro = await proUser();
    const later = await booking(anna.id, { status: 'accepted', hours: 72, proId: pro });
    const unassigned = await booking(anna.id, { status: 'searching', hours: 2 });
    const past = await booking(anna.id, { status: 'completed', hours: -100, proId: pro, paymentStatus: 'captured' });
    await t.pool.query("INSERT INTO customer_addresses (customer_id, label, address, postcode) VALUES ($1, 'Home', '12 Linden Street', '10115')", [anna.id]);
    const otherDevice = sessionCookie(await call(t, 'POST', '/auth/login', { body: { email: 'anna@example.com', password: PASSWORD } }));
    expect((await preview(anna.cookie)).json()).toMatchObject({ allowed: true, upcomingBookings: 2 });

    expect((await remove(anna.cookie, {})).json()).toEqual({ error: 'password_required' });
    expect((await remove(anna.cookie, { password: 'not-it-123' })).json()).toEqual({ error: 'wrong_password' });
    expect(await account(anna.id)).toMatchObject({ disabled: false });

    const deleted = await remove(anna.cookie, { password: PASSWORD });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true });
    expect(String(deleted.headers['set-cookie'])).toMatch(/misk_session=;/);

    // The details are gone; the account stays for the records, closed.
    expect(await account(anna.id)).toEqual({
      email: null,
      phone: null,
      first_name: null,
      password_hash: null,
      disabled: true,
      deleted_reason: SELF_DELETE_REASON,
    });
    const statuses = await t.pool.query<{ id: string; status: string; cancelled_by: string | null }>(
      'SELECT id, status, cancelled_by FROM bookings WHERE customer_id = $1',
      [anna.id],
    );
    expect(Object.fromEntries(statuses.rows.map((row) => [row.id, [row.status, row.cancelled_by]]))).toEqual({
      [later]: ['cancelled', 'customer'],
      [unassigned]: ['cancelled', 'customer'],
      [past]: ['completed', null],
    });
    expect((await t.pool.query('SELECT 1 FROM customer_addresses WHERE customer_id = $1', [anna.id])).rowCount).toBe(0);
    expect((await t.pool.query('SELECT 1 FROM sessions WHERE user_id = $1', [anna.id])).rowCount).toBe(0);
    for (const cookie of [anna.cookie, otherDevice]) {
      expect((await call(t, 'GET', '/auth/me', { cookie })).statusCode).toBe(401);
    }
    expect((await call(t, 'POST', '/auth/login', { body: { email: 'anna@example.com', password: PASSWORD } })).statusCode).toBe(401);

    // The goodbye went to the phone and email the account had, and the pro hears the job is off.
    const goodbye = await t.pool.query<{ channel: string; email: string | null; phone: string | null; subject: string | null }>(
      "SELECT channel, email, phone, subject FROM notifications WHERE user_id = $1 AND kind = 'account' AND channel IN ('sms', 'email') ORDER BY channel",
      [anna.id],
    );
    expect(goodbye.rows).toEqual([
      { channel: 'email', email: 'anna@example.com', phone: null, subject: 'Your MISK account is deleted' },
      { channel: 'sms', email: null, phone: '+4915100000001', subject: null },
    ]);
    expect((await t.pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'booking_cancelled'", [pro])).rowCount).toBeGreaterThan(0);

    // Logged as the person's own action, with no team member.
    const log = await t.pool.query<{ action: string; admin_id: string | null; details: Record<string, unknown> }>(
      'SELECT action, admin_id, details FROM user_admin_actions WHERE user_id = $1',
      [anna.id],
    );
    expect(log.rows).toEqual([
      { action: 'closed_own_account', admin_id: null, details: expect.objectContaining({ name: 'Anna Meier', cancelledBookings: 2, endedPlans: 0 }) as unknown },
    ]);
  });

  it('asks an account without a password to type DELETE', async () => {
    const cookie = await signIn(t, '+4915100000005', 'customer', 'Sara');
    const id = (await call(t, 'GET', '/auth/me', { cookie })).json().user.id as string;
    expect((await preview(cookie)).json()).toMatchObject({ allowed: true, confirmWith: 'typed' });
    expect((await remove(cookie, { confirmText: 'delete' })).json()).toEqual({ error: 'delete_not_confirmed' });
    expect((await remove(cookie, {})).json()).toEqual({ error: 'delete_not_confirmed' });
    expect((await remove(cookie, { confirmText: ' DELETE ' })).statusCode).toBe(200);
    expect(await account(id)).toMatchObject({ phone: null, disabled: true });
  });

  it('limits the tries, wrong passwords included', async () => {
    const anna = await emailCustomer();
    for (let i = 0; i < MAX_DELETE_TRIES_PER_ACCOUNT; i += 1) {
      expect((await remove(anna.cookie, { password: `wrong-${i}-x` })).statusCode).toBe(400);
    }
    const limited = await remove(anna.cookie, { password: PASSWORD });
    expect(limited.statusCode).toBe(429);
    expect(await account(anna.id)).toMatchObject({ disabled: false });
    // Each wrong password waits a moment, like a failed login.
  }, 20_000);

  it('sends pros to support', async () => {
    const cookie = await signIn(t, '+4915100000007', 'pro', 'Daniel');
    expect((await preview(cookie)).json()).toMatchObject({ pro: true, allowed: false, blockers: [] });
    const refused = await remove(cookie, { confirmText: 'DELETE' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'pro_account' });
    const id = (await call(t, 'GET', '/auth/me', { cookie })).json().user.id as string;
    expect(await account(id)).toMatchObject({ disabled: false });
  });
});
