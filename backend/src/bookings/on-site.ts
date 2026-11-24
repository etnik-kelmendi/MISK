import type { PoolClient } from 'pg';
import { onlyRow, withTransaction, type Queryable } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { formatSlot, formatTime, messages } from '../notifications/messages.js';
import { enqueue } from '../notifications/outbox.js';
import { logAction } from './admin-routes.js';
import { LATE_NOTICE_MINUTES, loadArrival } from './arrival.js';
import { setStatus, type BookingDeps } from './events.js';
import { noShowAmounts, releaseHolds, settleNoShow } from './lifecycle.js';

/**
 * What happens after a pro reports a problem on site (D94, replacing the parts of D86 that only logged it):
 * support is alerted, the customer is warned when the pro runs late, a customer who is not home pays a call-out
 * fee, waiting at a locked door is paid, and an unsafe job is stopped.
 */

/** A pro waiting for a customer who is not home (or does not let them in) can leave after this many minutes. */
export const NO_SHOW_WAIT_MINUTES = 15;
/** Reports that mean the pro is waiting at the door. */
export const DOOR_REASONS = ['customer_not_home', 'no_access'];
/** Reports that put the booking at the top of the team's Needs action list. */
export const URGENT_REASONS = ['unsafe'];

const REASON_TEXT: Record<string, string> = {
  customer_not_home: 'Customer not home',
  no_access: "Can't get in",
  bigger_job: 'Job bigger than described',
  unsafe: 'Unsafe to work',
  other: 'Something else',
};

/** The call-out fee and the most waiting time paid, from Settings. */
export async function onSiteSettings(db: Queryable): Promise<{ noShowFeeCents: number; waitingCapMinutes: number }> {
  const found = await db.query<{ noShowFeeCents: number; waitingCapMinutes: number }>(
    'SELECT no_show_fee_cents AS "noShowFeeCents", waiting_cap_minutes AS "waitingCapMinutes" FROM settings',
  );
  return onlyRow(found);
}

/**
 * Tells every member of the MISK team by email that a pro needs help on site, so someone calls the customer
 * (not home, can't get in) or the pro (unsafe). The booking is also under Needs action until it is resolved.
 */
export async function alertSupport(
  db: Queryable,
  input: { bookingNumber: string; reason: string; address: string },
): Promise<number> {
  const team = await db.query<{ id: string }>("SELECT id FROM users WHERE role = 'admin' AND disabled_at IS NULL");
  const urgent = URGENT_REASONS.includes(input.reason);
  const body = messages.supportAlert(input.bookingNumber, REASON_TEXT[input.reason] ?? input.reason, input.address, urgent);
  for (const member of team.rows) {
    await enqueue(db, member.id, 'support_alert', body);
  }
  return team.rows.length;
}

/** The customer's price of one minute of the job, from the booked services' length. */
async function jobMinutes(db: Queryable, bookingId: string): Promise<number> {
  const found = await db.query<{ minutes: number }>(
    `SELECT COALESCE((SELECT sum(duration_minutes)::int FROM booking_services bs WHERE bs.booking_id = b.id),
       (extract(epoch FROM b.ends_at - b.starts_at) / 60)::int) AS minutes
     FROM bookings b WHERE b.id = $1`,
    [bookingId],
  );
  return Math.max(1, found.rows[0]?.minutes ?? 60);
}

/**
 * Waiting at a locked door, from the report until now, in whole minutes up to the cap, and its price at the
 * job's own rate per minute (the customer's price; the pro gets their usual share of it).
 */
export async function waitingTime(
  db: Queryable,
  input: { bookingId: string; reportedAt: Date; now: Date; priceCents: number; capMinutes: number },
): Promise<{ minutes: number; cents: number }> {
  const waited = Math.floor((input.now.getTime() - input.reportedAt.getTime()) / 60_000);
  const minutes = Math.max(0, Math.min(input.capMinutes, waited));
  if (minutes === 0) return { minutes: 0, cents: 0 };
  const perJob = await jobMinutes(db, input.bookingId);
  return { minutes, cents: Math.round((input.priceCents * minutes) / perJob) };
}

/**
 * The pro got in and starts the job (D94). An open "Can't get in" report is closed and the waiting time is
 * added to the job as a line the customer pays, since access is the customer's part; an open "Customer not
 * home" report is closed without pay, as the customer let the pro in. Call inside the status change's
 * transaction; returns the waiting line to put on the customer's card after it commits.
 */
export async function closeDoorIssueOnStart(
  client: PoolClient,
  input: { bookingId: string; proId: string; customerId: string; serviceName: string; priceCents: number },
): Promise<{ extraId: string; minutes: number; cents: number } | null> {
  const open = await client.query<{ id: string; reason: string }>(
    `SELECT id, reason FROM booking_issues
     WHERE booking_id = $1 AND pro_id = $2 AND resolved_at IS NULL AND reason = ANY($3) FOR UPDATE`,
    [input.bookingId, input.proId, DOOR_REASONS],
  );
  for (const issue of open.rows) {
    await client.query('UPDATE booking_issues SET resolved_at = now() WHERE id = $1', [issue.id]);
    await logAction(client, input.bookingId, null, 'issue_resolved', { reason: issue.reason, by: 'pro_started_job' });
  }
  // The latest "Can't get in" report of this pro whose waiting is not paid yet, also when support already
  // marked it resolved: the pro waited until they got in.
  const locked = await client.query<{ id: string; created_at: Date; now: Date }>(
    `SELECT i.id, i.created_at, now() AS now FROM booking_issues i
     WHERE i.booking_id = $1 AND i.pro_id = $2 AND i.reason = 'no_access'
       AND NOT EXISTS (SELECT 1 FROM extra_requests e WHERE e.issue_id = i.id)
     ORDER BY i.created_at DESC LIMIT 1`,
    [input.bookingId, input.proId],
  );
  const issue = locked.rows[0];
  if (!issue) return null;
  const { waitingCapMinutes } = await onSiteSettings(client);
  const waiting = await waitingTime(client, {
    bookingId: input.bookingId,
    reportedAt: issue.created_at,
    now: issue.now,
    priceCents: input.priceCents,
    capMinutes: waitingCapMinutes,
  });
  if (waiting.cents <= 0) return null;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO extra_requests (booking_id, description, price_cents, status, payment_status, kind, issue_id)
     VALUES ($1, $2, $3, 'awaiting_payment', 'pending', 'waiting', $4)
     ON CONFLICT (issue_id) WHERE kind = 'waiting' DO NOTHING RETURNING id`,
    [input.bookingId, `Waiting time at the door (${waiting.minutes} min)`, waiting.cents, issue.id],
  );
  const extraId = inserted.rows[0]?.id;
  if (!extraId) return null;
  await enqueue(client, input.customerId, 'payment_action_needed', messages.waitingCharged(input.serviceName, waiting.minutes, waiting.cents));
  return { extraId, ...waiting };
}

/**
 * Puts paid waiting time on the customer's saved card, like approved extra work. When the card refuses it, MISK
 * pays the pro's share itself, so the pro's waiting is paid either way (D94). Safe to call again.
 */
export async function chargeWaitingTime(deps: BookingDeps, extraId: string): Promise<'customer' | 'misk' | 'skipped'> {
  const found = await deps.pool.query<{
    booking_id: string;
    price_cents: number;
    description: string;
    booking_intent: string | null;
    customer_ref: string | null;
  }>(
    `SELECT e.booking_id, e.price_cents, e.description, b.payment_intent_id AS booking_intent, u.stripe_customer_id AS customer_ref
     FROM extra_requests e JOIN bookings b ON b.id = e.booking_id JOIN users u ON u.id = b.customer_id
     WHERE e.id = $1 AND e.kind = 'waiting' AND e.status = 'awaiting_payment' AND e.payment_intent_id IS NULL`,
    [extraId],
  );
  const extra = found.rows[0];
  if (!extra) return 'skipped';
  try {
    if (!extra.booking_intent || !extra.customer_ref) {
      throw new Error('Booking has no saved card');
    }
    const hold = await deps.gateway.holdOnSavedCard({
      customerRef: extra.customer_ref,
      fromIntentId: extra.booking_intent,
      amountCents: extra.price_cents,
      description: `MISK: ${extra.description}`.slice(0, 200),
      idempotencyKey: `waiting-${extraId}`,
      metadata: { bookingId: extra.booking_id, extraId },
    });
    if (!hold.held) {
      // The bank wants the customer to confirm, which nobody is there to do: MISK pays instead.
      await deps.gateway.release(hold.intentId).catch((error: unknown) => deps.log.warn({ event: 'release_failed', err: error }));
      throw new Error('Card needs the customer to confirm');
    }
    await deps.pool.query(
      `UPDATE extra_requests SET payment_intent_id = $2, status = 'approved', payment_status = 'held', decided_at = now()
       WHERE id = $1 AND status = 'awaiting_payment'`,
      [extraId, hold.intentId],
    );
    await logAction(deps.pool, extra.booking_id, null, 'waiting_paid', { cents: extra.price_cents, fundedBy: 'customer' });
    deps.log.info({ event: 'waiting_time_held', bookingId: extra.booking_id, extraId, cents: extra.price_cents });
    return 'customer';
  } catch (error) {
    await deps.pool.query(
      `UPDATE extra_requests SET status = 'approved', funded_by = 'misk', payment_status = 'none', decided_at = now()
       WHERE id = $1 AND status = 'awaiting_payment'`,
      [extraId],
    );
    await logAction(deps.pool, extra.booking_id, null, 'waiting_paid', { cents: extra.price_cents, fundedBy: 'misk' });
    deps.log.warn({ event: 'waiting_time_funded_by_misk', bookingId: extra.booking_id, extraId, err: error });
    return 'misk';
  }
}

/** When the pro may leave with the call-out fee: 15 minutes after their open "not home" or "can't get in" report. */
export function leaveAllowedAt(issue: { reason: string; createdAt: Date } | null): Date | null {
  if (!issue || !DOOR_REASONS.includes(issue.reason)) return null;
  return new Date(issue.createdAt.getTime() + NO_SHOW_WAIT_MINUTES * 60_000);
}

/**
 * "Leave and get the call-out fee" (D94): 15 minutes after reporting that the customer is not home or does not
 * let them in, the pro may leave. The booking ends as a customer no-show: the customer pays the call-out fee from
 * Settings (plus the waiting time for a locked door, at most what is held), the rest of the held money is
 * released, and the pro gets the fee with their next payout. Doing it twice changes nothing.
 */
export async function leaveAsNoShow(deps: BookingDeps, proId: string, bookingId: string): Promise<{ alreadyDone: boolean }> {
  const result = await withTransaction(deps.pool, async (client) => {
    const found = await client.query<{
      status: string;
      no_show_at: Date | null;
      customer_id: string;
      service_name: string;
      starts_at: Date;
      price_cents: number;
      fee_cents: number;
      pro_share_pct: number;
    }>(
      `SELECT status, no_show_at, customer_id, service_name, starts_at, price_cents, fee_cents, pro_share_pct
       FROM bookings WHERE id = $1 AND pro_id = $2 FOR UPDATE`,
      [bookingId, proId],
    );
    const booking = found.rows[0];
    if (!booking) throw notFound();
    if (booking.no_show_at) return { alreadyDone: true, holds: [] };
    if (!['accepted', 'on_the_way'].includes(booking.status)) throw conflict('invalid_status');
    const open = await client.query<{ id: string; reason: string; created_at: Date; now: Date }>(
      `SELECT id, reason, created_at, now() AS now FROM booking_issues
       WHERE booking_id = $1 AND pro_id = $2 AND resolved_at IS NULL FOR UPDATE`,
      [bookingId, proId],
    );
    const issue = open.rows[0];
    const allowedAt = leaveAllowedAt(issue ? { reason: issue.reason, createdAt: issue.created_at } : null);
    if (!issue || !allowedAt) throw conflict('no_door_issue');
    if (issue.now < allowedAt) throw conflict('wait_longer');

    const { noShowFeeCents, waitingCapMinutes } = await onSiteSettings(client);
    // A locked door is the customer's part, so its waiting is paid too; a customer not home pays the fee only.
    const waiting =
      issue.reason === 'no_access'
        ? await waitingTime(client, {
            bookingId,
            reportedAt: issue.created_at,
            now: issue.now,
            priceCents: booking.price_cents,
            capMinutes: waitingCapMinutes,
          })
        : { minutes: 0, cents: 0 };
    await setStatus(client, bookingId, 'cancelled', ', cancelled_by = $3, no_show_at = now(), no_show_fee_cents = $4, no_show_waiting_cents = $5', [
      'system',
      noShowFeeCents,
      waiting.cents,
    ]);
    await client.query('UPDATE booking_issues SET resolved_at = now() WHERE id = $1', [issue.id]);
    await client.query("UPDATE booking_offers SET status = 'withdrawn', responded_at = now() WHERE booking_id = $1 AND status = 'pending'", [
      bookingId,
    ]);
    await client.query(
      `UPDATE extra_requests SET status = 'cancelled', decided_at = now()
       WHERE booking_id = $1 AND status IN ('pending', 'awaiting_payment', 'approved')`,
      [bookingId],
    );
    // Extra work approved before the pro got in is not done, so its hold is released.
    const heldExtras = await client.query<{ payment_intent_id: string }>(
      `SELECT payment_intent_id FROM extra_requests
       WHERE booking_id = $1 AND payment_intent_id IS NOT NULL AND payment_status IN ('pending', 'held', 'failed')`,
      [bookingId],
    );
    const { chargeCents, proCents } = noShowAmounts({
      feeCents: noShowFeeCents,
      waitingCents: waiting.cents,
      heldCents: booking.price_cents + booking.fee_cents,
      proSharePct: booking.pro_share_pct,
    });
    await logAction(client, bookingId, null, 'no_show', {
      reason: issue.reason,
      feeCents: noShowFeeCents,
      waitingMinutes: waiting.minutes,
      waitingCents: waiting.cents,
      chargeCents,
      proCents,
    });
    const when = formatSlot(booking.starts_at, deps.config.timezone);
    await enqueue(client, booking.customer_id, 'booking_cancelled', messages.noShowCustomer(booking.service_name, when, chargeCents), {
      link: `/bookings/${bookingId}`,
    });
    await enqueue(client, proId, 'booking_cancelled', messages.noShowPro(booking.service_name, proCents), { link: `/pro/jobs/${bookingId}` });
    return {
      alreadyDone: false,
      holds: heldExtras.rows.map((row) => ({ intentId: row.payment_intent_id, table: 'extra_requests' as const })),
    };
  });
  if (result.alreadyDone) {
    return { alreadyDone: true };
  }
  deps.log.info({ event: 'customer_no_show', bookingId, proId });
  await releaseHolds(deps, result.holds);
  try {
    await settleNoShow(deps, bookingId);
  } catch (error) {
    // The no-show stands; the settlement worker takes the fee and pays the pro.
    deps.log.error({ event: 'no_show_settle_failed', bookingId, err: error });
  }
  return { alreadyDone: false };
}

/**
 * Warns the customer once when their pro will be more than 10 minutes late (D94), as the arrival is worked out
 * now (D83): from the pro's live position, or from the booked start for a pro who has not set off. Returns
 * whether the customer was told now.
 */
export async function warnIfLate(deps: BookingDeps, bookingId: string): Promise<boolean> {
  const arrival = await loadArrival(deps.pool, bookingId);
  if (!arrival || arrival.lateMinutes <= LATE_NOTICE_MINUTES) return false;
  return withTransaction(deps.pool, async (client) => {
    const marked = await client.query<{ customer_id: string; pro_name: string | null }>(
      `UPDATE bookings b SET late_warned_at = now()
       WHERE b.id = $1 AND b.late_warned_at IS NULL AND b.status IN ('accepted', 'on_the_way') AND b.pro_id IS NOT NULL
       RETURNING b.customer_id, (SELECT first_name FROM users WHERE id = b.pro_id) AS pro_name`,
      [bookingId],
    );
    const row = marked.rows[0];
    if (!row) return false;
    const at = formatTime(arrival.expectedAt, deps.config.timezone);
    await enqueue(client, row.customer_id, 'pro_on_the_way', messages.proRunningLate(row.pro_name ?? 'Your pro', arrival.lateMinutes, at), {
      link: `/bookings/${bookingId}`,
    });
    await logAction(client, bookingId, null, 'late_warning', { lateMinutes: arrival.lateMinutes, expectedAt: arrival.expectedAt.toISOString() });
    deps.log.info({ event: 'customer_warned_pro_late', bookingId, lateMinutes: arrival.lateMinutes });
    return true;
  });
}

/** Checks every booked job that has not started for a pro running more than 10 minutes late (D94). */
export async function lateWarningTick(deps: BookingDeps): Promise<number> {
  const due = await deps.pool.query<{ id: string }>(
    `SELECT id FROM bookings
     WHERE status IN ('accepted', 'on_the_way') AND pro_id IS NOT NULL AND late_warned_at IS NULL
       AND starts_at < now() + interval '6 hours' AND starts_at > now() - interval '1 day'
     ORDER BY starts_at LIMIT 200`,
  );
  let warned = 0;
  for (const { id } of due.rows) {
    try {
      if (await warnIfLate(deps, id)) warned += 1;
    } catch (error) {
      deps.log.error({ event: 'late_warning_failed', bookingId: id, err: error });
    }
  }
  return warned;
}

/** The pro's pay from a no-show (D94), for the Job page. */
export function noShowEarnings(row: {
  noShowFeeCents: number;
  noShowWaitingCents: number | null;
  priceCents: number;
  feeCents: number;
  proSharePct: number;
}): number {
  return noShowAmounts({
    feeCents: row.noShowFeeCents,
    waitingCents: row.noShowWaitingCents ?? 0,
    heldCents: row.priceCents + row.feeCents,
    proSharePct: row.proSharePct,
  }).proCents;
}
