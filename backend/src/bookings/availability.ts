import { onlyRow, type Queryable } from '../db.js';
import { badRequest } from '../errors.js';
import { blockedDateSql, offThatDaySql, onlineNowSql } from '../pros/working-hours.js';

/** Local start hours of bookable slots (from the demo). */
export const SLOT_HOURS = [8, 10, 12, 14, 16, 18];
/** A job must end by this local hour (QUESTIONS Q9). */
export const WORK_END_HOUR = 20;
/**
 * The days one availability request covers by default: one week of day buttons on Choose time (D74). The page
 * asks for the week around the chosen date (D101), at most `MAX_WINDOW_DAYS` days at once, so a wide booking
 * horizon never makes one request compute every day.
 */
export const WINDOW_DAYS = 7;
export const MAX_WINDOW_DAYS = 14;
/**
 * How many days ahead customers can book, today counting as the first (D101, replacing D74's fixed seven
 * days). The team sets it in Settings between these limits. A card reservation lasts about seven days and the
 * money is taken 24 h after the job, so reservations for later jobs are renewed before they run out (renewHolds).
 */
export const DEFAULT_BOOKING_HORIZON_DAYS = 60;
export const MIN_BOOKING_HORIZON_DAYS = 7;
export const MAX_BOOKING_HORIZON_DAYS = 180;
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
  /** The pro the customer picked on Home (D89): each slot then says whether that pro is free and online. */
  preferredProId?: string;
  /** The first local day (YYYY-MM-DD) to list; today when left out. Days before today are never listed. */
  from?: string;
  /** How many days from `from` to list (`WINDOW_DAYS` when left out); never past the booking horizon. */
  days?: number;
}

/** The days customers can book right now, in the market's time zone (D101). */
export interface BookingRange {
  /** "YYYY-MM-DD" */
  today: string;
  /** The last bookable day, "YYYY-MM-DD": today plus the horizon minus one. */
  lastDay: string;
  horizonDays: number;
}

/** Today and the last bookable day, from the booking horizon in Settings. */
export async function bookingRange(db: Queryable, timezone: string): Promise<BookingRange> {
  const found = await db.query<BookingRange>(
    `SELECT to_char(local.d, 'YYYY-MM-DD') AS today,
       to_char(local.d + (s.booking_horizon_days - 1), 'YYYY-MM-DD') AS "lastDay",
       s.booking_horizon_days AS "horizonDays"
     FROM settings s, (SELECT (now() AT TIME ZONE $1)::date AS d) local`,
    [timezone],
  );
  return onlyRow(found);
}

/** The last day ("YYYY-MM-DD") of a month given as "YYYY-MM". */
export function monthEnd(month: string): string {
  const [year = 0, monthNumber = 0] = month.split('-').map(Number);
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}

/** Refuses a local day before today or after the last bookable day (400 date_out_of_range). */
export function assertBookableDay(range: BookingRange, day: string): void {
  // Both are "YYYY-MM-DD", so comparing the text compares the dates.
  if (day < range.today || day > range.lastDay) {
    throw badRequest('date_out_of_range');
  }
}

/**
 * SQL that keeps only pros who serve trade `cat` at postcode `pc` at all: approved, able to receive payouts,
 * taking jobs, not suspended, doing that (approved) trade and within travel distance. The caller supplies the
 * alias `p` for `pro_profiles`.
 */
function servingProFilter(cat: string, pc: string, customer: string): string {
  return `p.status = 'approved' AND p.payouts_enabled AND p.jobs_paused_at IS NULL
    AND p.user_id IS DISTINCT FROM ${customer}
    AND EXISTS (SELECT 1 FROM users u WHERE u.id = p.user_id AND u.disabled_at IS NULL)
    AND EXISTS (SELECT 1 FROM pro_trades t WHERE t.pro_id = p.user_id AND t.category_id = ${cat} AND t.approved)
    AND EXISTS (
      SELECT 1 FROM postcodes home, postcodes dest
      WHERE home.code = p.home_postcode AND dest.code = ${pc}
        AND distance_km(home.lat, home.lng, dest.lat, dest.lng) <= p.radius_km
    )`;
}

export interface Slot {
  startsAt: Date;
  endsAt: Date;
  freePros: number;
  available: boolean;
  /** Only with `preferredProId`: whether that pro can take the job at this time. */
  preferredFree?: boolean;
}

/**
 * SQL that keeps only pros who can take a job in category `cat` at postcode `pc` between `s` and `e`:
 * approved, able to receive payouts, doing that trade, within travel distance, working that weekday and not
 * on holiday or a day off that day (D94, D99), and with no job or pending offer at an overlapping time. The caller supplies the alias `p`
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
  return `${servingProFilter(cat, pc, customer)}
    AND extract(isodow FROM ((${s}) AT TIME ZONE ${tz}))::smallint = ANY (p.working_days)
    AND NOT ${offThatDaySql(s, tz)}
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
 * Bookable slots for `days` days from `from` (today and the next six by default), only inside the booking
 * horizon (D101). A slot is available when more pros are free than there are bookings in the same trade at
 * that time still waiting for a pro. Counting demand across the whole trade, not per postcode, can hide a slot
 * at a busy time but never promises more pros than exist. With `onlyStart`, returns just that slot (or nothing
 * when it is not a real slot or lies outside the horizon), computing only its own day.
 */
export async function findSlots(db: Queryable, query: SlotQuery, onlyStart?: Date): Promise<Slot[]> {
  if (onlyStart && Number.isNaN(onlyStart.getTime())) return [];
  const from = onlyStart ? localDayHour(onlyStart, query.timezone).day : (query.from ?? null);
  const days = onlyStart ? 1 : Math.min(Math.max(Math.trunc(query.days ?? WINDOW_DAYS), 1), MAX_WINDOW_DAYS);
  const result = await db.query<{ startsAt: Date; endsAt: Date; freePros: number; demand: number; preferredFree: boolean | null }>(
    `WITH local_today AS (SELECT (now() AT TIME ZONE $4)::date AS d),
     bounds AS (
       SELECT GREATEST(COALESCE($13::date, local_today.d), local_today.d) AS first_day,
              LEAST(COALESCE($13::date, local_today.d) + ($5::int - 1), local_today.d + (s.booking_horizon_days - 1)) AS last_day
       FROM local_today, settings s
     ),
     slots AS (
       SELECT (day + make_interval(hours => h)) AT TIME ZONE $4 AS starts_at,
              (day + make_interval(hours => h, mins => $3)) AT TIME ZONE $4 AS ends_at,
              day + make_interval(hours => h, mins => $3) <= day + make_interval(hours => $6) AS fits
       FROM bounds,
            generate_series(bounds.first_day, bounds.last_day, interval '1 day') AS day,
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
            AND tstzrange(h.starts_at, h.ends_at) && tstzrange(s.starts_at, s.ends_at)) AS demand,
       CASE WHEN $12::uuid IS NOT NULL THEN EXISTS (
         SELECT 1 FROM pro_profiles p
         WHERE p.user_id = $12::uuid AND ${onlineNowSql('$4')}
           AND ${eligibleProFilter('$1', '$2', 's.starts_at', 's.ends_at', '$4', '$10::uuid', '$11::uuid')}
       ) END AS "preferredFree"
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
      days,
      WORK_END_HOUR,
      SLOT_HOURS,
      MIN_LEAD_MINUTES,
      onlyStart ?? null,
      query.customerId ?? null,
      query.excludeBookingId ?? null,
      query.preferredProId ?? null,
      from,
    ],
  );
  return result.rows.map(({ startsAt, endsAt, freePros, demand, preferredFree }) => ({
    startsAt,
    endsAt,
    freePros: Math.max(0, freePros - demand),
    available: freePros > demand,
    ...(query.preferredProId ? { preferredFree: preferredFree === true } : {}),
  }));
}

/** One day of the date picker (D101): whether the trade can be booked at the postcode on that day at all. */
export interface ServiceDay {
  /** "YYYY-MM-DD" */
  day: string;
  open: boolean;
}

/**
 * For each day from `first` to `last` that lies inside the booking horizon: whether some pro serves the trade at
 * the postcode on that weekday and is not on holiday or a day off, and a slot still starts late enough. Busy pros
 * count, because a full day can still be waited for. One light query for a whole month of the date picker.
 */
export async function serviceDays(
  db: Queryable,
  query: Pick<SlotQuery, 'categoryId' | 'postcode' | 'durationMinutes' | 'timezone' | 'customerId'>,
  first: string,
  last: string,
): Promise<ServiceDay[]> {
  const result = await db.query<ServiceDay>(
    `WITH local_today AS (SELECT (now() AT TIME ZONE $3)::date AS d),
     bounds AS (
       SELECT GREATEST($4::date, local_today.d) AS first_day,
              LEAST($5::date, local_today.d + (s.booking_horizon_days - 1)) AS last_day
       FROM local_today, settings s
     )
     SELECT to_char(cal_day, 'YYYY-MM-DD') AS day,
       (EXISTS (
          SELECT 1 FROM unnest($6::int[]) AS h
          WHERE cal_day + make_interval(hours => h, mins => $7) <= cal_day + make_interval(hours => $8)
            AND (cal_day + make_interval(hours => h)) AT TIME ZONE $3 >= now() + make_interval(mins => $9)
        )
        AND EXISTS (
          SELECT 1 FROM pro_profiles p
          WHERE ${servingProFilter('$1', '$2', '$10::uuid')}
            AND extract(isodow FROM cal_day)::smallint = ANY (p.working_days)
            AND NOT ${blockedDateSql('cal_day::date')}
        )) AS open
     -- Named cal_day, because the day-off table has a column called day.
     FROM bounds, generate_series(bounds.first_day, bounds.last_day, interval '1 day') AS cal_day
     ORDER BY 1`,
    [
      query.categoryId,
      query.postcode,
      query.timezone,
      first,
      last,
      SLOT_HOURS,
      query.durationMinutes,
      WORK_END_HOUR,
      MIN_LEAD_MINUTES,
      query.customerId ?? null,
    ],
  );
  return result.rows;
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
