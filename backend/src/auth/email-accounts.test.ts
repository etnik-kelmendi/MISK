import { call, createTestContext, resetDatabase, sessionCookie, type TestContext } from '../../test/helpers.js';
import { passwordProblems } from './email-accounts.js';
import { FAILED_LOGIN_DELAY_MS } from './passwords.js';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(() => resetDatabase(t.pool));

const valid = { firstName: 'Sara', lastName: 'Meier', email: 'sara@example.com', password: 'garden42', acceptTerms: true };
const register = (body: Record<string, unknown>) => call(t, 'POST', '/auth/register', { body });

describe('password rules', () => {
  it('needs 8 characters, a letter and a number', () => {
    expect(passwordProblems('garden42')).toEqual([]);
    expect(passwordProblems('g4')).toEqual(['length']);
    expect(passwordProblems('12345678')).toEqual(['letter']);
    expect(passwordProblems('gardening')).toEqual(['number']);
    expect(passwordProblems('')).toEqual(['length', 'letter', 'number']);
  });
});

describe('registration', () => {
  it('creates the account, signs the person in, and records when they accepted the terms', async () => {
    const response = await register({ ...valid, email: ' Sara@Example.com ' });
    expect(response.statusCode).toBe(201);
    expect(response.json().user).toMatchObject({ email: 'sara@example.com', firstName: 'Sara', lastName: 'Meier', role: null, phone: null });
    const me = await call(t, 'GET', '/auth/me', { cookie: sessionCookie(response) });
    expect(me.json().user.email).toBe('sara@example.com');
    const stored = await t.pool.query('SELECT password_hash, terms_accepted_at FROM users');
    expect(stored.rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(stored.rows[0].terms_accepted_at).not.toBeNull();
  });

  it('lets the new account choose to be a customer, like phone sign-up', async () => {
    const cookie = sessionCookie(await register(valid));
    const chosen = await call(t, 'POST', '/account/role', { cookie, body: { role: 'customer', firstName: 'Sara' } });
    expect(chosen.json().user).toMatchObject({ role: 'customer', email: 'sara@example.com' });
  });

  it('says when the email is already registered', async () => {
    await register(valid);
    const again = await register({ ...valid, email: 'SARA@example.com', firstName: 'Other' });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'email_taken' });
  });

  it('refuses invalid emails, weak passwords and unaccepted terms', async () => {
    expect((await register({ ...valid, email: 'sara@example' })).json()).toEqual({ error: 'invalid_email' });
    expect((await register({ ...valid, password: 'gardening' })).json()).toEqual({ error: 'weak_password' });
    expect((await register({ ...valid, password: '1234567' })).json()).toEqual({ error: 'weak_password' });
    expect((await register({ ...valid, acceptTerms: false })).json()).toEqual({ error: 'terms_not_accepted' });
  });

  it('refuses empty and missing fields', async () => {
    expect((await register({ ...valid, firstName: '   ' })).statusCode).toBe(400);
    const { lastName: _omit, ...withoutLastName } = valid;
    void _omit;
    expect((await register(withoutLastName)).statusCode).toBe(400);
  });
});

describe('email log-in', () => {
  it('signs in with email and password, and refuses a wrong password', async () => {
    await register(valid);
    const ok = await call(t, 'POST', '/auth/login', { body: { email: 'SARA@example.com', password: 'garden42' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.email).toBe('sara@example.com');
    const wrong = await call(t, 'POST', '/auth/login', { body: { email: 'sara@example.com', password: 'garden43' } });
    expect(wrong.json()).toEqual({ error: 'invalid_login' });
    const unknown = await call(t, 'POST', '/auth/login', { body: { email: 'nobody@example.com', password: 'garden42' } });
    expect(unknown.json()).toEqual({ error: 'invalid_login' });
  });

  it('never locks an account, however many wrong passwords, but answers them slowly', async () => {
    await register(valid);
    for (let i = 0; i < 7; i += 1) {
      const started = Date.now();
      const wrong = await call(t, 'POST', '/auth/login', { body: { email: 'sara@example.com', password: 'wrong123' } });
      expect(wrong.json()).toEqual({ error: 'invalid_login' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(FAILED_LOGIN_DELAY_MS - 50);
    }
    const right = await call(t, 'POST', '/auth/login', { body: { email: 'sara@example.com', password: 'garden42' } });
    expect(right.statusCode).toBe(200);
  }, 30_000);

  it('never lets an admin in through the customer log-in', async () => {
    await t.pool.query(
      `INSERT INTO users (username, email, password_hash, role)
       SELECT 'boss', 'boss@misk.app', password_hash, 'admin' FROM (SELECT $1::text AS password_hash) p`,
      ['$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA'],
    );
    const response = await call(t, 'POST', '/auth/login', { body: { email: 'boss@misk.app', password: 'anything1' } });
    expect(response.json()).toEqual({ error: 'invalid_login' });
  });
});
