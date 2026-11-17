import { onlyRow, withTransaction } from '../db.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { isExclusionViolation } from '../http.js';
import { proShareCents } from '../catalogue/pricing.js';
import { formatDay, formatSlot, messages } from '../notifications/messages.js';
import { enqueue } from '../notifications/outbox.js';
import { eligibleProFilter, SLOT_STEP_MINUTES } from './availability.js';
import { setStatus, type BookingDeps } from './events.js';

export const OFFER_MINUTES = 15;
/** Rating assumed for a pro with no ratings yet, so new pros are offered work between good and great pros. */
export const NEW_PRO_RATING = 4.5;

interface DispatchRow {
  id: string;
  status: string;
  category_id: string;
  postcode: string;
  starts_at: Date;
  ends_at: Date;
  service_name: string;
  price_cents: number;
  pro_share_pct: number;
  customer_id: string;
  started: boolean;
  /** Set for a flexible booking whose pro has not picked the time yet (D70). */
  flexible_window: string | null;
  confirm_by: Date | null;
  duration_minutes: number;
}

/**
 * SQL for the possible starts of a flexible booking: every slot start from its window start, two hours
 * apart, that still ends by the window end. `b` is the alias of the bookings row, `dur` the visit length.
 */
export function flexibleStarts(starts: string, ends: string, dur: string): string {
  return `generate_series(${starts}, ${ends} - make_interval(mins => ${dur}), make_interval(mins => ${SLOT_STEP_MINUTES}))`;
}

/**
 * Offers a searching booking to the best free pro who has not seen it yet: highest rating first, then
 * the fewest jobs this week, then the shortest distance. With nobody left, or once the start time has
 * passed, the booking becomes unassigned for the admins. Safe to call at any time and repeatedly.
 */
export async function offerNext(deps: BookingDeps, bookingId: string): Promise<'offered' | 'unassigned' | 'skipped'> {
  return withTransaction(deps.pool, async (client) => {
    const found = await client.query<DispatchRow>(
      `SELECT id, status, category_id, postcode, starts_at, ends_at, service_name, price_cents, pro_share_pct,
         customer_id,
         CASE WHEN flexible_window IS NOT NULL AND time_confirmed_at IS NULL THEN flexible_window END AS flexible_window,
         confirm_by,
         COALESCE((SELECT sum(duration_minutes)::int FROM booking_services bs WHERE bs.booking_id = bookings.id),
           (extract(epoch FROM ends_at - starts_at) / 60)::int) AS duration_minutes,
         CASE WHEN flexible_window IS NOT NULL AND time_confirmed_at IS NULL THEN confirm_by <= now()
           ELSE starts_at <= now() END AS started
       FROM bookings WHERE id = $1 FOR UPDATE`,
      [bookingId],
    );
    const booking = found.rows[0];
    if (!booking || booking.status !== 'searching') {
      return 'skipped';
    }
    const pending = await client.query("SELECT 1 FROM booking_offers WHERE booking_id = $1 AND status = 'pending'", [
      bookingId,
    ]);
    if (pending.rowCount) {
      return 'skipped';
    }

    const next = booking.started
      ? { rows: [] }
      : await client.query<{ user_id: string }>(
          `SELECT p.user_id FROM pro_profiles p
           WHERE ${
             booking.flexible_window
               ? // A flexible job goes to pros free at one of its possible starts at least.
                 `p.user_id IS NOT NULL AND EXISTS (SELECT 1 FROM ${flexibleStarts('$3::timestamptz', '$4::timestamptz', '$9::int')} AS st
                   WHERE ${eligibleProFilter('$1', '$2', 'st', 'st + make_interval(mins => $9::int)', '$5', '$8::uuid', '$6::uuid')})`
               : eligibleProFilter('$1', '$2', '$3', '$4', '$5', '$8::uuid')
           }
             AND NOT EXISTS (SELECT 1 FROM booking_offers o WHERE o.booking_id = $6 AND o.pro_id = p.user_id)
           ORDER BY
             COALESCE((SELECT avg(stars) FROM ratings r WHERE r.pro_id = p.user_id), $7) DESC,
             (SELECT count(*) FROM bookings d WHERE d.pro_id = p.user_id AND d.status = 'completed'
                AND d.completed_at > now() - interval '7 days') ASC,
             (SELECT distance_km(home.lat, home.lng, dest.lat, dest.lng) FROM postcodes home, postcodes dest
              WHERE home.code = p.home_postcode AND dest.code = $2) ASC,
             p.user_id
           LIMIT 1
           -- Two bookings dispatched at once never pick the same pro: the second skips the locked one.
           FOR UPDATE OF p SKIP LOCKED`,
          [
            booking.category_id,
            booking.postcode,
            booking.starts_at,
            booking.ends_at,
            deps.config.timezone,
            bookingId,
            NEW_PRO_RATING,
            booking.customer_id,
            ...(booking.flexible_window ? [booking.duration_minutes] : []),
          ],
        );
    const when = booking.flexible_window
      ? messages.flexibleWhen(formatDay(booking.starts_at, deps.config.timezone), booking.flexible_window)
      : formatSlot(booking.starts_at, deps.config.timezone);
    const proId = next.rows[0]?.user_id;
    if (!proId) {
      await setStatus(client, bookingId, 'unassigned');
      await enqueue(client, booking.customer_id, 'booking_unassigned', messages.bookingUnassigned(booking.service_name, when));
      deps.log.warn({ event: 'booking_unassigned', bookingId });
      return 'unassigned';
    }
    // A flexible job's offer runs out by the time the pro has to confirm it.
    const deadline = booking.flexible_window && booking.confirm_by ? booking.confirm_by : booking.starts_at;
    await client.query(
      `INSERT INTO booking_offers (booking_id, pro_id, expires_at)
       VALUES ($1, $2, LEAST(now() + make_interval(mins => $3), $4))`,
      [bookingId, proId, OFFER_MINUTES, deadline],
    );
    const earn = proShareCents(booking.price_cents, booking.pro_share_pct);
    await enqueue(
      client,
      proId,
      'job_offer',
      booking.flexible_window
        ? messages.flexibleJobOffer(booking.service_name, formatDay(booking.starts_at, deps.config.timezone), booking.flexible_window, earn)
        : messages.jobOffer(booking.service_name, when, earn),
    );
    deps.log.info({ event: 'job_offered', bookingId, proId });
    return 'offered';
  });
}

/**
 * One dispatch pass: expires offers past their deadline (or whose job has started) and moves every
 * searching booking without a live offer to its next pro.
 */
export async function dispatchTick(deps: BookingDeps): Promise<number> {
  await deps.pool.query(
    `UPDATE booking_offers o SET status = 'expired', responded_at = now()
     FROM bookings b
     WHERE b.id = o.booking_id AND o.status = 'pending' AND (o.expires_at <= now() OR b.starts_at <= now()
       OR (b.flexible_window IS NOT NULL AND b.time_confirmed_at IS NULL AND b.confirm_by <= now()))`,
  );
  const waiting = await deps.pool.query<{ id: string }>(
    `SELECT b.id FROM bookings b
     WHERE b.status = 'searching'
       AND NOT EXISTS (SELECT 1 FROM booking_offers o WHERE o.booking_id = b.id AND o.status = 'pending')
     ORDER BY b.starts_at LIMIT 100`,
  );
  for (const { id } of waiting.rows) {
    await offerNext(deps, id);
  }
  return waiting.rows.length;
}

export async function acceptOffer(deps: BookingDeps, proId: string, offerId: string, chosenStart?: Date): Promise<string> {
  const result = await withTransaction(deps.pool, async (client) => {
    const found = await client.query<{
      booking_id: string;
      offer_status: string;
      expired: boolean;
      booking_status: string;
      customer_id: string;
      service_name: string;
      starts_at: Date;
      ends_at: Date;
      flexible: boolean;
      category_id: string;
      postcode: string;
      duration_minutes: number;
    }>(
      `SELECT o.booking_id, o.status AS offer_status, o.expires_at <= now() AS expired, b.status AS booking_status,
         b.customer_id, b.service_name, b.starts_at, b.ends_at, b.category_id, b.postcode,
         (b.flexible_window IS NOT NULL AND b.time_confirmed_at IS NULL) AS flexible,
         COALESCE((SELECT sum(duration_minutes)::int FROM booking_services bs WHERE bs.booking_id = b.id),
           (extract(epoch FROM b.ends_at - b.starts_at) / 60)::int) AS duration_minutes
       FROM booking_offers o JOIN bookings b ON b.id = o.booking_id
       WHERE o.id = $1 AND o.pro_id = $2
       FOR UPDATE OF o, b`,
      [offerId, proId],
    );
    const offer = found.rows[0];
    if (!offer) {
      throw notFound();
    }
    if (offer.offer_status !== 'pending' || offer.expired || offer.booking_status !== 'searching') {
      throw conflict('offer_expired');
    }
    const pro = await client.query<{ firstName: string | null }>(
      `SELECT u.first_name AS "firstName" FROM pro_profiles p JOIN users u ON u.id = p.user_id
       WHERE p.user_id = $1 AND p.status = 'approved' AND p.payouts_enabled AND p.jobs_paused_at IS NULL AND u.disabled_at IS NULL`,
      [proId],
    );
    if (!pro.rowCount) {
      throw forbidden('not_approved');
    }
    let startsAt = offer.starts_at;
    if (offer.flexible) {
      // The pro picks one of the possible starts at which they are free (D70).
      if (!chosenStart) throw conflict('start_required');
      const free = await client.query(
        `SELECT 1 FROM pro_profiles p, ${flexibleStarts('$3::timestamptz', '$4::timestamptz', '$5::int')} AS st
         WHERE p.user_id = $1 AND st = $6::timestamptz
           AND ${eligibleProFilter('$7', '$8', 'st', 'st + make_interval(mins => $5::int)', '$9', 'NULL::uuid', '$2::uuid')}`,
        [proId, offer.booking_id, offer.starts_at, offer.ends_at, offer.duration_minutes, chosenStart, offer.category_id, offer.postcode, deps.config.timezone],
      );
      if (!free.rowCount) throw conflict('start_not_free');
      startsAt = chosenStart;
      await client.query(
        `UPDATE bookings SET starts_at = $2::timestamptz, ends_at = $2::timestamptz + make_interval(mins => $3::int), time_confirmed_at = now() WHERE id = $1`,
        [offer.booking_id, chosenStart, offer.duration_minutes],
      );
    }

    await client.query('SAVEPOINT assign');
    try {
      await setStatus(client, offer.booking_id, 'accepted', ', pro_id = $3', [proId]);
    } catch (error) {
      if (!isExclusionViolation(error)) {
        throw error;
      }
      // The pro already has a job at this time; the offer passes to the next pro.
      await client.query('ROLLBACK TO SAVEPOINT assign');
      await client.query("UPDATE booking_offers SET status = 'declined', responded_at = now() WHERE id = $1", [offerId]);
      return { conflict: true, bookingId: offer.booking_id } as const;
    }
    await client.query("UPDATE booking_offers SET status = 'accepted', responded_at = now() WHERE id = $1", [offerId]);
    const when = formatSlot(startsAt, deps.config.timezone);
    await enqueue(
      client,
      offer.customer_id,
      'pro_assigned',
      messages.proAssigned(offer.service_name, when, onlyRow(pro).firstName ?? 'Your pro'),
    );
    return { conflict: false, bookingId: offer.booking_id } as const;
  });

  if (result.conflict) {
    await offerNext(deps, result.bookingId);
    throw conflict('schedule_conflict');
  }
  deps.log.info({ event: 'job_accepted', bookingId: result.bookingId, proId });
  return result.bookingId;
}

export async function declineOffer(deps: BookingDeps, proId: string, offerId: string): Promise<void> {
  const declined = await deps.pool.query<{ booking_id: string }>(
    `UPDATE booking_offers SET status = 'declined', responded_at = now()
     WHERE id = $1 AND pro_id = $2 AND status = 'pending' RETURNING booking_id`,
    [offerId, proId],
  );
  const bookingId = declined.rows[0]?.booking_id;
  if (!bookingId) {
    throw conflict('offer_expired');
  }
  deps.log.info({ event: 'job_declined', bookingId, proId });
  await offerNext(deps, bookingId);
}
