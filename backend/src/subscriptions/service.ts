import type { PoolClient } from 'pg';
import { proShareCents } from '../catalogue/pricing.js';
import type { BookingDeps } from '../bookings/events.js';
import { withTransaction, type Queryable } from '../db.js';
import { messages } from '../notifications/messages.js';
import { enqueue } from '../notifications/outbox.js';
import type { Frequency } from '../plans/routes.js';

/** How far ahead visits are planned. */
export const PLANNING_DAYS = 28;

/**
 * Billing starts on the first visit day (D91): its first month is charged at midnight (market time) of that day.
 * When that midnight is less than this many hours away, i.e. the first visit is tomorrow, the first month is
 * charged at sign-up instead, so a card problem shows up while the customer is still in the app, not a few
 * hours before the pro comes.
 */
export const CHARGE_AT_ONCE_HOURS = 24;
/**
 * A visit of a plan whose first month is still unpaid is held this long before it starts, when the payment
 * provider has not told us about the first charge by then (D91). Stripe charges at about 01:00 on the first
 * visit day and the earliest visit is at 08:00, so this only catches a charge or a webhook that never came.
 */
export const HOLD_UNPAID_VISIT_HOURS = 2;

/** The SQL for when a plan's billing starts (D91); plans from before D91 count from their first payment or sign-up. */
export const BILLING_START = 'COALESCE(s.billing_starts_at, s.started_at, s.created_at)';

/**
 * When a new plan's billing starts (D91): midnight of its first visit day in the market time zone, or now when
 * that is less than `CHARGE_AT_ONCE_HOURS` away. `chargeNow` says which.
 */
export async function billingStart(db: Queryable, firstDay: string, timezone: string): Promise<{ at: Date; chargeNow: boolean }> {
  const result = await db.query<{ day_start: Date; now: Date; soon: boolean }>(
    `SELECT $1::date::timestamp AT TIME ZONE $2 AS day_start, now() AS now,
       $1::date::timestamp AT TIME ZONE $2 < now() + make_interval(hours => $3::int) AS soon`,
    [firstDay, timezone, CHARGE_AT_ONCE_HOURS],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('Billing start query returned nothing');
  }
  return row.soon ? { at: row.now, chargeNow: true } : { at: row.day_start, chargeNow: false };
}
/** An unpaid sign-up is dropped after this, freeing the pro's time. */
export const SUBSCRIPTION_PAYMENT_MINUTES = 30;
/** Local start hour of a visit for each time window. */
export const WINDOW_HOUR = { morning: 8, afternoon: 13 } as const;
export type TimeWindow = keyof typeof WINDOW_HOUR;
export type PlanSize = 'S' | 'M' | 'L';

/** The size part of a plan's price, in percent of a medium home or garden (the demo's rule). */
export const SIZE_PRICE_PCT: Record<PlanSize, number> = { S: 85, M: 100, L: 135 };
/**
 * The frequency part of a plan's price, in percent of once a week (the design's rule, D90). A plan's own price
 * is for its own frequency; another frequency the customer picks in the Plan builder scales it by these.
 */
export const FREQUENCY_PRICE_PCT: Record<Frequency, number> = {
  every_2_weeks: 60,
  weekly: 100,
  twice_weekly: 180,
  three_times_weekly: 250,
};
export const PLAN_SIZES: readonly PlanSize[] = ['S', 'M', 'L'];

/**
 * The one pricing rule for monthly plans (D90): the plan's price (a medium home at the plan's own frequency)
 * scaled by the chosen frequency and size, rounded once to whole cents. The extra is added on top by
 * `monthlyPrice`. The Plan builder shows exactly these numbers: `/plans` sends the whole table.
 */
export function planPrice(plan: { priceCents: number; frequency: Frequency }, choice: { frequency: Frequency; size: PlanSize }): number {
  return Math.round(
    (plan.priceCents * FREQUENCY_PRICE_PCT[choice.frequency] * SIZE_PRICE_PCT[choice.size]) / (FREQUENCY_PRICE_PCT[plan.frequency] * 100),
  );
}

/** What a customer pays a month for a plan with their choices, extra included. */
export function monthlyPrice(
  plan: { priceCents: number; frequency: Frequency; addonPriceCents: number | null },
  choice: { frequency: Frequency; size: PlanSize; withAddon: boolean },
): number {
  return planPrice(plan, choice) + (choice.withAddon ? (plan.addonPriceCents ?? 0) : 0);
}

/** Every frequency and size of a plan, priced by `planPrice`, for the Plan builder's live price. */
export function planPriceTable(plan: { priceCents: number; frequency: Frequency }): Record<Frequency, Record<PlanSize, number>> {
  return Object.fromEntries(
    (Object.keys(FREQUENCY_PRICE_PCT) as Frequency[]).map((frequency) => [frequency, Object.fromEntries(PLAN_SIZES.map((size) => [size, planPrice(plan, { frequency, size })]))]),
  ) as Record<Frequency, Record<PlanSize, number>>;
}

/** The plan's price is for a medium home or garden at its own frequency: small is 15% less, large 35% more. */
export function planSizePrice(priceCents: number, size: PlanSize): number {
  return planPrice({ priceCents, frequency: 'weekly' }, { frequency: 'weekly', size });
}

/** The Plan builder's Start choices (D90): the first visit is on a chosen day from tomorrow plus this many days. */
export const START_OFFSET_DAYS = { asap: 0, next_week: 7, in_2_weeks: 14 } as const;
export type StartOption = keyof typeof START_OFFSET_DAYS;

/** Midday UTC of a calendar day: the same calendar day in every European time zone, for week arithmetic. */
export const dayAnchor = (day: string): Date => new Date(`${day}T12:00:00Z`);

/**
 * The day of a new plan's first visit (D90): the first of the chosen weekdays from tomorrow plus the Start
 * option's days, in the market time zone, in season for a seasonal plan and within the planning window.
 * Null when there is none, e.g. a seasonal plan whose season ends first.
 */
export async function firstVisitDay(
  db: Queryable,
  input: { days: number[]; start: StartOption; seasonal: boolean; seasonFrom: number | null; seasonTo: number | null },
  timezone: string,
): Promise<string | null> {
  const result = await db.query<{ day: string }>(
    `WITH today AS (SELECT (now() AT TIME ZONE $1)::date AS d)
     SELECT to_char(day, 'YYYY-MM-DD') AS day
     FROM today, generate_series(today.d + 1 + $2::int, today.d + $3::int, interval '1 day') AS day
     WHERE extract(isodow FROM day)::int = ANY ($4::int[])
       AND (NOT $5::boolean OR extract(month FROM day)::int BETWEEN $6::int AND $7::int)
     ORDER BY day LIMIT 1`,
    [timezone, START_OFFSET_DAYS[input.start], PLANNING_DAYS, input.days, input.seasonal, input.seasonFrom ?? 1, input.seasonTo ?? 12],
  );
  return result.rows[0]?.day ?? null;
}

export interface VisitPattern {
  days: number[];
  frequency: Frequency;
  timeWindow: TimeWindow;
  visitMinutes: number;
  seasonal: boolean;
  seasonFrom: number | null;
  seasonTo: number | null;
  /** Every-two-weeks plans visit in the weeks that line up with this date. */
  anchor: Date;
  /** No visit after this moment, e.g. when a cancelled plan's last paid month ends. */
  until: Date | null;
  /** No visit before this local day ('YYYY-MM-DD'): the plan's first visit day (D90). */
  from?: string | null;
}

/**
 * Visit start times from tomorrow for `PLANNING_DAYS` days, in the market time zone: on the chosen
 * weekdays, every other week for "every 2 weeks", only within the season for seasonal plans. With `days`,
 * the local calendar days from `first` to `last` (both 'YYYY-MM-DD', inclusive) instead, e.g. the days of a
 * pause (D78).
 */
export async function plannedStarts(
  db: Queryable,
  pattern: VisitPattern,
  timezone: string,
  days?: { first: string; last: string },
): Promise<Date[]> {
  const result = await db.query<{ starts_at: Date }>(
    `WITH local_today AS (SELECT (now() AT TIME ZONE $1)::date AS d),
     bounds AS (
       SELECT GREATEST(COALESCE($12::date, local_today.d + 1), COALESCE($14::date, local_today.d + 1)) AS first,
         COALESCE($13::date, local_today.d + $2::int) AS last FROM local_today
     )
     SELECT (day + make_interval(hours => $3::int)) AT TIME ZONE $1 AS starts_at
     FROM bounds, generate_series(bounds.first, bounds.last, interval '1 day') AS day
     WHERE extract(isodow FROM day)::int = ANY ($4::int[])
       AND (NOT $5::boolean OR ((day::date - date_trunc('week', ($6::timestamptz AT TIME ZONE $1))::date) / 7) % 2 = 0)
       AND (NOT $7::boolean OR extract(month FROM day)::int BETWEEN $8::int AND $9::int)
       AND ($10::timestamptz IS NULL OR (day + make_interval(hours => $3::int, mins => $11::int)) AT TIME ZONE $1 <= $10)
     ORDER BY day`,
    [
      timezone,
      PLANNING_DAYS,
      WINDOW_HOUR[pattern.timeWindow],
      pattern.days,
      pattern.frequency === 'every_2_weeks',
      pattern.anchor,
      pattern.seasonal,
      pattern.seasonFrom ?? 1,
      pattern.seasonTo ?? 12,
      pattern.until,
      pattern.visitMinutes,
      days?.first ?? null,
      days?.last ?? null,
      pattern.from ?? null,
    ],
  );
  return result.rows.map((row) => row.starts_at);
}

/**
 * The best regular pro for a plan: approved with payouts, in the plan's trade, covering the postcode,
 * working on every chosen weekday, and free for every planned visit. Highest rating first, then nearest.
 */
export async function chooseRegularPro(
  db: Queryable,
  input: { categoryId: string; postcode: string; days: number[]; starts: Date[]; visitMinutes: number; customerId: string },
): Promise<string | null> {
  const result = await db.query<{ user_id: string }>(
    `SELECT p.user_id FROM pro_profiles p
     JOIN users u ON u.id = p.user_id AND u.disabled_at IS NULL
     JOIN postcodes home ON home.code = p.home_postcode
     JOIN postcodes dest ON dest.code = $2
     WHERE p.status = 'approved' AND p.payouts_enabled AND p.jobs_paused_at IS NULL
       AND p.user_id <> $6
       AND EXISTS (SELECT 1 FROM pro_trades t WHERE t.pro_id = p.user_id AND t.category_id = $1)
       AND distance_km(home.lat, home.lng, dest.lat, dest.lng) <= p.radius_km
       AND p.working_days @> $3::smallint[]
       AND NOT EXISTS (
         SELECT 1 FROM unnest($4::timestamptz[]) AS s(starts_at)
         WHERE EXISTS (
             SELECT 1 FROM bookings b WHERE b.pro_id = p.user_id AND b.status IN ('accepted', 'on_the_way', 'working')
               AND tstzrange(b.starts_at, b.ends_at) && tstzrange(s.starts_at, s.starts_at + make_interval(mins => $5::int)))
           OR EXISTS (
             SELECT 1 FROM subscription_visits v WHERE v.pro_id = p.user_id AND v.status IN ('pending', 'planned')
               AND tstzrange(v.starts_at, v.ends_at) && tstzrange(s.starts_at, s.starts_at + make_interval(mins => $5::int)))
       )
     ORDER BY COALESCE((SELECT avg(stars) FROM ratings r WHERE r.pro_id = p.user_id), 4.5) DESC,
       distance_km(home.lat, home.lng, dest.lat, dest.lng), p.user_id
     LIMIT 1`,
    [input.categoryId, input.postcode, input.days, input.starts, input.visitMinutes, input.customerId],
  );
  return result.rows[0]?.user_id ?? null;
}

export interface SubscriptionRow {
  id: string;
  pro_id: string | null;
  days: number[];
  frequency: Frequency;
  time_window: TimeWindow;
  visit_minutes: number;
  seasonal: boolean;
  season_from: number | null;
  season_to: number | null;
  started_at: Date | null;
  created_at: Date;
  ends_at: Date | null;
  /** The first visit's local day, 'YYYY-MM-DD' (D90); null for plans from before it was kept. */
  first_visit_on: string | null;
}

export const SUBSCRIPTION_PATTERN = `id, pro_id, days, frequency, time_window, visit_minutes, seasonal, season_from, season_to,
  started_at, created_at, ends_at, to_char(first_visit_on, 'YYYY-MM-DD') AS first_visit_on`;

export const patternOf = (row: SubscriptionRow): VisitPattern => ({
  days: row.days,
  frequency: row.frequency,
  timeWindow: row.time_window,
  visitMinutes: row.visit_minutes,
  seasonal: row.seasonal,
  seasonFrom: row.season_from,
  seasonTo: row.season_to,
  // Every-2-weeks plans count their weeks from the first visit (D90), older plans from when they started.
  anchor: row.first_visit_on ? dayAnchor(row.first_visit_on) : (row.started_at ?? row.created_at),
  until: row.ends_at,
  from: row.first_visit_on,
});

/**
 * Adds the visits still missing in the planning window, never after the plan's end (`ends_at`, e.g. the
 * end of a cancelled plan's 30 days' notice) and never inside a pause (D78). A time the pro has since
 * filled is left out rather than double-booking them. Returns how many were added.
 */
export async function planVisits(
  db: PoolClient | Queryable,
  subscription: SubscriptionRow,
  timezone: string,
  status: 'pending' | 'planned',
): Promise<number> {
  if (!subscription.pro_id) {
    return 0;
  }
  const starts = await plannedStarts(db, patternOf(subscription), timezone);
  if (!starts.length) {
    return 0;
  }
  const added = await db.query(
    `INSERT INTO subscription_visits (subscription_id, pro_id, starts_at, ends_at, status)
     SELECT $1, $2, s.starts_at, s.starts_at + make_interval(mins => $4::int), $5
     FROM unnest($3::timestamptz[]) AS s(starts_at)
     WHERE NOT EXISTS (
         SELECT 1 FROM subscription_visits v
         -- A visit moved to another day (D77) keeps its first time, which is never planned again.
         WHERE (v.subscription_id = $1 AND (v.starts_at = s.starts_at OR v.moved_from = s.starts_at))
            OR (v.pro_id = $2 AND v.status IN ('pending', 'planned')
                AND tstzrange(v.starts_at, v.ends_at) && tstzrange(s.starts_at, s.starts_at + make_interval(mins => $4::int))))
       -- Nothing is planned while the customer has paused the plan (D78).
       AND NOT EXISTS (
         SELECT 1 FROM subscription_pauses pz
         WHERE pz.subscription_id = $1 AND pz.status = 'active' AND s.starts_at >= pz.starts_at AND s.starts_at < pz.ends_at)
       AND NOT EXISTS (
         SELECT 1 FROM bookings b WHERE b.pro_id = $2 AND b.status IN ('accepted', 'on_the_way', 'working')
           AND tstzrange(b.starts_at, b.ends_at) && tstzrange(s.starts_at, s.starts_at + make_interval(mins => $4::int)))`,
    [subscription.id, subscription.pro_id, starts, subscription.visit_minutes, status],
  );
  return added.rowCount ?? 0;
}

/**
 * A month was paid: the plan becomes active (its pending visits real), the paid month is recorded,
 * and the pro's share is queued for payout. Safe to call twice for the same invoice.
 * The first paid month starts when billing starts (D91): the first visit day, or sign-up when charged at once.
 */
export async function recordPaidMonth(
  deps: BookingDeps,
  input: { subscriptionId: string; invoiceId: string; amountCents: number; periodEnd: Date },
): Promise<void> {
  const subscription = await withTransaction(deps.pool, async (client) => {
    const found = await client.query<SubscriptionRow & { pro_share_pct: number; status: string }>(
      `UPDATE subscriptions SET status = 'active', started_at = COALESCE(started_at, billing_starts_at, now()),
         current_period_end = GREATEST(COALESCE(current_period_end, $2), $2), updated_at = now()
       WHERE stripe_subscription_id = $1 AND status IN ('awaiting_payment', 'active', 'past_due')
       RETURNING ${SUBSCRIPTION_PATTERN}, pro_share_pct, status`,
      [input.subscriptionId, input.periodEnd],
    );
    const row = found.rows[0];
    if (!row) {
      return null;
    }
    // Visits held for the payment take place; one whose time passed while it was held (D91) did not happen.
    await client.query(
      `UPDATE subscription_visits SET status = CASE WHEN starts_at > now() THEN 'planned' ELSE 'cancelled' END
       WHERE subscription_id = $1 AND status = 'pending'`,
      [row.id],
    );
    // A month fully covered by credit, e.g. for paused visits (D78), is paid with nothing, so nothing is paid out.
    if (row.pro_id && input.amountCents > 0) {
      await client.query(
        `INSERT INTO subscription_payouts (subscription_id, pro_id, invoice_id, amount_cents)
         VALUES ($1, $2, $3, $4) ON CONFLICT (invoice_id) DO NOTHING`,
        [row.id, row.pro_id, input.invoiceId, proShareCents(input.amountCents, row.pro_share_pct)],
      );
    }
    return row;
  });
  if (!subscription) {
    deps.log.warn({ event: 'invoice_for_unknown_subscription', subscriptionId: input.subscriptionId });
    return;
  }
  await withTransaction(deps.pool, (client) => planVisits(client, subscription, deps.config.timezone, 'planned'));
  deps.log.info({ event: 'subscription_month_paid', subscriptionId: subscription.id, invoiceId: input.invoiceId });
  await paySubscriptionPayouts(deps, subscription.id);
}

/**
 * The card is set up for a plan billed from its first visit day (D91): the plan is active and its visits are
 * planned, while nothing is charged until that day. Until the first month is paid, "next payment" is that day.
 * Returns false when the plan was not waiting for its card (e.g. already active). Safe to call twice.
 */
export async function activateSubscription(deps: BookingDeps, stripeSubscriptionId: string): Promise<boolean> {
  const subscription = await withTransaction(deps.pool, async (client) => {
    const found = await client.query<SubscriptionRow>(
      `UPDATE subscriptions SET status = 'active', current_period_end = COALESCE(current_period_end, billing_starts_at), updated_at = now()
       WHERE stripe_subscription_id = $1 AND status = 'awaiting_payment'
       RETURNING ${SUBSCRIPTION_PATTERN}`,
      [stripeSubscriptionId],
    );
    const row = found.rows[0];
    if (!row) {
      return null;
    }
    await client.query(
      `UPDATE subscription_visits SET status = CASE WHEN starts_at > now() THEN 'planned' ELSE 'cancelled' END
       WHERE subscription_id = $1 AND status = 'pending'`,
      [row.id],
    );
    await planVisits(client, row, deps.config.timezone, 'planned');
    return row;
  });
  if (!subscription) {
    return false;
  }
  deps.log.info({ event: 'subscription_card_ready', subscriptionId: subscription.id });
  return true;
}

/**
 * Holds the upcoming planned visits of a plan whose first month is not paid (D91): they go back to 'pending',
 * which keeps the pro's time but takes them off the pro's week, so no visit is done unpaid. A paid first month
 * (`recordPaidMonth`) plans them again. With `withinHours`, only visits starting that soon. Returns how many.
 */
async function holdUnpaidVisits(db: Queryable, subscriptionId: string, withinHours: number | null): Promise<number> {
  const held = await db.query(
    `UPDATE subscription_visits SET status = 'pending'
     WHERE subscription_id = $1 AND status = 'planned' AND ends_at > now()
       AND ($2::int IS NULL OR starts_at < now() + make_interval(hours => $2::int))`,
    [subscriptionId, withinHours],
  );
  return held.rowCount ?? 0;
}

/**
 * A monthly charge failed. The plan is past due and Stripe tries again. When it was the first month of a plan
 * billed from its first visit day (D91), the plan has never been paid: its visits are held until the payment
 * goes through, and the customer is told to check their card.
 */
export async function markPastDue(deps: BookingDeps, stripeSubscriptionId: string): Promise<void> {
  const held = await withTransaction(deps.pool, async (client) => {
    const found = await client.query<{ id: string; customer_id: string; plan_name: string; first_month: boolean }>(
      `UPDATE subscriptions SET status = 'past_due', updated_at = now() WHERE stripe_subscription_id = $1 AND status = 'active'
       RETURNING id, customer_id, plan_name, started_at IS NULL AS first_month`,
      [stripeSubscriptionId],
    );
    const row = found.rows[0];
    if (!row?.first_month) {
      return null;
    }
    const visits = await holdUnpaidVisits(client, row.id, null);
    await enqueue(client, row.customer_id, 'payment_action_needed', messages.planFirstPaymentFailed(row.plan_name), {
      link: `/my-plans/${row.id}`,
    });
    return { subscriptionId: row.id, visits };
  });
  if (held) {
    deps.log.error({ event: 'subscription_first_payment_failed', stripeSubscriptionId, ...held });
  } else {
    deps.log.warn({ event: 'subscription_payment_failed', stripeSubscriptionId });
  }
}

/** Sends the pros their share of paid months. Failed transfers are retried by the worker. */
export async function paySubscriptionPayouts(deps: BookingDeps, subscriptionId?: string): Promise<number> {
  const due = await deps.pool.query<{ id: string; amount_cents: number; subscription_id: string; stripe_account_id: string | null }>(
    `SELECT sp.id, sp.amount_cents, sp.subscription_id, p.stripe_account_id
     FROM subscription_payouts sp JOIN pro_profiles p ON p.user_id = sp.pro_id
     WHERE sp.status IN ('pending', 'failed') AND ($1::uuid IS NULL OR sp.subscription_id = $1)
       AND ($1::uuid IS NOT NULL OR sp.status = 'pending' OR sp.updated_at < now() - interval '10 minutes')
     LIMIT 50`,
    [subscriptionId ?? null],
  );
  for (const payout of due.rows) {
    if (!payout.stripe_account_id) {
      deps.log.error({ event: 'subscription_payout_blocked', payoutId: payout.id, reason: 'pro_has_no_payout_account' });
      continue;
    }
    try {
      const { transferId } = await deps.gateway.transfer({
        accountId: payout.stripe_account_id,
        amountCents: payout.amount_cents,
        transferGroup: `subscription-${payout.subscription_id}`,
        idempotencyKey: `subscription-payout-${payout.id}`,
      });
      await deps.pool.query("UPDATE subscription_payouts SET status = 'sent', transfer_id = $2, error = NULL, updated_at = now() WHERE id = $1", [
        payout.id,
        transferId,
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.log.error({ event: 'subscription_payout_failed', payoutId: payout.id, error: message });
      await deps.pool.query("UPDATE subscription_payouts SET status = 'failed', error = $2, updated_at = now() WHERE id = $1", [
        payout.id,
        message.slice(0, 500),
      ]);
    }
  }
  return due.rows.length;
}

/** Ends a sign-up that was never paid: stops billing and frees the pro's held time. */
export async function dropUnpaidSubscription(deps: BookingDeps, id: string): Promise<void> {
  const found = await deps.pool.query<{ stripe_subscription_id: string | null }>(
    `UPDATE subscriptions SET status = 'cancelled', ends_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'awaiting_payment' RETURNING stripe_subscription_id`,
    [id],
  );
  const row = found.rows[0];
  if (!row) {
    return;
  }
  await deps.pool.query("DELETE FROM subscription_visits WHERE subscription_id = $1 AND status = 'pending'", [id]);
  if (row.stripe_subscription_id) {
    await deps.gateway
      .cancelSubscription(row.stripe_subscription_id, false)
      .catch((error: unknown) => deps.log.error({ event: 'subscription_cancel_failed', subscriptionId: id, err: error }));
  }
}

/**
 * One planning pass: drops unpaid sign-ups, ends plans whose last paid month is over, keeps every
 * active plan planned four weeks ahead, pauses seasonal plans' billing in winter and resumes it in
 * spring, and retries payouts.
 */
export async function subscriptionTick(deps: BookingDeps): Promise<void> {
  const unpaid = await deps.pool.query<{ id: string; stripe_subscription_id: string | null; later: boolean }>(
    `SELECT id, stripe_subscription_id, billing_starts_at > created_at + interval '1 minute' AS later
     FROM subscriptions WHERE status = 'awaiting_payment' AND created_at < now() - make_interval(mins => $1) LIMIT 50`,
    [SUBSCRIPTION_PAYMENT_MINUTES],
  );
  for (const row of unpaid.rows) {
    // A plan billed from a later day (D91) whose card was set up, but whose webhook never came, starts after all.
    if (row.later && row.stripe_subscription_id) {
      try {
        if (await deps.gateway.subscriptionCardReady(row.stripe_subscription_id)) {
          await activateSubscription(deps, row.stripe_subscription_id);
          continue;
        }
      } catch (error) {
        // Asked again on the next pass rather than dropping a plan whose card may be set up.
        deps.log.error({ event: 'subscription_card_check_failed', subscriptionId: row.id, err: error });
        continue;
      }
    }
    await dropUnpaidSubscription(deps, row.id);
  }

  await deps.pool.query(
    `UPDATE subscriptions SET status = 'cancelled', updated_at = now() WHERE status IN ('active', 'past_due') AND ends_at <= now()`,
  );

  const active = await deps.pool.query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_PATTERN} FROM subscriptions WHERE status = 'active' AND pro_id IS NOT NULL ORDER BY id LIMIT 500`,
  );
  for (const subscription of active.rows) {
    await planVisits(deps.pool, subscription, deps.config.timezone, 'planned');
  }

  // No visit is done unpaid (D91): billing has started but the first month is still not paid, and Stripe has not
  // said it failed either, so the visits about to start wait for the payment.
  const unpaidFirstMonth = await deps.pool.query<{ id: string; customer_id: string; plan_name: string }>(
    `SELECT s.id, s.customer_id, s.plan_name FROM subscriptions s
     WHERE s.status IN ('active', 'past_due') AND s.started_at IS NULL AND s.billing_starts_at <= now()
       AND EXISTS (SELECT 1 FROM subscription_visits v WHERE v.subscription_id = s.id AND v.status = 'planned'
                   AND v.ends_at > now() AND v.starts_at < now() + make_interval(hours => $1))
     LIMIT 50`,
    [HOLD_UNPAID_VISIT_HOURS],
  );
  for (const row of unpaidFirstMonth.rows) {
    const visits = await withTransaction(deps.pool, async (client) => {
      const count = await holdUnpaidVisits(client, row.id, HOLD_UNPAID_VISIT_HOURS);
      if (count > 0) {
        await enqueue(client, row.customer_id, 'payment_action_needed', messages.planFirstPaymentFailed(row.plan_name), {
          link: `/my-plans/${row.id}`,
        });
      }
      return count;
    });
    deps.log.error({ event: 'subscription_unpaid_visits_held', subscriptionId: row.id, visits });
  }

  const seasonal = await deps.pool.query<{ id: string; stripe_subscription_id: string; billing_paused: boolean; in_season: boolean }>(
    `SELECT id, stripe_subscription_id, billing_paused,
       extract(month FROM now() AT TIME ZONE $1)::int BETWEEN season_from AND season_to AS in_season
     FROM subscriptions
     WHERE status = 'active' AND seasonal AND stripe_subscription_id IS NOT NULL`,
    [deps.config.timezone],
  );
  for (const row of seasonal.rows) {
    const shouldPause = !row.in_season;
    if (shouldPause !== row.billing_paused) {
      try {
        await deps.gateway.setBillingPaused(row.stripe_subscription_id, shouldPause);
        await deps.pool.query('UPDATE subscriptions SET billing_paused = $2, updated_at = now() WHERE id = $1', [row.id, shouldPause]);
        deps.log.info({ event: shouldPause ? 'subscription_season_paused' : 'subscription_season_resumed', subscriptionId: row.id });
      } catch (error) {
        deps.log.error({ event: 'subscription_season_change_failed', subscriptionId: row.id, err: error });
      }
    }
  }

  await paySubscriptionPayouts(deps);
}
