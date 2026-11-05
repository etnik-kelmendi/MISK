import type { Queryable } from '../db.js';

/** Local start hours of bookable slots (from the demo). */
export const SLOT_HOURS = [8, 10, 12, 14, 16, 18];
/** A job must end by this local hour (QUESTIONS Q9). */
export const WORK_END_HOUR = 20;
/** Today plus five days: card holds last seven days, so every job ends while its hold is valid (D6). */
export const BOOKING_DAYS = 6;
/** Customers cannot book a slot that starts sooner than this, so a pro can be found and travel. */
export const MIN_LEAD_MINUTES = 120;

export interface SlotQuery {
  categoryId: string;
  postcode: string;
  durationMinutes: number;
  timezone: string;
}

export interface Slot {
  startsAt: Date;
  endsAt: Date;
  freePros: number;
  available: boolean;
}

/**
 * SQL that keeps only pros who can take a job in category `cat` at postcode `pc` between `s` and `e`:
 * approved, able to receive payouts, doing that trade, within travel distance, working that weekday,
 * and with no job or pending offer at an overlapping time. The caller supplies the alias `p`
 * for `pro_profiles` and the four expressions.
 */
export function eligibleProFilter(cat: string, pc: string, s: string, e: string, tz: string): string {
  return `p.status = 'approved' AND p.payouts_enabled
    AND EXISTS (SELECT 1 FROM users u WHERE u.id = p.user_id AND u.disabled_at IS NULL)
    AND EXISTS (SELECT 1 FROM pro_trades t WHERE t.pro_id = p.user_id AND t.category_id = ${cat})
    AND EXISTS (
      SELECT 1 FROM postcodes home, postcodes dest
      WHERE home.code = p.home_postcode AND dest.code = ${pc}
        AND distance_km(home.lat, home.lng, dest.lat, dest.lng) <= p.radius_km
    )
    AND extract(isodow FROM ((${s}) AT TIME ZONE ${tz}))::smallint = ANY (p.working_days)
    AND NOT EXISTS (
      SELECT 1 FROM bookings busy
      WHERE busy.pro_id = p.user_id AND busy.status IN ('accepted', 'on_the_way', 'working')
        AND tstzrange(busy.starts_at, busy.ends_at) && tstzrange(${s}, ${e})
    )
    AND NOT EXISTS (
      SELECT 1 FROM subscription_visits visit
      WHERE visit.pro_id = p.user_id AND visit.status IN ('pending', 'planned')
        AND tstzrange(visit.starts_at, visit.ends_at) && tstzrange(${s}, ${e})
    )
    AND NOT EXISTS (
      SELECT 1 FROM booking_offers held JOIN bookings hb ON hb.id = held.booking_id
      WHERE held.pro_id = p.user_id AND held.status = 'pending'
        AND tstzrange(hb.starts_at, hb.ends_at) && tstzrange(${s}, ${e})
    )`;
}

/**
 * Bookable slots for the next `BOOKING_DAYS` days. A slot is available when more pros are free than
 * there are bookings in the same trade at that time still waiting for a pro. Counting demand across the
 * whole trade, not per postcode, can hide a slot at a busy time but never promises more pros than exist.
 * With `onlyStart`, returns just that slot (or nothing when it is not a real slot).
 */
export async function findSlots(db: Queryable, query: SlotQuery, onlyStart?: Date): Promise<Slot[]> {
  const result = await db.query<{ startsAt: Date; endsAt: Date; freePros: number; demand: number }>(
    `WITH local_today AS (SELECT (now() AT TIME ZONE $4)::date AS d),
     slots AS (
       SELECT (day + make_interval(hours => h)) AT TIME ZONE $4 AS starts_at,
              (day + make_interval(hours => h, mins => $3)) AT TIME ZONE $4 AS ends_at,
              day + make_interval(hours => h, mins => $3) <= day + make_interval(hours => $6) AS fits
       FROM local_today,
            generate_series(local_today.d, local_today.d + ($5::int - 1), interval '1 day') AS day,
            unnest($7::int[]) AS h
     )
     SELECT s.starts_at AS "startsAt", s.ends_at AS "endsAt",
       (SELECT count(*)::int FROM pro_profiles p
        WHERE ${eligibleProFilter('$1', '$2', 's.starts_at', 's.ends_at', '$4')}) AS "freePros",
       (SELECT count(*)::int FROM bookings b
        WHERE b.category_id = $1 AND b.status IN ('awaiting_payment', 'searching')
          AND tstzrange(b.starts_at, b.ends_at) && tstzrange(s.starts_at, s.ends_at)
          AND NOT EXISTS (SELECT 1 FROM booking_offers o WHERE o.booking_id = b.id AND o.status = 'pending')) AS demand
     FROM slots s
     WHERE s.fits
       AND s.starts_at >= now() + make_interval(mins => $8)
       AND ($9::timestamptz IS NULL OR s.starts_at = $9)
     ORDER BY s.starts_at`,
    [
      query.categoryId,
      query.postcode,
      query.durationMinutes,
      query.timezone,
      BOOKING_DAYS,
      WORK_END_HOUR,
      SLOT_HOURS,
      MIN_LEAD_MINUTES,
      onlyStart ?? null,
    ],
  );
  return result.rows.map(({ startsAt, endsAt, freePros, demand }) => ({
    startsAt,
    endsAt,
    freePros: Math.max(0, freePros - demand),
    available: freePros > demand,
  }));
}
