import type { PoolClient } from 'pg';
import { proShareCents } from '../catalogue/pricing.js';
import type { BookingDeps } from '../bookings/events.js';
import { withTransaction, type Queryable } from '../db.js';
import type { Frequency } from '../plans/routes.js';

/** How far ahead visits are planned. */
export const PLANNING_DAYS = 28;
/** An unpaid sign-up is dropped after this, freeing the pro's time. */
export const SUBSCRIPTION_PAYMENT_MINUTES = 30;
/** Local start hour of a visit for each time window. */
export const WINDOW_HOUR = { morning: 8, afternoon: 13 } as const;
export type TimeWindow = keyof typeof WINDOW_HOUR;
export type PlanSize = 'S' | 'M' | 'L';

/** The plan's price is for a medium home or garden: small is 15% less, large 35% more (the demo's rule). */
export function planSizePrice(priceCents: number, size: PlanSize): number {
  return Math.round((priceCents * { S: 85, M: 100, L: 135 }[size]) / 100);
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
}

/**
 * Visit start times from tomorrow for `PLANNING_DAYS` days, in the market time zone: on the chosen
 * weekdays, every other week for "every 2 weeks", only within the season for seasonal plans.
 */
export async function plannedStarts(db: Queryable, pattern: VisitPattern, timezone: string): Promise<Date[]> {
  const result = await db.query<{ starts_at: Date }>(
    `WITH local_today AS (SELECT (now() AT TIME ZONE $1)::date AS d)
     SELECT (day + make_interval(hours => $3::int)) AT TIME ZONE $1 AS starts_at
     FROM local_today, generate_series(local_today.d + 1, local_today.d + $2::int, interval '1 day') AS day
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
  input: { categoryId: string; postcode: string; days: number[]; starts: Date[]; visitMinutes: number },
): Promise<string | null> {
  const result = await db.query<{ user_id: string }>(
    `SELECT p.user_id FROM pro_profiles p
     JOIN users u ON u.id = p.user_id AND u.disabled_at IS NULL
     JOIN postcodes home ON home.code = p.home_postcode
     JOIN postcodes dest ON dest.code = $2
     WHERE p.status = 'approved' AND p.payouts_enabled
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
    [input.categoryId, input.postcode, input.days, input.starts, input.visitMinutes],
  );
  return result.rows[0]?.user_id ?? null;
}

interface SubscriptionRow {
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
}

const SUBSCRIPTION_PATTERN = `id, pro_id, days, frequency, time_window, visit_minutes, seasonal, season_from, season_to,
  started_at, created_at, ends_at`;

export const patternOf = (row: SubscriptionRow): VisitPattern => ({
  days: row.days,
  frequency: row.frequency,
  timeWindow: row.time_window,
  visitMinutes: row.visit_minutes,
  seasonal: row.seasonal,
  seasonFrom: row.season_from,
  seasonTo: row.season_to,
  anchor: row.started_at ?? row.created_at,
  until: row.ends_at,
});

/**
 * Adds the visits still missing in the planning window. A time the pro has since filled is left out
 * and logged, rather than double-booking them. Returns how many were added.
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
         WHERE (v.subscription_id = $1 AND v.starts_at = s.starts_at)
            OR (v.pro_id = $2 AND v.status IN ('pending', 'planned')
                AND tstzrange(v.starts_at, v.ends_at) && tstzrange(s.starts_at, s.starts_at + make_interval(mins => $4::int))))
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
 */
export async function recordPaidMonth(
  deps: BookingDeps,
  input: { subscriptionId: string; invoiceId: string; amountCents: number; periodEnd: Date },
): Promise<void> {
  const subscription = await withTransaction(deps.pool, async (client) => {
    const found = await client.query<SubscriptionRow & { pro_share_pct: number; status: string }>(
      `UPDATE subscriptions SET status = 'active', started_at = COALESCE(started_at, now()),
         current_period_end = GREATEST(COALESCE(current_period_end, $2), $2), updated_at = now()
       WHERE stripe_subscription_id = $1 AND status IN ('awaiting_payment', 'active', 'past_due')
       RETURNING ${SUBSCRIPTION_PATTERN}, pro_share_pct, status`,
      [input.subscriptionId, input.periodEnd],
    );
    const row = found.rows[0];
    if (!row) {
      return null;
    }
    await client.query("UPDATE subscription_visits SET status = 'planned' WHERE subscription_id = $1 AND status = 'pending'", [row.id]);
    if (row.pro_id) {
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

export async function markPastDue(deps: BookingDeps, stripeSubscriptionId: string): Promise<void> {
  await deps.pool.query(
    `UPDATE subscriptions SET status = 'past_due', updated_at = now() WHERE stripe_subscription_id = $1 AND status = 'active'`,
    [stripeSubscriptionId],
  );
  deps.log.warn({ event: 'subscription_payment_failed', stripeSubscriptionId });
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
  const unpaid = await deps.pool.query<{ id: string }>(
    `SELECT id FROM subscriptions WHERE status = 'awaiting_payment' AND created_at < now() - make_interval(mins => $1) LIMIT 50`,
    [SUBSCRIPTION_PAYMENT_MINUTES],
  );
  for (const { id } of unpaid.rows) {
    await dropUnpaidSubscription(deps, id);
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
