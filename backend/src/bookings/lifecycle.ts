import { proShareCents } from '../catalogue/pricing.js';
import { nextPayoutDate, type PayoutInterval } from '../payments/payouts.js';
import { marketToday } from '../pros/checks.js';
import { withTransaction } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { formatSlot, messages } from '../notifications/messages.js';
import { enqueue } from '../notifications/outbox.js';
import { offerNext } from './dispatch.js';
import { setStatus, type BookingDeps } from './events.js';

/** An unpaid booking is dropped after this, so its slot is free again. */
export const PAYMENT_WINDOW_MINUTES = 30;
/** The customer is charged this long after the job is done, unless they report a problem first (D25). */
export const CHARGE_DELAY_HOURS = 24;

/** SQL: a completed booking whose money may be taken now. */
const READY_TO_CHARGE = `b.completed_at <= now() - make_interval(hours => ${CHARGE_DELAY_HOURS})
  AND (b.problem_reported_at IS NULL OR b.problem_resolved_at IS NOT NULL)`;

/** Customers may cancel an assigned job until this long before it starts (QUESTIONS Q3). */
export const FREE_CANCEL_HOURS = 24;

/** The card hold for a booking or for approved extra work is in place (webhook or instant). */
export async function confirmHold(deps: BookingDeps, intentId: string): Promise<void> {
  const booking = await withTransaction(deps.pool, async (client) => {
    const held = await client.query<{ id: string; customer_id: string; service_name: string; starts_at: Date }>(
      `UPDATE bookings SET payment_status = 'held', updated_at = now()
       WHERE payment_intent_id = $1 AND status = 'awaiting_payment' AND payment_status IN ('pending', 'failed')
       RETURNING id, customer_id, service_name, starts_at`,
      [intentId],
    );
    const row = held.rows[0];
    if (row) {
      await setStatus(client, row.id, 'searching');
      await enqueue(
        client,
        row.customer_id,
        'booking_confirmed',
        messages.bookingConfirmed(row.service_name, formatSlot(row.starts_at, deps.config.timezone)),
      );
      return row;
    }
    await client.query(
      `UPDATE extra_requests SET status = 'approved', payment_status = 'held', decided_at = now()
       WHERE payment_intent_id = $1 AND status = 'awaiting_payment'`,
      [intentId],
    );
    return null;
  });
  if (booking) {
    deps.log.info({ event: 'booking_paid', bookingId: booking.id });
    await offerNext(deps, booking.id);
  }
}

/** The card was refused. The customer can try again until the payment window closes. */
export async function markPaymentFailed(deps: BookingDeps, intentId: string): Promise<void> {
  await deps.pool.query(
    `UPDATE bookings SET payment_status = 'failed', updated_at = now()
     WHERE payment_intent_id = $1 AND status = 'awaiting_payment'`,
    [intentId],
  );
  // Extra work goes back to waiting for the customer's answer.
  await deps.pool.query(
    `UPDATE extra_requests SET status = 'pending', payment_status = 'failed'
     WHERE payment_intent_id = $1 AND status = 'awaiting_payment'`,
    [intentId],
  );
}

async function releaseHolds(deps: BookingDeps, holds: { intentId: string; table: 'bookings' | 'extra_requests' }[]) {
  for (const { intentId, table } of holds) {
    try {
      await deps.gateway.release(intentId);
      await deps.pool.query(`UPDATE ${table} SET payment_status = 'released' WHERE payment_intent_id = $1`, [intentId]);
    } catch (error) {
      // The hold lapses by itself within seven days; admins see it as still held until then.
      deps.log.error({ event: 'release_failed', intentId, err: error });
    }
  }
}

export type CancelledBy = 'customer' | 'admin' | 'system';

/**
 * Cancels a booking that is not finished, releases holds on the card, withdraws open offers and tells
 * the people involved. Customers cancel for free until a pro is assigned, and after that until
 * `FREE_CANCEL_HOURS` before the start. Later, once they accept it, the full price is charged and split
 * between the pro and MISK by the booking's commission (D34). The team's cancellations are always free.
 */
export async function cancelBooking(
  deps: BookingDeps,
  bookingId: string,
  by: CancelledBy,
  customerId?: string,
  options: { acceptLateCharge?: boolean } = {},
): Promise<void> {
  let late = false;
  const holds = await withTransaction(deps.pool, async (client) => {
    const found = await client.query<{
      status: string;
      customer_id: string;
      pro_id: string | null;
      payment_intent_id: string | null;
      payment_status: string;
      service_name: string;
      starts_at: Date;
      hours_left: number;
    }>(
      `SELECT status, customer_id, pro_id, payment_intent_id, payment_status, service_name, starts_at,
         extract(epoch FROM starts_at - now()) / 3600 AS hours_left
       FROM bookings WHERE id = $1 FOR UPDATE`,
      [bookingId],
    );
    const booking = found.rows[0];
    if (!booking || (customerId && booking.customer_id !== customerId)) {
      throw notFound();
    }
    if (booking.status === 'completed' || booking.status === 'cancelled') {
      throw conflict('invalid_status');
    }
    if (by === 'customer') {
      const unassigned = ['awaiting_payment', 'searching', 'unassigned'].includes(booking.status);
      const assigned = booking.status === 'accepted' || booking.status === 'on_the_way';
      if (!unassigned && !assigned) {
        throw conflict('too_late_to_cancel');
      }
      late = assigned && booking.hours_left < FREE_CANCEL_HOURS && booking.payment_status === 'held';
      if (late && !options.acceptLateCharge) {
        throw conflict('late_cancel_charge');
      }
    }

    await setStatus(client, bookingId, 'cancelled', ', cancelled_by = $3, late_cancel = $4', [by, late]);
    await client.query(
      "UPDATE booking_offers SET status = 'withdrawn', responded_at = now() WHERE booking_id = $1 AND status = 'pending'",
      [bookingId],
    );
    await client.query(
      `UPDATE extra_requests SET status = 'cancelled', decided_at = now()
       WHERE booking_id = $1 AND status IN ('pending', 'awaiting_payment')`,
      [bookingId],
    );
    const heldExtras = await client.query<{ payment_intent_id: string }>(
      `SELECT payment_intent_id FROM extra_requests
       WHERE booking_id = $1 AND payment_intent_id IS NOT NULL AND payment_status IN ('pending', 'held', 'failed')`,
      [bookingId],
    );

    const when = formatSlot(booking.starts_at, deps.config.timezone);
    if (by !== 'customer') {
      await enqueue(client, booking.customer_id, 'booking_cancelled', messages.bookingCancelled(booking.service_name, when));
    }
    if (booking.pro_id && !late) {
      await enqueue(client, booking.pro_id, 'booking_cancelled', messages.bookingCancelledForPro(booking.service_name, when));
    }

    const result: { intentId: string; table: 'bookings' | 'extra_requests' }[] = heldExtras.rows.map((row) => ({
      intentId: row.payment_intent_id,
      table: 'extra_requests',
    }));
    // A late cancellation keeps the job's hold: it is charged below instead of released.
    if (!late && booking.payment_intent_id && ['pending', 'held', 'failed'].includes(booking.payment_status)) {
      result.push({ intentId: booking.payment_intent_id, table: 'bookings' });
    }
    return result;
  });
  deps.log.info({ event: 'booking_cancelled', bookingId, by, late });
  await releaseHolds(deps, holds);
  if (late) {
    try {
      await settleLateCancellation(deps, bookingId);
    } catch (error) {
      // The cancellation stands; the settlement worker charges and pays the pro.
      deps.log.error({ event: 'late_cancel_settle_failed', bookingId, err: error });
    }
  }
}

/**
 * Charges a late cancellation's full price and pays the pro their share of the job price, like a
 * finished job. Safe to call again: each step is recorded.
 */
export async function settleLateCancellation(deps: BookingDeps, bookingId: string): Promise<void> {
  const found = await deps.pool.query<{
    pro_id: string;
    customer_id: string;
    payment_intent_id: string;
    payment_status: string;
    price_cents: number;
    fee_cents: number;
    pro_share_pct: number;
    service_name: string;
  }>(
    `SELECT pro_id, customer_id, payment_intent_id, payment_status, price_cents, fee_cents, pro_share_pct, service_name
     FROM bookings WHERE id = $1 AND status = 'cancelled' AND late_cancel AND pro_id IS NOT NULL`,
    [bookingId],
  );
  const booking = found.rows[0];
  if (!booking) {
    return;
  }
  if (booking.payment_status === 'held') {
    const { chargeId } = await deps.gateway.capture(booking.payment_intent_id);
    const share = proShareCents(booking.price_cents, booking.pro_share_pct);
    await withTransaction(deps.pool, async (client) => {
      await client.query("UPDATE bookings SET payment_status = 'captured' WHERE id = $1", [bookingId]);
      await client.query(
        `INSERT INTO payouts (booking_id, pro_id, payment_intent_id, charge_id, amount_cents)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (payment_intent_id) DO NOTHING`,
        [bookingId, booking.pro_id, booking.payment_intent_id, chargeId, share],
      );
      await enqueue(
        client,
        booking.customer_id,
        'booking_cancelled',
        messages.lateCancelCharged(booking.service_name, booking.price_cents + booking.fee_cents),
      );
      await enqueue(client, booking.pro_id, 'booking_cancelled', messages.lateCancelForPro(booking.service_name, share));
    });
  }
  await payPro(deps, bookingId);
}

/** Cancels bookings whose payment was never completed, freeing their slot. Returns how many. */
export async function expireUnpaid(deps: BookingDeps): Promise<number> {
  const stale = await deps.pool.query<{ id: string }>(
    `SELECT id FROM bookings
     WHERE status = 'awaiting_payment' AND created_at < now() - make_interval(mins => $1)
     LIMIT 100`,
    [PAYMENT_WINDOW_MINUTES],
  );
  for (const { id } of stale.rows) {
    try {
      await cancelBooking(deps, id, 'system');
    } catch (error) {
      deps.log.error({ event: 'expire_unpaid_failed', bookingId: id, err: error });
    }
  }
  return stale.rows.length;
}

interface Charge {
  intentId: string;
  table: 'bookings' | 'extra_requests';
  shareCents: number;
}

/**
 * Takes the held money of a completed booking (job and approved extra work) and pays the pro's share
 * to their Stripe account. Every step is recorded, so a failed run is finished by the next one.
 */
export async function settleBooking(deps: BookingDeps, bookingId: string): Promise<void> {
  const ready = await deps.pool.query(`SELECT 1 FROM bookings b WHERE b.id = $1 AND ${READY_TO_CHARGE}`, [bookingId]);
  if (!ready.rowCount) {
    return;
  }
  const found = await deps.pool.query<{
    pro_id: string;
    status: string;
    payment_intent_id: string;
    payment_status: string;
    price_cents: number;
    pro_share_pct: number;
    stripe_account_id: string | null;
  }>(
    `SELECT b.pro_id, b.status, b.payment_intent_id, b.payment_status, b.price_cents, b.pro_share_pct, p.stripe_account_id
     FROM bookings b JOIN pro_profiles p ON p.user_id = b.pro_id WHERE b.id = $1`,
    [bookingId],
  );
  const booking = found.rows[0];
  if (!booking || booking.status !== 'completed') {
    return;
  }
  const extras = await deps.pool.query<{ payment_intent_id: string; price_cents: number }>(
    `SELECT payment_intent_id, price_cents FROM extra_requests
     WHERE booking_id = $1 AND status = 'approved' AND payment_status = 'held'`,
    [bookingId],
  );
  const toCapture: Charge[] = [];
  if (booking.payment_status === 'held') {
    toCapture.push({
      intentId: booking.payment_intent_id,
      table: 'bookings',
      shareCents: proShareCents(booking.price_cents, booking.pro_share_pct),
    });
  }
  for (const extra of extras.rows) {
    toCapture.push({
      intentId: extra.payment_intent_id,
      table: 'extra_requests',
      shareCents: proShareCents(extra.price_cents, booking.pro_share_pct),
    });
  }

  for (const charge of toCapture) {
    const { chargeId } = await deps.gateway.capture(charge.intentId);
    await withTransaction(deps.pool, async (client) => {
      await client.query(`UPDATE ${charge.table} SET payment_status = 'captured' WHERE payment_intent_id = $1`, [
        charge.intentId,
      ]);
      await client.query(
        `INSERT INTO payouts (booking_id, pro_id, payment_intent_id, charge_id, amount_cents)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (payment_intent_id) DO NOTHING`,
        [bookingId, booking.pro_id, charge.intentId, chargeId, charge.shareCents],
      );
    });
  }

  await payPro(deps, bookingId);
}

/**
 * Sends the pro every payout of a booking that is still owed (job, extra work, tip, late cancellation),
 * and tells them when it reaches their bank. Failed transfers are retried by the settlement worker.
 */
export async function payPro(deps: BookingDeps, bookingId: string): Promise<void> {
  const found = await deps.pool.query<{ pro_id: string; stripe_account_id: string | null; service_name: string; interval: PayoutInterval }>(
    `SELECT b.pro_id, p.stripe_account_id, b.service_name, (SELECT payout_interval FROM settings) AS interval
     FROM bookings b JOIN pro_profiles p ON p.user_id = b.pro_id WHERE b.id = $1`,
    [bookingId],
  );
  const booking = found.rows[0];
  if (!booking) {
    return;
  }
  if (!booking.stripe_account_id) {
    deps.log.error({ event: 'payout_blocked', bookingId, reason: 'pro_has_no_payout_account' });
    return;
  }
  const pending = await deps.pool.query<{ id: string; charge_id: string; amount_cents: number }>(
    `SELECT id, charge_id, amount_cents FROM payouts WHERE booking_id = $1 AND status IN ('pending', 'failed')`,
    [bookingId],
  );
  for (const payout of pending.rows) {
    try {
      const { transferId } = await deps.gateway.transfer({
        accountId: booking.stripe_account_id,
        amountCents: payout.amount_cents,
        sourceChargeId: payout.charge_id,
        transferGroup: `booking-${bookingId}`,
        idempotencyKey: `payout-${payout.id}`,
      });
      await withTransaction(deps.pool, async (client) => {
        await client.query("UPDATE payouts SET status = 'sent', transfer_id = $2, error = NULL, updated_at = now() WHERE id = $1", [
          payout.id,
          transferId,
        ]);
        const bankDay = formatDay(nextPayoutDate(booking.interval, marketToday(deps.config.timezone)));
        await enqueue(client, booking.pro_id, 'payout_sent', messages.payoutSent(payout.amount_cents, booking.service_name, bankDay));
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.log.error({ event: 'payout_failed', bookingId, payoutId: payout.id, error: message });
      await deps.pool.query("UPDATE payouts SET status = 'failed', error = $2, updated_at = now() WHERE id = $1", [
        payout.id,
        message.slice(0, 500),
      ]);
    }
  }
}

/** "Fri 13 Nov", for messages about a calendar day. */
function formatDay(day: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(
    new Date(`${day}T12:00:00Z`),
  );
}

/** Charges completed bookings once their 24 hours have passed without an open problem, and pays the pros. */
export async function settleTick(deps: BookingDeps): Promise<number> {
  const due = await deps.pool.query<{ id: string }>(
    `SELECT b.id FROM bookings b
     WHERE b.status = 'completed' AND ${READY_TO_CHARGE} AND (
       b.payment_status = 'held'
       OR EXISTS (SELECT 1 FROM extra_requests e WHERE e.booking_id = b.id AND e.status = 'approved' AND e.payment_status = 'held')
       OR EXISTS (SELECT 1 FROM payouts p WHERE p.booking_id = b.id AND p.status IN ('pending', 'failed')
                  AND p.updated_at < now() - interval '10 minutes')
     )
     LIMIT 50`,
  );
  for (const { id } of due.rows) {
    try {
      await settleBooking(deps, id);
    } catch (error) {
      deps.log.error({ event: 'settle_failed', bookingId: id, err: error });
    }
  }
  const lateCancels = await deps.pool.query<{ id: string }>(
    `SELECT b.id FROM bookings b
     WHERE b.status = 'cancelled' AND b.late_cancel AND (
       b.payment_status = 'held'
       OR EXISTS (SELECT 1 FROM payouts p WHERE p.booking_id = b.id AND p.status IN ('pending', 'failed')
                  AND p.updated_at < now() - interval '10 minutes'))
     LIMIT 50`,
  );
  for (const { id } of lateCancels.rows) {
    try {
      await settleLateCancellation(deps, id);
    } catch (error) {
      deps.log.error({ event: 'late_cancel_settle_failed', bookingId: id, err: error });
    }
  }
  return due.rows.length + lateCancels.rows.length;
}
