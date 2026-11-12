import type { FastifyBaseLogger } from 'fastify';
import type { Pool } from 'pg';
import type { Queryable } from '../db.js';
import type { EmailSender } from './email.js';
import { PushGoneError, type PushSender } from './push.js';
import type { SmsSender } from './sms.js';

export type NotificationKind =
  | 'job_offer'
  | 'booking_confirmed'
  | 'booking_reminder'
  | 'pro_assigned'
  | 'pro_on_the_way'
  | 'job_completed'
  | 'rating_request'
  | 'extra_requested'
  | 'booking_cancelled'
  | 'booking_rescheduled'
  | 'booking_unassigned'
  | 'application_reviewed'
  | 'pro_documents'
  | 'pro_account'
  | 'plan_pro_changed'
  | 'payout_sent'
  | 'waitlist_open'
  | 'admin_test';

export type Channel = 'push' | 'sms' | 'email';
export const CHANNELS: Channel[] = ['push', 'sms', 'email'];

/**
 * The messages whose channels the team chooses on the Settings page, in the order shown there, with who
 * receives them. Every other message goes by SMS, or by email to people without a phone.
 */
export const CONFIGURABLE = [
  { kind: 'booking_confirmed', audience: 'customer' },
  { kind: 'booking_reminder', audience: 'customer' },
  { kind: 'pro_on_the_way', audience: 'customer' },
  { kind: 'extra_requested', audience: 'customer' },
  { kind: 'job_completed', audience: 'customer' },
  { kind: 'rating_request', audience: 'customer' },
  { kind: 'job_offer', audience: 'pro' },
  { kind: 'payout_sent', audience: 'pro' },
] as const satisfies readonly { kind: NotificationKind; audience: 'customer' | 'pro' }[];
export type ConfigurableKind = (typeof CONFIGURABLE)[number]['kind'];

/** Email subjects; the text is the same as the SMS. */
const SUBJECTS: Partial<Record<NotificationKind, string>> = {
  booking_confirmed: 'Your MISK booking is confirmed',
  booking_reminder: 'Your MISK job is tomorrow',
  pro_on_the_way: 'Your MISK pro is on the way',
  extra_requested: 'Your pro asks to add extra work',
  job_completed: 'Your job is done: see the photos',
  rating_request: 'How was your MISK pro?',
  job_offer: 'New job offer on MISK',
  payout_sent: 'MISK sent you a payout',
  waitlist_open: 'MISK now serves your area',
  booking_cancelled: 'Your MISK booking was cancelled',
  booking_rescheduled: 'Your MISK booking has a new time',
};

export const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 20;
const RETRY_AFTER_SECONDS = 60;
// A message left "sending" this long was interrupted, e.g. by a restart, and is tried again.
const STUCK_AFTER_SECONDS = 300;
// One SMS segment holds 160 characters; longer texts are cut to four segments at most.
export const MAX_BODY_LENGTH = 640;

export function fitBody(body: string): string {
  return body.length <= MAX_BODY_LENGTH ? body : `${body.slice(0, MAX_BODY_LENGTH - 1)}…`;
}

export function subjectOf(kind: NotificationKind): string {
  return SUBJECTS[kind] ?? 'A message from MISK';
}

/**
 * Queues a message for one person on every channel chosen for it. Disabled people get none; a channel
 * the person cannot be reached on (no phone, no email, no push on any device) is skipped.
 * Customers and pros also get it in their inbox in the app.
 * Pass the transaction's client so the message is only sent if the change it reports is saved.
 * Returns true when at least one channel was queued.
 */
export async function enqueue(db: Queryable, userId: string, kind: NotificationKind, body: string): Promise<boolean> {
  const result = await db.query(
    `WITH person AS (
       SELECT id, phone, email FROM users WHERE id = $1 AND disabled_at IS NULL
     ), chosen AS (
       SELECT COALESCE(s.push, false) AS push,
              COALESCE(s.sms, (SELECT phone IS NOT NULL FROM person)) AS sms,
              COALESCE(s.email, (SELECT phone IS NULL FROM person)) AS email
       FROM (SELECT 1) one LEFT JOIN notification_settings s ON s.kind = $2
     )
     INSERT INTO notifications (user_id, channel, phone, email, subject, push_subscription_id, kind, body)
     SELECT p.id, 'sms', p.phone, NULL, NULL, NULL::uuid, $2, $3 FROM person p, chosen c WHERE c.sms AND p.phone IS NOT NULL
     UNION ALL
     SELECT p.id, 'email', NULL, p.email, $4, NULL::uuid, $2, $3 FROM person p, chosen c WHERE c.email AND p.email IS NOT NULL
     UNION ALL
     SELECT p.id, 'push', NULL, NULL, NULL, ps.id, $2, $3
     FROM person p JOIN push_subscriptions ps ON ps.user_id = p.id, chosen c WHERE c.push`,
    [userId, kind, fitBody(body), subjectOf(kind)],
  );
  // Customers and pros also find every message in the app (Messages), whatever the channels did.
  if (kind !== 'admin_test') {
    await db.query(
      `INSERT INTO inbox (user_id, kind, body)
       SELECT id, $2, $3 FROM users WHERE id = $1 AND disabled_at IS NULL AND role IS DISTINCT FROM 'admin'`,
      [userId, kind, fitBody(body)],
    );
  }
  return Boolean(result.rowCount);
}

export interface Senders {
  sms: SmsSender | null;
  email: EmailSender | null;
  push: PushSender | null;
}

interface OutboxRow {
  id: string;
  channel: Channel;
  phone: string | null;
  email: string | null;
  subject: string | null;
  body: string;
  endpoint: string | null;
  p256dh: string | null;
  auth: string | null;
}

/**
 * Sends the queued messages once. Rows are claimed with SKIP LOCKED, so several servers never send
 * the same message twice. A channel that is not set up marks its messages as not sent rather than
 * dropping them; a browser that no longer accepts push loses its subscription.
 */
export async function dispatchOnce(pool: Pool, senders: Senders, log: FastifyBaseLogger): Promise<number> {
  const { rows } = await pool.query<OutboxRow>(
    `WITH claimed AS (
       UPDATE notifications SET status = 'sending', attempts = attempts + 1, updated_at = now()
       WHERE id IN (
         SELECT id FROM notifications
         WHERE status = 'queued'
            OR (status = 'failed' AND attempts < $1
                AND updated_at < now() - make_interval(secs => $2))
            OR (status = 'sending' AND updated_at < now() - make_interval(secs => $3))
         ORDER BY created_at
         LIMIT $4
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, channel, phone, email, subject, body, push_subscription_id
     )
     SELECT c.id, c.channel, c.phone, c.email, c.subject, c.body, ps.endpoint, ps.p256dh, ps.auth
     FROM claimed c LEFT JOIN push_subscriptions ps ON ps.id = c.push_subscription_id`,
    [MAX_ATTEMPTS, RETRY_AFTER_SECONDS, STUCK_AFTER_SECONDS, BATCH_SIZE],
  );

  const finish = (id: string, status: 'sent' | 'not_configured', providerId: string | null = null) =>
    pool.query('UPDATE notifications SET status = $2, provider_id = $3, error = NULL, updated_at = now() WHERE id = $1', [
      id,
      status,
      providerId,
    ]);

  for (const row of rows) {
    try {
      if (row.channel === 'sms' && row.phone) {
        if (!senders.sms) {
          await finish(row.id, 'not_configured');
          continue;
        }
        const { providerId } = await senders.sms(row.phone, row.body);
        await finish(row.id, 'sent', providerId);
      } else if (row.channel === 'email' && row.email) {
        if (!senders.email) {
          await finish(row.id, 'not_configured');
          continue;
        }
        await senders.email({ to: row.email, subject: row.subject ?? subjectOf('admin_test'), text: row.body });
        await finish(row.id, 'sent');
      } else if (row.channel === 'push' && row.endpoint && row.p256dh && row.auth) {
        if (!senders.push) {
          await finish(row.id, 'not_configured');
          continue;
        }
        await senders.push({ endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth }, { title: 'MISK', body: row.body });
        await finish(row.id, 'sent');
      } else {
        throw new Error(`Message has no ${row.channel} address`);
      }
    } catch (error) {
      if (error instanceof PushGoneError) {
        // Deleting the subscription also removes its queued messages.
        await pool.query(
          'DELETE FROM push_subscriptions WHERE id = (SELECT push_subscription_id FROM notifications WHERE id = $1)',
          [row.id],
        );
        log.info({ event: 'push_subscription_ended', notificationId: row.id });
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      log.warn({ event: `${row.channel}_failed`, notificationId: row.id, error: message });
      await pool.query(`UPDATE notifications SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [
        row.id,
        message.slice(0, 500),
      ]);
    }
  }
  return rows.length;
}
