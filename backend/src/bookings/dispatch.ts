import { onlyRow, withTransaction } from '../db.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { isExclusionViolation } from '../http.js';
import { proShareCents } from '../catalogue/pricing.js';
import { formatSlot, messages } from '../notifications/messages.js';
import { enqueue } from '../notifications/outbox.js';
import { eligibleProFilter } from './availability.js';
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
         customer_id, starts_at <= now() AS started
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
           WHERE ${eligibleProFilter('$1', '$2', '$3', '$4', '$5')}
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
          ],
        );
    const when = formatSlot(booking.starts_at, deps.config.timezone);
    const proId = next.rows[0]?.user_id;
    if (!proId) {
      await setStatus(client, bookingId, 'unassigned');
      await enqueue(client, booking.customer_id, 'booking_unassigned', messages.bookingUnassigned(booking.service_name, when));
      deps.log.warn({ event: 'booking_unassigned', bookingId });
      return 'unassigned';
    }
    await client.query(
      `INSERT INTO booking_offers (booking_id, pro_id, expires_at)
       VALUES ($1, $2, LEAST(now() + make_interval(mins => $3), $4))`,
      [bookingId, proId, OFFER_MINUTES, booking.starts_at],
    );
    const earn = proShareCents(booking.price_cents, booking.pro_share_pct);
    await enqueue(client, proId, 'job_offer', messages.jobOffer(booking.service_name, when, earn));
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
     WHERE b.id = o.booking_id AND o.status = 'pending' AND (o.expires_at <= now() OR b.starts_at <= now())`,
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

export async function acceptOffer(deps: BookingDeps, proId: string, offerId: string): Promise<string> {
  const result = await withTransaction(deps.pool, async (client) => {
    const found = await client.query<{
      booking_id: string;
      offer_status: string;
      expired: boolean;
      booking_status: string;
      customer_id: string;
      service_name: string;
      starts_at: Date;
    }>(
      `SELECT o.booking_id, o.status AS offer_status, o.expires_at <= now() AS expired, b.status AS booking_status,
         b.customer_id, b.service_name, b.starts_at
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
       WHERE p.user_id = $1 AND p.status = 'approved' AND p.payouts_enabled AND u.disabled_at IS NULL`,
      [proId],
    );
    if (!pro.rowCount) {
      throw forbidden('not_approved');
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
    const when = formatSlot(offer.starts_at, deps.config.timezone);
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
