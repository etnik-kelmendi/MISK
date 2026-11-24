import type { FastifyBaseLogger } from 'fastify';
import { call, createTestContext, resetDatabase, signInAdmin, type TestContext } from '../../test/helpers.js';
import { alertSupport } from '../bookings/on-site.js';
import { issueAlertsEmailable, missingSettingsWarning, setupChecklist } from './setup.js';

const NOTHING = { support: { email: null, phone: null }, smtp: null, twilio: null, push: null, stripe: null };
const EVERYTHING = {
  support: { email: 'help@example.com', phone: '+4930123456' },
  smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'mailer', password: 'smtp-secret-value', from: 'MISK <no-reply@example.com>' },
  twilio: { accountSid: 'AC123', authToken: 'twilio-secret-value', from: '+4915112345678' },
  push: { publicKey: 'p'.repeat(87), privateKey: 'k'.repeat(43), subject: 'mailto:ops@example.com' },
  stripe: { secretKey: 'sk_test_secret-value', publishableKey: 'pk_test_x', webhookSecret: 'whsec_secret-value' },
};

describe('the setup checklist and the missing-settings warning (D98)', () => {
  it('says which optional settings are set, yes or no only', () => {
    expect(setupChecklist(NOTHING)).toEqual([
      { key: 'support_email', set: false },
      { key: 'support_phone', set: false },
      { key: 'email_sender', set: false },
      { key: 'sms_sender', set: false },
      { key: 'push', set: false },
      { key: 'stripe_webhook', set: false },
    ]);
    expect(setupChecklist(EVERYTHING).every((item) => item.set)).toBe(true);
    expect(JSON.stringify(setupChecklist(EVERYTHING))).not.toMatch(/secret|help@example\.com|\+49/);
  });

  it('logs one warning naming each missing setting and what it affects, never a value', () => {
    expect(missingSettingsWarning(EVERYTHING)).toBeNull();
    const warning = missingSettingsWarning({ ...EVERYTHING, support: { email: null, phone: '+4930123456' }, twilio: null }) ?? '';
    expect(warning.split('\n')).toEqual([
      'Optional settings are missing; set them before going live:',
      expect.stringMatching(/^- SUPPORT_EMAIL: the "Email us" contact buttons are hidden/),
      expect.stringMatching(/^- TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER: no text is sent/),
    ]);
    const all = missingSettingsWarning(NOTHING) ?? '';
    expect(all).toContain('SMTP_HOST, SMTP_USER, SMTP_PASSWORD, MAIL_FROM: no email is sent');
    expect(all).toContain('STRIPE_WEBHOOK_SECRET: payments and plan sign-ups are never confirmed');
    expect(all).toContain('SUPPORT_PHONE: the "Call us" contact buttons are hidden');
    expect(all).not.toMatch(/secret-value/);
  });
});

describe('the Setup checklist endpoint and support alerts (D98)', () => {
  let t: TestContext;
  let admin: string;
  const fakeLog = () => ({ error: vi.fn() }) as unknown as FastifyBaseLogger & { error: ReturnType<typeof vi.fn> };
  const alert = (supportEmail: string | null, log = fakeLog()) =>
    alertSupport(t.pool, { bookingNumber: 'MS-1001', reason: 'unsafe', address: 'Linden Street 4' }, { supportEmail, log });
  const emailsQueued = async () =>
    (
      await t.pool.query<{ user_id: string | null; email: string; subject: string }>(
        "SELECT user_id, email, subject FROM notifications WHERE kind = 'support_alert' AND channel = 'email' ORDER BY created_at",
      )
    ).rows;

  beforeAll(async () => {
    t = await createTestContext();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await resetDatabase(t.pool);
    admin = await signInAdmin(t);
  });

  it('shows full admins which settings are set and whether issue alerts can be emailed', async () => {
    const response = await call(t, 'GET', '/admin/team/setup', { cookie: admin });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.checklist).toEqual(setupChecklist(t.config));
    expect(body.issueAlertsEmailable).toBe(false);

    await t.pool.query("UPDATE users SET email = 'team@example.com' WHERE username = 'admin'");
    expect((await call(t, 'GET', '/admin/team/setup', { cookie: admin })).json().issueAlertsEmailable).toBe(true);
    expect(await issueAlertsEmailable(t.pool, null)).toBe(true);

    // Only the Team & access area may see it.
    const support = await signInAdmin(t, 'support-member');
    await t.pool.query("UPDATE users SET admin_role = 'support' WHERE username = 'support-member'");
    expect((await call(t, 'GET', '/admin/team/setup', { cookie: support })).statusCode).toBe(403);
  });

  it('counts SUPPORT_EMAIL as a way to email issue alerts', async () => {
    expect(await issueAlertsEmailable(t.pool, null)).toBe(false);
    expect(await issueAlertsEmailable(t.pool, 'help@example.com')).toBe(true);
  });

  it('emails every team member with an address, and nobody else', async () => {
    await t.pool.query("UPDATE users SET email = 'team@example.com' WHERE username = 'admin'");
    const log = fakeLog();
    expect(await alert('help@example.com', log)).toBe(1);
    expect(await emailsQueued()).toEqual([
      { user_id: expect.any(String), email: 'team@example.com', subject: 'MISK support: a pro needs help on site' },
    ]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('falls back to SUPPORT_EMAIL when no team member has an email address', async () => {
    const log = fakeLog();
    expect(await alert('help@example.com', log)).toBe(1);
    expect(await emailsQueued()).toEqual([{ user_id: null, email: 'help@example.com', subject: 'MISK support: a pro needs help on site' }]);
    const body = (await t.pool.query<{ body: string }>("SELECT body FROM notifications WHERE user_id IS NULL")).rows[0]?.body;
    expect(body).toContain('MS-1001');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('logs an error when the alert reached nobody by email', async () => {
    const log = fakeLog();
    expect(await alert(null, log)).toBe(0);
    expect(await emailsQueued()).toEqual([]);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ event: 'support_alert_not_emailed', bookingNumber: 'MS-1001' }));
  });
});
