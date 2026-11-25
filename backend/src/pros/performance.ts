import type { Queryable } from '../db.js';
import { notFound } from '../errors.js';
// Dispatch orders pros by this module's score, so its constants are only read when called, never at load time.
import { LATE_CANCEL_LIMIT, LATE_CANCEL_WINDOW_DAYS } from '../bookings/dispatch.js';
import { QUALITY } from './checks.js';

/**
 * The pro's Performance page and the order in which free pros are offered new jobs (D100).
 *
 * Every number covers the last PERFORMANCE_DAYS days:
 * - Acceptance rate: offers accepted out of offers answered or left to run out (offers taken back because the pro
 *   went offline do not count).
 * - On time: finished one-off jobs where the pro arrived (started work) at most 10 minutes after the booked start,
 *   out of the finished jobs with a recorded arrival (a job the team closed without one is not judged).
 * - Completed jobs: accepted one-off jobs the pro finished, out of those finished plus those they gave back.
 * - Late cancellations: jobs given back less than 24 hours before the start; 3 within 30 days pause new offers.
 * - Rating: the average of all the pro's ratings, as customers see it.
 *
 * The performance score is the mean of the three rates and the rating on a 0–100 scale (stars × 20), minus
 * LATE_CANCEL_PENALTY points per late cancellation. A number without data counts as its goal, so a new pro starts
 * in the middle rather than first or last. Dispatch offers a job to the free online pros with the highest score
 * first (after the customer's own pick, D89), and the "top 10%" message compares the same score among the approved
 * pros of the pro's main trade, so the message is true by construction.
 */
export const PERFORMANCE_DAYS = 30;
export const GOALS = {
  acceptancePct: 85,
  onTimePct: 90,
  completionPct: 98,
  rating: 4.5,
} as const;
/** Points a late cancellation takes off the score. */
export const LATE_CANCEL_PENALTY = 5;
/** The late-cancellation count shown in red: one more pauses new offers. */
export const lateCancelWarning = () => LATE_CANCEL_LIMIT - 1;
/** The shares of a trade's pros that the top message names. */
export const TOP_SHARES = [10, 25] as const;

const WINDOW = `make_interval(days => ${PERFORMANCE_DAYS})`;

/** SQL columns: the pro `pro`'s raw counts over the window (all integers, average stars or NULL). */
export function performanceCountsSql(pro: string): string {
  return `(SELECT count(*) FROM booking_offers o WHERE o.pro_id = ${pro} AND o.status IN ('accepted', 'declined', 'expired')
      AND o.offered_at > now() - ${WINDOW})::int AS offered,
    (SELECT count(*) FROM booking_offers o WHERE o.pro_id = ${pro} AND o.status = 'accepted'
      AND o.offered_at > now() - ${WINDOW})::int AS accepted,
    (SELECT count(*) FROM bookings b WHERE b.pro_id = ${pro} AND b.status = 'completed'
      AND b.completed_at > now() - ${WINDOW})::int AS completed,
    (SELECT count(*) FROM bookings b WHERE b.pro_id = ${pro} AND b.status = 'completed'
      AND b.completed_at > now() - ${WINDOW}
      AND EXISTS (SELECT 1 FROM booking_events e WHERE e.booking_id = b.id AND e.status = 'working'))::int AS timed,
    (SELECT count(*) FROM bookings b WHERE b.pro_id = ${pro} AND b.status = 'completed'
      AND b.completed_at > now() - ${WINDOW}
      AND (SELECT min(e.created_at) FROM booking_events e WHERE e.booking_id = b.id AND e.status = 'working')
          <= b.starts_at + make_interval(mins => ${QUALITY.graceMinutes}))::int AS on_time,
    (SELECT count(*) FROM pro_cancellations c WHERE c.pro_id = ${pro} AND c.created_at > now() - ${WINDOW})::int AS cancelled,
    (SELECT count(*) FROM pro_cancellations c WHERE c.pro_id = ${pro} AND c.late
      AND c.created_at > now() - make_interval(days => ${LATE_CANCEL_WINDOW_DAYS}))::int AS late_cancelled,
    (SELECT avg(r.stars)::float FROM ratings r WHERE r.pro_id = ${pro}) AS rating`;
}

/**
 * SQL for the performance score of the pro whose id is the SQL expression `pro` (see the module comment). Used to
 * order dispatch and to rank pros within a trade.
 */
export function performanceScoreSql(pro: string): string {
  return `(SELECT (
      COALESCE(100.0 * k.accepted / NULLIF(k.offered, 0), ${GOALS.acceptancePct})
      + COALESCE(100.0 * k.on_time / NULLIF(k.timed, 0), ${GOALS.onTimePct})
      + COALESCE(100.0 * k.completed / NULLIF(k.completed + k.cancelled, 0), ${GOALS.completionPct})
      + COALESCE(k.rating, ${GOALS.rating}) * 20
    ) / 4 - ${LATE_CANCEL_PENALTY} * k.late_cancelled
    FROM (SELECT ${performanceCountsSql(pro)}) k)`;
}

interface CountsRow {
  offered: number;
  accepted: number;
  completed: number;
  timed: number;
  on_time: number;
  cancelled: number;
  late_cancelled: number;
  rating: number | null;
}

/** One number of the page: its value (null without data), its goal and whether it is below the goal. */
export interface Metric {
  value: number | null;
  goal: number;
  belowGoal: boolean;
  /** How many jobs or offers the number is based on. */
  basis: number;
}

export interface Performance {
  windowDays: number;
  acceptance: Metric;
  onTime: Metric;
  completion: Metric;
  /** "[number] of 3": below goal (red) from lateCancelWarning() on. */
  lateCancellations: { value: number; limit: number; belowGoal: boolean };
  /** Rounded to one decimal, like everywhere else customers and pros see it. */
  rating: Metric;
  /** Where the pro stands in their main trade; null for a pro without an approved trade. */
  rank: { trade: string; pros: number; topPercent: TopPercent | null } | null;
}

export type TopPercent = (typeof TOP_SHARES)[number];

const pct = (part: number, whole: number) => (whole ? Math.round((part * 100) / whole) : null);

function metric(value: number | null, goal: number, basis: number): Metric {
  return { value, goal, belowGoal: value !== null && value < goal, basis };
}

/** The pro's numbers as the Performance page shows them. */
export function metricsOf(row: CountsRow): Omit<Performance, 'rank' | 'windowDays'> {
  const rating = row.rating === null ? null : Math.round(row.rating * 10) / 10;
  return {
    acceptance: metric(pct(row.accepted, row.offered), GOALS.acceptancePct, row.offered),
    onTime: metric(pct(row.on_time, row.timed), GOALS.onTimePct, row.timed),
    completion: metric(pct(row.completed, row.completed + row.cancelled), GOALS.completionPct, row.completed + row.cancelled),
    lateCancellations: { value: row.late_cancelled, limit: LATE_CANCEL_LIMIT, belowGoal: row.late_cancelled >= lateCancelWarning() },
    rating: metric(rating, GOALS.rating, row.rating === null ? 0 : 1),
  };
}

/**
 * Which share of `pros` pros the one with `better` pros scoring above them is in: 10 (top 10%), 25, or null.
 * The top share always holds at least one pro, so the best pro of a small trade is in the top 10%.
 */
export function topShare(better: number, pros: number): TopPercent | null {
  for (const share of TOP_SHARES) {
    if (better < Math.max(1, Math.ceil((pros * share) / 100))) {
      return share;
    }
  }
  return null;
}

/**
 * The pro's main trade: the approved trade they finished most one-off jobs in over the window, then the first in
 * the catalogue order. Null without an approved trade.
 */
async function mainTrade(db: Queryable, proId: string): Promise<{ id: string; name: string } | null> {
  const found = await db.query<{ id: string; name: string }>(
    `SELECT c.id, c.name FROM pro_trades t JOIN categories c ON c.id = t.category_id
     WHERE t.pro_id = $1 AND t.approved
     ORDER BY (SELECT count(*) FROM bookings b WHERE b.pro_id = $1 AND b.category_id = c.id AND b.status = 'completed'
               AND b.completed_at > now() - ${WINDOW}) DESC, c.sort_order, c.name
     LIMIT 1`,
    [proId],
  );
  return found.rows[0] ?? null;
}

/** The pro's Performance page: the numbers of the last 30 days, their goals, and the rank in the main trade. */
export async function loadPerformance(db: Queryable, proId: string): Promise<Performance> {
  const found = await db.query<CountsRow>(
    `SELECT ${performanceCountsSql('p.user_id')} FROM pro_profiles p WHERE p.user_id = $1`,
    [proId],
  );
  const row = found.rows[0];
  if (!row) {
    throw notFound('profile_not_found');
  }
  const trade = await mainTrade(db, proId);
  let rank: Performance['rank'] = null;
  if (trade) {
    // Every approved pro of the trade, the pro themselves included even while their account is being re-checked.
    const ranked = await db.query<{ pros: number; better: number }>(
      `WITH scores AS (
         SELECT p.user_id, ${performanceScoreSql('p.user_id')} AS score
         FROM pro_profiles p JOIN pro_trades t ON t.pro_id = p.user_id AND t.category_id = $2 AND t.approved
         WHERE p.status = 'approved' OR p.user_id = $1
       )
       SELECT count(*)::int AS pros,
         count(*) FILTER (WHERE score > (SELECT score FROM scores WHERE user_id = $1))::int AS better
       FROM scores`,
      [proId, trade.id],
    );
    const { pros, better } = ranked.rows[0] ?? { pros: 1, better: 0 };
    rank = { trade: trade.name, pros, topPercent: topShare(better, pros) };
  }
  return { windowDays: PERFORMANCE_DAYS, ...metricsOf(row), rank };
}
