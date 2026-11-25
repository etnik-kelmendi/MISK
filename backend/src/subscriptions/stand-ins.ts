import type { PoolClient } from 'pg';
import type { BookingDeps } from '../bookings/events.js';
import { CHARGE_DELAY_HOURS } from '../bookings/lifecycle.js';
import { VISITS_PER_MONTH } from '../plans/routes.js';

/**
 * Plan visits done by a stand-in (D99) pay the stand-in, not the regular pro:
 * - 24 hours after the stand-in finishes the visit (the customer's review time), the stand-in gets a payout of
 *   their own for it: one row in subscription_payouts with the visit's fixed per-visit amount, sent to their Stripe
 *   account like every plan payout (one transfer per row, its id as the idempotency key);
 * - the regular pro's next monthly payout for that plan has the same amount taken off, once per visit.
 * A visit that never took place (skipped, D90, or called off by a pause with credit, D78) is not completed, so it
 * pays neither pro.
 */

/**
 * SQL: the fixed payout of one visit of plan `s` (the monthly pro share over the plan's visits a month), like the
 * pro's schedule shows it. Built on each call, so importing this module never depends on load order.
 */
export function visitCentsSql(alias = 's'): string {
  const cases = Object.entries(VISITS_PER_MONTH)
    .map(([frequency, visits]) => `WHEN '${frequency}' THEN ${visits}`)
    .join(' ');
  return `round(floor(${alias}.price_cents * ${alias}.pro_share_pct / 100.0) / (CASE ${alias}.frequency ${cases} END))::int`;
}

/**
 * Takes the stand-in visits of a plan that are not yet deducted off a new monthly payout of its regular pro, oldest
 * first, as far as the payout covers them (the rest wait for the next month). Call it in the transaction that
 * created the payout, so a repeated invoice event never deducts twice. Returns the amount taken off.
 */
export async function deductStandInVisits(
  client: PoolClient,
  payout: { id: string; subscriptionId: string; proId: string; amountCents: number },
): Promise<number> {
  const visits = await client.query<{ id: string; cents: number }>(
    `SELECT v.id, ${visitCentsSql()} AS cents
     FROM subscription_visits v JOIN subscriptions s ON s.id = v.subscription_id
     WHERE v.subscription_id = $1 AND v.stand_in_for = $2 AND v.pro_id <> $2 AND v.status = 'completed'
       AND v.stand_in_deducted_by IS NULL
     ORDER BY v.starts_at
     FOR UPDATE OF v`,
    [payout.subscriptionId, payout.proId],
  );
  let total = 0;
  const taken: string[] = [];
  for (const visit of visits.rows) {
    if (total + visit.cents > payout.amountCents) break;
    total += visit.cents;
    taken.push(visit.id);
  }
  if (taken.length === 0) {
    return 0;
  }
  await client.query('UPDATE subscription_visits SET stand_in_deducted_by = $1 WHERE id = ANY($2::uuid[])', [payout.id, taken]);
  await client.query(
    'UPDATE subscription_payouts SET amount_cents = amount_cents - $2, deducted_cents = deducted_cents + $2, updated_at = now() WHERE id = $1',
    [payout.id, total],
  );
  return total;
}

/**
 * Queues the stand-in's payout for every stand-in visit finished at least 24 hours ago that has none yet. Safe to
 * run on several servers and again: one payout per visit (unique key). The payouts are then sent by
 * paySubscriptionPayouts. Returns how many were queued.
 */
export async function queueStandInPayouts(deps: BookingDeps): Promise<number> {
  const queued = await deps.pool.query(
    `INSERT INTO subscription_payouts (subscription_id, pro_id, invoice_id, amount_cents, visit_id)
     SELECT v.subscription_id, v.pro_id, 'stand-in-' || v.id, ${visitCentsSql()}, v.id
     FROM subscription_visits v JOIN subscriptions s ON s.id = v.subscription_id
     WHERE v.stand_in_for IS NOT NULL AND v.pro_id <> v.stand_in_for AND v.status = 'completed'
       AND v.completed_at <= now() - make_interval(hours => $1)
       AND NOT EXISTS (SELECT 1 FROM subscription_payouts sp WHERE sp.visit_id = v.id)
     ORDER BY v.completed_at
     LIMIT 100
     ON CONFLICT DO NOTHING`,
    [CHARGE_DELAY_HOURS],
  );
  const count = queued.rowCount ?? 0;
  if (count > 0) {
    deps.log.info({ event: 'stand_in_payouts_queued', count });
  }
  return count;
}
