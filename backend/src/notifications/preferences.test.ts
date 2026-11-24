import { call, createTestContext, resetDatabase, signIn, type TestContext } from '../../test/helpers.js';
import { enqueue, type NotificationKind } from './outbox.js';
import { KIND_TOPIC, TOPIC_DEFAULTS, TOPICS } from './preferences.js';

/** D92: the customer's Notifications page and how the outbox keeps to it. */

let t: TestContext;
let customer: string;
let customerId: string;

beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());
beforeEach(async () => {
  await resetDatabase(t.pool);
  customer = await signIn(t, '+4915100000001', 'customer', 'Sara');
  customerId = (await call(t, 'GET', '/auth/me', { cookie: customer })).json().user.id as string;
});

const topics = (cookie = customer) => call(t, 'GET', '/account/notifications', { cookie });
const change = (body: unknown, cookie = customer) => call(t, 'PATCH', '/account/notifications', { cookie, body });

/** The channels a message of this kind was queued on for the person, and whether it reached their inbox. */
async function sent(userId: string, kind: NotificationKind) {
  await enqueue(t.pool, userId, kind, `A ${kind} message`);
  const channels = await t.pool.query<{ channel: string }>('SELECT channel FROM notifications WHERE user_id = $1 AND kind = $2 ORDER BY channel', [
    userId,
    kind,
  ]);
  const inbox = await t.pool.query('SELECT 1 FROM inbox WHERE user_id = $1 AND kind = $2', [userId, kind]);
  return { channels: channels.rows.map((row) => row.channel), inbox: inbox.rowCount };
}

describe('the Notifications page', () => {
  it('starts with every topic on except offers, and saves each switch', async () => {
    expect((await topics()).json()).toEqual({ topics: TOPIC_DEFAULTS });
    expect(TOPIC_DEFAULTS).toEqual({ booking_updates: true, pro_on_the_way: true, reminders: true, plan_changes: true, offers: false });

    const saved = await change({ reminders: false, offers: true });
    expect(saved.json()).toEqual({ topics: { ...TOPIC_DEFAULTS, reminders: false, offers: true } });
    expect((await change({ reminders: true })).json().topics.reminders).toBe(true);
    expect((await topics()).json().topics).toEqual({ ...TOPIC_DEFAULTS, offers: true });
  });

  it('refuses unknown topics, non-switches and empty changes', async () => {
    for (const body of [{}, { payments: false }, { reminders: 'no' }, { reminders: null }]) {
      expect((await change(body)).statusCode).toBe(400);
    }
    expect((await call(t, 'GET', '/account/notifications')).statusCode).toBe(401);
  });

  it('is for customers only', async () => {
    const pro = await signIn(t, '+4915100000002', 'pro', 'Daniel');
    expect((await topics(pro)).statusCode).toBe(403);
    expect((await change({ reminders: false }, pro)).statusCode).toBe(403);
  });
});

describe('sending with the switches', () => {
  it('sends a switched-off topic only to the inbox in the app', async () => {
    expect(await sent(customerId, 'booking_reminder')).toEqual({ channels: ['sms'], inbox: 1 });
    await change({ reminders: false, booking_updates: false, pro_on_the_way: false, plan_changes: false });
    for (const kind of ['booking_reminder', 'booking_confirmed', 'pro_on_the_way', 'plan_paused', 'visit_move_answered'] as const) {
      await t.pool.query('DELETE FROM notifications');
      await t.pool.query('DELETE FROM inbox');
      expect(await sent(customerId, kind)).toEqual({ channels: [], inbox: 1 });
    }
    // Switching it back on sends it again.
    await change({ reminders: true });
    await t.pool.query('DELETE FROM notifications');
    expect((await sent(customerId, 'booking_reminder')).channels).toEqual(['sms']);
  });

  it('always sends messages about payments, safety and the account', async () => {
    await change({ booking_updates: false, pro_on_the_way: false, reminders: false, plan_changes: false, offers: false });
    const always: NotificationKind[] = ['booking_cancelled', 'payment_action_needed', 'extra_requested', 'chat_message', 'account', 'team_message'];
    for (const kind of always) {
      expect(KIND_TOPIC[kind]).toBeUndefined();
      expect((await sent(customerId, kind)).channels).toEqual(['sms']);
    }
  });

  it('maps every customer topic but offers to at least one message, and only to known topics', () => {
    const mapped = new Set(Object.values(KIND_TOPIC));
    expect([...mapped].every((topic) => (TOPICS as readonly string[]).includes(topic))).toBe(true);
    expect(TOPICS.filter((topic) => !mapped.has(topic))).toEqual(['offers']);
  });

  it('leaves the messages of a pro alone, even one who switched topics off as a customer before', async () => {
    await change({ plan_changes: false });
    // The customer becomes a pro (D92): their old switches no longer mute anything.
    await call(t, 'POST', '/account/become-pro', { cookie: customer });
    expect((await sent(customerId, 'plan_paused')).channels).toEqual(['sms']);
  });
});
