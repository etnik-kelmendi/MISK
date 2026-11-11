import { call, createTestContext, resetDatabase, sessionCookie, type TestContext } from '../../test/helpers.js';
import { passwordProblems } from './email-accounts.js';
import { FAILED_LOGIN_DELAY_MS } from './passwords.js';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(async () => {
  await resetDatabase(t.pool);
  t.emails.length = 0;
});

const valid = { firstName: 'Sara', lastName: 'Meier', email: 'sara@example.com', password: 'garden42', acceptTerms: true };
const register = (body: Record<string, unknown>) => call(t, 'POST', '/auth/register', { body });
const login = (email = 'sara@example.com', password = 'garden42') => call(t, 'POST', '/auth/login', { body: { email, password } });

/** The token in the newest confirmation link emailed to this address. */
function linkToken(to = 'sara@example.com'): string {
  const email = [...t.emails].reverse().find((e) => e.to === to);
  const token = email?.text.match(/\/verify-email#token=([\w-]+)/)?.[1];
  if (!token) {
    throw new Error(`No confirmation link was emailed to ${to}`);
  }
  return token;
}

const verify = (token: string) => call(t, 'POST', '/auth/verify-email', { body: { token } });

/** Registers and opens the emailed link, which signs the person in. */
async function registerAndVerify(body: Record<string, unknown> = valid) {
  expect((await register(body)).statusCode).toBe(201);
  return verify(linkToken(String(body.email).trim().toLowerCase()));
}

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
  it('creates the account without signing in, records the terms, and emails a confirmation link', async () => {
    const response = await register({ ...valid, email: ' Sara@Example.com ' });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ status: 'verification_sent', email: 'sara@example.com' });
    expect(response.cookies).toEqual([]);
    const stored = await t.pool.query('SELECT password_hash, terms_accepted_at, email_verified_at FROM users');
    expect(stored.rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(stored.rows[0].terms_accepted_at).not.toBeNull();
    expect(stored.rows[0].email_verified_at).toBeNull();

    const email = t.emails.at(-1);
    expect(email).toMatchObject({ to: 'sara@example.com', subject: 'Confirm your email for MISK' });
    expect(email?.text).toContain('Hello Sara,');
    expect(email?.text).toContain('http://localhost:5173/verify-email#token=');
    // Only a hash of the token is stored.
    const tokens = await t.pool.query<{ token_hash: Buffer }>('SELECT token_hash FROM email_verifications');
    expect(tokens.rows[0]?.token_hash.toString('base64url')).not.toBe(linkToken());
  });

  it('confirms the email once from the link, signs the person in, and lets them choose to be a customer', async () => {
    await register(valid);
    const token = linkToken();
    const verified = await verify(token);
    expect(verified.statusCode).toBe(200);
    expect(verified.json().user).toMatchObject({
      email: 'sara@example.com',
      firstName: 'Sara',
      lastName: 'Meier',
      role: null,
      phone: null,
    });
    const cookie = sessionCookie(verified);
    expect((await call(t, 'GET', '/auth/me', { cookie })).json().user.email).toBe('sara@example.com');
    const chosen = await call(t, 'POST', '/account/role', { cookie, body: { role: 'customer', firstName: 'Sara' } });
    expect(chosen.json().user).toMatchObject({ role: 'customer', email: 'sara@example.com' });

    expect((await verify(token)).json()).toEqual({ error: 'invalid_verification_link' });
    expect((await verify('x'.repeat(43))).json()).toEqual({ error: 'invalid_verification_link' });
  });

  it('refuses an expired link', async () => {
    await register(valid);
    await t.pool.query("UPDATE email_verifications SET expires_at = now() - interval '1 second'");
    expect((await verify(linkToken())).json()).toEqual({ error: 'invalid_verification_link' });
    expect((await login()).json()).toEqual({ error: 'email_not_verified' });
  });

  it('sends a new link on request, which replaces the old one, and answers the same for unknown emails', async () => {
    await register(valid);
    const first = linkToken();
    const resent = await call(t, 'POST', '/auth/verify-email/resend', { body: { email: 'SARA@example.com' } });
    expect(resent.statusCode).toBe(202);
    const second = linkToken();
    expect(second).not.toBe(first);
    expect((await verify(first)).json()).toEqual({ error: 'invalid_verification_link' });
    expect((await verify(second)).statusCode).toBe(200);

    const sent = t.emails.length;
    const unknown = await call(t, 'POST', '/auth/verify-email/resend', { body: { email: 'nobody@example.com' } });
    expect(unknown.statusCode).toBe(202);
    // Already confirmed: nothing more is sent either.
    expect((await call(t, 'POST', '/auth/verify-email/resend', { body: { email: 'sara@example.com' } })).statusCode).toBe(202);
    expect(t.emails.length).toBe(sent);
    expect((await call(t, 'POST', '/auth/verify-email/resend', { body: { email: 'sara@example' } })).json()).toEqual({
      error: 'invalid_email',
    });
  });

  it('limits how often a link can be sent again', async () => {
    await register(valid);
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await call(t, 'POST', '/auth/verify-email/resend', { body: { email: 'sara@example.com' } })).statusCode);
    }
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
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
    expect((await register(withoutLastName)).json()).toEqual({ error: 'validation_failed', field: 'lastName' });
    expect((await register({ ...valid, firstName: '   ' })).json()).toEqual({ error: 'validation_failed', field: 'firstName' });
    expect((await register({ ...valid, email: 'x'.repeat(300) })).json()).toEqual({ error: 'validation_failed', field: 'email' });
  });
});

describe('email log-in', () => {
  it('refuses to sign in until the email is confirmed, and only says so after the right password', async () => {
    await register(valid);
    const unverified = await login();
    expect(unverified.statusCode).toBe(403);
    expect(unverified.json()).toEqual({ error: 'email_not_verified' });
    expect(unverified.cookies).toEqual([]);
    expect((await login('sara@example.com', 'garden43')).json()).toEqual({ error: 'invalid_login' });
    await verify(linkToken());
    expect((await login()).statusCode).toBe(200);
  });

  it('signs in with email and password, and refuses a wrong password', async () => {
    await registerAndVerify();
    const ok = await call(t, 'POST', '/auth/login', { body: { email: 'SARA@example.com', password: 'garden42' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.email).toBe('sara@example.com');
    const wrong = await call(t, 'POST', '/auth/login', { body: { email: 'sara@example.com', password: 'garden43' } });
    expect(wrong.json()).toEqual({ error: 'invalid_login' });
    const unknown = await call(t, 'POST', '/auth/login', { body: { email: 'nobody@example.com', password: 'garden42' } });
    expect(unknown.json()).toEqual({ error: 'invalid_login' });
  });

  it('never locks an account, however many wrong passwords, but answers them slowly', async () => {
    await registerAndVerify();
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
