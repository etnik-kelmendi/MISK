import type { FastifyInstance, FastifyRequest } from 'fastify';
import { currentUser } from '../auth/guard.js';
import type { AppContext } from '../context.js';
import { withTransaction, type Queryable } from '../db.js';
import { forbidden } from '../errors.js';
import type { NotificationKind } from './outbox.js';

/** The switches on the customer's Notifications page (D92), in the order shown there. */
export const TOPICS = ['booking_updates', 'pro_on_the_way', 'reminders', 'plan_changes', 'offers'] as const;
export type Topic = (typeof TOPICS)[number];
export type TopicSettings = Record<Topic, boolean>;

/** Every topic is on until the customer switches it off, except offers, which need their yes first. */
export const TOPIC_DEFAULTS: TopicSettings = {
  booking_updates: true,
  pro_on_the_way: true,
  reminders: true,
  plan_changes: true,
  offers: false,
};

/**
 * The customer messages each topic covers. A kind that is not listed is always sent: payments (a late
 * cancellation charge, extra work to approve, a payment to confirm), safety (a pro waiting at the door, a
 * cancelled job), the account and messages from the team. "Offers" has no kind yet: MISK sends no offers,
 * and the choice is kept for when it does.
 */
export const KIND_TOPIC: Partial<Record<NotificationKind, Topic>> = {
  booking_confirmed: 'booking_updates',
  pro_assigned: 'booking_updates',
  booking_rescheduled: 'booking_updates',
  booking_unassigned: 'booking_updates',
  job_completed: 'booking_updates',
  rating_request: 'booking_updates',
  pro_on_the_way: 'pro_on_the_way',
  booking_reminder: 'reminders',
  plan_pro_changed: 'plan_changes',
  plan_paused: 'plan_changes',
  plan_pause_called_off: 'plan_changes',
  visit_move_answered: 'plan_changes',
};

/** The topic a message belongs to, or null when it is always sent. */
export function topicOf(kind: NotificationKind): Topic | null {
  return KIND_TOPIC[kind] ?? null;
}

/** The switches on the pro's Notifications page (D100), in the order shown there. */
export const PRO_TOPICS = ['job_offers', 'offer_sound', 'schedule_changes', 'payouts', 'tips_news'] as const;
export type ProTopic = (typeof PRO_TOPICS)[number];
export type ProTopicSettings = Record<ProTopic, boolean>;

/** Everything is on until the pro switches it off, except tips and news from the team, which need their yes. */
export const PRO_TOPIC_DEFAULTS: ProTopicSettings = {
  job_offers: true,
  offer_sound: true,
  schedule_changes: true,
  payouts: true,
  tips_news: false,
};

/**
 * The pro messages each switch covers (D100). Switched off, the message still reaches Messages in the app, but not
 * push, text or email. Cancelled jobs, payments, safety, documents and the account always go out. "Offer sound" is
 * no message of its own: it decides how a job offer's push behaves (see dispatchOnce). "Tips and news" has no kind
 * yet: MISK sends no news, and the choice is kept for when it does.
 */
export const PRO_KIND_TOPIC: Partial<Record<NotificationKind, ProTopic>> = {
  job_offer: 'job_offers',
  visit_move_requested: 'schedule_changes',
  visit_move_withdrawn: 'schedule_changes',
  visit_skipped: 'schedule_changes',
  visit_unskipped: 'schedule_changes',
  plan_paused: 'schedule_changes',
  plan_pause_called_off: 'schedule_changes',
  payout_sent: 'payouts',
};

/** The pro switch a message belongs to, or null when it is always sent. */
export function proTopicOf(kind: NotificationKind): ProTopic | null {
  return PRO_KIND_TOPIC[kind] ?? null;
}

export async function loadProTopics(db: Queryable, userId: string): Promise<ProTopicSettings> {
  const result = await db.query<{ topic: ProTopic; enabled: boolean }>(
    'SELECT topic, enabled FROM user_notification_prefs WHERE user_id = $1 AND topic = ANY($2::text[])',
    [userId, [...PRO_TOPICS]],
  );
  const settings = { ...PRO_TOPIC_DEFAULTS };
  for (const row of result.rows) settings[row.topic] = row.enabled;
  return settings;
}

export async function loadTopics(db: Queryable, userId: string): Promise<TopicSettings> {
  const result = await db.query<{ topic: Topic; enabled: boolean }>(
    'SELECT topic, enabled FROM user_notification_prefs WHERE user_id = $1 AND topic = ANY($2::text[])',
    [userId, [...TOPICS]],
  );
  const settings = { ...TOPIC_DEFAULTS };
  for (const row of result.rows) settings[row.topic] = row.enabled;
  return settings;
}

const proTopicsBody = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: Object.fromEntries(PRO_TOPICS.map((topic) => [topic, { type: 'boolean' }])),
} as const;

async function saveTopics(db: Queryable, userId: string, changes: { topic: string; enabled: boolean }[]) {
  for (const { topic, enabled } of changes) {
    await db.query(
      `INSERT INTO user_notification_prefs (user_id, topic, enabled) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, topic) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
      [userId, topic, enabled],
    );
  }
}

const topicsBody = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: Object.fromEntries(TOPICS.map((topic) => [topic, { type: 'boolean' }])),
} as const;

/**
 * The customer's Notifications page (D92): which topics also go out by push, text and email. Only customers
 * have it: a pro's messages about jobs and plan visits are part of the work and always go out, and a pro
 * booking for themselves (D64) gets the same kinds of messages as a pro, so muting them would mute both.
 */
export async function notificationPreferenceRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards } = ctx;

  function customerId(request: FastifyRequest): string {
    const user = currentUser(request);
    if (user.role !== 'customer') throw forbidden();
    return user.id;
  }

  app.get('/account/notifications', { preHandler: guards.customer }, async (request) => ({
    topics: await loadTopics(pool, customerId(request)),
  }));

  app.patch<{ Body: Partial<TopicSettings> }>(
    '/account/notifications',
    { preHandler: guards.customer, schema: { body: topicsBody } },
    async (request) => {
      const userId = customerId(request);
      const changes = TOPICS.flatMap((topic) => {
        const enabled = request.body[topic];
        return enabled === undefined ? [] : [{ topic, enabled }];
      });
      const topics = await withTransaction(pool, async (client) => {
        await saveTopics(client, userId, changes);
        return loadTopics(client, userId);
      });
      request.log.info({ event: 'notification_topics_changed', changes });
      return { topics };
    },
  );

  // The pro's Notifications page (D100). A pro booking for themselves (D64) keeps getting their customer messages:
  // these switches only cover pro messages.
  app.get('/pro/notifications', { preHandler: guards.pro }, async (request) => ({
    topics: await loadProTopics(pool, currentUser(request).id),
  }));

  app.patch<{ Body: Partial<ProTopicSettings> }>(
    '/pro/notifications',
    { preHandler: guards.pro, schema: { body: proTopicsBody } },
    async (request) => {
      const userId = currentUser(request).id;
      const changes = PRO_TOPICS.flatMap((topic) => {
        const enabled = request.body[topic];
        return enabled === undefined ? [] : [{ topic, enabled }];
      });
      const topics = await withTransaction(pool, async (client) => {
        await saveTopics(client, userId, changes);
        return loadProTopics(client, userId);
      });
      request.log.info({ event: 'pro_notification_topics_changed', changes });
      return { topics };
    },
  );
}
