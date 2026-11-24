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

export async function loadTopics(db: Queryable, userId: string): Promise<TopicSettings> {
  const result = await db.query<{ topic: Topic; enabled: boolean }>('SELECT topic, enabled FROM user_notification_prefs WHERE user_id = $1', [
    userId,
  ]);
  const settings = { ...TOPIC_DEFAULTS };
  for (const row of result.rows) settings[row.topic] = row.enabled;
  return settings;
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
        for (const { topic, enabled } of changes) {
          await client.query(
            `INSERT INTO user_notification_prefs (user_id, topic, enabled) VALUES ($1, $2, $3)
             ON CONFLICT (user_id, topic) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
            [userId, topic, enabled],
          );
        }
        return loadTopics(client, userId);
      });
      request.log.info({ event: 'notification_topics_changed', changes });
      return { topics };
    },
  );
}
