import { ADMIN_PASSWORD, call, createTestContext, resetDatabase, signIn, signInAdmin, type TestContext } from '../../test/helpers.js';
import { resetAdminPasswordByUsername } from './admin-accounts.js';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(() => resetDatabase(t.pool));

const NEW_PASSWORD = 'a brand new long password';
const login = (username: string, password: string) =>
  call(t, 'POST', '/auth/admin/login', { body: { username, password } });

describe('admin team', () => {
  it('lets an admin add another admin, who can then sign in', async () => {
    const admin = await signInAdmin(t);
    const created = await call(t, 'POST', '/admin/team', { cookie: admin, body: { username: ' Elion ', password: NEW_PASSWORD } });
    expect(created.statusCode).toBe(201);
    expect(created.json().admin).toMatchObject({ username: 'elion', disabled: false });
    expect((await login('elion', NEW_PASSWORD)).statusCode).toBe(200);

    const list = await call(t, 'GET', '/admin/team', { cookie: admin });
    expect(list.json().admins.map((a: { username: string }) => a.username)).toEqual(['admin', 'elion']);
    expect(list.body).not.toContain('password');
  });

  it('lets an admin log in with their email as well as their username', async () => {
    const admin = await signInAdmin(t);
    await call(t, 'POST', '/admin/team', {
      cookie: admin,
      body: { username: 'robin', password: NEW_PASSWORD, email: 'robin@example.com' },
    });
    expect((await login('Robin@Example.com', NEW_PASSWORD)).statusCode).toBe(200);
    expect((await login('robin', NEW_PASSWORD)).statusCode).toBe(200);
    expect((await login('robin@example.com', 'a wrong long password')).statusCode).toBe(401);
  });

  it('refuses short passwords and taken usernames', async () => {
    const admin = await signInAdmin(t);
    expect((await call(t, 'POST', '/admin/team', { cookie: admin, body: { username: 'x1y', password: 'short' } })).statusCode).toBe(400);
    const taken = await call(t, 'POST', '/admin/team', { cookie: admin, body: { username: 'ADMIN', password: NEW_PASSWORD } });
    expect(taken.json()).toEqual({ error: 'username_taken' });
    const spaced = await call(t, 'POST', '/admin/team', { cookie: admin, body: { username: 'two words', password: NEW_PASSWORD } });
    expect(spaced.json()).toEqual({ error: 'invalid_username' });
  });

  it('keeps the team to admins', async () => {
    const customer = await signIn(t, '+4915100000001', 'customer');
    expect((await call(t, 'GET', '/admin/team', { cookie: customer })).statusCode).toBe(403);
    expect((await call(t, 'POST', '/admin/team', { body: { username: 'eve', password: NEW_PASSWORD } })).statusCode).toBe(401);
  });
});

describe('password recovery by email', () => {
  const EMAIL = 'elion.thaqi@canera.ch';
  const tokenFrom = (text: string) => text.match(/#token=([A-Za-z0-9_-]+)/)?.[1] ?? '';

  async function adminWithEmail() {
    const owner = await signInAdmin(t, 'owner');
    const created = await call(t, 'POST', '/admin/team', {
      cookie: owner,
      body: { username: 'elion', password: NEW_PASSWORD, email: ' Elion.Thaqi@Canera.ch ' },
    });
    expect(created.json().admin.email).toBe(EMAIL);
    return owner;
  }

  beforeEach(() => {
    t.emails.length = 0;
  });

  it('emails a single-use link that sets a new password', async () => {
    await adminWithEmail();
    const forgot = await call(t, 'POST', '/auth/admin/forgot', { body: { identifier: EMAIL } });
    expect(forgot.statusCode).toBe(202);
    expect(t.emails).toHaveLength(1);
    expect(t.emails[0]).toMatchObject({ to: EMAIL, subject: 'Reset your MISK admin password' });
    expect(t.emails[0]?.text).toContain('http://localhost:5173/admin/reset-password#token=');
    const token = tokenFrom(t.emails[0]?.text ?? '');

    const reset = await call(t, 'POST', '/auth/admin/reset', { body: { token, password: 'my fresh new password' } });
    expect(reset.statusCode).toBe(204);
    expect((await login('elion', 'my fresh new password')).statusCode).toBe(200);
    expect((await login('elion', NEW_PASSWORD)).statusCode).toBe(401);
    const again = await call(t, 'POST', '/auth/admin/reset', { body: { token, password: 'another new password' } });
    expect(again.json()).toEqual({ error: 'invalid_reset_link' });
  });

  it('also finds the account by username, and only the newest link works', async () => {
    await adminWithEmail();
    await call(t, 'POST', '/auth/admin/forgot', { body: { identifier: 'ELION' } });
    await call(t, 'POST', '/auth/admin/forgot', { body: { identifier: EMAIL } });
    const [first, second] = t.emails.map((e) => tokenFrom(e.text));
    expect((await call(t, 'POST', '/auth/admin/reset', { body: { token: first, password: 'my fresh new password' } })).statusCode).toBe(400);
    expect((await call(t, 'POST', '/auth/admin/reset', { body: { token: second, password: 'my fresh new password' } })).statusCode).toBe(204);
  });

  it('expires links after 30 minutes', async () => {
    await adminWithEmail();
    await call(t, 'POST', '/auth/admin/forgot', { body: { identifier: EMAIL } });
    await t.pool.query("UPDATE password_resets SET expires_at = now() - interval '1 second'");
    const reset = await call(t, 'POST', '/auth/admin/reset', {
      body: { token: tokenFrom(t.emails[0]?.text ?? ''), password: 'my fresh new password' },
    });
    expect(reset.json()).toEqual({ error: 'invalid_reset_link' });
  });

  it('answers the same for unknown accounts and accounts without an email, and sends nothing', async () => {
    await signInAdmin(t, 'noemail');
    for (const identifier of ['nobody@example.com', 'noemail']) {
      const response = await call(t, 'POST', '/auth/admin/forgot', { body: { identifier } });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({});
    }
    expect(t.emails).toHaveLength(0);
  });

  it('limits how often a link can be requested', async () => {
    await adminWithEmail();
    for (let i = 0; i < 3; i += 1) {
      expect((await call(t, 'POST', '/auth/admin/forgot', { body: { identifier: EMAIL } })).statusCode).toBe(202);
    }
    expect((await call(t, 'POST', '/auth/admin/forgot', { body: { identifier: EMAIL } })).statusCode).toBe(429);
    expect(t.emails).toHaveLength(3);
  });

  it('refuses short passwords and made-up links', async () => {
    await adminWithEmail();
    await call(t, 'POST', '/auth/admin/forgot', { body: { identifier: EMAIL } });
    const token = tokenFrom(t.emails[0]?.text ?? '');
    expect((await call(t, 'POST', '/auth/admin/reset', { body: { token, password: 'short' } })).statusCode).toBe(400);
    const fake = await call(t, 'POST', '/auth/admin/reset', { body: { token: 'x'.repeat(43), password: NEW_PASSWORD } });
    expect(fake.json()).toEqual({ error: 'invalid_reset_link' });
  });
});

describe('a teammate’s email and password', () => {
  it('cannot be changed by another teammate from the control panel (D51)', async () => {
    const owner = await signInAdmin(t, 'owner');
    const other = await signInAdmin(t, 'other');
    const team = (await call(t, 'GET', '/admin/team', { cookie: owner })).json().admins as { id: string; username: string }[];
    const id = team.find((a) => a.username === 'other')?.id;

    expect((await call(t, 'POST', `/admin/team/${id}/password`, { cookie: owner, body: { password: NEW_PASSWORD } })).statusCode).toBe(404);
    expect((await call(t, 'PATCH', `/admin/team/${id}`, { cookie: owner, body: { email: 'other@misk.app' } })).statusCode).toBe(404);
    // Nothing changed: the teammate keeps their password, session and (no) email.
    expect((await call(t, 'GET', '/auth/me', { cookie: other })).statusCode).toBe(200);
    expect((await login('other', ADMIN_PASSWORD)).statusCode).toBe(200);
    const row = await t.pool.query<{ email: string | null }>('SELECT email FROM users WHERE id = $1', [id]);
    expect(row.rows[0]?.email).toBeNull();
  });
});

describe('forgotten admin passwords', () => {
  it('resets from the server command when no admin can sign in', async () => {
    await signInAdmin(t, 'solo');
    await resetAdminPasswordByUsername(t.pool, 'SOLO', NEW_PASSWORD);
    expect((await login('solo', NEW_PASSWORD)).statusCode).toBe(200);
    await expect(resetAdminPasswordByUsername(t.pool, 'nobody', NEW_PASSWORD)).rejects.toThrow('no admin');
    await expect(resetAdminPasswordByUsername(t.pool, 'solo', 'short')).rejects.toThrow();
  });
});
