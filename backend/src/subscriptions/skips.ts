import type { PoolClient } from 'pg';
import type { BookingDeps } from '../bookings/events.js';
import { withTransaction } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { isExclusionViolation } from '../http.js';
import { formatSlot, messages } from '../notifications/messages.js';
import { enqueue } from '../notifications/outbox.js';
import { MOVE_NOTICE_HOURS } from './moves.js';

/**
 * Skipping one plan visit (D90, reversing that part of D77). A customer may skip an upcoming planned visit up
 * to 24 hours before it starts, at most `MAX_SKIPS_PER_MONTH` visits per calendar month (market time zone) of
 * one plan, and undo a skip up to the same 24 hours when the visit can still take place. A skipped visit
 * frees the pro's time, and is still part of the monthly price: nothing is credited or refunded, and the
 * pro's share is not changed. The pro is told either way and does not expect a skipped visit.
 *
 * Every skip and undo locks the plan's row first, so changes to one plan happen one at a time and two skips
 * at the same moment can never both take the last skip of a month.
 */
export const MAX_SKIPS_PER_MONTH = 2;
/** Skips and undos must come at least this long before the visit, like moves (D77). */
export const SKIP_NOTICE_HOURS = MOVE_NOTICE_HOURS;

const PRO_CHANNELS = { push: true, sms: false, email: false };

interface SkipIds {
  subscriptionId: string;
  visitId: string;
  customerId: string;
}

interface LockedVisit {
  id: string;
  status: string;
  starts_at: Date;
  ends_at: Date;
  pro_id: string;
  early_enough: boolean;
  pending_move: boolean;
  paused: boolean;
  plan_status: string;
  plan_ends_at: Date | null;
  plan_pro_id: string | null;
  plan_name: string;
  customer_name: string | null;
  skipped_in_month: number;
}

/** The customer's own plan and visit, both locked, with what skipping depends on. */
async function lockVisit(client: PoolClient, ids: SkipIds, timezone: string): Promise<LockedVisit> {
  // The plan first, always in this order, so concurrent changes to one plan queue up instead of racing.
  const plan = await client.query('SELECT 1 FROM subscriptions WHERE id = $1 AND customer_id = $2 FOR UPDATE', [
    ids.subscriptionId,
    ids.customerId,
  ]);
  if (!plan.rowCount) {
    throw notFound();
  }
  const found = await client.query<LockedVisit>(
    `SELECT v.id, v.status, v.starts_at, v.ends_at, v.pro_id,
       v.starts_at >= now() + make_interval(hours => $3) AS early_enough,
       EXISTS (SELECT 1 FROM subscription_visit_moves m WHERE m.visit_id = v.id AND m.status = 'pending') AS pending_move,
       EXISTS (
         SELECT 1 FROM subscription_pauses pz
         WHERE pz.subscription_id = s.id AND pz.status = 'active' AND v.starts_at >= pz.starts_at AND v.starts_at < pz.ends_at
       ) AS paused,
       s.status AS plan_status, s.ends_at AS plan_ends_at, s.pro_id AS plan_pro_id, s.plan_name,
       (SELECT first_name FROM users u WHERE u.id = s.customer_id) AS customer_name,
       (SELECT count(*)::int FROM subscription_visits x
        WHERE x.subscription_id = s.id AND x.status = 'skipped'
          AND date_trunc('month', x.starts_at AT TIME ZONE $4) = date_trunc('month', v.starts_at AT TIME ZONE $4)) AS skipped_in_month
     FROM subscription_visits v JOIN subscriptions s ON s.id = v.subscription_id
     WHERE v.id = $1 AND s.id = $2
     FOR UPDATE OF v`,
    [ids.visitId, ids.subscriptionId, SKIP_NOTICE_HOURS, timezone],
  );
  const visit = found.rows[0];
  if (!visit) {
    throw notFound();
  }
  return visit;
}

const running = (status: string) => status === 'active' || status === 'past_due';

/** The customer skips one upcoming visit; the pro is told it will not happen. */
export async function skipVisit(deps: BookingDeps, ids: SkipIds): Promise<void> {
  const tz = deps.config.timezone;
  await withTransaction(deps.pool, async (client) => {
    const visit = await lockVisit(client, ids, tz);
    if (visit.status !== 'planned' || !running(visit.plan_status)) {
      throw conflict('visit_not_skippable');
    }
    if (!visit.early_enough) {
      throw conflict('skip_too_late');
    }
    // A visit waiting for the pro to confirm a new day is withdrawn first, by the customer (D77).
    if (visit.pending_move) {
      throw conflict('move_pending');
    }
    if (visit.skipped_in_month >= MAX_SKIPS_PER_MONTH) {
      throw conflict('no_skips_left');
    }
    await client.query("UPDATE subscription_visits SET status = 'skipped', skipped_at = now() WHERE id = $1", [visit.id]);
    await enqueue(
      client,
      visit.pro_id,
      'visit_skipped',
      messages.visitSkipped(visit.customer_name ?? 'Your customer', visit.plan_name, formatSlot(visit.starts_at, tz)),
      { channels: PRO_CHANNELS },
    );
  });
  deps.log.info({ event: 'visit_skipped', visitId: ids.visitId, subscriptionId: ids.subscriptionId });
}

/**
 * The customer takes a skip back: the visit is planned again if it is still 24 hours or more away, inside the
 * plan (not after its end, not in a pause) and the same pro is still free then.
 */
export async function undoSkip(deps: BookingDeps, ids: SkipIds): Promise<void> {
  const tz = deps.config.timezone;
  await withTransaction(deps.pool, async (client) => {
    const visit = await lockVisit(client, ids, tz);
    if (visit.status !== 'skipped') {
      throw conflict('visit_not_skipped');
    }
    if (!running(visit.plan_status)) {
      throw conflict('visit_not_skippable');
    }
    if (!visit.early_enough) {
      throw conflict('skip_too_late');
    }
    if (visit.plan_ends_at && visit.ends_at > visit.plan_ends_at) {
      throw conflict('plan_ending');
    }
    if (visit.paused) {
      throw conflict('visit_paused');
    }
    // The plan has another regular pro now, or this one took a job at that time meanwhile.
    const busy = await client.query(
      `SELECT 1 FROM bookings b WHERE b.pro_id = $1 AND b.status IN ('accepted', 'on_the_way', 'working')
         AND tstzrange(b.starts_at, b.ends_at) && tstzrange($2, $3)`,
      [visit.pro_id, visit.starts_at, visit.ends_at],
    );
    if (visit.plan_pro_id !== visit.pro_id || busy.rowCount) {
      throw conflict('pro_no_longer_free');
    }
    try {
      await client.query("UPDATE subscription_visits SET status = 'planned', skipped_at = NULL WHERE id = $1", [visit.id]);
    } catch (error) {
      // Another plan's visit took the time (the overlap rule).
      if (isExclusionViolation(error)) {
        throw conflict('pro_no_longer_free');
      }
      throw error;
    }
    await enqueue(
      client,
      visit.pro_id,
      'visit_unskipped',
      messages.visitUnskipped(visit.customer_name ?? 'Your customer', visit.plan_name, formatSlot(visit.starts_at, tz)),
      { channels: PRO_CHANNELS },
    );
  });
  deps.log.info({ event: 'visit_skip_undone', visitId: ids.visitId, subscriptionId: ids.subscriptionId });
}
