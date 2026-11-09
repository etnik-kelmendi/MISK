import type { PoolClient } from 'pg';
import { logAction } from '../bookings/admin-routes.js';
import { offerNext } from '../bookings/dispatch.js';
import { setStatus, type BookingDeps } from '../bookings/events.js';
import { withTransaction, type Queryable } from '../db.js';
import { formatSlot, messages } from '../notifications/messages.js';
import { enqueue } from '../notifications/outbox.js';
import {
  chooseRegularPro,
  planVisits,
  patternOf,
  plannedStarts,
  SUBSCRIPTION_PATTERN,
  type SubscriptionRow,
} from '../subscriptions/service.js';
import { marketToday, type DocumentKind } from './checks.js';

export type ProAction =
  | 'approved'
  | 'info_requested'
  | 'rejected'
  | 'document_accepted'
  | 'document_rejected'
  | 'reminder_sent'
  | 'watch_list_on'
  | 'watch_list_off'
  | 'coaching_booked'
  | 'jobs_paused'
  | 'jobs_resumed'
  | 'suspended'
  | 'reinstated'
  | 'moved_to_pending'
  | 'back_to_active';

/** Writes one line in the pro's activity log. `adminId` is null when MISK acted by itself. */
export async function logProAction(
  db: Queryable,
  proId: string,
  adminId: string | null,
  action: ProAction,
  details: Record<string, unknown> = {},
) {
  await db.query('INSERT INTO pro_admin_actions (pro_id, admin_id, action, details) VALUES ($1, $2, $3, $4)', [
    proId,
    adminId,
    action,
    JSON.stringify(details),
  ]);
}

/** Names of documents in text messages. */
export const DOCUMENT_NAMES: Record<DocumentKind, string> = {
  id: 'ID card or passport',
  certificate: 'trade certificate',
  insurance: 'liability insurance',
  background: 'certificate of good conduct',
};

/** Takes back the job offers a pro has not answered; the dispatcher then offers those jobs to others. */
export async function withdrawOffers(deps: BookingDeps, proId: string): Promise<number> {
  const withdrawn = await deps.pool.query<{ booking_id: string }>(
    `UPDATE booking_offers SET status = 'withdrawn', responded_at = now()
     WHERE pro_id = $1 AND status = 'pending' RETURNING booking_id`,
    [proId],
  );
  for (const { booking_id } of withdrawn.rows) {
    await offerNext(deps, booking_id);
  }
  return withdrawn.rowCount ?? 0;
}

export interface HandOver {
  bookings: number;
  plans: number;
  plansWithoutPro: number;
}

/**
 * Gives a suspended pro's open work to other pros: offers are withdrawn, booked jobs that have not started
 * go back to the search, and each monthly plan gets a new regular pro with fresh visits. Jobs already under
 * way stay with the pro. Plans no free pro can take keep their customer and are counted for the team.
 */
export async function handOverWork(deps: BookingDeps, proId: string, adminId: string): Promise<HandOver> {
  await withdrawOffers(deps, proId);

  const restarted = await withTransaction(deps.pool, async (client) => {
    const jobs = await client.query<{ id: string; customer_id: string; service_name: string; starts_at: Date }>(
      `SELECT id, customer_id, service_name, starts_at FROM bookings
       WHERE pro_id = $1 AND status = 'accepted' FOR UPDATE`,
      [proId],
    );
    for (const job of jobs.rows) {
      // Pros who passed before may be asked again; the suspended pro can no longer be chosen.
      await client.query("DELETE FROM booking_offers WHERE booking_id = $1 AND status <> 'withdrawn'", [job.id]);
      await setStatus(client, job.id, 'searching', ', pro_id = NULL');
      await enqueue(
        client,
        job.customer_id,
        'pro_assigned',
        messages.proReplaced(job.service_name, formatSlot(job.starts_at, deps.config.timezone)),
      );
      await logAction(client, job.id, adminId, 'restarted_search', { previousPro: proId, reason: 'pro_suspended' });
    }
    return jobs.rows.map((job) => job.id);
  });
  for (const bookingId of restarted) {
    await offerNext(deps, bookingId);
  }

  const plans = await deps.pool.query<{ id: string }>(
    "SELECT id FROM subscriptions WHERE pro_id = $1 AND status IN ('awaiting_payment', 'active', 'past_due')",
    [proId],
  );
  let plansWithoutPro = 0;
  for (const { id } of plans.rows) {
    const moved = await withTransaction(deps.pool, (client) => movePlan(client, deps, id, proId));
    if (!moved) {
      plansWithoutPro += 1;
    }
  }
  return { bookings: restarted.length, plans: plans.rows.length, plansWithoutPro };
}

async function movePlan(client: PoolClient, deps: BookingDeps, subscriptionId: string, oldProId: string): Promise<boolean> {
  const found = await client.query<
    SubscriptionRow & { customer_id: string; plan_name: string; category_id: string; postcode: string; status: string }
  >(
    `SELECT ${SUBSCRIPTION_PATTERN}, customer_id, plan_name, category_id, postcode, status
     FROM subscriptions WHERE id = $1 AND pro_id = $2 FOR UPDATE`,
    [subscriptionId, oldProId],
  );
  const plan = found.rows[0];
  if (!plan) {
    return true;
  }
  // Future visits are planned again for the new pro; visits already done or under way stay as they are.
  await client.query(
    "DELETE FROM subscription_visits WHERE subscription_id = $1 AND status IN ('pending', 'planned') AND starts_at > now()",
    [subscriptionId],
  );
  const starts = await plannedStarts(client, patternOf(plan), deps.config.timezone);
  const newPro = await chooseRegularPro(client, {
    categoryId: plan.category_id,
    postcode: plan.postcode,
    days: plan.days,
    starts,
    visitMinutes: plan.visit_minutes,
  });
  await client.query('UPDATE subscriptions SET pro_id = $2, updated_at = now() WHERE id = $1', [subscriptionId, newPro]);
  if (!newPro) {
    await enqueue(client, plan.customer_id, 'plan_pro_changed', messages.planProMissing(plan.plan_name));
    deps.log.warn({ event: 'plan_without_pro', subscriptionId });
    return false;
  }
  await planVisits(client, { ...plan, pro_id: newPro }, deps.config.timezone, plan.status === 'awaiting_payment' ? 'pending' : 'planned');
  const name = await client.query<{ first_name: string | null }>('SELECT first_name FROM users WHERE id = $1', [newPro]);
  await enqueue(client, plan.customer_id, 'plan_pro_changed', messages.planProReplaced(plan.plan_name, name.rows[0]?.first_name ?? 'A new pro'));
  await enqueue(client, newPro, 'plan_pro_changed', messages.newRegularCustomer(plan.plan_name));
  deps.log.info({ event: 'plan_pro_changed', subscriptionId, from: oldProId, to: newPro });
  return true;
}

/**
 * Moves active pros with a required document past its cover date to Pending approval: they get no new
 * jobs until a new copy is accepted. Their unanswered offers go to other pros. Returns how many moved.
 */
export async function documentExpiryTick(deps: BookingDeps): Promise<number> {
  const today = marketToday(deps.config.timezone);
  const moved = await deps.pool.query<{ user_id: string; kinds: DocumentKind[] }>(
    `UPDATE pro_profiles p SET status = 'pending_approval', updated_at = now()
     FROM (
       SELECT pro_id, array_agg(kind ORDER BY kind) AS kinds FROM pro_documents
       WHERE valid_until < $1::date GROUP BY pro_id
     ) expired
     WHERE expired.pro_id = p.user_id AND p.status = 'approved'
     RETURNING p.user_id, expired.kinds`,
    [today],
  );
  for (const row of moved.rows) {
    await logProAction(deps.pool, row.user_id, null, 'moved_to_pending', { documents: row.kinds });
    await enqueue(deps.pool, row.user_id, 'pro_documents', messages.documentsExpired(row.kinds.map((k) => DOCUMENT_NAMES[k]).join(' and ')));
    await withdrawOffers(deps, row.user_id);
    deps.log.warn({ event: 'pro_documents_expired', proId: row.user_id, documents: row.kinds });
  }
  return moved.rowCount ?? 0;
}

/**
 * A pro waiting in Pending approval goes back to Active once no document is out of cover and every new
 * copy has been checked. Returns true when the pro moved.
 */
export async function backToActiveIfCovered(db: Queryable, proId: string, adminId: string, timezone: string): Promise<boolean> {
  const moved = await db.query(
    `UPDATE pro_profiles p SET status = 'approved', updated_at = now()
     WHERE p.user_id = $1 AND p.status = 'pending_approval'
       AND NOT EXISTS (
         SELECT 1 FROM pro_documents d WHERE d.pro_id = p.user_id
           AND (d.valid_until IS NULL OR d.valid_until < $2::date OR d.review_status <> 'accepted'))`,
    [proId, marketToday(timezone)],
  );
  if (!moved.rowCount) {
    return false;
  }
  await logProAction(db, proId, adminId, 'back_to_active');
  await enqueue(db, proId, 'pro_account', messages.backToActive());
  return true;
}

/** True when any of the pro's documents is past its cover date. */
export async function hasExpiredDocument(db: Queryable, proId: string, timezone: string): Promise<boolean> {
  const found = await db.query('SELECT 1 FROM pro_documents WHERE pro_id = $1 AND valid_until < $2::date', [
    proId,
    marketToday(timezone),
  ]);
  return Boolean(found.rowCount);
}

