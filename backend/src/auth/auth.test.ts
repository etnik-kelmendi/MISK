import { ADMIN_PASSWORD, call, createTestContext, lastCode, resetDatabase, sessionCookie, signIn, signInAdmin, type TestContext } from '../../test/helpers.js';
import { createFirstAdmin } from './first-admin.js';
import { FAILED_LOGIN_DELAY_MS } from './passwords.js';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(async () => {
  await resetDatabase(t.pool);
  t.texts.length = 0;
});

const PHONE = '+4915112345678';

describe('phone sign-in', () => {
  it('texts a 6-digit code and signs a new person in without a role', async () => {
    const start = await call(t, 'POST', '/auth/phone/start', { body: { phone: '+49 151 1234-5678' } });
    expect(start.statusCode).toBe(202);
    expect(start.json()).toEqual({ phone: PHONE });
    expect(t.texts[0]?.to).toBe(PHONE);

    const verify = await call(t, 'POST', '/auth/phone/verify', { body: { phone: PHONE, code: lastCode(t, PHONE) } });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().user).toMatchObject({ phone: PHONE, role: null });
    const me = await call(t, 'GET', '/auth/me', { cookie: sessionCookie(verify) });
    expect(me.json().user.phone).toBe(PHONE);
  });

  it('refuses numbers without a country code', async () => {
    const response = await call(t, 'POST', '/auth/phone/start', { body: { phone: '0151 12345678' } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_phone' });
  });

  it('refuses a wrong code, and kills the code after five wrong guesses', async () => {
    await call(t, 'POST', '/auth/phone/start', { body: { phone: PHONE } });
    const code = lastCode(t, PHONE);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) {
      const response = await call(t, 'POST', '/auth/phone/verify', { body: { phone: PHONE, code: wrong } });
      expect(response.json()).toEqual({ error: 'invalid_code' });
    }
    const late = await call(t, 'POST', '/auth/phone/verify', { body: { phone: PHONE, code } });
    expect(late.statusCode).toBe(429);
  });

  it('accepts each code only once and only the newest code', async () => {
    await call(t, 'POST', '/auth/phone/start', { body: { phone: PHONE } });
    const first = lastCode(t, PHONE);
    await call(t, 'POST', '/auth/phone/start', { body: { phone: PHONE } });
    const second = lastCode(t, PHONE);
    if (first !== second) {
      const old = await call(t, 'POST', '/auth/phone/verify', { body: { phone: PHONE, code: first } });
      expect(old.statusCode).toBe(401);
    }
    expect((await call(t, 'POST', '/auth/phone/verify', { body: { phone: PHONE, code: second } })).statusCode).toBe(200);
    expect((await call(t, 'POST', '/auth/phone/verify', { body: { phone: PHONE, code: second } })).statusCode).toBe(401);
  });

  it('expires codes', async () => {
    await call(t, 'POST', '/auth/phone/start', { body: { phone: PHONE } });
    await t.pool.query("UPDATE sign_in_codes SET expires_at = now() - interval '1 second'");
    const response = await call(t, 'POST', '/auth/phone/verify', { body: { phone: PHONE, code: lastCode(t, PHONE) } });
    expect(response.statusCode).toBe(401);
  });

  it('limits how many codes one number can request', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await call(t, 'POST', '/auth/phone/start', { body: { phone: PHONE } })).statusCode).toBe(202);
    }
    const limited = await call(t, 'POST', '/auth/phone/start', { body: { phone: PHONE } });
    expect(limited.statusCode).toBe(429);
    expect(t.texts).toHaveLength(3);
  });

  it('turns away disabled accounts', async () => {
    await signIn(t, PHONE, 'customer');
    await t.pool.query('UPDATE users SET disabled_at = now() WHERE phone = $1', [PHONE]);
    await t.pool.query('DELETE FROM login_attempts');
    await call(t, 'POST', '/auth/phone/start', { body: { phone: PHONE } });
    const response = await call(t, 'POST', '/auth/phone/verify', { body: { phone: PHONE, code: lastCode(t, PHONE) } });
    expect(response.statusCode).toBe(403);
  });
});

describe('roles', () => {
  it('lets a new person choose a role once, and a pro gets a draft application', async () => {
    const cookie = await signIn(t, PHONE);
    const chosen = await call(t, 'POST', '/account/role', { cookie, body: { role: 'pro', firstName: ' Daniel ' } });
    expect(chosen.json().user).toMatchObject({ role: 'pro', firstName: 'Daniel' });
    const profile = await call(t, 'GET', '/pro/profile', { cookie });
    expect(profile.json().profile.status).toBe('draft');

    const again = await call(t, 'POST', '/account/role', { cookie, body: { role: 'customer', firstName: 'D' } });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'role_already_chosen' });
  });

  it('never lets anyone choose the admin role', async () => {
    const cookie = await signIn(t, PHONE);
    const response = await call(t, 'POST', '/account/role', { cookie, body: { role: 'admin', firstName: 'Eve' } });
    expect(response.statusCode).toBe(400);
  });

  it('keeps each area to its own role', async () => {
    const customer = await signIn(t, PHONE, 'customer');
    const pro = await signIn(t, '+4915199999999', 'pro');
    expect((await call(t, 'GET', '/pro/profile', { cookie: customer })).statusCode).toBe(403);
    expect((await call(t, 'GET', '/bookings', { cookie: pro })).statusCode).toBe(403);
    expect((await call(t, 'GET', '/admin/pros', { cookie: customer })).statusCode).toBe(403);
    expect((await call(t, 'GET', '/admin/pros')).statusCode).toBe(401);
  });
});

describe('admin sign-in', () => {
  it('signs admins in with username and password, never locks them out, and slows down wrong passwords', async () => {
    const cookie = await signInAdmin(t);
    expect((await call(t, 'GET', '/admin/pros', { cookie })).statusCode).toBe(200);
    for (let i = 0; i < 7; i += 1) {
      const started = Date.now();
      const wrong = await call(t, 'POST', '/auth/admin/login', { body: { username: 'admin', password: 'wrong password' } });
      expect(wrong.statusCode).toBe(401);
      expect(Date.now() - started).toBeGreaterThanOrEqual(FAILED_LOGIN_DELAY_MS - 50);
    }
    const right = await call(t, 'POST', '/auth/admin/login', { body: { username: 'admin', password: ADMIN_PASSWORD } });
    expect(right.statusCode).toBe(200);
  }, 30_000);

  it('creates the first admin only once', async () => {
    await createFirstAdmin(t.pool, 'Owner', 'a long enough password');
    await expect(createFirstAdmin(t.pool, 'second', 'a long enough password')).rejects.toThrow('already exists');
    await expect(createFirstAdmin(t.pool, 'x', 'short')).rejects.toThrow();
  });
});

describe('sessions', () => {
  it('ends the session on logout', async () => {
    const cookie = await signIn(t, PHONE, 'customer');
    expect((await call(t, 'POST', '/auth/logout', { cookie })).statusCode).toBe(204);
    expect((await call(t, 'GET', '/auth/me', { cookie })).statusCode).toBe(401);
  });

  it('refuses writes from other origins', async () => {
    const response = await t.app.inject({
      method: 'POST',
      url: '/auth/phone/start',
      headers: { origin: 'https://evil.example' },
      payload: { phone: PHONE },
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects unknown fields instead of ignoring them', async () => {
    const response = await call(t, 'POST', '/auth/phone/start', { body: { phone: PHONE, admin: true } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'validation_failed' });
  });
});
