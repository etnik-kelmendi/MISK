import { cancelBooking, type CancelledBy } from '../bookings/lifecycle.js';
import type { BookingDeps } from '../bookings/events.js';
import { withTransaction, type Queryable } from '../db.js';
import { conflict, notFound } from '../errors.js';
import type { Notice } from '../notifications/account-notices.js';
import { messages } from '../notifications/messages.js';
import { enqueue, enqueueChannels, type Channel } from '../notifications/outbox.js';
import { handOverWork, type HandOver } from '../pros/management.js';
import { dropUnpaidSubscription } from '../subscriptions/service.js';
import { logUserAction } from './actions.js';

/** Bookings that have not started yet: these are cancelled when an account is suspended or closed. */
export const NOT_STARTED = ['awaiting_payment', 'searching', 'unassigned', 'accepted', 'on_the_way'];

/** The account as it is just before closing, locked for the change. */
export interface ClosingAccount {
  role: string | null;
  first_name: string | null;
  last_name: string | null;
}

export function fullName(row: { first_name: string | null; last_name: string | null }) {
  return [row.first_name, row.last_name].filter(Boolean).join(' ');
}

/** An account notice by every way the person can be reached: they may not be able to open the app (D87). */
export const sendAccountNotice = (db: Queryable, userId: string, notice: Notice) =>
  enqueueChannels(db, userId, 'account', notice.text, { channels: { push: true, sms: true, email: true }, email: notice.email });

/**
 * Ends what an account booked as a customer: bookings that have not started are cancelled (held money is
 * released and the pro is told), and monthly plans end at once, Stripe included. Returns the counts.
 * `by` is who cancels: the team ('admin', the customer is told) or the person closing their own account.
 */
export async function endCustomerWork(deps: BookingDeps, userId: string, by: CancelledBy = 'admin'): Promise<{ bookings: number; plans: number }> {
  const upcoming = await deps.pool.query<{ id: string }>('SELECT id FROM bookings WHERE customer_id = $1 AND status = ANY($2)', [
    userId,
    NOT_STARTED,
  ]);
  for (const booking of upcoming.rows) {
    await cancelBooking(deps, booking.id, by, by === 'customer' ? userId : undefined);
  }
  const plans = await deps.pool.query<{ id: string; status: string; stripe_subscription_id: string | null; pro_id: string | null; plan_name: string }>(
    `SELECT id, status, stripe_subscription_id, pro_id, plan_name FROM subscriptions
     WHERE customer_id = $1 AND status <> 'cancelled' AND (ends_at IS NULL OR ends_at > now())`,
    [userId],
  );
  for (const plan of plans.rows) {
    if (plan.status === 'awaiting_payment') {
      await dropUnpaidSubscription(deps, plan.id);
      continue;
    }
    if (plan.stripe_subscription_id) {
      await deps.gateway.cancelSubscription(plan.stripe_subscription_id, false);
    }
    await withTransaction(deps.pool, async (client) => {
      await client.query("UPDATE subscriptions SET status = 'cancelled', ends_at = now(), updated_at = now() WHERE id = $1", [plan.id]);
      await client.query(
        "UPDATE subscription_visits SET status = 'cancelled' WHERE subscription_id = $1 AND status IN ('pending', 'planned') AND starts_at > now()",
        [plan.id],
      );
      if (plan.pro_id) await enqueue(client, plan.pro_id, 'plan_pro_changed', messages.planEndedByTeam(plan.plan_name));
    });
  }
  return { bookings: upcoming.rows.length, plans: plans.rows.length };
}

export interface CloseInput {
  userId: string;
  /** The admin closing the account, or null when the person closes their own account (D97). */
  adminId: string | null;
  /** Saved on the account (deleted_reason) and in the activity log. */
  reason: string;
  /** The goodbye, built from the account as it is before its details are removed. */
  notice: (account: ClosingAccount) => Notice;
}

/**
 * Closes an account for good, the same way for the team's "Delete" (D87) and the person's own "Delete
 * account" (D97): the goodbye goes out first, while the phone and email are still there (queued messages keep
 * them); upcoming bookings and plans end; then name, phone, email, username, password, saved addresses,
 * favourites and open links are removed and every session ends. Bookings, plans and payments stay for the
 * records, without the person's details. Saved cards are removed from the payment provider afterwards.
 */
export async function closeAccount(deps: BookingDeps, input: CloseInput): Promise<{ channels: Channel[] }> {
  const { userId, adminId, reason } = input;
  const { account, channels } = await withTransaction(deps.pool, async (client) => {
    const found = await client.query<ClosingAccount & { deleted: boolean }>(
      `SELECT role, first_name, last_name, disabled_at IS NOT NULL AS deleted
       FROM users WHERE id = $1 AND role IS DISTINCT FROM 'admin' FOR UPDATE`,
      [userId],
    );
    const row = found.rows[0];
    if (!row) throw notFound();
    if (row.deleted) throw conflict('account_deleted');
    const queued = await sendAccountNotice(client, userId, input.notice(row));
    if (row.role === 'pro') {
      await client.query(
        `UPDATE pro_profiles SET status = 'suspended', suspended_at = COALESCE(suspended_at, now()),
           suspended_reason = $2, updated_at = now() WHERE user_id = $1 AND status <> 'suspended'`,
        [userId, reason],
      );
    }
    return { account: row, channels: queued };
  });
  const customer = await endCustomerWork(deps, userId, adminId ? 'admin' : 'customer');
  let handOver: HandOver | null = null;
  if (account.role === 'pro') {
    if (!adminId) throw new Error('A pro account is closed by the team only');
    handOver = await handOverWork(deps, userId, adminId);
  }
  const stripeCustomer = await withTransaction(deps.pool, async (client) => {
    const wiped = await client.query<{ stripe_customer_id: string | null }>(
      `UPDATE users SET disabled_at = now(), deleted_reason = $2, suspended_at = NULL, suspended_reason = NULL, suspended_message = NULL,
         first_name = NULL, last_name = NULL, phone = NULL, email = NULL, username = NULL, password_hash = NULL
       WHERE id = $1 RETURNING stripe_customer_id`,
      [userId, reason],
    );
    for (const table of ['sessions', 'push_subscriptions', 'user_notification_prefs', 'email_changes', 'email_verifications', 'password_resets', 'sign_in_codes']) {
      await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
    }
    await client.query('DELETE FROM customer_addresses WHERE customer_id = $1', [userId]);
    await client.query('DELETE FROM customer_favourite_pros WHERE customer_id = $1', [userId]);
    await logUserAction(client, userId, adminId, adminId ? 'deleted' : 'closed_own_account', {
      ...(adminId ? { reason } : {}),
      name: fullName(account),
      cancelledBookings: customer.bookings,
      endedPlans: customer.plans,
      ...(handOver ?? {}),
      channels,
    });
    return wiped.rows[0]?.stripe_customer_id ?? null;
  });
  await removeSavedCards(deps, userId, stripeCustomer);
  return { channels };
}

/** Takes the closed account's saved cards off the payment provider. The account is closed either way. */
async function removeSavedCards(deps: BookingDeps, userId: string, customerRef: string | null) {
  if (!customerRef) return;
  try {
    for (const card of await deps.gateway.listCards(customerRef)) {
      await deps.gateway.detachCard(customerRef, card.id);
    }
  } catch (error) {
    deps.log.error({ event: 'closed_account_cards_not_removed', userId, err: error });
  }
}
