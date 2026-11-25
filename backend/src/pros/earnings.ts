import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import type { BookingDeps } from '../bookings/events.js';
import { CHARGE_DELAY_HOURS } from '../bookings/lifecycle.js';
import { renderPdf, type PdfLine } from '../bookings/pdf.js';
import type { AppContext } from '../context.js';
import { withTransaction, type Queryable } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import type { PaymentGateway } from '../payments/gateway.js';
import { nextPayoutDate, type PayoutInterval } from '../payments/payouts.js';
import { visitCentsSql } from '../subscriptions/stand-ins.js';
import { marketToday } from './checks.js';

/**
 * The pro's Earnings page (D99). Every amount comes from what was stored when the money moved: the pro share
 * copied onto each booking and plan, the payouts sent to the pro's Stripe account, captured tips, and MISK's record
 * of each payout to the bank. Today's commission setting never changes a past job.
 *
 * A one-off job is
 * - On hold while the customer's problem report is open,
 * - Pending until its money is taken (24 hours after completion, the customer's review time),
 * - Ready once the pro's share is released to their Stripe account, until a payout day pays it to the bank,
 * - Paid once a payout to the bank holds all of it.
 * A plan visit is worth its fixed payout per visit (the plan's monthly share over its visits a month): Pending for
 * 24 hours after it is done, then Ready, then Paid.
 */

/** "stand_in" marks a regular pro's plan visit that a stand-in did and was paid for (D99): no amount, in All only. */
export const EARNING_STATUSES = ['pending', 'ready', 'paid', 'on_hold', 'stand_in'] as const;
export type EarningStatus = (typeof EARNING_STATUSES)[number];
/** The filter buttons: Pending includes On hold. */
export const EARNING_FILTERS = ['all', 'pending', 'ready', 'paid'] as const;
export type EarningFilter = (typeof EARNING_FILTERS)[number];
/** Earnings listed per page by default and at most, and the furthest a page can start. */
const DEFAULT_PAGE = 20;
const MAX_PAGE = 50;
const MAX_OFFSET = 10_000;
/** Past payouts listed on the page. */
const LISTED_PAYOUTS = 12;
/** The most lines one statement lists; a month of full-time work stays far below it. */
const STATEMENT_MAX_ITEMS = 1000;
/** The oldest month a statement can be asked for. */
const FIRST_STATEMENT_MONTH = '2026-01';

/** SQL: the fixed payout of one visit of plan `s`, like the pro's schedule shows it. */
const VISIT_CENTS = visitCentsSql('s');
/**
 * SQL: a plan visit done by a stand-in can go into a payout to the stand-in's bank only once its own transfer to
 * the stand-in was sent (D99).
 */
const STAND_IN_SENT = `(v.stand_in_for IS NULL OR EXISTS (SELECT 1 FROM subscription_payouts sip WHERE sip.visit_id = v.id AND sip.status = 'sent'))`;

/**
 * Every earning of the pro `$1` as one list: one-off jobs (finished, or late-cancelled / no-show jobs that paid
 * the pro) and finished plan visits. `you_get` is what the pro gets; `unpaid` the part not yet paid to the bank.
 */
const ITEMS = `
  WITH job_rows AS (
    SELECT b.id, b.starts_at, b.service_name, cu.first_name AS customer_name, b.price_cents, b.pro_share_pct,
      CASE WHEN b.no_show_at IS NOT NULL THEN 'no_show' WHEN b.late_cancel THEN 'late_cancel' ELSE 'job' END AS job_kind,
      COALESCE((SELECT json_agg(json_build_object('label', e.description, 'kind', e.kind, 'cents', e.price_cents) ORDER BY e.created_at)
        FROM extra_requests e WHERE e.booking_id = b.id AND e.status = 'approved'), '[]'::json) AS extras,
      COALESCE(t.pro_cents, 0) AS tip_cents,
      (b.problem_reported_at IS NOT NULL AND b.problem_resolved_at IS NULL) AS problem_open,
      EXISTS (SELECT 1 FROM payouts mp WHERE mp.booking_id = b.id AND mp.payment_intent_id = b.payment_intent_id AND mp.status <> 'reversed')
        AS released,
      (SELECT COALESCE(sum(po.amount_cents), 0)::int FROM payouts po WHERE po.booking_id = b.id AND po.pro_id = $1 AND po.status <> 'reversed')
        AS live_cents,
      (SELECT COALESCE(sum(po.amount_cents), 0)::int FROM payouts po
        WHERE po.booking_id = b.id AND po.pro_id = $1 AND po.status <> 'reversed' AND po.bank_payout_id IS NULL) AS unpaid_cents,
      floor(b.price_cents * b.pro_share_pct / 100.0)::int
        + COALESCE((SELECT sum(floor(e.price_cents * b.pro_share_pct / 100.0)) FROM extra_requests e
                    WHERE e.booking_id = b.id AND e.status = 'approved'), 0)::int
        + COALESCE(t.pro_cents, 0) AS projected_cents
    FROM bookings b
    JOIN users cu ON cu.id = b.customer_id
    LEFT JOIN tips t ON t.booking_id = b.id AND t.status = 'captured'
    WHERE b.pro_id = $1
      AND (b.status = 'completed' OR b.late_cancel OR b.no_show_at IS NOT NULL)
  ),
  items AS (
    SELECT 'job' AS kind, j.id, j.starts_at AS at, j.service_name AS title, j.customer_name,
      CASE WHEN j.problem_open THEN 'on_hold' WHEN NOT j.released THEN 'pending' WHEN j.unpaid_cents > 0 THEN 'ready' ELSE 'paid' END AS status,
      CASE WHEN j.problem_open OR NOT j.released THEN j.projected_cents ELSE j.live_cents END AS you_get,
      CASE WHEN j.released AND NOT j.problem_open THEN j.unpaid_cents ELSE 0 END AS unpaid,
      j.price_cents, j.pro_share_pct, j.job_kind, j.extras, j.tip_cents
    FROM job_rows j
    -- A job whose money was given back (refunded or released) earns nothing and is left out.
    WHERE j.released OR (j.job_kind = 'job' AND EXISTS (
      SELECT 1 FROM bookings pb WHERE pb.id = j.id AND pb.payment_status IN ('pending', 'held', 'failed')))
    UNION ALL
    SELECT 'visit', v.id, v.starts_at, s.plan_name, cu.first_name,
      CASE WHEN v.completed_at > now() - make_interval(hours => ${CHARGE_DELAY_HOURS}) THEN 'pending'
           WHEN v.bank_payout_id IS NULL THEN 'ready' ELSE 'paid' END,
      ${VISIT_CENTS},
      CASE WHEN v.completed_at <= now() - make_interval(hours => ${CHARGE_DELAY_HOURS}) AND v.bank_payout_id IS NULL THEN ${VISIT_CENTS} ELSE 0 END,
      NULL::int, NULL::int, NULL::text, NULL::json, 0
    FROM subscription_visits v
    JOIN subscriptions s ON s.id = v.subscription_id
    JOIN users cu ON cu.id = s.customer_id
    WHERE v.pro_id = $1 AND v.status = 'completed'
    UNION ALL
    -- The regular pro's visits a stand-in did (D99): listed, but paid to the stand-in, so worth nothing here.
    SELECT 'stand_in', v.id, v.starts_at, s.plan_name, cu.first_name, 'stand_in', 0, 0,
      NULL::int, NULL::int, NULL::text, NULL::json, 0
    FROM subscription_visits v
    JOIN subscriptions s ON s.id = v.subscription_id
    JOIN users cu ON cu.id = s.customer_id
    WHERE v.stand_in_for = $1 AND v.pro_id <> $1 AND v.status = 'completed'
  )`;

interface ItemRow {
  kind: 'job' | 'visit' | 'stand_in';
  id: string;
  at: Date;
  title: string;
  customer_name: string | null;
  status: EarningStatus;
  you_get: number;
  price_cents: number | null;
  pro_share_pct: number | null;
  job_kind: 'job' | 'late_cancel' | 'no_show' | null;
  extras: { label: string; kind: 'work' | 'waiting'; cents: number }[] | null;
  tip_cents: number;
}

/** What a one-off job was worth, line by line: the price, approved extras and waiting time, commission and tip. */
export interface EarningBreakdown {
  type: 'job' | 'late_cancel' | 'no_show';
  lines: { kind: 'job' | 'extra' | 'waiting'; label: string; cents: number }[];
  /** MISK's commission as stored on the booking (100 minus the pro share); null for a call-out fee. */
  commissionPct: number | null;
  commissionCents: number;
  tipCents: number;
}

export interface EarningItem {
  kind: 'job' | 'visit' | 'stand_in';
  id: string;
  date: Date;
  title: string;
  customerName: string | null;
  status: EarningStatus;
  youGetCents: number;
  /** Null for a plan visit: a fixed payout per visit. */
  breakdown: EarningBreakdown | null;
}

const share = (cents: number, pct: number) => Math.floor((cents * pct) / 100);

function toItem(row: ItemRow): EarningItem {
  const base = { kind: row.kind, id: row.id, date: row.at, title: row.title, customerName: row.customer_name, status: row.status, youGetCents: row.you_get };
  if (row.kind !== 'job' || row.price_cents === null || row.pro_share_pct === null || !row.job_kind) {
    return { ...base, breakdown: null };
  }
  if (row.job_kind === 'no_show') {
    // The call-out fee and paid waiting at the door (D94): the pro's amount is what was paid out.
    return { ...base, breakdown: { type: 'no_show', lines: [], commissionPct: null, commissionCents: 0, tipCents: row.tip_cents } };
  }
  const pct = row.pro_share_pct;
  const lines: EarningBreakdown['lines'] = [
    { kind: 'job', label: row.title, cents: row.price_cents },
    ...(row.extras ?? []).map((extra) => ({ kind: extra.kind === 'waiting' ? ('waiting' as const) : ('extra' as const), label: extra.label, cents: extra.cents })),
  ];
  const gross = lines.reduce((sum, line) => sum + line.cents, 0);
  const proPart = lines.reduce((sum, line) => sum + share(line.cents, pct), 0);
  return {
    ...base,
    breakdown: { type: row.job_kind, lines, commissionPct: 100 - pct, commissionCents: gross - proPart, tipCents: row.tip_cents },
  };
}

const STATUS_FILTER = `($2::text = 'all' OR status = $2 OR ($2 = 'pending' AND status = 'on_hold'))`;

/** One page of the pro's earnings, newest first. */
export async function loadEarningItems(
  db: Queryable,
  proId: string,
  options: { filter: EarningFilter; limit: number; offset: number },
): Promise<{ items: EarningItem[]; hasMore: boolean }> {
  const found = await db.query<ItemRow>(
    `${ITEMS} SELECT * FROM items WHERE ${STATUS_FILTER} ORDER BY at DESC, id LIMIT $3 OFFSET $4`,
    [proId, options.filter, options.limit + 1, options.offset],
  );
  return { items: found.rows.slice(0, options.limit).map(toItem), hasMore: found.rows.length > options.limit };
}

export interface EarningsSummary {
  /** Released to the pro and going out on the next payout day. */
  readyCents: number;
  /** Still in the customer's 24-hour review, or on hold after a problem report. */
  pendingCents: number;
  /** Paid to the bank this calendar month (market time zone). */
  paidThisMonthCents: number;
  nextPayoutOn: string;
  interval: PayoutInterval;
  bankLast4: string | null;
}

/** The three totals, the next payout day and the bank account they go to. */
export async function loadEarningsSummary(
  db: Queryable,
  provider: { gateway: PaymentGateway; log: FastifyBaseLogger },
  proId: string,
  timezone: string,
): Promise<EarningsSummary> {
  const today = marketToday(timezone);
  const [totals, settings] = await Promise.all([
    db.query<{ readyCents: number; pendingCents: number; paidThisMonthCents: number }>(
      `${ITEMS}
       SELECT COALESCE(sum(unpaid) FILTER (WHERE status = 'ready'), 0)::int AS "readyCents",
         COALESCE(sum(you_get) FILTER (WHERE status IN ('pending', 'on_hold')), 0)::int AS "pendingCents",
         (SELECT COALESCE(sum(bp.amount_cents), 0)::int FROM pro_bank_payouts bp
          WHERE bp.pro_id = $1 AND to_char(bp.paid_on, 'YYYY-MM') = $2) AS "paidThisMonthCents"
       FROM items`,
      [proId, today.slice(0, 7)],
    ),
    db.query<{ interval: PayoutInterval; account: string | null }>(
      'SELECT s.payout_interval AS interval, p.stripe_account_id AS account FROM settings s, pro_profiles p WHERE p.user_id = $1',
      [proId],
    ),
  ]);
  const setting = settings.rows[0];
  if (!setting) {
    throw notFound('profile_not_found');
  }
  let bankLast4: string | null = null;
  if (setting.account) {
    try {
      bankLast4 = (await provider.gateway.payoutDetails(setting.account)).bankLast4;
    } catch (error) {
      provider.log.error({ event: 'payout_details_failed', proId, err: error });
    }
  }
  const row = totals.rows[0] ?? { readyCents: 0, pendingCents: 0, paidThisMonthCents: 0 };
  return { ...row, nextPayoutOn: nextPayoutDate(setting.interval, today), interval: setting.interval, bankLast4 };
}

export interface BankPayout {
  id: string;
  paidOn: string;
  amountCents: number;
  bankLast4: string | null;
}

async function loadBankPayouts(db: Queryable, proId: string, options: { month?: string; limit: number }): Promise<BankPayout[]> {
  const found = await db.query<BankPayout>(
    `SELECT id, to_char(paid_on, 'YYYY-MM-DD') AS "paidOn", amount_cents AS "amountCents", bank_last4 AS "bankLast4"
     FROM pro_bank_payouts WHERE pro_id = $1 AND ($2::text IS NULL OR to_char(paid_on, 'YYYY-MM') = $2)
     ORDER BY paid_on DESC LIMIT $3`,
    [proId, options.month ?? null, options.limit],
  );
  return found.rows;
}

/**
 * On a payout day (Settings: weekly on Fridays, every other Friday, or monthly on the 1st), records for each pro
 * what that payout pays to their bank: every share already sent to their Stripe account and every plan visit past
 * its 24 hours, none of them in an earlier payout. Stripe moves the money on the same schedule (D33); this is
 * MISK's own record, so the pro sees what each payout held. Safe to run on several servers and to run again: one
 * record per pro and day, claimed by a unique key. Returns how many payouts it recorded.
 */
export async function recordBankPayouts(deps: BookingDeps, today = marketToday(deps.config.timezone)): Promise<number> {
  const setting = await deps.pool.query<{ interval: PayoutInterval }>('SELECT payout_interval AS interval FROM settings');
  const interval = setting.rows[0]?.interval ?? 'weekly';
  if (nextPayoutDate(interval, today) !== today) {
    return 0;
  }
  const due = await deps.pool.query<{ user_id: string; stripe_account_id: string }>(
    `SELECT p.user_id, p.stripe_account_id FROM pro_profiles p
     WHERE p.stripe_account_id IS NOT NULL AND p.payouts_enabled
       AND NOT EXISTS (SELECT 1 FROM pro_bank_payouts bp WHERE bp.pro_id = p.user_id AND bp.paid_on = $1::date)
       AND (EXISTS (SELECT 1 FROM payouts po WHERE po.pro_id = p.user_id AND po.status = 'sent' AND po.bank_payout_id IS NULL)
         OR EXISTS (SELECT 1 FROM subscription_visits v WHERE v.pro_id = p.user_id AND v.status = 'completed'
                    AND v.bank_payout_id IS NULL AND v.completed_at <= now() - make_interval(hours => $2) AND ${STAND_IN_SENT}))
     ORDER BY p.user_id LIMIT 25`,
    [today, CHARGE_DELAY_HOURS],
  );
  let recorded = 0;
  for (const pro of due.rows) {
    let bankLast4: string | null = null;
    try {
      bankLast4 = (await deps.gateway.payoutDetails(pro.stripe_account_id)).bankLast4;
    } catch (error) {
      // The payout is still recorded; only the account digits are missing from it.
      deps.log.error({ event: 'payout_details_failed', proId: pro.user_id, err: error });
    }
    const amount = await withTransaction(deps.pool, async (client) => {
      const created = await client.query<{ id: string }>(
        `INSERT INTO pro_bank_payouts (pro_id, paid_on, amount_cents, bank_last4) VALUES ($1, $2, 0, $3)
         ON CONFLICT (pro_id, paid_on) DO NOTHING RETURNING id`,
        [pro.user_id, today, bankLast4 && /^\d{4}$/.test(bankLast4) ? bankLast4 : null],
      );
      const id = created.rows[0]?.id;
      if (!id) {
        return null;
      }
      const jobs = await client.query<{ cents: number }>(
        `UPDATE payouts SET bank_payout_id = $1, updated_at = now()
         WHERE pro_id = $2 AND status = 'sent' AND bank_payout_id IS NULL RETURNING amount_cents AS cents`,
        [id, pro.user_id],
      );
      const visits = await client.query<{ cents: number }>(
        `UPDATE subscription_visits v SET bank_payout_id = $1 FROM subscriptions s
         WHERE s.id = v.subscription_id AND v.pro_id = $2 AND v.status = 'completed' AND v.bank_payout_id IS NULL
           AND v.completed_at <= now() - make_interval(hours => $3) AND ${STAND_IN_SENT}
         RETURNING ${VISIT_CENTS} AS cents`,
        [id, pro.user_id, CHARGE_DELAY_HOURS],
      );
      const total = [...jobs.rows, ...visits.rows].reduce((sum, row) => sum + row.cents, 0);
      await client.query('UPDATE pro_bank_payouts SET amount_cents = $2 WHERE id = $1', [id, total]);
      return total;
    });
    if (amount !== null) {
      recorded += 1;
      deps.log.info({ event: 'bank_payout_recorded', proId: pro.user_id, paidOn: today, amountCents: amount });
    }
  }
  return recorded;
}

export const bankPayoutTick = (deps: BookingDeps) => recordBankPayouts(deps);

// ---------- Statement PDF ----------

function euro(cents: number): string {
  return `${cents < 0 ? '-' : ''}€${(Math.abs(cents) / 100).toFixed(2)}`;
}

const STATUS_TEXT: Record<EarningStatus, string> = { pending: 'Pending', ready: 'Ready', paid: 'Paid', on_hold: 'On hold', stand_in: 'Stand-in' };

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** "November 2026" for "2026-11". */
function monthName(month: string): string {
  return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T12:00:00Z`));
}

export interface Statement {
  month: string;
  proName: string;
  items: EarningItem[];
  payouts: BankPayout[];
}

/** The pro's earnings of one month (by the day of the job, market time zone) and the payouts made in it. */
export async function loadStatement(db: Queryable, proId: string, month: string, timezone: string): Promise<Statement> {
  const [person, rows, payouts] = await Promise.all([
    db.query<{ name: string }>("SELECT concat_ws(' ', first_name, last_name) AS name FROM users WHERE id = $1", [proId]),
    db.query<ItemRow>(
      `${ITEMS} SELECT * FROM items WHERE to_char(at AT TIME ZONE $2, 'YYYY-MM') = $3 ORDER BY at, id LIMIT ${STATEMENT_MAX_ITEMS}`,
      [proId, timezone, month],
    ),
    loadBankPayouts(db, proId, { month, limit: 31 }),
  ]);
  return { month, proName: person.rows[0]?.name ?? '', items: rows.rows.map(toItem), payouts: payouts.slice().reverse() };
}

const MARGIN = 40;
const RIGHT = 555;
const PAGE_BOTTOM = 790;
const COLUMNS = { date: MARGIN, job: 92, customer: 262, status: 328, price: 420, commission: 478, tip: 512, youGet: RIGHT };

/** The statement as a PDF: one line per job and plan visit, the totals, then the payouts of the month. */
export function statementPdf(statement: Statement, timezone: string): Buffer {
  const pages: PdfLine[][] = [];
  let page: PdfLine[] = [];
  let y = 0;
  const day = (date: Date) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: timezone }).format(date);

  const header = () => {
    page = [];
    pages.push(page);
    page.push({ text: 'MISK', x: MARGIN, y: 56, size: 20, bold: true });
    page.push({ text: `Earnings statement · ${monthName(statement.month)}`, x: MARGIN, y: 80, size: 13, bold: true });
    page.push({ text: statement.proName, x: MARGIN, y: 98, size: 10 });
    page.push({ text: `Page ${pages.length}`, x: RIGHT, y: 56, size: 9, align: 'right' });
    y = 128;
  };
  const tableHead = () => {
    const head: [string, number, 'left' | 'right'][] = [
      ['Date', COLUMNS.date, 'left'],
      ['Job', COLUMNS.job, 'left'],
      ['Customer', COLUMNS.customer, 'left'],
      ['Status', COLUMNS.status, 'left'],
      ['Job price', COLUMNS.price, 'right'],
      ['MISK', COLUMNS.commission, 'right'],
      ['Tip', COLUMNS.tip, 'right'],
      ['You get', COLUMNS.youGet, 'right'],
    ];
    for (const [text, x, align] of head) page.push({ text, x, y, size: 9, bold: true, align });
    page.push({ text: '', x: MARGIN, y: y + 6, rule: true });
    y += 20;
  };
  const room = (needed: number) => {
    if (y + needed > PAGE_BOTTOM) {
      header();
      tableHead();
    }
  };

  header();
  tableHead();
  const totals = { prices: 0, commission: 0, tips: 0, visits: 0, youGet: 0 };
  if (statement.items.length === 0) {
    page.push({ text: 'No jobs or plan visits this month.', x: MARGIN, y, size: 10 });
    y += 18;
  }
  for (const item of statement.items) {
    const lines = item.breakdown ? item.breakdown.lines : [];
    room(14 + (item.kind === 'visit' ? 12 : 0) + Math.max(0, lines.length - 1) * 12);
    page.push({ text: day(item.date), x: COLUMNS.date, y, size: 9 });
    page.push({ text: clip(item.title, 30), x: COLUMNS.job, y, size: 9 });
    page.push({ text: clip(item.customerName ?? '', 11), x: COLUMNS.customer, y, size: 9 });
    page.push({ text: STATUS_TEXT[item.status], x: COLUMNS.status, y, size: 9 });
    page.push({ text: item.kind === 'stand_in' ? '-' : euro(item.youGetCents), x: COLUMNS.youGet, y, size: 9, bold: true, align: 'right' });
    totals.youGet += item.youGetCents;
    if (item.kind === 'stand_in') {
      y += 12;
      page.push({ text: 'Done by a stand-in · not paid to you', x: COLUMNS.job, y, size: 8 });
    } else if (item.kind === 'visit' || !item.breakdown) {
      totals.visits += item.youGetCents;
      y += 12;
      page.push({ text: 'Plan visit · fixed payout per visit', x: COLUMNS.job, y, size: 8 });
    } else if (item.breakdown.type === 'no_show') {
      y += 12;
      page.push({ text: 'Call-out fee · customer not home', x: COLUMNS.job, y, size: 8 });
    } else {
      const { breakdown } = item;
      const price = breakdown.lines.reduce((sum, line) => sum + line.cents, 0);
      page.push({ text: euro(price), x: COLUMNS.price, y, size: 9, align: 'right' });
      page.push({ text: `-${euro(breakdown.commissionCents)}`, x: COLUMNS.commission, y, size: 9, align: 'right' });
      page.push({ text: breakdown.tipCents ? euro(breakdown.tipCents) : '', x: COLUMNS.tip, y, size: 9, align: 'right' });
      totals.prices += price;
      totals.commission += breakdown.commissionCents;
      totals.tips += breakdown.tipCents;
      for (const line of breakdown.lines.slice(1)) {
        y += 12;
        page.push({ text: clip(`+ ${line.kind === 'waiting' ? 'Waiting time' : line.label} ${euro(line.cents)}`, 44), x: COLUMNS.job, y, size: 8 });
      }
      if (breakdown.commissionPct !== null) {
        y += 12;
        page.push({ text: `MISK commission ${breakdown.commissionPct}%`, x: COLUMNS.job, y, size: 8 });
      }
    }
    y += 16;
  }

  room(110);
  page.push({ text: '', x: MARGIN, y, rule: true });
  y += 18;
  const totalRows: [string, string][] = [
    ['Job prices (one-off jobs)', euro(totals.prices)],
    ['MISK commission', `-${euro(totals.commission)}`],
    ['Tips', euro(totals.tips)],
    ['Plan visits', euro(totals.visits)],
  ];
  for (const [label, value] of totalRows) {
    page.push({ text: label, x: MARGIN, y, size: 10 });
    page.push({ text: value, x: RIGHT, y, size: 10, align: 'right' });
    y += 15;
  }
  page.push({ text: 'You get', x: MARGIN, y, size: 11, bold: true });
  page.push({ text: euro(totals.youGet), x: RIGHT, y, size: 11, bold: true, align: 'right' });
  y += 30;

  room(40);
  page.push({ text: 'Payouts this month', x: MARGIN, y, size: 11, bold: true });
  y += 18;
  if (statement.payouts.length === 0) {
    page.push({ text: 'No payouts this month.', x: MARGIN, y, size: 10 });
  }
  for (const payout of statement.payouts) {
    room(16);
    page.push({ text: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${payout.paidOn}T12:00:00Z`)), x: MARGIN, y, size: 10 });
    page.push({ text: payout.bankLast4 ? `To •••• ${payout.bankLast4}` : 'To your bank account', x: 160, y, size: 10 });
    page.push({ text: 'Paid', x: 400, y, size: 10 });
    page.push({ text: euro(payout.amountCents), x: RIGHT, y, size: 10, align: 'right' });
    y += 15;
  }
  return renderPdf(pages, `MISK earnings statement ${statement.month}`);
}

// ---------- Routes ----------

export async function earningsRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, gateway, guards } = ctx;
  const tz = ctx.config.timezone;
  const provider = { gateway, log: app.log };

  app.get('/pro/earnings/summary', { preHandler: guards.pro }, async (request) => ({
    summary: await loadEarningsSummary(pool, { gateway, log: request.log }, currentUser(request).id, tz),
  }));

  app.get<{ Querystring: { status?: EarningFilter; limit?: string; offset?: string } }>(
    '/pro/earnings',
    {
      preHandler: guards.pro,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: EARNING_FILTERS },
            // Query strings are not coerced to numbers (app.ts), so they are checked as digits here.
            limit: { type: 'string', pattern: '^[1-9][0-9]?$' },
            offset: { type: 'string', pattern: '^[0-9]{1,5}$' },
          },
        },
      },
    },
    async (request) => {
      const proId = currentUser(request).id;
      const limit = Number(request.query.limit ?? DEFAULT_PAGE);
      const offset = Number(request.query.offset ?? 0);
      if (limit > MAX_PAGE || offset > MAX_OFFSET) {
        throw badRequest('page_invalid');
      }
      const [page, summary, payouts] = await Promise.all([
        loadEarningItems(pool, proId, { filter: request.query.status ?? 'all', limit, offset }),
        loadEarningsSummary(pool, provider, proId, tz),
        loadBankPayouts(pool, proId, { limit: LISTED_PAYOUTS }),
      ]);
      return { ...page, summary, payouts };
    },
  );

  // This month's statement by default; any month from the first one MISK ran up to this one.
  app.get<{ Querystring: { month?: string } }>(
    '/pro/earnings/statement',
    {
      preHandler: guards.pro,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' } },
        },
      },
    },
    async (request, reply) => {
      const proId = currentUser(request).id;
      const current = marketToday(tz).slice(0, 7);
      const month = request.query.month ?? current;
      if (month > current || month < FIRST_STATEMENT_MONTH) {
        throw badRequest('month_invalid');
      }
      const pdf = statementPdf(await loadStatement(pool, proId, month, tz), tz);
      request.log.info({ event: 'earnings_statement_downloaded', proId, month });
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', `attachment; filename="misk-statement-${month}.pdf"`)
        .header('cache-control', 'private, no-store')
        .send(pdf);
    },
  );
}
