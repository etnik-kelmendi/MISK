import { call, createTestContext, lastCode, resetDatabase, sessionCookie, signIn, signInAdmin, type TestContext } from '../../test/helpers.js';
import { MAX_PHONE_CHANGE_CODES_PER_ACCOUNT } from './phone-sign-in.js';
import { hashPassword } from './passwords.js';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(async () => {
  await resetDatabase(t.pool);
  t.texts.length = 0;
  t.emails.length = 0;
});

const PASSWORD = 'garden42';
const NEW_PHONE = '+4915100000009';

/** A customer who signed up with email and password, with no phone. */
async function emailCustomer(email = 'anna@example.com') {
  const created = await t.pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, first_name, role, email_verified_at, terms_accepted_at)
     VALUES ($1, $2, 'Anna', 'customer', now(), now()) RETURNING id`,
    [email, await hashPassword(PASSWORD)],
  );
  const login = await call(t, 'POST', '/auth/login', { body: { email, password: PASSWORD } });
  return { id: created.rows[0]?.id ?? '', cookie: sessionCookie(login) };
}

const start = (cookie: string, phone: string) => call(t, 'POST', '/account/phone/start', { cookie, body: { phone } });
const verify = (cookie: string, phone: string, code: string) => call(t, 'POST', '/account/phone/verify', { cookie, body: { phone, code } });
const phoneOf = async (id: string) => (await t.pool.query<{ phone: string | null }>('SELECT phone FROM users WHERE id = $1', [id])).rows[0]?.phone;
const log = async (id: string) =>
  (await t.pool.query<{ action: string; admin_id: string | null; details: unknown }>('SELECT action, admin_id, details FROM user_admin_actions WHERE user_id = $1 ORDER BY id', [id]))
    .rows;
const accountNotices = async (id: string) =>
  (await t.pool.query<{ channel: string; body: string }>("SELECT channel, body FROM notifications WHERE user_id = $1 AND kind = 'account'", [id])).rows;

/** A wrong code that is never the real one. */
const wrong = (code: string) => (code === '000000' ? '111111' : '000000');

describe('adding a phone number to an account (D87)', () => {
  it('texts a code, adds the number once it is right, and the account can then sign in with it', async () => {
    const anna = await emailCustomer();
    const started = await start(anna.cookie, '0049 151 000 000 09');
    expect(started.statusCode).toBe(202);
    expect(started.json()).toEqual({ phone: NEW_PHONE });
    const code = lastCode(t, NEW_PHONE);

    expect((await verify(anna.cookie, NEW_PHONE, wrong(code))).json()).toEqual({ error: 'invalid_code' });
    expect(await phoneOf(anna.id)).toBeNull();
    const added = await verify(anna.cookie, NEW_PHONE, code);
    expect(added.statusCode).toBe(200);
    expect(added.json().user).toMatchObject({ id: anna.id, phone: NEW_PHONE, email: 'anna@example.com' });
    // A code works once.
    expect((await verify(anna.cookie, NEW_PHONE, code)).json()).toEqual({ error: 'invalid_code' });

    // Signing in with the phone opens the same account; the email login keeps working.
    const byPhone = await signIn(t, NEW_PHONE);
    expect((await call(t, 'GET', '/auth/me', { cookie: byPhone })).json().user.id).toBe(anna.id);
    expect((await call(t, 'GET', '/auth/me', { cookie: anna.cookie })).json().user.phone).toBe(NEW_PHONE);

    // Told by email, which shows only the last digits, and logged without the number.
    const notices = await accountNotices(anna.id);
    expect(notices).toEqual([{ channel: 'email', body: expect.stringContaining('ending …0009 was added') as unknown as string }]);
    expect(t.emails).toEqual([]); // emails go through the outbox, not straight out
    expect(await log(anna.id)).toEqual([{ action: 'phone_added', admin_id: null, details: {} }]);
    // The team's activity feed lists what the team did, not this.
    const admin = await signInAdmin(t);
    const feed = (await call(t, 'GET', '/admin/activity', { cookie: admin })).json().activity as { action: string }[];
    expect(feed.some((entry) => entry.action.startsWith('user_phone'))).toBe(false);
  });

  it('changes the number of a phone account, after a code to the new number', async () => {
    const cookie = await signIn(t, '+4915100000001', 'customer', 'Sara');
    const id = (await call(t, 'GET', '/auth/me', { cookie })).json().user.id as string;
    expect((await start(cookie, '+49 151 00000001')).json()).toEqual({ error: 'phone_unchanged' });
    await start(cookie, NEW_PHONE);
    expect((await verify(cookie, NEW_PHONE, lastCode(t, NEW_PHONE))).json().user.phone).toBe(NEW_PHONE);
    expect(await log(id)).toEqual([{ action: 'phone_changed', admin_id: null, details: {} }]);
    // The old number no longer opens this account.
    const old = await signIn(t, '+4915100000001');
    expect((await call(t, 'GET', '/auth/me', { cookie: old })).json().user.id).not.toBe(id);
  });

  it('refuses a number another account uses, saying so only after the right code, and never merges them', async () => {
    const other = await signIn(t, NEW_PHONE, 'customer', 'Tom');
    const anna = await emailCustomer();
    // Starting says nothing about the other account.
    const started = await start(anna.cookie, NEW_PHONE);
    expect(started.statusCode).toBe(202);
    expect((await verify(anna.cookie, NEW_PHONE, wrong(lastCode(t, NEW_PHONE)))).json()).toEqual({ error: 'invalid_code' });
    const taken = await verify(anna.cookie, NEW_PHONE, lastCode(t, NEW_PHONE));
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ error: 'phone_taken' });
    expect(await phoneOf(anna.id)).toBeNull();
    expect((await call(t, 'GET', '/auth/me', { cookie: other })).json().user).toMatchObject({ phone: NEW_PHONE, firstName: 'Tom' });
    expect(await log(anna.id)).toEqual([]);
  });

  it('keeps sign-in codes and add-a-phone codes apart, and codes of one account from another', async () => {
    const anna = await emailCustomer();
    const ben = await emailCustomer('ben@example.com');
    // A sign-in code does not add the phone...
    await call(t, 'POST', '/auth/phone/start', { body: { phone: NEW_PHONE } });
    expect((await verify(anna.cookie, NEW_PHONE, lastCode(t, NEW_PHONE))).json()).toEqual({ error: 'invalid_code' });
    // ...an add-a-phone code does not sign in or create an account...
    await start(anna.cookie, NEW_PHONE);
    const code = lastCode(t, NEW_PHONE);
    expect((await call(t, 'POST', '/auth/phone/verify', { body: { phone: NEW_PHONE, code } })).statusCode).toBe(401);
    // ...and Anna's code does not work for Ben.
    expect((await verify(ben.cookie, NEW_PHONE, code)).json()).toEqual({ error: 'invalid_code' });
    expect((await t.pool.query('SELECT 1 FROM users WHERE phone = $1', [NEW_PHONE])).rowCount).toBe(0);
    expect((await verify(anna.cookie, NEW_PHONE, code)).statusCode).toBe(200);
  });

  it('checks the input, limits the codes, and is only for signed-in customers and pros', async () => {
    const anna = await emailCustomer();
    expect((await start(anna.cookie, '0151 0000000')).json()).toEqual({ error: 'invalid_phone' });
    expect((await start(anna.cookie, 'x'.repeat(40))).statusCode).toBe(400);
    expect((await verify(anna.cookie, NEW_PHONE, '12ab56')).statusCode).toBe(400);
    expect((await call(t, 'POST', '/account/phone/start', { body: { phone: NEW_PHONE } })).statusCode).toBe(401);
    const admin = await signInAdmin(t);
    expect((await start(admin, NEW_PHONE)).statusCode).toBe(403);

    for (let i = 1; i <= MAX_PHONE_CHANGE_CODES_PER_ACCOUNT; i += 1) {
      expect((await start(anna.cookie, `+49151000001${String(i).padStart(2, '0')}`)).statusCode).toBe(202);
    }
    expect((await start(anna.cookie, '+4915100000199')).json()).toEqual({ error: 'too_many_attempts' });
  });

  it('removes the phone only from an account that can still sign in with email and password', async () => {
    const phoneOnly = await signIn(t, '+4915100000001', 'customer', 'Sara');
    expect((await call(t, 'DELETE', '/account/phone', { cookie: phoneOnly })).json()).toEqual({ error: 'phone_needed_to_sign_in' });

    const anna = await emailCustomer();
    expect((await call(t, 'DELETE', '/account/phone', { cookie: anna.cookie })).json()).toEqual({ error: 'no_phone' });
    await start(anna.cookie, NEW_PHONE);
    await verify(anna.cookie, NEW_PHONE, lastCode(t, NEW_PHONE));
    const removed = await call(t, 'DELETE', '/account/phone', { cookie: anna.cookie });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().user.phone).toBeNull();
    expect((await log(anna.id)).map((entry) => entry.action)).toEqual(['phone_added', 'phone_removed']);
    expect((await accountNotices(anna.id)).at(-1)?.body).toContain('The phone number was removed from your MISK account');
  });
});
