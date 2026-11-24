import { call, createTestContext, resetDatabase, sessionCookie, signIn, signInAdmin, type TestContext } from '../../test/helpers.js';
import { MAX_EMAIL_CHANGES_PER_ACCOUNT } from './email-change.js';
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

async function emailCustomer(email = 'anna@example.com') {
  const created = await t.pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, first_name, role, email_verified_at, terms_accepted_at)
     VALUES ($1, $2, 'Anna', 'customer', now(), now()) RETURNING id`,
    [email, await hashPassword(PASSWORD)],
  );
  const login = await call(t, 'POST', '/auth/login', { body: { email, password: PASSWORD } });
  return { id: created.rows[0]?.id ?? '', cookie: sessionCookie(login) };
}

const start = (cookie: string, body: Record<string, unknown>) => call(t, 'POST', '/account/email/start', { cookie, body });
const confirm = (token: string, cookie?: string) => call(t, 'POST', '/account/email/confirm', { body: { token }, ...(cookie ? { cookie } : {}) });
const emailOf = async (id: string) => (await t.pool.query<{ email: string | null }>('SELECT email FROM users WHERE id = $1', [id])).rows[0]?.email;
const log = async (id: string) =>
  (await t.pool.query<{ action: string; admin_id: string | null; details: unknown }>('SELECT action, admin_id, details FROM user_admin_actions WHERE user_id = $1 ORDER BY id', [id])).rows;
const notices = async (id: string) =>
  (await t.pool.query<{ channel: string; email: string | null; phone: string | null; body: string }>(
    "SELECT channel, email, phone, body FROM notifications WHERE user_id = $1 AND kind = 'account' ORDER BY created_at, id",
    [id],
  )).rows;

/** The token from the newest link sent to the address. */
function tokenSentTo(address: string): string {
  const message = [...t.emails].reverse().find((sent) => sent.to === address);
  const token = message?.text.match(/#token=([A-Za-z0-9_-]+)/)?.[1];
  if (!token) throw new Error(`No link was sent to ${address}`);
  return token;
}

describe('changing the email of an account (D97)', () => {
  it('needs the password, sends a link to the new address and tells the old one, and changes only on confirming', async () => {
    const anna = await emailCustomer();
    expect((await call(t, 'GET', '/account/email', { cookie: anna.cookie })).json()).toEqual({
      email: 'anna@example.com',
      hasPassword: true,
      pending: null,
    });

    expect((await start(anna.cookie, { email: 'new@example.com' })).json()).toEqual({ error: 'password_required' });
    const wrong = await start(anna.cookie, { email: 'new@example.com', password: 'wrong-one-1' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toEqual({ error: 'wrong_password' });
    expect(t.emails).toEqual([]);

    const started = await start(anna.cookie, { email: '  New@Example.com ', password: PASSWORD });
    expect(started.statusCode).toBe(202);
    expect(started.json().pending).toMatchObject({ email: 'new@example.com' });
    expect(t.emails.map((sent) => sent.to)).toEqual(['new@example.com']);
    expect(t.emails[0]?.subject).toBe('Confirm your new email for MISK');
    // Nothing changes yet; the old address hears about it, with the new one masked.
    expect(await emailOf(anna.id)).toBe('anna@example.com');
    expect(await notices(anna.id)).toEqual([
      expect.objectContaining({ channel: 'email', email: 'anna@example.com', body: expect.stringContaining('being changed to n***@example.com') as unknown }),
    ]);
    expect((await notices(anna.id))[0]?.body).not.toContain('new@example.com');
    expect((await call(t, 'GET', '/account/email', { cookie: anna.cookie })).json().pending).toMatchObject({ email: 'new@example.com' });

    const token = tokenSentTo('new@example.com');
    const confirmed = await confirm(token);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toEqual({ email: 'new@example.com' });
    expect(await emailOf(anna.id)).toBe('new@example.com');
    // The link works once.
    expect((await confirm(token)).json()).toEqual({ error: 'invalid_email_change_link' });

    // The session stays; the new email is the login now, the old one no longer is.
    expect((await call(t, 'GET', '/auth/me', { cookie: anna.cookie })).json().user.email).toBe('new@example.com');
    expect((await call(t, 'POST', '/auth/login', { body: { email: 'new@example.com', password: PASSWORD } })).statusCode).toBe(200);
    expect((await call(t, 'POST', '/auth/login', { body: { email: 'anna@example.com', password: PASSWORD } })).statusCode).toBe(401);

    // The old address is told it changed; the log has no addresses and is the person's own change.
    const all = await notices(anna.id);
    expect(all[1]).toMatchObject({ channel: 'email', email: 'anna@example.com' });
    expect(all[1]?.body).toContain('now n***@example.com');
    expect(await log(anna.id)).toEqual([{ action: 'email_changed', admin_id: null, details: {} }]);
    expect((await call(t, 'GET', '/account/email', { cookie: anna.cookie })).json().pending).toBeNull();

    // The Users page shows the new email; the team's activity feed does not list the person's own change.
    const admin = await signInAdmin(t);
    const users = (await call(t, 'GET', '/admin/users?q=new%40example', { cookie: admin })).json().users as { id: string; email: string }[];
    expect(users).toEqual([expect.objectContaining({ id: anna.id, email: 'new@example.com' })]);
    const feed = (await call(t, 'GET', '/admin/activity', { cookie: admin })).json().activity as { action: string }[];
    expect(feed.some((entry) => entry.action.startsWith('user_email'))).toBe(false);
  });

  it('refuses a malformed or unchanged address', async () => {
    const anna = await emailCustomer();
    expect((await start(anna.cookie, { email: 'not-an-email', password: PASSWORD })).json()).toEqual({ error: 'invalid_email' });
    expect((await start(anna.cookie, { email: 'a'.repeat(250) + '@example.com', password: PASSWORD })).statusCode).toBe(400);
    const same = await start(anna.cookie, { email: 'ANNA@example.com', password: PASSWORD });
    expect(same.statusCode).toBe(409);
    expect(same.json()).toEqual({ error: 'email_unchanged' });
  });

  it('answers the same for an address another account uses, and refuses it on confirming', async () => {
    const anna = await emailCustomer();
    await emailCustomer('ben@example.com');
    const started = await start(anna.cookie, { email: 'ben@example.com', password: PASSWORD });
    expect(started.statusCode).toBe(202);
    expect(started.json().pending).toMatchObject({ email: 'ben@example.com' });
    const taken = await confirm(tokenSentTo('ben@example.com'));
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ error: 'email_taken' });
    expect(await emailOf(anna.id)).toBe('anna@example.com');
    expect(await log(anna.id)).toEqual([]);
  });

  it('refuses an expired link, and a link replaced by a newer one', async () => {
    const anna = await emailCustomer();
    await start(anna.cookie, { email: 'new@example.com', password: PASSWORD });
    const first = tokenSentTo('new@example.com');
    const resent = await call(t, 'POST', '/account/email/resend', { cookie: anna.cookie });
    expect(resent.statusCode).toBe(202);
    const second = tokenSentTo('new@example.com');
    expect(second).not.toBe(first);
    expect((await confirm(first)).json()).toEqual({ error: 'invalid_email_change_link' });

    await t.pool.query("UPDATE email_changes SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [anna.id]);
    const expired = await confirm(second);
    expect(expired.statusCode).toBe(400);
    expect(expired.json()).toEqual({ error: 'invalid_email_change_link' });
    expect(await emailOf(anna.id)).toBe('anna@example.com');
    // Nothing is waiting any more, so there is nothing to send again.
    expect((await call(t, 'POST', '/account/email/resend', { cookie: anna.cookie })).json()).toEqual({ error: 'no_email_change' });
  });

  it('cancels a waiting change', async () => {
    const anna = await emailCustomer();
    await start(anna.cookie, { email: 'new@example.com', password: PASSWORD });
    const token = tokenSentTo('new@example.com');
    expect((await call(t, 'DELETE', '/account/email/pending', { cookie: anna.cookie })).statusCode).toBe(204);
    expect((await call(t, 'GET', '/account/email', { cookie: anna.cookie })).json().pending).toBeNull();
    expect((await confirm(token)).json()).toEqual({ error: 'invalid_email_change_link' });
  });

  it('limits the links per account', async () => {
    const anna = await emailCustomer();
    for (let i = 0; i < MAX_EMAIL_CHANGES_PER_ACCOUNT; i += 1) {
      expect((await start(anna.cookie, { email: `new${i}@example.com`, password: PASSWORD })).statusCode).toBe(202);
    }
    const limited = await start(anna.cookie, { email: 'one-more@example.com', password: PASSWORD });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: 'too_many_attempts' });
    // Wrong passwords count too, so the limit also stops guessing the password.
    expect((await start(anna.cookie, { email: 'one-more@example.com', password: 'guess-123' })).statusCode).toBe(429);
  });

  it('lets a phone account add an email without a password, told by text', async () => {
    const cookie = await signIn(t, '+4915100000001', 'customer', 'Sara');
    const id = (await call(t, 'GET', '/auth/me', { cookie })).json().user.id as string;
    expect((await call(t, 'GET', '/account/email', { cookie })).json()).toEqual({ email: null, hasPassword: false, pending: null });
    expect((await start(cookie, { email: 'sara@example.com' })).statusCode).toBe(202);
    expect(await notices(id)).toEqual([expect.objectContaining({ channel: 'sms', phone: '+4915100000001' })]);
    expect((await confirm(tokenSentTo('sara@example.com'))).json()).toEqual({ email: 'sara@example.com' });
    expect(await emailOf(id)).toBe('sara@example.com');
    expect(await log(id)).toEqual([{ action: 'email_added', admin_id: null, details: {} }]);
  });

  it('is not for team accounts or signed-out visitors', async () => {
    const admin = await signInAdmin(t);
    expect((await start(admin, { email: 'new@example.com' })).statusCode).toBe(403);
    expect((await call(t, 'POST', '/account/email/start', { body: { email: 'new@example.com' } })).statusCode).toBe(401);
  });
});
