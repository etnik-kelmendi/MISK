import type { Queryable } from '../db.js';

/** Local start hours of bookable slots (from the demo). */
export const SLOT_HOURS = [8, 10, 12, 14, 16, 18];
/** A job must end by this local hour (QUESTIONS Q9). */
export const WORK_END_HOUR = 20;
/**
 * Today and the next six days (D74). A card reservation lasts about seven days and the money is taken 24 h
 * after the job, so reservations for later jobs are renewed before they run out (see renewHolds).
 */
export const BOOKING_DAYS = 7;
/** A time that frees up is held this long for the customer who waited for it (D74). */
export const SLOT_HOLD_MINUTES = 15;
/** Customers cannot book a slot that starts sooner than this, so a pro can be found and travel. */
export const MIN_LEAD_MINUTES = 120;

export interface SlotQuery {
  categoryId: string;
  postcode: string;
  durationMinutes: number;
  timezone: string;
  /** The person booking: when they are a pro too, they are not counted as free for their own job (D64). */
  customerId?: string;
  /** A booking that is being moved: it does not count against the pros or the demand at its new time. */
  excludeBookingId?: string;
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
export function eligibleProFilter(
  cat: string,
  pc: string,
  s: string,
  e: string,
  tz: string,
  customer = 'NULL::uuid',
  /** A booking whose own pending offer or job does not count as busy, e.g. a flexible job or one being moved. */
  ownBooking = 'NULL::uuid',
  /** A plan visit that does not count as busy, e.g. one being moved to another day (D77). */
  ownVisit = 'NULL::uuid',
): string {
  return `p.status = 'approved' AND p.payouts_enabled AND p.jobs_paused_at IS NULL
    AND p.user_id IS DISTINCT FROM ${customer}
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
        AND busy.id IS DISTINCT FROM ${ownBooking}
        AND tstzrange(busy.starts_at, busy.ends_at) && tstzrange(${s}, ${e})
    )
    AND NOT EXISTS (
      SELECT 1 FROM subscription_visits visit
      WHERE visit.pro_id = p.user_id AND visit.status IN ('pending', 'planned')
        AND visit.id IS DISTINCT FROM ${ownVisit}
        AND tstzrange(visit.starts_at, visit.ends_at) && tstzrange(${s}, ${e})
    )
    AND NOT EXISTS (
      SELECT 1 FROM booking_offers held JOIN bookings hb ON hb.id = held.booking_id
      WHERE held.pro_id = p.user_id AND held.status = 'pending' AND hb.id IS DISTINCT FROM ${ownBooking}
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
        WHERE ${eligibleProFilter('$1', '$2', 's.starts_at', 's.ends_at', '$4', '$10::uuid', '$11::uuid')}) AS "freePros",
       (SELECT count(*)::int FROM bookings b
        WHERE b.category_id = $1 AND b.status IN ('awaiting_payment', 'searching') AND b.id IS DISTINCT FROM $11::uuid
          AND tstzrange(b.starts_at, b.ends_at) && tstzrange(s.starts_at, s.ends_at)
          AND NOT EXISTS (SELECT 1 FROM booking_offers o WHERE o.booking_id = b.id AND o.status = 'pending'))
       + (SELECT count(*)::int FROM slot_holds h
          WHERE h.category_id = $1 AND h.expires_at > now() AND h.customer_id IS DISTINCT FROM $10::uuid
            AND tstzrange(h.starts_at, h.ends_at) && tstzrange(s.starts_at, s.ends_at)) AS demand
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
      query.customerId ?? null,
      query.excludeBookingId ?? null,
    ],
  );
  return result.rows.map(({ startsAt, endsAt, freePros, demand }) => ({
    startsAt,
    endsAt,
    freePros: Math.max(0, freePros - demand),
    available: freePros > demand,
  }));
}

/** Flexible bookings (D70): the customer gives a window on a day, and the pro picks a start in it. */
export type FlexibleWindow = 'morning' | 'afternoon' | 'any';
export const FLEXIBLE_WINDOWS: FlexibleWindow[] = ['morning', 'afternoon', 'any'];
/** Local start hours each window allows. */
export const WINDOWS: Record<FlexibleWindow, { from: number; to: number }> = {
  morning: { from: 8, to: 12 },
  afternoon: { from: 12, to: 18 },
  any: { from: 8, to: WORK_END_HOUR },
};
/** A pro must pick the time of a flexible job by this local hour the evening before. */
export const FLEXIBLE_CONFIRM_HOUR = 18;
/** Time between two slot starts, which is also the step between a flexible job's possible starts. */
export const SLOT_STEP_MINUTES = 120;

/** The local day (YYYY-MM-DD), hour and minute of a moment. */
export function localDayHour(date: Date, timezone: string): { day: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { day: `${part('year')}-${part('month')}-${part('day')}`, hour: Number(part('hour')), minute: Number(part('minute')) };
}

/** The slots of one local day that start and end inside a flexible window, e.g. 12:00 to 18:00. */
export function windowSlots(slots: Slot[], day: string, window: FlexibleWindow, timezone: string): Slot[] {
  return slots.filter((slot) => {
    const local = localDayHour(slot.startsAt, timezone);
    const end = localDayHour(slot.endsAt, timezone);
    const { from, to } = WINDOWS[window];
    return local.day === day && local.hour >= from && end.day === day && end.hour * 60 + end.minute <= to * 60;
  });
}
