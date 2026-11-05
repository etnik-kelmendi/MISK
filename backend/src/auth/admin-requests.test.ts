import { call, createTestContext, resetDatabase, sessionCookie, type TestContext } from '../../test/helpers.js';
import { hashPassword } from './passwords.js';

const APP = 'http://localhost:5173';
const ADMIN = 'http://localhost:5174';
const PASSWORD = 'a long new admin password';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext({ ADMIN_ORIGIN: ADMIN });
});
afterAll(() => t.close());
beforeEach(async () => {
  await resetDatabase(t.pool);
  t.emails.length = 0;
});

const request = (body: Record<string, unknown> = {}, origin = ADMIN) =>
  call(t, 'POST', '/auth/admin/register', {
    origin,
    body: { firstName: 'Lina', lastName: 'Hoxha', email: 'lina@misk.test', password: PASSWORD, ...body },
  });
const login = (username: string, password = PASSWORD) =>
  call(t, 'POST', '/auth/admin/login', { origin: ADMIN, body: { username, password } });

/** An approved admin with an email, signed in on the control panel. */
async function ownerCookie() {
  await t.pool.query(`INSERT INTO users (username, email, password_hash, role) VALUES ('owner', 'owner@misk.test', $1, 'admin')`, [
    await hashPassword(PASSWORD),
  ]);
  return sessionCookie(await login('owner'), 'misk_admin_session');
}

describe('asking for an admin account', () => {
  it('creates a request that cannot sign in until an admin approves it', async () => {
    const created = await request();
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ status: 'pending_approval' });
    expect(created.cookies).toEqual([]);

    expect((await login('lina@misk.test')).json()).toEqual({ error: 'pending_approval' });
    expect((await login('lina@misk.test', 'a wrong long password')).json()).toEqual({ error: 'invalid_credentials' });
  });

  it('lets an admin approve it from the team list, after which the person signs in', async () => {
    await request();
    const owner = await ownerCookie();
    const team = (await call(t, 'GET', '/admin/team', { cookie: owner, origin: ADMIN })).json().admins as {
      id: string;
      email: string;
      pending: boolean;
      firstName: string;
    }[];
    const lina = team.find((a) => a.email === 'lina@misk.test');
    expect(lina).toMatchObject({ pending: true, firstName: 'Lina' });

    const approved = await call(t, 'POST', `/admin/team/${lina?.id}/approve`, { cookie: owner, origin: ADMIN });
    expect(approved.statusCode).toBe(200);
    const signedIn = await login('lina@misk.test');
    expect(signedIn.statusCode).toBe(200);
    expect(sessionCookie(signedIn, 'misk_admin_session')).toMatch(/^misk_admin_session=/);
    expect((await call(t, 'POST', `/admin/team/${lina?.id}/approve`, { cookie: owner, origin: ADMIN })).json()).toEqual({
      error: 'not_pending',
    });
  });

  it('lets an admin decline it, removing the account', async () => {
    await request();
    const owner = await ownerCookie();
    const id = (await t.pool.query<{ id: string }>("SELECT id FROM users WHERE email = 'lina@misk.test'")).rows[0]?.id;
    expect((await call(t, 'POST', `/admin/team/${id}/decline`, { cookie: owner, origin: ADMIN })).statusCode).toBe(204);
    expect((await login('lina@misk.test')).json()).toEqual({ error: 'invalid_credentials' });
    expect((await request()).statusCode).toBe(201);
  });

  it('emails the approved admins about the request', async () => {
    await ownerCookie();
    await request();
    expect(t.emails).toEqual([
      expect.objectContaining({ to: 'owner@misk.test', subject: 'New MISK admin account request' }),
    ]);
    expect(t.emails[0]?.text).toContain(`${ADMIN}/admin/settings/team`);
  });

  it('never gives a waiting request a password reset link', async () => {
    await request();
    await call(t, 'POST', '/auth/admin/forgot', { origin: ADMIN, body: { identifier: 'lina@misk.test' } });
    expect(t.emails.filter((e) => e.to === 'lina@misk.test')).toEqual([]);
  });

  it('refuses taken emails, short passwords, bad emails and the app site', async () => {
    await request();
    expect((await request()).json()).toEqual({ error: 'email_taken' });
    expect((await request({ email: 'other@misk.test', password: 'short' })).json()).toEqual({ error: 'password_too_short' });
    expect((await request({ email: 'not-an-email' })).json()).toEqual({ error: 'invalid_email' });
    expect((await request({ email: 'app@misk.test' }, APP)).json()).toEqual({ error: 'wrong_site' });
  });

  it('keeps approving and declining to admins', async () => {
    await request();
    const id = (await t.pool.query<{ id: string }>("SELECT id FROM users WHERE email = 'lina@misk.test'")).rows[0]?.id;
    expect((await call(t, 'POST', `/admin/team/${id}/approve`, { origin: ADMIN })).statusCode).toBe(401);
  });
});
