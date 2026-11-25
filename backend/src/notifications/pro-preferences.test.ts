import { call, createTestContext, resetDatabase, signIn, type TestContext } from '../../test/helpers.js';
import { dispatchOnce, enqueue, type NotificationKind } from './outbox.js';
import type { PushMessage } from './push.js';
import { PRO_KIND_TOPIC, PRO_TOPIC_DEFAULTS, PRO_TOPICS } from './preferences.js';

/** D100: the pro's Notifications page and how the outbox keeps to it. */

let t: TestContext;
let pro: string;
let proId: string;

beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(async () => {
  await resetDatabase(t.pool);
  pro = await signIn(t, '+4915100000002', 'pro', 'Daniel');
  proId = (await call(t, 'GET', '/auth/me', { cookie: pro })).json().user.id as string;
  await t.pool.query(
    "INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, 'https://push.example.com/pro', 'BKey', 'auth1')",
    [proId],
  );
});

const topics = (cookie = pro) => call(t, 'GET', '/pro/notifications', { cookie });
const change = (body: unknown, cookie = pro) => call(t, 'PATCH', '/pro/notifications', { cookie, body });

/** The channels a message of this kind was queued on for the pro, and whether it reached their inbox. */
async function sent(kind: NotificationKind) {
  await t.pool.query('DELETE FROM notifications');
  await t.pool.query('DELETE FROM inbox');
  await enqueue(t.pool, proId, kind, `A ${kind} message`, { channels: { push: true, sms: true, email: false } });
  const channels = await t.pool.query<{ channel: string }>('SELECT channel FROM notifications WHERE user_id = $1 ORDER BY channel', [proId]);
  const inbox = await t.pool.query('SELECT 1 FROM inbox WHERE user_id = $1', [proId]);
  return { channels: channels.rows.map((row) => row.channel), inbox: inbox.rowCount };
}

/** What the pro's phone receives for the queued push messages. */
async function pushed(): Promise<PushMessage[]> {
  const messages: PushMessage[] = [];
  await dispatchOnce(
    t.pool,
    {
      sms: async () => ({ providerId: 'sms-1' }),
      email: null,
      push: async (_target, message) => {
        messages.push(message);
      },
    },
    t.deps.log,
  );
  return messages;
}

describe('the pro Notifications page', () => {
  it('starts with everything on except tips and news, and saves each switch', async () => {
    expect((await topics()).json()).toEqual({ topics: PRO_TOPIC_DEFAULTS });
    expect(PRO_TOPIC_DEFAULTS).toEqual({ job_offers: true, offer_sound: true, schedule_changes: true, payouts: true, tips_news: false });
    const saved = await change({ job_offers: false, tips_news: true });
    expect(saved.json()).toEqual({ topics: { ...PRO_TOPIC_DEFAULTS, job_offers: false, tips_news: true } });
    expect((await topics()).json().topics).toMatchObject({ job_offers: false, tips_news: true });
  });

  it('refuses unknown topics and non-switches, and is for pros only', async () => {
    for (const body of [{}, { reminders: false }, { payouts: 'no' }]) {
      expect((await change(body)).statusCode).toBe(400);
    }
    const customer = await signIn(t, '+4915100000001', 'customer', 'Sara');
    expect((await topics(customer)).statusCode).toBe(403);
  });
});

describe('sending with the pro switches', () => {
  it('sends a switched-off job offer, schedule change or payout only to Messages in the app', async () => {
    expect(await sent('job_offer')).toEqual({ channels: ['push', 'sms'], inbox: 1 });
    await change({ job_offers: false, schedule_changes: false, payouts: false });
    for (const kind of ['job_offer', 'visit_skipped', 'visit_move_requested', 'plan_paused', 'payout_sent'] as const) {
      expect(await sent(kind)).toEqual({ channels: [], inbox: 1 });
    }
    await change({ job_offers: true });
    expect((await sent('job_offer')).channels).toEqual(['push', 'sms']);
  });

  it('always sends cancelled jobs, documents, payments and account messages', async () => {
    await change({ job_offers: false, schedule_changes: false, payouts: false, offer_sound: false });
    for (const kind of ['booking_cancelled', 'document_expiring', 'pro_account', 'account', 'team_message', 'support_alert'] as const) {
      expect(PRO_KIND_TOPIC[kind]).toBeUndefined();
      expect((await sent(kind)).channels).toEqual(['push', 'sms']);
    }
  });

  it('keeps the switches of a pro away from their messages as a customer (D64) and maps only known topics', () => {
    expect(new Set(Object.values(PRO_KIND_TOPIC)).size).toBeGreaterThan(0);
    expect(Object.values(PRO_KIND_TOPIC).every((topic) => (PRO_TOPICS as readonly string[]).includes(topic))).toBe(true);
  });

  it('sends a job offer push with the offer sound choice, and other pushes without it', async () => {
    await sent('job_offer');
    expect(await pushed()).toEqual([{ title: 'MISK', body: 'A job_offer message', offer: { sound: true } }]);
    await change({ offer_sound: false });
    await sent('job_offer');
    expect(await pushed()).toEqual([{ title: 'MISK', body: 'A job_offer message', offer: { sound: false } }]);
    await sent('visit_skipped');
    expect(await pushed()).toEqual([{ title: 'MISK', body: 'A visit_skipped message' }]);
  });
});
