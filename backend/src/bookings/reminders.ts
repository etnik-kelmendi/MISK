import { formatSlot, messages } from '../notifications/messages.js';
import { enqueue } from '../notifications/outbox.js';
import type { BookingDeps } from './events.js';

/** The evening reminder goes out from this hour (market time) the day before the job. */
export const REMINDER_HOUR = 18;
/** Customers are asked for a rating this long after the job is done, if they have not rated yet. */
export const RATING_REQUEST_HOURS = 2;
/** After this, a missing rating is no longer asked for. */
const RATING_REQUEST_MAX_DAYS = 7;

/**
 * From 18:00 market time, reminds customers of tomorrow's jobs. Each booking is claimed in the database
 * first, so a reminder goes out once even with several servers. Returns how many were sent.
 */
export async function reminderTick(deps: BookingDeps): Promise<number> {
  const due = await deps.pool.query<{ id: string; customer_id: string; service_name: string; starts_at: Date }>(
    `UPDATE bookings b SET reminder_sent_at = now()
     WHERE b.status IN ('searching', 'accepted') AND b.reminder_sent_at IS NULL
       AND extract(hour FROM now() AT TIME ZONE $1) >= $2
       AND (b.starts_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date + 1
     RETURNING b.id, b.customer_id, b.service_name, b.starts_at`,
    [deps.config.timezone, REMINDER_HOUR],
  );
  for (const booking of due.rows) {
    await enqueue(
      deps.pool,
      booking.customer_id,
      'booking_reminder',
      messages.bookingReminder(booking.service_name, formatSlot(booking.starts_at, deps.config.timezone)),
    );
  }
  return due.rowCount ?? 0;
}

/** Asks customers to rate a job a couple of hours after it is done, once. Returns how many were asked. */
export async function ratingRequestTick(deps: BookingDeps): Promise<number> {
  const due = await deps.pool.query<{ customer_id: string; pro_name: string | null }>(
    `UPDATE bookings b SET rating_requested_at = now()
     FROM users pu
     WHERE pu.id = b.pro_id AND b.status = 'completed' AND b.rating_requested_at IS NULL
       AND b.completed_at < now() - make_interval(hours => $1)
       AND b.completed_at > now() - make_interval(days => $2)
       AND NOT EXISTS (SELECT 1 FROM ratings r WHERE r.booking_id = b.id)
     RETURNING b.customer_id, pu.first_name AS pro_name`,
    [RATING_REQUEST_HOURS, RATING_REQUEST_MAX_DAYS],
  );
  for (const booking of due.rows) {
    await enqueue(deps.pool, booking.customer_id, 'rating_request', messages.ratingRequest(booking.pro_name ?? 'your pro'));
  }
  return due.rowCount ?? 0;
}
