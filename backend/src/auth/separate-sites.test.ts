import { ADMIN_PASSWORD, call, createTestContext, lastCode, resetDatabase, sessionCookie, type TestContext } from '../../test/helpers.js';
import { hashPassword } from './passwords.js';

const APP = 'http://localhost:5173';
const ADMIN = 'http://localhost:5174';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext({ ADMIN_ORIGIN: ADMIN });
});
afterAll(() => t.close());
beforeEach(async () => {
  await resetDatabase(t.pool);
  await t.pool.query(`INSERT INTO users (username, email, password_hash, role) VALUES ('admin', 'admin@misk.test', $1, 'admin')`, [
    await hashPassword(ADMIN_PASSWORD),
  ]);
});

const adminLogin = (origin: string) =>
  call(t, 'POST', '/auth/admin/login', { origin, body: { username: 'admin', password: ADMIN_PASSWORD } });

async function customerLogin(origin = APP) {
  const phone = '+4915100000001';
  await call(t, 'POST', '/auth/phone/start', { origin, body: { phone } });
  return call(t, 'POST', '/auth/phone/verify', { origin, body: { phone, code: lastCode(t, phone) } });
}

describe('admin panel as its own website', () => {
  it('signs admins in only on the admin site, with their own cookie', async () => {
    const fromApp = await adminLogin(APP);
    expect(fromApp.statusCode).toBe(403);
    expect(fromApp.json()).toEqual({ error: 'wrong_site' });

    const fromAdmin = await adminLogin(ADMIN);
    expect(fromAdmin.statusCode).toBe(200);
    expect(fromAdmin.cookies.map((c) => c.name)).toEqual(['misk_admin_session']);
    const cookie = sessionCookie(fromAdmin, 'misk_admin_session');
    expect((await call(t, 'GET', '/admin/pros', { origin: ADMIN, cookie })).statusCode).toBe(200);
  });

  it('signs customers and pros in only on the app', async () => {
    const start = await call(t, 'POST', '/auth/phone/start', { origin: ADMIN, body: { phone: '+4915100000001' } });
    expect(start.json()).toEqual({ error: 'wrong_site' });
    const register = await call(t, 'POST', '/auth/register', {
      origin: ADMIN,
      body: { firstName: 'Sara', lastName: 'M', email: 'sara@example.com', password: 'garden42', acceptTerms: true },
    });
    expect(register.json()).toEqual({ error: 'wrong_site' });
    const app = await customerLogin(APP);
    expect(app.cookies.map((c) => c.name)).toEqual(['misk_session']);
  });

  it('never lets a session from one site count on the other', async () => {
    const admin = sessionCookie(await adminLogin(ADMIN), 'misk_admin_session');
    const customer = sessionCookie(await customerLogin());
    const both = `${admin}; ${customer}`;

    const onApp = await call(t, 'GET', '/auth/me', { origin: APP, cookie: both });
    expect(onApp.json().user.role).toBeNull();
    const onAdmin = await call(t, 'GET', '/auth/me', { origin: ADMIN, cookie: both });
    expect(onAdmin.json().user.username).toBe('admin');

    // An admin cookie sent from the app site is ignored there.
    expect((await call(t, 'GET', '/admin/pros', { origin: APP, cookie: admin })).statusCode).toBe(401);
  });

  it('signs out only the site you sign out of', async () => {
    const admin = sessionCookie(await adminLogin(ADMIN), 'misk_admin_session');
    const customer = sessionCookie(await customerLogin());
    const both = `${admin}; ${customer}`;
    await call(t, 'POST', '/auth/logout', { origin: APP, cookie: both });
    expect((await call(t, 'GET', '/auth/me', { origin: APP, cookie: customer })).statusCode).toBe(401);
    expect((await call(t, 'GET', '/auth/me', { origin: ADMIN, cookie: admin })).statusCode).toBe(200);
  });

  it('accepts writes and browser calls from both sites, and nothing else', async () => {
    const response = await t.app.inject({
      method: 'OPTIONS',
      url: '/auth/admin/login',
      headers: { origin: ADMIN, 'access-control-request-method': 'POST' },
    });
    expect(response.headers['access-control-allow-origin']).toBe(ADMIN);
    const other = await call(t, 'POST', '/auth/admin/login', {
      origin: 'https://evil.example',
      body: { username: 'admin', password: ADMIN_PASSWORD },
    });
    expect(other.statusCode).toBe(403);
  });

  it('sends password reset links to the admin site', async () => {
    t.emails.length = 0;
    await call(t, 'POST', '/auth/admin/forgot', { origin: ADMIN, body: { identifier: 'admin@misk.test' } });
    expect(t.emails[0]?.text).toContain(`${ADMIN}/admin/reset-password#token=`);
    const fromApp = await call(t, 'POST', '/auth/admin/forgot', { origin: APP, body: { identifier: 'admin@misk.test' } });
    expect(fromApp.json()).toEqual({ error: 'wrong_site' });
  });
});
