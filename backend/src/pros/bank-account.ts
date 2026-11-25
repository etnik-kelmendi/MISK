import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import { CHARGE_DELAY_HOURS } from '../bookings/lifecycle.js';
import { renderPdf, type PdfLine } from '../bookings/pdf.js';
import type { AppContext } from '../context.js';
import type { Queryable } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import type { BankAccountInfo } from '../payments/gateway.js';
import { nextPayoutDate, type PayoutInterval } from '../payments/payouts.js';
import { VISITS_PER_MONTH } from '../plans/routes.js';
import { marketToday } from './checks.js';

/**
 * The pro's Bank account page (D100): the account payouts go to, as the payment provider reports it, the payout
 * schedule MISK sets for every pro, the next payout day and amount, a link to change the account with the provider
 * (which checks a new account before any payout goes to it), and the yearly statement for taxes as a PDF.
 * The amounts are read-only queries of their own; the Earnings page (D99) keeps its own code.
 */

const PER_MONTH_CASES = Object.entries(VISITS_PER_MONTH)
  .map(([frequency, visits]) => `WHEN '${frequency}' THEN ${visits}`)
  .join(' ');
/** SQL: plan `s`'s payout to the pro for one visit, and what the customer pays for one visit. */
const VISIT_NET = `round(floor(s.price_cents * s.pro_share_pct / 100.0) / (CASE s.frequency ${PER_MONTH_CASES} END))::int`;
const VISIT_GROSS = `round(s.price_cents / (CASE s.frequency ${PER_MONTH_CASES} END))::int`;

/**
 * What the next payout day pays to the bank: the pro's money already released to their payment account and not yet
 * paid out (jobs whose problem report is still open wait), plus plan visits done more than 24 hours ago that no
 * payout holds yet. The same rules as the Earnings page's "Ready".
 */
export async function nextPayoutCents(db: Queryable, proId: string): Promise<number> {
  const found = await db.query<{ cents: number }>(
    `SELECT (
       (SELECT COALESCE(sum(po.amount_cents), 0) FROM payouts po JOIN bookings b ON b.id = po.booking_id
        WHERE po.pro_id = $1 AND po.status <> 'reversed' AND po.bank_payout_id IS NULL
          AND NOT (b.problem_reported_at IS NOT NULL AND b.problem_resolved_at IS NULL))
       + (SELECT COALESCE(sum(${VISIT_NET}), 0) FROM subscription_visits v JOIN subscriptions s ON s.id = v.subscription_id
          WHERE v.pro_id = $1 AND v.status = 'completed' AND v.bank_payout_id IS NULL
            AND v.completed_at <= now() - make_interval(hours => ${CHARGE_DELAY_HOURS}))
     )::int AS cents`,
    [proId],
  );
  return found.rows[0]?.cents ?? 0;
}

export interface BankSummary {
  hasPayoutAccount: boolean;
  payoutsEnabled: boolean;
  /** Null without a bank account, or when the provider could not be reached (then `bankError`). */
  bank: BankAccountInfo | null;
  bankError: boolean;
  interval: PayoutInterval;
  nextPayoutOn: string;
  nextPayoutCents: number;
  /** Years a statement can be downloaded for, newest first, and the one chosen at first: the last full year. */
  statementYears: number[];
  defaultStatementYear: number;
}

export async function loadBankSummary(
  ctx: Pick<AppContext, 'pool' | 'gateway' | 'config'>,
  proId: string,
  log: FastifyBaseLogger,
): Promise<BankSummary> {
  const found = await ctx.pool.query<{ account: string | null; payoutsEnabled: boolean; interval: PayoutInterval; since: number }>(
    `SELECT p.stripe_account_id AS account, p.payouts_enabled AS "payoutsEnabled", s.payout_interval AS interval,
       extract(year FROM p.created_at AT TIME ZONE $2)::int AS since
     FROM pro_profiles p, settings s WHERE p.user_id = $1`,
    [proId, ctx.config.timezone],
  );
  const row = found.rows[0];
  if (!row) {
    throw notFound('profile_not_found');
  }
  let bank: BankAccountInfo | null = null;
  let bankError = false;
  if (row.account) {
    try {
      bank = await ctx.gateway.bankAccount(row.account);
    } catch (error) {
      // The page still opens and says the account could not be loaded.
      bankError = true;
      log.error({ event: 'bank_account_failed', proId, err: error });
    }
  }
  const today = marketToday(ctx.config.timezone);
  const years = statementYears(row.since, Number(today.slice(0, 4)));
  return {
    hasPayoutAccount: row.account !== null,
    payoutsEnabled: row.payoutsEnabled,
    bank,
    bankError,
    interval: row.interval,
    nextPayoutOn: nextPayoutDate(row.interval, today),
    nextPayoutCents: await nextPayoutCents(ctx.pool, proId),
    statementYears: years,
    defaultStatementYear: defaultStatementYear(years, Number(today.slice(0, 4))),
  };
}

/** Every year from the one the pro joined to this one (year to date), newest first. */
export function statementYears(since: number, thisYear: number): number[] {
  const first = Math.min(since, thisYear);
  return Array.from({ length: thisYear - first + 1 }, (_, i) => thisYear - i);
}

/** The last full year, or this year for a pro who joined this year. */
export function defaultStatementYear(years: number[], thisYear: number): number {
  return years.includes(thisYear - 1) ? thisYear - 1 : thisYear;
}

// ---------- The yearly statement for taxes ----------

export interface TaxMonth {
  /** 1 to 12. */
  month: number;
  /** What customers paid for the pro's jobs and plan visits, tips not included. */
  grossCents: number;
  commissionCents: number;
  /** The pro's share of tips. */
  tipsCents: number;
  /** What MISK paid the pro: gross − commission + tips. */
  netCents: number;
}

export interface TaxStatement {
  year: number;
  proName: string;
  months: TaxMonth[];
  total: Omit<TaxMonth, 'month'>;
}

/**
 * The pro's year, month by month in the market's time zone (by the day of the job or visit): job prices including
 * approved extras (a late cancellation's full price, a no-show's call-out fee), MISK's commission, tips and what the
 * pro was paid. Only money actually released to the pro counts: a job whose payment was given back is left out,
 * and a plan visit counts once its 24-hour review time has passed.
 */
export async function loadTaxStatement(db: Queryable, proId: string, year: number, timezone: string): Promise<TaxStatement> {
  const [person, rows] = await Promise.all([
    db.query<{ name: string }>("SELECT concat_ws(' ', first_name, last_name) AS name FROM users WHERE id = $1", [proId]),
    db.query<{ month: number; gross: number; net: number; tip: number }>(
      `WITH jobs AS (
         SELECT extract(month FROM b.starts_at AT TIME ZONE $2)::int AS month,
           CASE WHEN b.no_show_at IS NOT NULL THEN COALESCE(b.no_show_fee_cents, 0) + COALESCE(b.no_show_waiting_cents, 0)
                WHEN b.status = 'completed' THEN b.price_cents
                  + COALESCE((SELECT sum(e.price_cents) FROM extra_requests e WHERE e.booking_id = b.id AND e.status = 'approved'), 0)
                ELSE b.price_cents END::int AS gross,
           (SELECT COALESCE(sum(po.amount_cents), 0) FROM payouts po WHERE po.booking_id = b.id AND po.pro_id = $1
              AND po.status <> 'reversed' AND po.payment_intent_id IS DISTINCT FROM t.payment_intent_id)::int AS net,
           (SELECT COALESCE(sum(po.amount_cents), 0) FROM payouts po WHERE po.booking_id = b.id AND po.pro_id = $1
              AND po.status <> 'reversed' AND po.payment_intent_id = t.payment_intent_id)::int AS tip
         FROM bookings b LEFT JOIN tips t ON t.booking_id = b.id AND t.status = 'captured'
         WHERE b.pro_id = $1 AND (b.status = 'completed' OR b.late_cancel OR b.no_show_at IS NOT NULL)
           AND b.starts_at >= make_timestamptz($3, 1, 1, 0, 0, 0, $2) AND b.starts_at < make_timestamptz($3 + 1, 1, 1, 0, 0, 0, $2)
       )
       SELECT month, CASE WHEN net > 0 THEN gross ELSE 0 END AS gross, net, tip FROM jobs WHERE net > 0 OR tip > 0
       UNION ALL
       SELECT extract(month FROM v.starts_at AT TIME ZONE $2)::int, ${VISIT_GROSS}, ${VISIT_NET}, 0
       FROM subscription_visits v JOIN subscriptions s ON s.id = v.subscription_id
       WHERE v.pro_id = $1 AND v.status = 'completed' AND v.completed_at <= now() - make_interval(hours => ${CHARGE_DELAY_HOURS})
         AND v.starts_at >= make_timestamptz($3, 1, 1, 0, 0, 0, $2) AND v.starts_at < make_timestamptz($3 + 1, 1, 1, 0, 0, 0, $2)`,
      [proId, timezone, year],
    ),
  ]);
  const months: TaxMonth[] = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, grossCents: 0, commissionCents: 0, tipsCents: 0, netCents: 0 }));
  for (const row of rows.rows) {
    const month = months[row.month - 1];
    if (!month) continue;
    month.grossCents += row.gross;
    month.commissionCents += row.gross - row.net;
    month.tipsCents += row.tip;
    month.netCents += row.net + row.tip;
  }
  const total = months.reduce(
    (sum, m) => ({
      grossCents: sum.grossCents + m.grossCents,
      commissionCents: sum.commissionCents + m.commissionCents,
      tipsCents: sum.tipsCents + m.tipsCents,
      netCents: sum.netCents + m.netCents,
    }),
    { grossCents: 0, commissionCents: 0, tipsCents: 0, netCents: 0 },
  );
  return { year, proName: person.rows[0]?.name ?? '', months, total };
}

function euro(cents: number): string {
  return `${cents < 0 ? '-' : ''}€${(Math.abs(cents) / 100).toFixed(2)}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const LEFT = 40;
const RIGHT = 555;
const COLUMNS = { gross: 300, commission: 385, tips: 465, net: RIGHT };

/** The statement as a one-page PDF: the pro's name and the year, one line per month, and the year's totals. */
export function taxStatementPdf(statement: TaxStatement, generatedOn: string): Buffer {
  const page: PdfLine[] = [
    { text: 'MISK', x: LEFT, y: 56, size: 20, bold: true },
    { text: `Yearly statement for taxes · ${statement.year}`, x: LEFT, y: 82, size: 14, bold: true },
    { text: statement.proName || 'MISK pro', x: LEFT, y: 100, size: 11 },
    { text: `Created on ${generatedOn}`, x: RIGHT, y: 56, size: 9, align: 'right' },
  ];
  let y = 136;
  const head: [string, number, 'left' | 'right'][] = [
    ['Month', LEFT, 'left'],
    ['Job prices', COLUMNS.gross, 'right'],
    ['MISK commission', COLUMNS.commission, 'right'],
    ['Tips', COLUMNS.tips, 'right'],
    ['Net paid to you', COLUMNS.net, 'right'],
  ];
  for (const [text, x, align] of head) page.push({ text, x, y, size: 9, bold: true, align });
  page.push({ text: '', x: LEFT, y: y + 6, rule: true });
  y += 22;
  const line = (label: string, m: Omit<TaxMonth, 'month'>, bold = false) => {
    page.push({ text: label, x: LEFT, y, size: 10, bold });
    page.push({ text: euro(m.grossCents), x: COLUMNS.gross, y, size: 10, bold, align: 'right' });
    page.push({ text: m.commissionCents ? `-${euro(m.commissionCents)}` : euro(0), x: COLUMNS.commission, y, size: 10, bold, align: 'right' });
    page.push({ text: euro(m.tipsCents), x: COLUMNS.tips, y, size: 10, bold, align: 'right' });
    page.push({ text: euro(m.netCents), x: COLUMNS.net, y, size: 10, bold, align: 'right' });
    y += 18;
  };
  for (const month of statement.months) line(MONTHS[month.month - 1] ?? String(month.month), month);
  page.push({ text: '', x: LEFT, y: y - 8, rule: true });
  y += 6;
  line(`Total ${statement.year}`, statement.total, true);
  y += 18;
  const notes = [
    'Job prices are what customers paid for your jobs and plan visits, including approved extra work, without tips.',
    'Tips are your share of the tips customers gave. Net paid to you = job prices - MISK commission + tips.',
    'Months follow the day of each job or visit. Only money released to you is included.',
    'MISK does not give tax advice. Please check with your tax adviser what applies to you.',
  ];
  for (const note of notes) {
    page.push({ text: note, x: LEFT, y, size: 8.5 });
    y += 13;
  }
  return renderPdf([page], `MISK yearly statement for taxes ${statement.year}`);
}

export async function bankAccountRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards } = ctx;
  const tz = ctx.config.timezone;

  app.get('/pro/bank', { preHandler: guards.pro }, async (request) => ({
    bank: await loadBankSummary(ctx, currentUser(request).id, request.log),
  }));

  // "Change bank account": a one-time link to the provider, where the pro enters the new account and the provider
  // checks it. Until it reports the account as active the page says "Being checked" and no payout goes to it.
  app.post('/pro/bank/change-link', { preHandler: guards.pro }, async (request) => {
    const proId = currentUser(request).id;
    const found = await pool.query<{ account: string | null }>('SELECT stripe_account_id AS account FROM pro_profiles WHERE user_id = $1', [
      proId,
    ]);
    const account = found.rows[0]?.account;
    if (!account) {
      throw conflict('no_payout_account');
    }
    const url = await ctx.gateway.bankChangeLink(account);
    request.log.info({ event: 'bank_change_link_created', proId });
    return { url };
  });

  // The yearly statement for taxes: the last full year by default, any year from the one the pro joined.
  app.get<{ Querystring: { year?: string } }>(
    '/pro/earnings/tax-statement',
    {
      preHandler: guards.pro,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          // Query strings are not coerced to numbers (app.ts), so the year is checked as four digits.
          properties: { year: { type: 'string', pattern: '^20[0-9]{2}$' } },
        },
      },
    },
    async (request, reply) => {
      const proId = currentUser(request).id;
      const found = await pool.query<{ since: number }>(
        'SELECT extract(year FROM created_at AT TIME ZONE $2)::int AS since FROM pro_profiles WHERE user_id = $1',
        [proId, tz],
      );
      const since = found.rows[0]?.since;
      if (since === undefined) {
        throw notFound('profile_not_found');
      }
      const today = marketToday(tz);
      const thisYear = Number(today.slice(0, 4));
      const years = statementYears(since, thisYear);
      const year = request.query.year === undefined ? defaultStatementYear(years, thisYear) : Number(request.query.year);
      if (!years.includes(year)) {
        throw badRequest('year_invalid');
      }
      const pdf = taxStatementPdf(await loadTaxStatement(pool, proId, year, tz), today);
      request.log.info({ event: 'tax_statement_downloaded', proId, year });
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', `attachment; filename="misk-tax-statement-${year}.pdf"`)
        .header('cache-control', 'private, no-store')
        .send(pdf);
    },
  );
}
