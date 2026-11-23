import type { PoolClient } from 'pg';
import { eligibleProFilter } from '../bookings/availability.js';
import type { BookingDeps } from '../bookings/events.js';
import { withTransaction, type Queryable } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { isExclusionViolation, isUniqueViolation } from '../http.js';
import { formatSlot, messages } from '../notifications/messages.js';
import { enqueue } from '../notifications/outbox.js';

/**
 * Moving one plan visit (D77): a customer may ask to move a single visit to another day of the same week
 * (Monday to Sunday in the market time zone), at the same time of day, on a day the regular pro is free.
 * The request must come at least this long before the visit's original time. The pro confirms or declines;
 * an unanswered request expires 24 hours before the original time, or at the new time if that is sooner.
 * Billing never changes.
 */
export const MOVE_NOTICE_HOURS = 24;

/** Why a visit cannot be moved at all, shown to the customer in place of the choices. */
export type MoveBlock = 'not_movable' | 'too_late' | 'move_pending' | 'no_free_day';

export interface MovableVisit {
  id: string;
  subscription_id: string;
  pro_id: string;
  starts_at: Date;
  ends_at: Date;
  status: string;
  category_id: string;
  postcode: string;
  plan_ends_at: Date | null;
  plan_status: string;
  plan_name: string;
  customer_id: string;
  customer_name: string | null;
  early_enough: boolean;
  pending_move: boolean;
}

export interface MoveTarget {
  startsAt: Date;
  endsAt: Date;
}

/** A customer's own visit with what moving it depends on; `lock` locks the visit row for a change. */
export async function loadMovableVisit(
  db: Queryable,
  ids: { subscriptionId: string; visitId: string; customerId: string },
  lock = false,
): Promise<MovableVisit> {
  const found = await db.query<MovableVisit>(
    `SELECT v.id, v.subscription_id, v.pro_id, v.starts_at, v.ends_at, v.status, s.category_id, s.postcode,
       s.ends_at AS plan_ends_at, s.status AS plan_status, s.plan_name, s.customer_id, cu.first_name AS customer_name,
       v.starts_at >= now() + make_interval(hours => $4) AS early_enough,
       EXISTS (SELECT 1 FROM subscription_visit_moves m WHERE m.visit_id = v.id AND m.status = 'pending') AS pending_move
     FROM subscription_visits v JOIN subscriptions s ON s.id = v.subscription_id JOIN users cu ON cu.id = s.customer_id
     WHERE v.id = $1 AND s.id = $2 AND s.customer_id = $3
     ${lock ? 'FOR UPDATE OF v' : ''}`,
    [ids.visitId, ids.subscriptionId, ids.customerId, MOVE_NOTICE_HOURS],
  );
  const visit = found.rows[0];
  if (!visit) {
    throw notFound();
  }
  return visit;
}

/** What stops a visit from moving, before looking at the pro's free days; null when nothing does. */
export function moveBlock(visit: MovableVisit): Exclude<MoveBlock, 'no_free_day'> | null {
  if (visit.status !== 'planned' || !['active', 'past_due'].includes(visit.plan_status)) {
    return 'not_movable';
  }
  if (!visit.early_enough) {
    return 'too_late';
  }
  return visit.pending_move ? 'move_pending' : null;
}

/**
 * The times a visit can move to: the other days of its week (Monday to Sunday, market time zone) at the
 * same time of day and length, on days after today, before the plan ends, where the visit's pro is free
 * (the visit itself not counting) and no other move request already asks for that time. With `only`,
 * checks just that start. When the pro is `accepting`, a new time later today still counts.
 */
export async function moveTargets(
  db: Queryable,
  visit: Pick<MovableVisit, 'id' | 'subscription_id' | 'pro_id' | 'starts_at' | 'ends_at' | 'category_id' | 'postcode' | 'plan_ends_at'>,
  timezone: string,
  options: { only?: Date; accepting?: boolean } = {},
): Promise<MoveTarget[]> {
  const minutes = Math.round((visit.ends_at.getTime() - visit.starts_at.getTime()) / 60_000);
  const result = await db.query<MoveTarget>(
    `WITH local AS (SELECT $1::timestamptz AT TIME ZONE $2 AS start),
     days AS (
       SELECT d::date AS day
       FROM local, generate_series(date_trunc('week', local.start), date_trunc('week', local.start) + interval '6 days', interval '1 day') AS d
     ),
     slots AS (
       SELECT ((days.day + local.start::time) AT TIME ZONE $2) AS starts_at,
              ((days.day + local.start::time) AT TIME ZONE $2) + make_interval(mins => $3::int) AS ends_at
       FROM days, local
       WHERE days.day <> local.start::date
         AND ($11::boolean OR days.day > (now() AT TIME ZONE $2)::date)
     )
     SELECT sl.starts_at AS "startsAt", sl.ends_at AS "endsAt" FROM slots sl
     WHERE sl.starts_at > now()
       AND ($10::timestamptz IS NULL OR sl.starts_at = $10)
       AND ($9::timestamptz IS NULL OR sl.ends_at <= $9)
       AND NOT EXISTS (
         SELECT 1 FROM subscription_visits other WHERE other.subscription_id = $4 AND other.id <> $8 AND other.starts_at = sl.starts_at)
       -- Never into a time the customer paused the plan (D78).
       AND NOT EXISTS (
         SELECT 1 FROM subscription_pauses pz
         WHERE pz.subscription_id = $4 AND pz.status = 'active' AND sl.starts_at >= pz.starts_at AND sl.starts_at < pz.ends_at)
       AND EXISTS (
         SELECT 1 FROM pro_profiles p
         WHERE p.user_id = $5 AND ${eligibleProFilter('$6', '$7', 'sl.starts_at', 'sl.ends_at', '$2', 'NULL::uuid', 'NULL::uuid', '$8::uuid')})
       AND NOT EXISTS (
         SELECT 1 FROM subscription_visit_moves asked
         WHERE asked.pro_id = $5 AND asked.status = 'pending' AND asked.visit_id <> $8
           AND tstzrange(asked.to_starts_at, asked.to_ends_at) && tstzrange(sl.starts_at, sl.ends_at))
     ORDER BY sl.starts_at`,
    [
      visit.starts_at,
      timezone,
      minutes,
      visit.subscription_id,
      visit.pro_id,
      visit.category_id,
      visit.postcode,
      visit.id,
      visit.plan_ends_at,
      options.only ?? null,
      options.accepting ?? false,
    ],
  );
  return result.rows;
}

export interface MoveDay extends MoveTarget {
  /** The pro is free then, so the customer can ask for it. */
  free: boolean;
}

/**
 * The nearby days the Move sheet shows (D90): every other day of the visit's week after today, at the same time,
 * inside the plan (before its end, outside pauses, not a time the plan already has), each saying whether the pro
 * is free then. Only free days can be asked for; `moveTargets` decides which those are.
 */
export async function moveDays(
  db: Queryable,
  visit: Pick<MovableVisit, 'id' | 'subscription_id' | 'pro_id' | 'starts_at' | 'ends_at' | 'category_id' | 'postcode' | 'plan_ends_at'>,
  timezone: string,
): Promise<MoveDay[]> {
  const minutes = Math.round((visit.ends_at.getTime() - visit.starts_at.getTime()) / 60_000);
  const [candidates, free] = await Promise.all([
    db.query<MoveTarget>(
      `WITH local AS (SELECT $1::timestamptz AT TIME ZONE $2 AS start),
       slots AS (
         SELECT ((d::date + local.start::time) AT TIME ZONE $2) AS starts_at,
                ((d::date + local.start::time) AT TIME ZONE $2) + make_interval(mins => $3::int) AS ends_at
         FROM local, generate_series(date_trunc('week', local.start), date_trunc('week', local.start) + interval '6 days', interval '1 day') AS d
         WHERE d::date <> local.start::date AND d::date > (now() AT TIME ZONE $2)::date
       )
       SELECT sl.starts_at AS "startsAt", sl.ends_at AS "endsAt" FROM slots sl
       WHERE ($6::timestamptz IS NULL OR sl.ends_at <= $6)
         AND NOT EXISTS (
           SELECT 1 FROM subscription_visits other WHERE other.subscription_id = $4 AND other.id <> $5 AND other.starts_at = sl.starts_at)
         AND NOT EXISTS (
           SELECT 1 FROM subscription_pauses pz
           WHERE pz.subscription_id = $4 AND pz.status = 'active' AND sl.starts_at >= pz.starts_at AND sl.starts_at < pz.ends_at)
       ORDER BY sl.starts_at`,
      [visit.starts_at, timezone, minutes, visit.subscription_id, visit.id, visit.plan_ends_at],
    ),
    moveTargets(db, visit, timezone),
  ]);
  const freeTimes = new Set(free.map((target) => target.startsAt.getTime()));
  return candidates.rows.map((day) => ({ ...day, free: freeTimes.has(day.startsAt.getTime()) }));
}

/**
 * Whether `to` is a time a visit at `from` may ask for at all: another day of the same Monday-to-Sunday week
 * (market time zone), after today, at the same time of day.
 */
async function isSameWeekOtherDay(db: Queryable, from: Date, to: Date, timezone: string): Promise<boolean> {
  const result = await db.query<{ ok: boolean }>(
    `WITH a AS (SELECT $1::timestamptz AT TIME ZONE $3 AS t), b AS (SELECT $2::timestamptz AT TIME ZONE $3 AS t)
     SELECT date_trunc('week', a.t) = date_trunc('week', b.t) AND a.t::date <> b.t::date AND a.t::time = b.t::time
       AND b.t::date > (now() AT TIME ZONE $3)::date AS ok
     FROM a, b`,
    [from, to, timezone],
  );
  return result.rows[0]?.ok ?? false;
}

/** The customer asks to move one visit; the pro is told and must confirm. */
export async function requestMove(
  deps: BookingDeps,
  ids: { subscriptionId: string; visitId: string; customerId: string },
  startsAt: Date,
): Promise<void> {
  const tz = deps.config.timezone;
  await withTransaction(deps.pool, async (client) => {
    const visit = await loadMovableVisit(client, ids, true);
    const block = moveBlock(visit);
    if (block === 'move_pending') {
      throw conflict('move_pending');
    }
    if (block) {
      throw conflict('visit_not_movable');
    }
    if (!(await isSameWeekOtherDay(client, visit.starts_at, startsAt, tz))) {
      throw conflict('move_not_same_week');
    }
    const [target] = await moveTargets(client, visit, tz, { only: startsAt });
    if (!target) {
      throw conflict('pro_not_free');
    }
    const respondBy = new Date(
      Math.min(visit.starts_at.getTime() - MOVE_NOTICE_HOURS * 3600_000, target.startsAt.getTime()),
    );
    try {
      await client.query(
        `INSERT INTO subscription_visit_moves (visit_id, subscription_id, customer_id, pro_id, from_starts_at, from_ends_at,
           to_starts_at, to_ends_at, respond_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [visit.id, visit.subscription_id, ids.customerId, visit.pro_id, visit.starts_at, visit.ends_at, target.startsAt, target.endsAt, respondBy],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict('move_pending');
      }
      throw error;
    }
    await enqueue(
      client,
      visit.pro_id,
      'visit_move_requested',
      messages.visitMoveRequested(visit.customer_name ?? 'Your customer', visit.plan_name, formatSlot(visit.starts_at, tz), formatSlot(target.startsAt, tz)),
      { channels: { push: true, sms: false, email: false } },
    );
  });
  deps.log.info({ event: 'visit_move_requested', visitId: ids.visitId, subscriptionId: ids.subscriptionId });
}

/** The customer takes back a request the pro has not answered yet; the pro is told. */
export async function withdrawMove(deps: BookingDeps, ids: { subscriptionId: string; visitId: string; customerId: string }): Promise<void> {
  const tz = deps.config.timezone;
  await withTransaction(deps.pool, async (client) => {
    const found = await client.query<{ pro_id: string; from_starts_at: Date; plan_name: string; customer_name: string | null }>(
      `UPDATE subscription_visit_moves m SET status = 'withdrawn', responded_at = now()
       FROM subscriptions s, users cu
       WHERE m.visit_id = $1 AND m.subscription_id = $2 AND m.customer_id = $3 AND m.status = 'pending'
         AND s.id = m.subscription_id AND cu.id = m.customer_id
       RETURNING m.pro_id, m.from_starts_at, s.plan_name, cu.first_name AS customer_name`,
      [ids.visitId, ids.subscriptionId, ids.customerId],
    );
    const move = found.rows[0];
    if (!move) {
      throw conflict('move_not_pending');
    }
    await enqueue(
      client,
      move.pro_id,
      'visit_move_withdrawn',
      messages.visitMoveWithdrawn(move.customer_name ?? 'Your customer', move.plan_name, formatSlot(move.from_starts_at, tz)),
      { channels: { push: true, sms: false, email: false } },
    );
  });
  deps.log.info({ event: 'visit_move_withdrawn', visitId: ids.visitId });
}

/** The move requests a pro still has to answer, soonest deadline first. */
export async function pendingMovesForPro(db: Queryable, proId: string) {
  const result = await db.query(
    `SELECT m.id, m.visit_id AS "visitId", m.subscription_id AS "subscriptionId", s.plan_name AS "planName",
       cu.first_name AS "customerName", s.address, s.postcode,
       m.from_starts_at AS "fromStartsAt", m.from_ends_at AS "fromEndsAt", m.to_starts_at AS "toStartsAt",
       m.to_ends_at AS "toEndsAt", m.respond_by AS "respondBy"
     FROM subscription_visit_moves m JOIN subscriptions s ON s.id = m.subscription_id JOIN users cu ON cu.id = m.customer_id
     WHERE m.pro_id = $1 AND m.status = 'pending' AND m.respond_by > now()
     ORDER BY m.respond_by`,
    [proId],
  );
  return result.rows;
}

interface MoveRow {
  id: string;
  visit_id: string;
  subscription_id: string;
  customer_id: string;
  pro_id: string;
  from_starts_at: Date;
  from_ends_at: Date;
  to_starts_at: Date;
  to_ends_at: Date;
  status: string;
  open: boolean;
  visit_status: string;
  visit_starts_at: Date;
  visit_pro_id: string;
  category_id: string;
  postcode: string;
  plan_ends_at: Date | null;
  plan_name: string;
  pro_name: string | null;
}

async function lockMove(client: PoolClient, moveId: string, proId: string): Promise<MoveRow> {
  const category = await client.query<{ category_id: string }>(
    `SELECT s.category_id FROM subscription_visit_moves m JOIN subscriptions s ON s.id = m.subscription_id
     WHERE m.id = $1 AND m.pro_id = $2`,
    [moveId, proId],
  );
  const categoryId = category.rows[0]?.category_id;
  if (!categoryId) {
    throw notFound();
  }
  // The same lock bookings take while they look for a free pro, so nobody books this time meanwhile.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`book:${categoryId}`]);
  const found = await client.query<MoveRow>(
    `SELECT m.id, m.visit_id, m.subscription_id, m.customer_id, m.pro_id, m.from_starts_at, m.from_ends_at, m.to_starts_at,
       m.to_ends_at, m.status, m.respond_by > now() AS open, v.status AS visit_status, v.starts_at AS visit_starts_at,
       v.pro_id AS visit_pro_id, s.category_id, s.postcode, s.ends_at AS plan_ends_at, s.plan_name, pu.first_name AS pro_name
     FROM subscription_visit_moves m
     JOIN subscription_visits v ON v.id = m.visit_id
     JOIN subscriptions s ON s.id = m.subscription_id
     JOIN users pu ON pu.id = m.pro_id
     WHERE m.id = $1 AND m.pro_id = $2
     FOR UPDATE OF m, v`,
    [moveId, proId],
  );
  const move = found.rows[0];
  if (!move) {
    throw notFound();
  }
  if (move.status !== 'pending' || !move.open) {
    throw conflict('move_not_pending');
  }
  return move;
}

/**
 * The pro confirms a move: only that visit gets the new time. When the pro is no longer free then, the
 * request is refused with `pro_not_free` and stays open, so the pro can decline it.
 */
export async function acceptMove(deps: BookingDeps, moveId: string, proId: string): Promise<void> {
  const tz = deps.config.timezone;
  await withTransaction(deps.pool, async (client) => {
    const move = await lockMove(client, moveId, proId);
    if (
      move.visit_status !== 'planned' ||
      move.visit_starts_at.getTime() !== move.from_starts_at.getTime() ||
      move.visit_pro_id !== move.pro_id
    ) {
      throw conflict('move_not_pending');
    }
    const [target] = await moveTargets(
      client,
      {
        id: move.visit_id,
        subscription_id: move.subscription_id,
        pro_id: move.pro_id,
        starts_at: move.from_starts_at,
        ends_at: move.from_ends_at,
        category_id: move.category_id,
        postcode: move.postcode,
        plan_ends_at: move.plan_ends_at,
      },
      tz,
      { only: move.to_starts_at, accepting: true },
    );
    if (!target) {
      throw conflict('pro_not_free');
    }
    try {
      await client.query(
        `UPDATE subscription_visits SET starts_at = $2, ends_at = $3, moved_from = COALESCE(moved_from, starts_at) WHERE id = $1`,
        [move.visit_id, move.to_starts_at, move.to_ends_at],
      );
    } catch (error) {
      if (isExclusionViolation(error) || isUniqueViolation(error)) {
        throw conflict('pro_not_free');
      }
      throw error;
    }
    await client.query("UPDATE subscription_visit_moves SET status = 'accepted', responded_at = now() WHERE id = $1", [moveId]);
    await enqueue(
      client,
      move.customer_id,
      'visit_move_answered',
      messages.visitMoveAccepted(move.pro_name ?? 'Your pro', move.plan_name, formatSlot(move.to_starts_at, tz)),
    );
  });
  deps.log.info({ event: 'visit_move_accepted', moveId, proId });
}

/** The pro declines a move: the visit stays at its original time and the customer is told. */
export async function declineMove(deps: BookingDeps, moveId: string, proId: string): Promise<void> {
  const tz = deps.config.timezone;
  await withTransaction(deps.pool, async (client) => {
    const move = await lockMove(client, moveId, proId);
    await client.query("UPDATE subscription_visit_moves SET status = 'declined', responded_at = now() WHERE id = $1", [moveId]);
    await enqueue(
      client,
      move.customer_id,
      'visit_move_answered',
      messages.visitMoveDeclined(move.pro_name ?? 'Your pro', move.plan_name, formatSlot(move.to_starts_at, tz), formatSlot(move.from_starts_at, tz)),
    );
  });
  deps.log.info({ event: 'visit_move_declined', moveId, proId });
}

/**
 * Background job: a request the pro has not answered by its deadline counts as declined, and the customer
 * is told the visit stays. Requests whose visit changed meanwhile (cancelled, a new pro, the plan ending
 * first) are closed quietly. Returns how many requests expired.
 */
export async function visitMoveTick(deps: BookingDeps): Promise<number> {
  const tz = deps.config.timezone;
  return withTransaction(deps.pool, async (client) => {
    await client.query(
      `UPDATE subscription_visit_moves m SET status = 'withdrawn', responded_at = now()
       FROM subscription_visits v, subscriptions s
       WHERE m.status = 'pending' AND v.id = m.visit_id AND s.id = m.subscription_id
         AND (v.status <> 'planned' OR v.starts_at <> m.from_starts_at OR v.pro_id <> m.pro_id
              OR (s.ends_at IS NOT NULL AND m.to_ends_at > s.ends_at))`,
    );
    const expired = await client.query<{ id: string; customer_id: string; from_starts_at: Date; plan_name: string; pro_name: string | null }>(
      `WITH due AS (
         UPDATE subscription_visit_moves SET status = 'expired', responded_at = now()
         WHERE id IN (
           SELECT id FROM subscription_visit_moves WHERE status = 'pending' AND respond_by <= now()
           ORDER BY respond_by LIMIT 100 FOR UPDATE SKIP LOCKED
         )
         RETURNING id, customer_id, pro_id, subscription_id, from_starts_at
       )
       SELECT due.id, due.customer_id, due.from_starts_at, s.plan_name, pu.first_name AS pro_name
       FROM due JOIN subscriptions s ON s.id = due.subscription_id JOIN users pu ON pu.id = due.pro_id`,
    );
    for (const move of expired.rows) {
      await enqueue(
        client,
        move.customer_id,
        'visit_move_answered',
        messages.visitMoveExpired(move.pro_name ?? 'Your pro', move.plan_name, formatSlot(move.from_starts_at, tz)),
      );
      deps.log.info({ event: 'visit_move_expired', moveId: move.id });
    }
    return expired.rows.length;
  });
}
