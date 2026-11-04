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

describe('forgotten admin passwords', () => {
  it('lets one admin set a new password for another, signing them out and lifting a lockout', async () => {
    const owner = await signInAdmin(t, 'owner');
    const forgetful = await signInAdmin(t, 'forgetful');
    for (let i = 0; i < 6; i += 1) {
      await login('forgetful', 'wrong guess');
    }
    expect((await login('forgetful', ADMIN_PASSWORD)).statusCode).toBe(429);

    const team = (await call(t, 'GET', '/admin/team', { cookie: owner })).json().admins as { id: string; username: string }[];
    const id = team.find((a) => a.username === 'forgetful')?.id;
    const reset = await call(t, 'POST', `/admin/team/${id}/password`, { cookie: owner, body: { password: NEW_PASSWORD } });
    expect(reset.statusCode).toBe(204);

    expect((await call(t, 'GET', '/auth/me', { cookie: forgetful })).statusCode).toBe(401);
    expect((await call(t, 'GET', '/auth/me', { cookie: owner })).statusCode).toBe(200);
    expect((await login('forgetful', ADMIN_PASSWORD)).statusCode).toBe(401);
    expect((await login('forgetful', NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('keeps the caller signed in when they change their own password', async () => {
    const owner = await signInAdmin(t, 'owner');
    const id = (await call(t, 'GET', '/auth/me', { cookie: owner })).json().user.id;
    await call(t, 'POST', `/admin/team/${id}/password`, { cookie: owner, body: { password: NEW_PASSWORD } });
    expect((await call(t, 'GET', '/auth/me', { cookie: owner })).statusCode).toBe(200);
  });

  it('never resets a customer or pro through the admin route', async () => {
    const owner = await signInAdmin(t);
    await signIn(t, '+4915100000001', 'customer');
    const customer = await t.pool.query<{ id: string }>("SELECT id FROM users WHERE role = 'customer'");
    const response = await call(t, 'POST', `/admin/team/${customer.rows[0]?.id}/password`, {
      cookie: owner,
      body: { password: NEW_PASSWORD },
    });
    expect(response.statusCode).toBe(404);
  });

  it('resets from the server command when no admin can sign in', async () => {
    await signInAdmin(t, 'solo');
    await resetAdminPasswordByUsername(t.pool, 'SOLO', NEW_PASSWORD);
    expect((await login('solo', NEW_PASSWORD)).statusCode).toBe(200);
    await expect(resetAdminPasswordByUsername(t.pool, 'nobody', NEW_PASSWORD)).rejects.toThrow('no admin');
    await expect(resetAdminPasswordByUsername(t.pool, 'solo', 'short')).rejects.toThrow();
  });
});
