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
 * - needs_action: no pro, a problem the customer reported, an on-site issue the pro reported (D86), still searching under 2 hours before the start,
 *   money still held on a cancelled job, a failed payout, or a plan visit whose time passed without completion
 * - live: a pro is on the way or working, or a plan visit is happening now
 * - upcoming: booked and not yet started
 * - done: finished, cancelled or skipped
 */
const PER_MONTH_CASES = Object.entries(VISITS_PER_MONTH)
  .map(([frequency, visits]) => `WHEN '${frequency}' THEN ${visits}`)
  .join(' ');

/** First and last initial of the pro, or the first two letters of the first name when there is no last name. NULL without a pro. */
const PRO_INITIALS = `CASE WHEN pu.id IS NULL THEN NULL
  WHEN COALESCE(pu.last_name, '') <> '' THEN upper(left(pu.first_name, 1) || left(pu.last_name, 1))
  ELSE upper(left(COALESCE(pu.first_name, ''), 2)) END`;
const REASON_CHARS = 80;

/** Pro-reported reasons, "Unsafe to work" first (D94). Only the reason key is sent; the page words it. */
export interface ListAlert {
  level: 'problem' | 'warning';
  key: string;
  params?: Record<string, string | number>;
}

interface AlertInput {
  kind: string;
  status: string;
  paymentStatus: string;
  startsAt: Date;
  pro: string | null;
  problem: boolean;
  problemNote: string | null;
  issueReason: string | null;
  lateWarned: boolean;
  extraPending: boolean;
  payoutFailed: boolean;
}

const RAW_ALERT_FIELDS = ['problemNote', 'issueReason', 'lateWarned', 'extraPending', 'payoutFailed'] as const;

/**
 * The short lines a board card shows, worked out from the row so the list stays one query (D96).
 * Problems (red) come first, then warnings (orange); "Unsafe to work" leads the problems.
 */
export function listAlerts(row: AlertInput, now: Date = new Date()): ListAlert[] {
  const problems: ListAlert[] = [];
  const warnings: ListAlert[] = [];
  const minutesToStart = (row.startsAt.getTime() - now.getTime()) / 60000;
  if (row.issueReason) {
    const alert: ListAlert = { level: 'problem', key: 'issue', params: { reason: row.issueReason } };
    if (row.issueReason === 'unsafe') problems.unshift(alert);
    else problems.push(alert);
  }
  if (row.problem) {
    problems.push(
      row.problemNote ? { level: 'problem', key: 'problemWithReason', params: { reason: row.problemNote } } : { level: 'problem', key: 'problem' },
    );
  }
  if (row.kind === 'booking') {
    if (row.paymentStatus === 'failed') problems.push({ level: 'problem', key: 'paymentFailed' });
    if (row.payoutFailed) problems.push({ level: 'problem', key: 'payoutFailed' });
    if (!row.pro && row.status === 'unassigned') problems.push({ level: 'problem', key: 'noPro' });
    if (row.status === 'searching' && minutesToStart < 120) {
      warnings.push({ level: 'warning', key: 'searching', params: { minutes: Math.max(0, Math.round(minutesToStart)) } });
    }
    if (row.lateWarned) warnings.push({ level: 'warning', key: 'late' });
    if (row.extraPending) warnings.push({ level: 'warning', key: 'extraPending' });
    if (row.status === 'completed' && row.paymentStatus === 'held' && !row.problem) warnings.push({ level: 'warning', key: 'charging' });
  }
  return [...problems, ...warnings];
}

export const ITEMS = `
  WITH items AS (
    SELECT 'booking' AS kind, b.id, 'B-' || b.number AS number, b.starts_at, b.ends_at, b.service_name AS service,
      b.category_id, cat.name AS trade, cu.first_name AS customer, b.address, b.postcode, pu.first_name AS pro,
      b.status::text AS status,
      b.price_cents + b.fee_cents + COALESCE((SELECT sum(e.price_cents) FROM extra_requests e
        WHERE e.booking_id = b.id AND e.status = 'approved' AND e.funded_by = 'customer'), 0)::int AS value_cents,
      b.payment_status::text AS payment_status,
      (b.problem_reported_at IS NOT NULL AND b.problem_resolved_at IS NULL) AS problem,
      EXISTS (SELECT 1 FROM booking_issues i WHERE i.booking_id = b.id AND i.resolved_at IS NULL) AS pro_issue,
      -- A pro who reported "Unsafe to work" goes to the very top of Needs action (D94).
      EXISTS (SELECT 1 FROM booking_issues i WHERE i.booking_id = b.id AND i.resolved_at IS NULL AND i.reason = 'unsafe') AS urgent,
      CASE
        WHEN b.status = 'unassigned'
          OR (b.problem_reported_at IS NOT NULL AND b.problem_resolved_at IS NULL)
          OR EXISTS (SELECT 1 FROM booking_issues i WHERE i.booking_id = b.id AND i.resolved_at IS NULL)
          OR (b.status = 'searching' AND b.starts_at < now() + interval '2 hours')
          OR (b.status = 'cancelled' AND b.payment_status = 'held')
          OR EXISTS (SELECT 1 FROM payouts p WHERE p.booking_id = b.id AND p.status = 'failed') THEN 'needs_action'
        WHEN b.status IN ('on_the_way', 'working') THEN 'live'
        WHEN b.status IN ('awaiting_payment', 'searching', 'accepted') THEN 'upcoming'
        ELSE 'done'
      END AS tab,
      -- Full names, so search finds "Anna Schmidt" as well as "Anna".
      concat_ws(' ', cu.first_name, cu.last_name) AS customer_full, concat_ws(' ', pu.first_name, pu.last_name) AS pro_full,
      -- What a board card needs (D96): only initials of the pro, never more personal data.
      ${PRO_INITIALS} AS pro_initials,
      left(b.problem_note, ${REASON_CHARS}) AS problem_note,
      (SELECT i.reason FROM booking_issues i WHERE i.booking_id = b.id AND i.resolved_at IS NULL LIMIT 1) AS issue_reason,
      (b.late_warned_at IS NOT NULL AND b.status IN ('accepted', 'on_the_way')) AS late_warned,
      EXISTS (SELECT 1 FROM extra_requests e WHERE e.booking_id = b.id AND e.status = 'pending') AS extra_pending,
      EXISTS (SELECT 1 FROM payouts p WHERE p.booking_id = b.id AND p.status = 'failed') AS payout_failed
    FROM bookings b
    JOIN users cu ON cu.id = b.customer_id
    LEFT JOIN users pu ON pu.id = b.pro_id
    JOIN categories cat ON cat.id = b.category_id
    UNION ALL
    SELECT 'visit', v.id, 'V-' || v.number, v.starts_at, v.ends_at, s.plan_name, s.category_id, cat.name,
      cu.first_name, s.address, s.postcode, pu.first_name, v.status::text,
      round(s.price_cents / CASE s.frequency ${PER_MONTH_CASES} END)::int,
      s.status::text, false, false, false,
      CASE
        WHEN v.status = 'planned' AND v.ends_at <= now() THEN 'needs_action'
        WHEN v.status = 'planned' AND v.starts_at <= now() THEN 'live'
        WHEN v.status = 'planned' THEN 'upcoming'
        ELSE 'done'
      END,
      concat_ws(' ', cu.first_name, cu.last_name), concat_ws(' ', pu.first_name, pu.last_name),
      ${PRO_INITIALS}, NULL, NULL, false, false, false
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
  AND ($3::text IS NULL OR number ILIKE '%' || $3 || '%' OR customer_full ILIKE '%' || $3 || '%'
       OR address ILIKE '%' || $3 || '%' OR postcode ILIKE '%' || $3 || '%' OR pro_full ILIKE '%' || $3 || '%')`;

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
             problem, pro_issue AS "proIssue", urgent, tab, pro_initials AS "proInitials",
             problem_note AS "problemNote", issue_reason AS "issueReason", late_warned AS "lateWarned",
             extra_pending AS "extraPending", payout_failed AS "payoutFailed"
           FROM items
           WHERE ${FILTERS} AND ($4::text = 'all' OR tab = $4)
           ORDER BY urgent DESC, (tab = 'needs_action') DESC, abs(extract(epoch FROM starts_at - now())) ASC
           LIMIT ${MAX_LISTED}`,
          [...params, tab],
        ),
        pool.query<{ tab: Tab; n: number }>(`${ITEMS} SELECT tab, count(*)::int AS n FROM items WHERE ${FILTERS} GROUP BY tab`, params),
      ]);
      const byTab = Object.fromEntries(counts.rows.map((row) => [row.tab, row.n]));
      const total = counts.rows.reduce((sum, row) => sum + row.n, 0);
      const now = new Date();
      const bookings = (rows.rows as AlertInput[]).map((row) => {
        // The raw reasons stay on the server: the card gets the finished lines.
        const item = Object.fromEntries(Object.entries(row).filter(([key]) => !(RAW_ALERT_FIELDS as readonly string[]).includes(key)));
        return { ...item, alerts: listAlerts(row, now) };
      });
      return {
        bookings,
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
           json_build_object('id', pu.id, 'firstName', pu.first_name, 'phone', pu.phone) AS pro,
           -- The customer's pause that called this visit off (D78), shown read-only to the team.
           (SELECT json_build_object('startsOn', to_char(pz.starts_on, 'YYYY-MM-DD'), 'endsOn', to_char(pz.starts_on + pz.weeks * 7, 'YYYY-MM-DD'),
              'creditCents', pz.credit_cents, 'visitsCalledOff', pz.visits_called_off)
            FROM subscription_pauses pz WHERE pz.id = v.paused_by AND pz.status = 'active') AS pause
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
