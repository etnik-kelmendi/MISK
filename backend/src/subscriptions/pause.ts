import type { PoolClient } from 'pg';
import { eligibleProFilter } from '../bookings/availability.js';
import type { BookingDeps } from '../bookings/events.js';
import { withTransaction, type Queryable } from '../db.js';
import { ApiError, badRequest, conflict, notFound } from '../errors.js';
import { isExclusionViolation, isUniqueViolation } from '../http.js';
import { formatDay, formatSlot, messages } from '../notifications/messages.js';
import { enqueue } from '../notifications/outbox.js';
import { VISITS_PER_MONTH } from '../plans/routes.js';
import { PLANNING_DAYS, SUBSCRIPTION_PATTERN, patternOf, planVisits, plannedStarts, type SubscriptionRow } from './service.js';

/**
 * Pausing a monthly plan (D78). The customer of an active plan pauses it for whole weeks, starting on a
 * whole local day at least the plan's notice ahead, within the yearly allowance (weeks of the pauses that
 * start in a calendar year, withdrawn ones not counting). Visits starting inside the pause are called off,
 * the planner plans nothing there, and the value of the called-off visits is credited to the customer's next
 * monthly bill. One pause that has not finished yet at a time; it can be called off until it starts, and the
 * visits whose pro is still free come back, with their credit taken back.
 */

/** Why a plan cannot be paused right now, shown to the customer in place of the choices. */
export type PauseBlock = 'not_active' | 'pause_already_planned' | 'no_weeks_left' | 'plan_ending' | 'pauses_not_allowed';

const DAY_MS = 24 * 3600 * 1000;
const PRO_CHANNELS = { push: true, sms: false, email: false };

/** 'YYYY-MM-DD' plus `days` calendar days. */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

const yearOf = (day: string): number => Number(day.slice(0, 4));

/** A pause can start at the latest on the last day of next year, so a whole next year can be planned. */
const lastStartDay = (today: string): string => `${yearOf(today) + 1}-12-31`;

interface PauseSubscription extends SubscriptionRow {
  customer_id: string;
  status: string;
  plan_name: string;
  category_id: string;
  postcode: string;
  price_cents: number;
  pause_notice_days: number;
  max_pause_weeks: number;
  customer_name: string | null;
  stripe_customer_id: string | null;
  /** Today in the market time zone, 'YYYY-MM-DD'. */
  today: string;
  /** The local day the plan ends on (`ends_at`), when it is cancelled. */
  ends_on: string | null;
}

async function loadPauseSubscription(
  db: Queryable,
  ids: { subscriptionId: string; customerId: string },
  timezone: string,
  lock = false,
): Promise<PauseSubscription> {
  const found = await db.query<PauseSubscription>(
    `SELECT ${SUBSCRIPTION_PATTERN}, customer_id, status, plan_name, category_id, postcode, price_cents,
       pause_notice_days, max_pause_weeks,
       (SELECT first_name FROM users u WHERE u.id = subscriptions.customer_id) AS customer_name,
       (SELECT stripe_customer_id FROM users u WHERE u.id = subscriptions.customer_id) AS stripe_customer_id,
       to_char((now() AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS today,
       to_char((ends_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS ends_on
     FROM subscriptions WHERE id = $1 AND customer_id = $2
     ${lock ? 'FOR UPDATE' : ''}`,
    [ids.subscriptionId, ids.customerId, timezone],
  );
  const subscription = found.rows[0];
  if (!subscription) {
    throw notFound();
  }
  return subscription;
}

/** What one visit is worth: the monthly price (with any extra) over the visits a month of the plan's frequency. */
export function visitValueCents(subscription: Pick<PauseSubscription, 'price_cents' | 'frequency'>): number {
  return Math.round(subscription.price_cents / VISITS_PER_MONTH[subscription.frequency]);
}

/** Local midnight of each day, as instants. */
async function localMidnights(db: Queryable, timezone: string, days: string[]): Promise<Date[]> {
  const result = await db.query<{ at: Date }>(
    `SELECT (d::date)::timestamp AT TIME ZONE $2 AS at FROM unnest($1::text[]) WITH ORDINALITY AS x(d, n) ORDER BY n`,
    [days, timezone],
  );
  return result.rows.map((row) => row.at);
}

/** Paused weeks per calendar year of the start, withdrawn pauses not counting. */
async function weeksUsedByYear(db: Queryable, subscriptionId: string): Promise<Map<number, number>> {
  const result = await db.query<{ year: number; weeks: number }>(
    `SELECT extract(year FROM starts_on)::int AS year, sum(weeks)::int AS weeks
     FROM subscription_pauses WHERE subscription_id = $1 AND status = 'active' GROUP BY 1`,
    [subscriptionId],
  );
  return new Map(result.rows.map((row) => [row.year, row.weeks]));
}

/** The pause that has not finished yet, if any. */
async function openPause(db: Queryable, subscriptionId: string): Promise<{ id: string } | null> {
  const result = await db.query<{ id: string }>(
    "SELECT id FROM subscription_pauses WHERE subscription_id = $1 AND status = 'active' AND ends_at > now() LIMIT 1",
    [subscriptionId],
  );
  return result.rows[0] ?? null;
}

interface VisitRow {
  id: string;
  starts_at: Date;
  ends_at: Date;
  pro_id: string;
}

/**
 * The visits a pause from local day `first` to `end` (exclusive) calls off: the planned visits starting in
 * it, and, past the planning window, the times the planner would plan (on the plan's days, in season, before
 * the plan ends). Times inside the window that have no visit are left out: the pro was busy then.
 */
async function visitsInRange(
  db: Queryable,
  subscription: PauseSubscription,
  timezone: string,
  first: string,
  end: string,
): Promise<{ planned: VisitRow[]; future: Date[]; from: Date; to: Date }> {
  const [from, to] = await localMidnights(db, timezone, [first, end]);
  if (!from || !to) {
    throw new Error('Could not convert pause days to instants');
  }
  const planned = await db.query<VisitRow>(
    `SELECT id, starts_at, ends_at, pro_id FROM subscription_visits
     WHERE subscription_id = $1 AND status IN ('pending', 'planned') AND starts_at >= $2 AND starts_at < $3
     ORDER BY starts_at`,
    [subscription.id, from, to],
  );
  let future: Date[] = [];
  const firstUnplanned = [first, addDays(subscription.today, PLANNING_DAYS + 1)].sort()[1] ?? first;
  const last = addDays(end, -1);
  if (subscription.pro_id && firstUnplanned <= last) {
    const starts = await plannedStarts(db, patternOf(subscription), timezone, { first: firstUnplanned, last });
    const taken = await db.query<{ at: Date }>(
      `SELECT starts_at AS at FROM subscription_visits WHERE subscription_id = $1 AND starts_at >= $2 AND starts_at < $3
       UNION SELECT moved_from FROM subscription_visits WHERE subscription_id = $1 AND moved_from >= $2 AND moved_from < $3`,
      [subscription.id, from, to],
    );
    const takenTimes = new Set(taken.rows.map((row) => row.at.getTime()));
    future = starts.filter((start) => !takenTimes.has(start.getTime()));
  }
  return { planned: planned.rows, future, from, to };
}

export interface PauseOptions {
  /** The first day a pause can start ('YYYY-MM-DD'); null when pausing is not possible. */
  earliestStartOn: string | null;
  /** The last day a pause can start. */
  latestStartOn: string | null;
  /** A pause must end by this day (the plan's end when it is cancelled, else the end of the start range). */
  latestEndOn: string | null;
  noticeDays: number;
  /** The most paused weeks in a calendar year. */
  maxPauseWeeks: number;
  /** Weeks left this year (market time zone). */
  weeksLeftThisYear: number;
  /** Weeks left per calendar year a pause can start in, keyed by the year. */
  weeksLeft: Record<string, number>;
  /** The credit for each called-off visit. */
  visitCreditCents: number;
  /** The times of the visits a pause could call off, from the earliest start to the latest end. */
  visitStarts: Date[];
  reason: PauseBlock | null;
}

/** What the customer can choose when pausing, or why they cannot pause now. */
export async function pauseOptions(
  db: Queryable,
  ids: { subscriptionId: string; customerId: string },
  timezone: string,
): Promise<PauseOptions> {
  const subscription = await loadPauseSubscription(db, ids, timezone);
  const thisYear = yearOf(subscription.today);
  const used = await weeksUsedByYear(db, subscription.id);
  const weeksLeft: Record<string, number> = {};
  for (const year of [thisYear, thisYear + 1]) {
    weeksLeft[String(year)] = Math.max(0, subscription.max_pause_weeks - (used.get(year) ?? 0));
  }
  const base = {
    noticeDays: subscription.pause_notice_days,
    maxPauseWeeks: subscription.max_pause_weeks,
    weeksLeftThisYear: weeksLeft[String(thisYear)] ?? 0,
    weeksLeft,
    visitCreditCents: visitValueCents(subscription),
  };
  const blocked = (reason: PauseBlock): PauseOptions => ({
    ...base,
    earliestStartOn: null,
    latestStartOn: null,
    latestEndOn: null,
    visitStarts: [],
    reason,
  });

  if (subscription.status !== 'active') {
    return blocked('not_active');
  }
  if (subscription.max_pause_weeks === 0) {
    return blocked('pauses_not_allowed');
  }
  if (await openPause(db, subscription.id)) {
    return blocked('pause_already_planned');
  }
  let earliest = addDays(subscription.today, subscription.pause_notice_days);
  if ((weeksLeft[String(yearOf(earliest))] ?? 0) === 0) {
    // This year's weeks are used up: a pause can still start next year.
    earliest = `${yearOf(earliest) + 1}-01-01`;
  }
  let latestStart = lastStartDay(subscription.today);
  if (subscription.ends_on) {
    const lastByEnd = addDays(subscription.ends_on, -7);
    latestStart = lastByEnd < latestStart ? lastByEnd : latestStart;
  }
  if ((weeksLeft[String(yearOf(earliest))] ?? 0) === 0) {
    return blocked('no_weeks_left');
  }
  if (earliest > latestStart) {
    return blocked(subscription.ends_on ? 'plan_ending' : 'no_weeks_left');
  }
  const rangeEnd = addDays(latestStart, 7 * subscription.max_pause_weeks);
  const latestEnd = subscription.ends_on && subscription.ends_on < rangeEnd ? subscription.ends_on : rangeEnd;
  const { planned, future } = await visitsInRange(db, subscription, timezone, earliest, latestEnd);
  const visitStarts = [...planned.map((visit) => visit.starts_at), ...future].sort((a, b) => a.getTime() - b.getTime());
  return { ...base, earliestStartOn: earliest, latestStartOn: latestStart, latestEndOn: latestEnd, visitStarts, reason: null };
}

/** Undoes a balance change whose transaction did not save, so the customer's bill matches what MISK recorded. */
interface BalanceChange {
  kind: 'credit' | 'reversal';
  customerRef: string;
  amountCents: number;
  pauseId: string;
}

async function undoBalanceChange(deps: BookingDeps, change: BalanceChange): Promise<void> {
  const input = {
    customerRef: change.customerRef,
    amountCents: change.amountCents,
    description: 'MISK: correction of a plan pause change that did not go through',
    idempotencyKey: `pause-undo-${change.kind}-${change.pauseId}`,
  };
  try {
    await (change.kind === 'credit' ? deps.gateway.reverseCustomerCredit(input) : deps.gateway.creditCustomer(input));
    deps.log.warn({ event: 'pause_balance_change_undone', pauseId: change.pauseId, kind: change.kind });
  } catch (error) {
    // Needs the team: the customer's balance and MISK's records disagree by this amount.
    deps.log.error({ event: 'pause_balance_change_not_undone', pauseId: change.pauseId, kind: change.kind, amountCents: change.amountCents, err: error });
  }
}

/**
 * Pauses the plan from `startsOn` for `weeks` weeks. Everything happens in one transaction; the credit is
 * the last step before it commits, so a refused credit leaves no pause and no visit changed. Should the
 * commit itself fail after the credit, the credit is taken back again.
 */
export async function createPause(
  deps: BookingDeps,
  ids: { subscriptionId: string; customerId: string },
  input: { startsOn: string; weeks: number },
): Promise<{ pauseId: string }> {
  const tz = deps.config.timezone;
  // Set once the credit went through, so a failed commit can take it back.
  const done: { credit: BalanceChange | null } = { credit: null };
  try {
    return await withTransaction(deps.pool, async (client) => {
      const subscription = await loadPauseSubscription(client, ids, tz, true);
      if (subscription.status !== 'active') {
        throw conflict('pause_not_possible');
      }
      // The plan's own terms, copied when the customer subscribed (D77), say 0 weeks: no new pauses.
      if (subscription.max_pause_weeks === 0) {
        throw conflict('pauses_not_allowed');
      }
      if (await openPause(client, subscription.id)) {
        throw conflict('pause_already_planned');
      }
      const { startsOn, weeks } = input;
      const endOn = addDays(startsOn, weeks * 7);
      if (startsOn < addDays(subscription.today, subscription.pause_notice_days)) {
        throw conflict('pause_notice');
      }
      if (startsOn > lastStartDay(subscription.today)) {
        throw badRequest('pause_too_far');
      }
      if (subscription.ends_on && endOn > subscription.ends_on) {
        throw conflict('pause_after_end');
      }
      const used = (await weeksUsedByYear(client, subscription.id)).get(yearOf(startsOn)) ?? 0;
      if (used + weeks > subscription.max_pause_weeks) {
        throw conflict('pause_allowance');
      }

      // Fill the planning window first, so the visits about to be called off are all there.
      await planVisits(client, subscription, tz, 'planned');
      const { planned, future, from, to } = await visitsInRange(client, subscription, tz, startsOn, endOn);
      let pauseId: string;
      try {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO subscription_pauses (subscription_id, customer_id, starts_on, weeks, starts_at, ends_at)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [subscription.id, subscription.customer_id, startsOn, weeks, from, to],
        );
        pauseId = inserted.rows[0]?.id ?? '';
      } catch (error) {
        if (isExclusionViolation(error)) {
          throw conflict('pause_already_planned');
        }
        throw error;
      }

      const plannedIds = planned.map((visit) => visit.id);
      await client.query(`UPDATE subscription_visits SET status = 'cancelled', paused_by = $2 WHERE id = ANY ($1::uuid[])`, [
        plannedIds,
        pauseId,
      ]);
      // Times past the planning window get a called-off visit too, so they show as paused and can come back.
      const placeholders = subscription.pro_id
        ? await client.query(
            `INSERT INTO subscription_visits (subscription_id, pro_id, starts_at, ends_at, status, paused_by)
             SELECT $1, $2, s, s + make_interval(mins => $4::int), 'cancelled', $5 FROM unnest($3::timestamptz[]) AS s
             ON CONFLICT (subscription_id, starts_at) DO NOTHING`,
            [subscription.id, subscription.pro_id, future, subscription.visit_minutes, pauseId],
          )
        : { rowCount: 0 };
      // Requests to move a paused visit, or to move a visit into the pause, can no longer happen.
      await client.query(
        `UPDATE subscription_visit_moves SET status = 'withdrawn', responded_at = now()
         WHERE subscription_id = $1 AND status = 'pending'
           AND (visit_id = ANY ($2::uuid[]) OR (to_starts_at >= $3 AND to_starts_at < $4))`,
        [subscription.id, plannedIds, from, to],
      );

      const visitsCalledOff = planned.length + (placeholders.rowCount ?? 0);
      const value = visitValueCents(subscription);
      const creditCents = value * visitsCalledOff;
      await client.query(
        'UPDATE subscription_pauses SET visit_value_cents = $2, visits_called_off = $3, credit_cents = $4 WHERE id = $1',
        [pauseId, value, visitsCalledOff, creditCents],
      );

      const fromText = formatDay(from, tz);
      const toText = formatDay(to, tz);
      await enqueue(client, subscription.customer_id, 'plan_paused', messages.planPaused(subscription.plan_name, fromText, toText, creditCents));
      const byPro = new Map<string, string[]>();
      if (subscription.pro_id) {
        byPro.set(subscription.pro_id, []);
      }
      for (const visit of planned) {
        byPro.set(visit.pro_id, [...(byPro.get(visit.pro_id) ?? []), formatSlot(visit.starts_at, tz)]);
      }
      const customerName = subscription.customer_name ?? 'Your customer';
      for (const [proId, visits] of byPro) {
        await enqueue(client, proId, 'plan_paused', messages.planPausedForPro(customerName, subscription.plan_name, fromText, toText, visits), {
          channels: PRO_CHANNELS,
        });
      }

      if (creditCents > 0) {
        let customerRef: string;
        let transactionId: string;
        try {
          customerRef = await deps.gateway.ensureCustomer({ userId: subscription.customer_id, existing: subscription.stripe_customer_id });
          ({ transactionId } = await deps.gateway.creditCustomer({
            customerRef,
            amountCents: creditCents,
            description: `MISK ${subscription.plan_name}: ${visitsCalledOff} paused visit(s), ${fromText} to ${toText}`,
            idempotencyKey: `pause-credit-${pauseId}`,
          }));
        } catch (error) {
          deps.log.error({ event: 'pause_credit_failed', subscriptionId: subscription.id, err: error });
          throw new ApiError(502, 'pause_credit_failed');
        }
        done.credit = { kind: 'credit', customerRef, amountCents: creditCents, pauseId };
        await client.query('UPDATE users SET stripe_customer_id = $2 WHERE id = $1 AND stripe_customer_id IS NULL', [
          subscription.customer_id,
          customerRef,
        ]);
        await client.query('UPDATE subscription_pauses SET credit_ref = $2 WHERE id = $1', [pauseId, transactionId]);
      }
      deps.log.info({ event: 'subscription_paused', subscriptionId: subscription.id, pauseId, startsOn, weeks, visitsCalledOff, creditCents });
      return { pauseId };
    });
  } catch (error) {
    if (done.credit) {
      await undoBalanceChange(deps, done.credit);
    }
    throw error;
  }
}

/** Whether the plan's pro is free for a called-off visit again, the visit itself not counting. */
async function proFreeFor(client: PoolClient, subscription: PauseSubscription, visit: VisitRow, timezone: string): Promise<boolean> {
  const result = await client.query<{ free: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pro_profiles p
       WHERE p.user_id = $1
         AND ${eligibleProFilter('$2', '$3', '$4::timestamptz', '$5::timestamptz', '$6', '$7::uuid', 'NULL::uuid', '$8::uuid')}
         AND NOT EXISTS (
           SELECT 1 FROM subscription_visit_moves asked
           WHERE asked.pro_id = p.user_id AND asked.status = 'pending'
             AND tstzrange(asked.to_starts_at, asked.to_ends_at) && tstzrange($4::timestamptz, $5::timestamptz))
     ) AS free`,
    [
      subscription.pro_id,
      subscription.category_id,
      subscription.postcode,
      visit.starts_at,
      visit.ends_at,
      timezone,
      subscription.customer_id,
      visit.id,
    ],
  );
  return result.rows[0]?.free ?? false;
}

/**
 * Calls off a pause that has not started. Each called-off visit comes back when the plan's pro is still
 * free then (and the plan has not ended by then); the others stay cancelled and the customer is told which.
 * The credit for the visits that came back is taken back, and the pause no longer counts against the
 * allowance.
 */
export async function callOffPause(
  deps: BookingDeps,
  ids: { subscriptionId: string; customerId: string; pauseId: string },
): Promise<void> {
  const tz = deps.config.timezone;
  const done: { reversal: BalanceChange | null } = { reversal: null };
  try {
    await withTransaction(deps.pool, async (client) => {
      const category = await client.query<{ category_id: string }>(
        'SELECT category_id FROM subscriptions WHERE id = $1 AND customer_id = $2',
        [ids.subscriptionId, ids.customerId],
      );
      const categoryId = category.rows[0]?.category_id;
      if (!categoryId) {
        throw notFound();
      }
      // The same lock bookings take while they look for a free pro, so nobody books these times meanwhile.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`book:${categoryId}`]);
      const subscription = await loadPauseSubscription(client, ids, tz, true);
      const found = await client.query<{
        status: string;
        upcoming: boolean;
        starts_at: Date;
        ends_at: Date;
        visit_value_cents: number;
        credit_cents: number;
        reversed_cents: number;
      }>(
        `SELECT status, starts_at > now() AS upcoming, starts_at, ends_at, visit_value_cents, credit_cents, reversed_cents
         FROM subscription_pauses WHERE id = $1 AND subscription_id = $2 FOR UPDATE`,
        [ids.pauseId, subscription.id],
      );
      const pause = found.rows[0];
      if (!pause) {
        throw notFound();
      }
      if (pause.status === 'withdrawn') {
        throw conflict('pause_withdrawn');
      }
      if (!pause.upcoming) {
        throw conflict('pause_started');
      }

      const paused = await client.query<VisitRow>(
        `SELECT id, starts_at, ends_at, pro_id FROM subscription_visits
         WHERE paused_by = $1 AND status = 'cancelled' ORDER BY starts_at`,
        [ids.pauseId],
      );
      await client.query("UPDATE subscription_pauses SET status = 'withdrawn', withdrawn_at = now() WHERE id = $1", [ids.pauseId]);
      const back: VisitRow[] = [];
      const notBack: VisitRow[] = [];
      for (const visit of paused.rows) {
        const inPlan = subscription.ends_at === null || visit.ends_at <= subscription.ends_at;
        if (!subscription.pro_id || !inPlan || !(await proFreeFor(client, subscription, visit, tz))) {
          notBack.push(visit);
          continue;
        }
        await client.query('SAVEPOINT restore_visit');
        try {
          await client.query("UPDATE subscription_visits SET status = 'planned', pro_id = $2, paused_by = NULL WHERE id = $1", [
            visit.id,
            subscription.pro_id,
          ]);
          await client.query('RELEASE SAVEPOINT restore_visit');
          back.push(visit);
        } catch (error) {
          if (!isExclusionViolation(error) && !isUniqueViolation(error)) {
            throw error;
          }
          await client.query('ROLLBACK TO SAVEPOINT restore_visit');
          notBack.push(visit);
        }
      }

      const reversedCents = Math.min(pause.visit_value_cents * back.length, pause.credit_cents - pause.reversed_cents);
      await client.query('UPDATE subscription_pauses SET visits_restored = $2, reversed_cents = reversed_cents + $3 WHERE id = $1', [
        ids.pauseId,
        back.length,
        reversedCents,
      ]);

      await enqueue(
        client,
        subscription.customer_id,
        'plan_pause_called_off',
        messages.planPauseCalledOff(
          subscription.plan_name,
          reversedCents,
          notBack.map((visit) => formatSlot(visit.starts_at, tz)),
        ),
      );
      if (subscription.pro_id && back.length > 0) {
        await enqueue(
          client,
          subscription.pro_id,
          'plan_pause_called_off',
          messages.planPauseCalledOffForPro(
            subscription.customer_name ?? 'Your customer',
            subscription.plan_name,
            back.map((visit) => formatSlot(visit.starts_at, tz)),
          ),
          { channels: PRO_CHANNELS },
        );
      }

      if (reversedCents > 0) {
        if (!subscription.stripe_customer_id) {
          // A credit is only ever given to a customer known to the provider; nothing to take back otherwise.
          deps.log.error({ event: 'pause_reversal_without_customer', pauseId: ids.pauseId });
        } else {
          try {
            await deps.gateway.reverseCustomerCredit({
              customerRef: subscription.stripe_customer_id,
              amountCents: reversedCents,
              description: `MISK ${subscription.plan_name}: pause called off, ${back.length} visit(s) back`,
              idempotencyKey: `pause-calloff-${ids.pauseId}`,
            });
          } catch (error) {
            deps.log.error({ event: 'pause_reversal_failed', pauseId: ids.pauseId, err: error });
            throw new ApiError(502, 'pause_credit_failed');
          }
          done.reversal = { kind: 'reversal', customerRef: subscription.stripe_customer_id, amountCents: reversedCents, pauseId: ids.pauseId };
        }
      }
      deps.log.info({ event: 'subscription_pause_called_off', pauseId: ids.pauseId, back: back.length, notBack: notBack.length, reversedCents });
    });
  } catch (error) {
    if (done.reversal) {
      await undoBalanceChange(deps, done.reversal);
    }
    throw error;
  }
}

/**
 * A plan cancelled after a pause was planned ends before some paused visits: those would not have taken
 * place anyway, so their credit is taken back. When the customer then keeps the plan after all ("Keep my
 * plan", D90), the credit taken back is given again. Safe to run again: each pause records what it took back.
 * Runs right after a cancellation or keep, and in the planning job, which retries a failed attempt.
 */
export async function settlePausesAfterPlanEnd(deps: BookingDeps, subscriptionId?: string): Promise<number> {
  const due = await deps.pool.query<{
    id: string;
    plan_name: string;
    stripe_customer_id: string | null;
    reversed_cents: number;
    target_cents: number;
    /** How many times this has changed the pause's credit before, for a new idempotency key each time. */
    credit_changes: number;
  }>(
    `SELECT * FROM (
       SELECT pz.id, s.plan_name, u.stripe_customer_id, pz.reversed_cents, pz.credit_changes,
         CASE WHEN s.ends_at IS NULL THEN 0 ELSE LEAST(pz.credit_cents, pz.visit_value_cents * (
           SELECT count(*)::int FROM subscription_visits v WHERE v.paused_by = pz.id AND v.status = 'cancelled' AND v.ends_at > s.ends_at
         )) END AS target_cents
       FROM subscription_pauses pz JOIN subscriptions s ON s.id = pz.subscription_id JOIN users u ON u.id = s.customer_id
       WHERE pz.status = 'active' AND (s.ends_at IS NOT NULL OR pz.reversed_cents > 0) AND ($1::uuid IS NULL OR s.id = $1)
     ) due
     WHERE target_cents <> reversed_cents
     LIMIT 50`,
    [subscriptionId ?? null],
  );
  let settled = 0;
  for (const pause of due.rows) {
    const amountCents = Math.abs(pause.target_cents - pause.reversed_cents);
    if (amountCents === 0 || !pause.stripe_customer_id) {
      continue;
    }
    const giveBack = pause.target_cents < pause.reversed_cents;
    try {
      const input = {
        customerRef: pause.stripe_customer_id,
        amountCents,
        description: giveBack
          ? `MISK ${pause.plan_name}: paused visits, the plan goes on`
          : `MISK ${pause.plan_name}: paused visits after the plan ends`,
        // Each change once, however often this runs; a later cancel or keep is a new change.
        idempotencyKey: `pause-settle-${pause.id}-${pause.credit_changes + 1}`,
      };
      await (giveBack ? deps.gateway.creditCustomer(input) : deps.gateway.reverseCustomerCredit(input));
      await deps.pool.query(
        `UPDATE subscription_pauses SET reversed_cents = $3, credit_changes = credit_changes + 1
         WHERE id = $1 AND reversed_cents = $2 AND credit_changes = $4`,
        [pause.id, pause.reversed_cents, pause.target_cents, pause.credit_changes],
      );
      settled += 1;
      deps.log.info({ event: giveBack ? 'pause_credit_given_again' : 'pause_credit_after_end_reversed', pauseId: pause.id, amountCents });
    } catch (error) {
      deps.log.error({ event: 'pause_credit_after_end_failed', pauseId: pause.id, err: error });
    }
  }
  return settled;
}

/** A plan's pauses for the customer, newest first, with where each stands now. */
export async function pausesOf(db: Queryable, subscriptionId: string) {
  const result = await db.query(
    `SELECT id, to_char(starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(starts_on + weeks * 7, 'YYYY-MM-DD') AS "endsOn", weeks,
       starts_at AS "startsAt", ends_at AS "endsAt",
       CASE WHEN status = 'withdrawn' THEN 'withdrawn' WHEN starts_at > now() THEN 'upcoming'
            WHEN ends_at > now() THEN 'running' ELSE 'past' END AS status,
       visits_called_off AS "visitsCalledOff", visit_value_cents AS "visitCreditCents", credit_cents AS "creditCents",
       visits_restored AS "visitsRestored", reversed_cents AS "reversedCents", created_at AS "createdAt", withdrawn_at AS "withdrawnAt"
     FROM subscription_pauses WHERE subscription_id = $1
     ORDER BY starts_on DESC, created_at DESC LIMIT 20`,
    [subscriptionId],
  );
  return result.rows;
}
