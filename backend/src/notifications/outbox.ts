import type { FastifyBaseLogger } from 'fastify';
import type { Pool } from 'pg';
import type { Queryable } from '../db.js';
import type { SmsSender } from './sms.js';

export type NotificationKind =
  | 'job_offer'
  | 'booking_confirmed'
  | 'pro_assigned'
  | 'pro_on_the_way'
  | 'job_completed'
  | 'extra_requested'
  | 'booking_cancelled'
  | 'booking_rescheduled'
  | 'booking_unassigned'
  | 'application_reviewed';

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

/**
 * Queues a message for one person. Disabled people and people without a phone get none.
 * Pass the transaction's client so the message is only sent if the change it reports is saved.
 */
export async function enqueue(db: Queryable, userId: string, kind: NotificationKind, body: string): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO notifications (user_id, phone, kind, body)
     SELECT id, phone, $2, $3 FROM users WHERE id = $1 AND disabled_at IS NULL AND phone IS NOT NULL`,
    [userId, kind, fitBody(body)],
  );
  return Boolean(result.rowCount);
}

/**
 * Sends the queued messages once. Rows are claimed with SKIP LOCKED, so several servers never send
 * the same message twice. Without a sender, messages are marked as not sent rather than dropped.
 */
export async function dispatchOnce(
  pool: Pool,
  sender: SmsSender | null,
  log: FastifyBaseLogger,
): Promise<number> {
  const { rows } = await pool.query<{ id: string; phone: string; body: string }>(
    `UPDATE notifications SET status = 'sending', attempts = attempts + 1, updated_at = now()
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
     RETURNING id, phone, body`,
    [MAX_ATTEMPTS, RETRY_AFTER_SECONDS, STUCK_AFTER_SECONDS, BATCH_SIZE],
  );

  for (const row of rows) {
    if (!sender) {
      await pool.query(
        `UPDATE notifications SET status = 'not_configured', updated_at = now() WHERE id = $1`,
        [row.id],
      );
      continue;
    }
    try {
      const { providerId } = await sender(row.phone, row.body);
      await pool.query(
        `UPDATE notifications SET status = 'sent', provider_id = $2, error = NULL, updated_at = now()
         WHERE id = $1`,
        [row.id, providerId],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn({ event: 'sms_failed', notificationId: row.id, error: message });
      await pool.query(
        `UPDATE notifications SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
        [row.id, message.slice(0, 500)],
      );
    }
  }
  return rows.length;
}
