import type { FastifyInstance } from 'fastify';
import { canOpen } from '../auth/access.js';
import { currentUser } from '../auth/guard.js';
import type { AppContext } from '../context.js';
import { DOCUMENT_KINDS, loadChecks, QUALITY } from '../pros/checks.js';
import { ITEMS } from './admin-list.js';

export const PERIODS = ['1', '7', '30'] as const;
export type Period = (typeof PERIODS)[number];

/** Weeks in the chart: a longer period shows a longer history (D38). */
export const CHART_WEEKS: Record<Period, number> = { '1': 4, '7': 8, '30': 13 };

/** Bookings in the "Live bookings" table, the ones starting closest to now. */
export const LIVE_ROWS = 8;
/** Applications listed on the overview; the rest are under Providers. */
export const LISTED_APPLICATIONS = 5;

/**
 * The period and the one before it, in the market's time zone:
 * - Today: from midnight until now, against yesterday from midnight until the same time
 * - 7 and 30 days: the last 7 or 30 days, against the 7 or 30 days before
 */
const PERIOD = `period AS (
  SELECT since, since - make_interval(days => $1) AS prev_since, now() - make_interval(days => $1) AS prev_until
  FROM (SELECT CASE WHEN $1 = 1 THEN date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2
                    ELSE now() - make_interval(days => $1) END AS since) s
)`;

/** A one-off booking that really happened or is going to: paid for and not cancelled by the system. */
const COUNTED_BOOKING = `b.status <> 'awaiting_payment' AND b.cancelled_by IS DISTINCT FROM 'system'`;

/** Money charged for jobs finished between two moments: price, fee and approved extras. */
function gross(from: string, until: string) {
  return `((SELECT COALESCE(sum(b.price_cents + b.fee_cents), 0) FROM bookings b
              WHERE b.completed_at >= ${from} AND b.completed_at < ${until} AND b.payment_status = 'captured')
          + (SELECT COALESCE(sum(e.price_cents), 0) FROM extra_requests e JOIN bookings b ON b.id = e.booking_id
              WHERE b.completed_at >= ${from} AND b.completed_at < ${until} AND e.payment_status = 'captured'))::int`;
}

interface KpiRow {
  bookings: number;
  previousBookings: number;
  completed: number;
  grossCents: number;
  previousGrossCents: number;
  payoutCents: number;
  ratingAverage: number | null;
  ratingCount: number;
  timedJobs: number;
  onTimeJobs: number;
  activeSubscriptions: number;
  newSubscriptions: number;
}

/** Change against the previous period in whole percent; null when there is nothing to compare with. */
export function changePct(now: number, before: number): number | null {
  return before === 0 ? null : Math.round(((now - before) * 100) / before);
}

export async function overviewRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards } = ctx;
  const { timezone, city } = ctx.config;

  app.get<{ Querystring: { days?: Period } }>(
    '/admin/overview',
    {
      preHandler: guards.admin,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { days: { type: 'string', enum: PERIODS } },
        },
      },
    },
    async (request) => {
      const period = request.query.days ?? '7';
      const days = Number(period);
      const [kpis, weekly, attention] = await Promise.all([
        pool.query<KpiRow>(
          `WITH ${PERIOD}
           SELECT
             (SELECT count(*)::int FROM bookings b WHERE b.created_at >= since AND ${COUNTED_BOOKING}) AS bookings,
             (SELECT count(*)::int FROM bookings b WHERE b.created_at >= prev_since AND b.created_at < prev_until
                AND ${COUNTED_BOOKING}) AS "previousBookings",
             (SELECT count(*)::int FROM bookings b WHERE b.completed_at >= since) AS completed,
             ${gross('since', 'now()')} AS "grossCents",
             ${gross('prev_since', 'prev_until')} AS "previousGrossCents",
             (SELECT COALESCE(sum(p.amount_cents), 0)::int FROM payouts p JOIN bookings b ON b.id = p.booking_id
                WHERE b.completed_at >= since) AS "payoutCents",
             (SELECT round(avg(stars)::numeric, 2)::float FROM ratings WHERE created_at >= since) AS "ratingAverage",
             (SELECT count(*)::int FROM ratings WHERE created_at >= since) AS "ratingCount",
             (SELECT count(*)::int FROM bookings b WHERE b.status = 'completed' AND b.completed_at >= since) AS "timedJobs",
             (SELECT count(*)::int FROM bookings b WHERE b.status = 'completed' AND b.completed_at >= since
                AND (SELECT min(e.created_at) FROM booking_events e WHERE e.booking_id = b.id AND e.status = 'working')
                    <= b.starts_at + make_interval(mins => ${QUALITY.graceMinutes})) AS "onTimeJobs",
             (SELECT count(*)::int FROM subscriptions WHERE status = 'active') AS "activeSubscriptions",
             (SELECT count(*)::int FROM subscriptions WHERE status = 'active' AND started_at >= since) AS "newSubscriptions"
           FROM period`,
          [days, timezone],
        ),
        // Weeks run Monday to Sunday in the market. One-off jobs and plan visits count together, in the week they take place.
        pool.query<{ week: string; oneOff: number; visits: number }>(
          `SELECT to_char(w, 'YYYY-MM-DD') AS week,
             (SELECT count(*)::int FROM bookings b WHERE ${COUNTED_BOOKING}
                AND b.starts_at >= w AT TIME ZONE $2 AND b.starts_at < (w + interval '7 days') AT TIME ZONE $2) AS "oneOff",
             (SELECT count(*)::int FROM subscription_visits v WHERE v.status IN ('planned', 'completed')
                AND v.starts_at >= w AT TIME ZONE $2 AND v.starts_at < (w + interval '7 days') AT TIME ZONE $2) AS visits
           FROM generate_series(date_trunc('week', now() AT TIME ZONE $2) - make_interval(weeks => $1 - 1),
                                date_trunc('week', now() AT TIME ZONE $2), interval '1 week') AS w
           ORDER BY w`,
          [CHART_WEEKS[period], timezone],
        ),
        pool.query(
          `SELECT
             (SELECT count(*)::int FROM pro_profiles WHERE status = 'submitted') AS "pendingApplications",
             (SELECT count(*)::int FROM bookings WHERE status = 'unassigned') AS unassigned,
             (SELECT count(*)::int FROM bookings WHERE status = 'cancelled' AND payment_status = 'held') AS "unreleasedHolds",
             (SELECT count(*)::int FROM payouts WHERE status = 'failed') AS "failedPayouts"`,
        ),
      ]);
      const k = kpis.rows[0];
      if (!k) {
        throw new Error('Overview query returned nothing');
      }
      return {
        days,
        city,
        timezone,
        kpis: {
          bookings: k.bookings,
          previousBookings: k.previousBookings,
          bookingsChangePct: changePct(k.bookings, k.previousBookings),
          completed: k.completed,
          activeSubscriptions: k.activeSubscriptions,
          newSubscriptions: k.newSubscriptions,
          grossCents: k.grossCents,
          previousGrossCents: k.previousGrossCents,
          grossChangePct: changePct(k.grossCents, k.previousGrossCents),
          payoutCents: k.payoutCents,
          miskShareCents: k.grossCents - k.payoutCents,
          ratingAverage: k.ratingAverage,
          ratingCount: k.ratingCount,
          onTimePct: k.timedJobs ? Math.round((k.onTimeJobs * 100) / k.timedJobs) : null,
        },
        weekly: weekly.rows.map((w) => ({ ...w, bookings: w.oneOff + w.visits })),
        attention: attention.rows[0],
      };
    },
  );

  /**
   * What changes minute by minute, polled by the overview: waiting applications and the bookings around now.
   * Applications are only sent to team members who may open Providers.
   */
  app.get('/admin/overview/live', { preHandler: guards.admin }, async (request) => {
    const mayReview = canOpen(currentUser(request).adminRole ?? null, 'providers');
    const [bookings, applications] = await Promise.all([
      pool.query(
        `${ITEMS}
         SELECT * FROM (
           SELECT kind, id, number, starts_at AS "startsAt", ends_at AS "endsAt", service, customer, address, postcode, pro,
             status, value_cents AS "valueCents", problem, tab
           FROM items
           WHERE NOT (kind = 'booking' AND status = 'awaiting_payment')
           ORDER BY abs(extract(epoch FROM starts_at - now())) ASC
           LIMIT ${LIVE_ROWS}
         ) nearest
         ORDER BY "startsAt", number`,
      ),
      mayReview
        ? pool.query<{
            id: string;
            firstName: string | null;
            lastName: string | null;
            trades: string[];
            documentsUploaded: number;
            waiting: number;
          }>(
            `SELECT p.user_id AS id, u.first_name AS "firstName", u.last_name AS "lastName",
               COALESCE((SELECT array_agg(c.name ORDER BY c.name) FROM pro_trades t JOIN categories c ON c.id = t.category_id
                         WHERE t.pro_id = p.user_id), '{}') AS trades,
               (SELECT count(*)::int FROM pro_documents d WHERE d.pro_id = p.user_id) AS "documentsUploaded",
               count(*) OVER ()::int AS waiting
             FROM pro_profiles p JOIN users u ON u.id = p.user_id
             WHERE p.status = 'submitted'
             ORDER BY p.submitted_at ASC NULLS LAST, p.user_id
             LIMIT ${LISTED_APPLICATIONS}`,
          )
        : null,
    ]);
    let applicationList = null;
    if (applications) {
      const pros = await Promise.all(
        applications.rows.map(async (row) => {
          const checks = await loadChecks(pool, row.id, timezone);
          return {
            id: row.id,
            firstName: row.firstName,
            lastName: row.lastName,
            trades: row.trades,
            documentsUploaded: row.documentsUploaded,
            documentsTotal: DOCUMENT_KINDS.length,
            ready: checks.every((c) => c.ok),
          };
        }),
      );
      applicationList = { waiting: applications.rows[0]?.waiting ?? 0, pros };
    }
    return { bookings: bookings.rows, applications: applicationList };
  });
}
