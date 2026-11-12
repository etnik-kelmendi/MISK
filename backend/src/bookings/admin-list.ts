import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import { uuidParams } from '../http.js';
import { proShareCents } from '../catalogue/pricing.js';
import { VISITS_PER_MONTH, type Frequency } from '../plans/routes.js';
import { loadCustomerProfile } from './customer-profile.js';

export const TABS = ['all', 'needs_action', 'live', 'upcoming', 'done'] as const;
export type Tab = (typeof TABS)[number];

/**
 * One-off bookings and plan visits as one list, each in exactly one tab:
 * - needs_action: no pro, a problem the customer reported, still searching under 2 hours before the start,
 *   money still held on a cancelled job, a failed payout, or a plan visit whose time passed without completion
 * - live: a pro is on the way or working, or a plan visit is happening now
 * - upcoming: booked and not yet started
 * - done: finished, cancelled or skipped
 */
const PER_MONTH_CASES = Object.entries(VISITS_PER_MONTH)
  .map(([frequency, visits]) => `WHEN '${frequency}' THEN ${visits}`)
  .join(' ');

export const ITEMS = `
  WITH items AS (
    SELECT 'booking' AS kind, b.id, 'B-' || b.number AS number, b.starts_at, b.ends_at, b.service_name AS service,
      b.category_id, cat.name AS trade, cu.first_name AS customer, b.address, b.postcode, pu.first_name AS pro,
      b.status::text AS status,
      b.price_cents + b.fee_cents + COALESCE((SELECT sum(e.price_cents) FROM extra_requests e
        WHERE e.booking_id = b.id AND e.status = 'approved'), 0)::int AS value_cents,
      b.payment_status::text AS payment_status,
      (b.problem_reported_at IS NOT NULL AND b.problem_resolved_at IS NULL) AS problem,
      CASE
        WHEN b.status = 'unassigned'
          OR (b.problem_reported_at IS NOT NULL AND b.problem_resolved_at IS NULL)
          OR (b.status = 'searching' AND b.starts_at < now() + interval '2 hours')
          OR (b.status = 'cancelled' AND b.payment_status = 'held')
          OR EXISTS (SELECT 1 FROM payouts p WHERE p.booking_id = b.id AND p.status = 'failed') THEN 'needs_action'
        WHEN b.status IN ('on_the_way', 'working') THEN 'live'
        WHEN b.status IN ('awaiting_payment', 'searching', 'accepted') THEN 'upcoming'
        ELSE 'done'
      END AS tab
    FROM bookings b
    JOIN users cu ON cu.id = b.customer_id
    LEFT JOIN users pu ON pu.id = b.pro_id
    JOIN categories cat ON cat.id = b.category_id
    UNION ALL
    SELECT 'visit', v.id, 'V-' || v.number, v.starts_at, v.ends_at, s.plan_name, s.category_id, cat.name,
      cu.first_name, s.address, s.postcode, pu.first_name, v.status::text,
      round(s.price_cents / CASE s.frequency ${PER_MONTH_CASES} END)::int,
      s.status::text, false,
      CASE
        WHEN v.status = 'planned' AND v.ends_at <= now() THEN 'needs_action'
        WHEN v.status = 'planned' AND v.starts_at <= now() THEN 'live'
        WHEN v.status = 'planned' THEN 'upcoming'
        ELSE 'done'
      END
    FROM subscription_visits v
    JOIN subscriptions s ON s.id = v.subscription_id
    JOIN users cu ON cu.id = s.customer_id
    JOIN users pu ON pu.id = v.pro_id
    JOIN categories cat ON cat.id = s.category_id
    -- Plan visits repeat forever, so only those of the last 90 days and the planning window are listed.
    WHERE v.status <> 'pending' AND v.starts_at > now() - interval '90 days'
  )`;

const FILTERS = `
  ($1::uuid IS NULL OR category_id = $1)
  AND ($2::text IS NULL OR kind = $2)
  AND ($3::text IS NULL OR number ILIKE '%' || $3 || '%' OR customer ILIKE '%' || $3 || '%'
       OR address ILIKE '%' || $3 || '%' OR postcode ILIKE '%' || $3 || '%' OR pro ILIKE '%' || $3 || '%')`;

export const MAX_LISTED = 500;

export async function adminListRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards } = ctx;

  app.get<{ Querystring: { tab?: Tab; q?: string; trade?: string; type?: 'booking' | 'visit' } }>(
    '/admin/bookings',
    {
      preHandler: guards.admin,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tab: { type: 'string', enum: TABS },
            q: { type: 'string', maxLength: 60 },
            trade: { type: 'string', format: 'uuid' },
            type: { type: 'string', enum: ['booking', 'visit'] },
          },
        },
      },
    },
    async (request) => {
      const tab = request.query.tab ?? 'all';
      // Matching is case-insensitive and partial, so "b-1042", "1042" and "B-1042" all find booking B-1042.
      const q = request.query.q?.trim() || null;
      const params = [request.query.trade ?? null, request.query.type ?? null, q];
      const [rows, counts] = await Promise.all([
        pool.query(
          `${ITEMS}
           SELECT kind, id, number, starts_at AS "startsAt", ends_at AS "endsAt", service, category_id AS "categoryId", trade,
             customer, address, postcode, pro, status, value_cents AS "valueCents", payment_status AS "paymentStatus",
             problem, tab
           FROM items
           WHERE ${FILTERS} AND ($4::text = 'all' OR tab = $4)
           ORDER BY (tab = 'needs_action') DESC, abs(extract(epoch FROM starts_at - now())) ASC
           LIMIT ${MAX_LISTED}`,
          [...params, tab],
        ),
        pool.query<{ tab: Tab; n: number }>(`${ITEMS} SELECT tab, count(*)::int AS n FROM items WHERE ${FILTERS} GROUP BY tab`, params),
      ]);
      const byTab = Object.fromEntries(counts.rows.map((row) => [row.tab, row.n]));
      const total = counts.rows.reduce((sum, row) => sum + row.n, 0);
      return {
        bookings: rows.rows,
        counts: {
          all: total,
          needs_action: byTab.needs_action ?? 0,
          live: byTab.live ?? 0,
          upcoming: byTab.upcoming ?? 0,
          done: byTab.done ?? 0,
        },
        truncated: rows.rowCount === MAX_LISTED,
      };
    },
  );

  // A plan visit's details, for the same side panel as bookings.
  app.get<{ Params: { id: string } }>(
    '/admin/visits/:id',
    { preHandler: guards.admin, schema: { params: uuidParams } },
    async (request) => {
      const found = await pool.query<{ priceCents: number; proSharePct: number; frequency: Frequency; customerId: string }>(
        `SELECT v.id, 'V-' || v.number AS number, v.starts_at AS "startsAt", v.ends_at AS "endsAt", v.status, v.tasks_done AS "tasksDone",
           v.completed_at AS "completedAt", s.id AS "subscriptionId", s.plan_name AS "planName", s.tasks, s.address, s.postcode,
           s.customer_id AS "customerId", s.notes, s.price_cents AS "priceCents", s.pro_share_pct AS "proSharePct", s.frequency, s.status AS "subscriptionStatus",
           cat.name AS "categoryName",
           json_build_object('firstName', cu.first_name, 'lastName', cu.last_name, 'phone', cu.phone, 'email', cu.email) AS customer,
           json_build_object('id', pu.id, 'firstName', pu.first_name, 'phone', pu.phone) AS pro
         FROM subscription_visits v JOIN subscriptions s ON s.id = v.subscription_id
         JOIN users cu ON cu.id = s.customer_id JOIN users pu ON pu.id = v.pro_id JOIN categories cat ON cat.id = s.category_id
         WHERE v.id = $1`,
        [request.params.id],
      );
      const visit = found.rows[0];
      if (!visit) {
        throw notFound();
      }
      const proMonthly = proShareCents(visit.priceCents, visit.proSharePct);
      const { customerId, ...rest } = visit;
      return {
        visit: {
          ...rest,
          customerProfile: await loadCustomerProfile(pool, customerId),
          perVisitCents: Math.round(visit.priceCents / VISITS_PER_MONTH[visit.frequency]),
          proMonthlyCents: proMonthly,
          miskMonthlyCents: visit.priceCents - proMonthly,
        },
      };
    },
  );
}
