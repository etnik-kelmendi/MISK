import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { currentUser } from '../auth/guard.js';
import { eligibleProFilter } from '../bookings/availability.js';
import type { BookingDeps } from '../bookings/events.js';
import type { AppContext } from '../context.js';
import { withTransaction, type Queryable } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { isExclusionViolation, isUniqueViolation, uuidParams } from '../http.js';
import { formatSlot, messages } from '../notifications/messages.js';
import { enqueue } from '../notifications/outbox.js';
import { logActivity } from '../settings/activity.js';
import { moveTargets } from '../subscriptions/moves.js';
import { blockedDateSql, loadAvailability, type Availability } from './working-hours.js';

/**
 * A plan visit on the pro's day off or holiday (D99). The pro is asked, per visit, to do one of two things:
 * - "Move it": to another day of the same Monday-to-Sunday week at the same time, on a day they work and are free
 *   (the D77 rule for customers' moves). The customer is told the new day and can still move it themselves.
 * - "Give to another pro": the best free, approved pro of the trade who covers the address (highest rating, then
 *   nearest) does that one visit as a stand-in; the customer and the stand-in are told, and the plan keeps its
 *   regular pro. When nobody is free, the visit goes under Needs action in the control panel, where the team picks
 *   a stand-in from the free pros nearby and confirms it.
 * The stand-in is paid for the visit and the regular pro is not (see subscriptions/stand-ins.ts).
 * Accepted one-off jobs on those days stay with the pro; they can still cancel one through the job's Cancel flow.
 */

/** How many stand-ins are tried in turn when one is taken at the same moment. */
const STAND_IN_CANDIDATES = 5;
/** The most free pros the team is shown for one visit. */
const TEAM_CANDIDATES = 50;

interface DayOffVisit {
  id: string;
  number: string;
  subscription_id: string;
  pro_id: string;
  starts_at: Date;
  ends_at: Date;
  status: string;
  category_id: string;
  postcode: string;
  address: string;
  plan_ends_at: Date | null;
  plan_status: string;
  plan_name: string;
  customer_id: string;
  pro_name: string | null;
  regular_pro_id: string | null;
  team_asked: boolean;
  on_day_off: boolean;
  pending_move: boolean;
}

/**
 * A plan visit with what moving or handing it over depends on: the pro's own (`proId`), or any visit for the team
 * (`proId` null). `lock` locks the visit row.
 */
async function loadVisit(db: Queryable, visitId: string, proId: string | null, timezone: string, lock = false): Promise<DayOffVisit> {
  const found = await db.query<DayOffVisit>(
    `SELECT v.id, 'V-' || v.number AS number, v.subscription_id, v.pro_id, v.starts_at, v.ends_at, v.status, s.category_id,
       s.postcode, s.address, s.ends_at AS plan_ends_at, s.status AS plan_status, s.plan_name, s.customer_id,
       pu.first_name AS pro_name, COALESCE(v.stand_in_for, s.pro_id) AS regular_pro_id,
       v.handover_requested_at IS NOT NULL AS team_asked,
       ${blockedDateSql('(v.starts_at AT TIME ZONE $3)::date', 'v.pro_id')} AS on_day_off,
       EXISTS (SELECT 1 FROM subscription_visit_moves m WHERE m.visit_id = v.id AND m.status = 'pending') AS pending_move
     FROM subscription_visits v JOIN subscriptions s ON s.id = v.subscription_id JOIN users pu ON pu.id = v.pro_id
     WHERE v.id = $1 AND ($2::uuid IS NULL OR v.pro_id = $2)
     ${lock ? 'FOR UPDATE OF v' : ''}`,
    [visitId, proId, timezone],
  );
  const visit = found.rows[0];
  if (!visit) {
    throw notFound();
  }
  return visit;
}

/** A planned visit of a running plan that has not started yet. */
const isUpcoming = (visit: DayOffVisit) =>
  visit.status === 'planned' && ['active', 'past_due'].includes(visit.plan_status) && visit.starts_at.getTime() > Date.now();

/** Refuses a visit that is not a planned, future visit of a running plan on one of the pro's days off. */
function assertOnDayOff(visit: DayOffVisit): void {
  if (!isUpcoming(visit)) {
    throw conflict('not_movable');
  }
  if (!visit.on_day_off) {
    throw conflict('visit_not_on_day_off');
  }
  // The customer asked to move this visit (D77): the pro answers that request first, on the Jobs page.
  if (visit.pending_move) {
    throw conflict('move_pending');
  }
}

/** The team picks a stand-in only for an upcoming visit whose pro asked for one and found nobody. */
function assertStandInNeeded(visit: DayOffVisit): void {
  if (!isUpcoming(visit) || !visit.team_asked) {
    throw conflict('stand_in_not_needed');
  }
}

/** The days of the visit's week the pro can move it to: same time, a working day, not off, and free. */
export async function proMoveDays(deps: BookingDeps, visitId: string, proId: string) {
  const visit = await loadVisit(deps.pool, visitId, proId, deps.config.timezone);
  assertOnDayOff(visit);
  return moveTargets(deps.pool, visit, deps.config.timezone);
}

/** The pro moves their visit off their day off; the customer is told the new day. */
export async function proMoveVisit(deps: BookingDeps, visitId: string, proId: string, startsAt: Date): Promise<void> {
  const tz = deps.config.timezone;
  await withTransaction(deps.pool, async (client) => {
    const visit = await loadVisit(client, visitId, proId, tz, true);
    assertOnDayOff(visit);
    const [target] = await moveTargets(client, visit, tz, { only: startsAt });
    if (!target) {
      throw conflict('day_not_free');
    }
    try {
      await client.query(
        `UPDATE subscription_visits SET starts_at = $2, ends_at = $3, moved_from = COALESCE(moved_from, starts_at),
           handover_requested_at = NULL
         WHERE id = $1`,
        [visit.id, target.startsAt, target.endsAt],
      );
    } catch (error) {
      if (isExclusionViolation(error) || isUniqueViolation(error)) {
        throw conflict('day_not_free');
      }
      throw error;
    }
    await enqueue(
      client,
      visit.customer_id,
      'visit_move_answered',
      messages.visitMovedByPro(visit.pro_name ?? 'Your pro', visit.plan_name, formatSlot(visit.starts_at, tz), formatSlot(target.startsAt, tz)),
      { link: `/my-plans/${visit.subscription_id}` },
    );
  });
  deps.log.info({ event: 'visit_moved_by_pro', visitId, proId, startsAt: startsAt.toISOString() });
}

export interface StandInCandidate {
  id: string;
  firstName: string | null;
  distanceKm: number;
  ratingAverage: number | null;
}

/**
 * Free stand-ins for the visit: approved, in the trade, covering the address, working and not off that day, and
 * free then; never the visit's pro, its regular pro or the customer. Best first (highest rating, then nearest), or
 * nearest first for the team's list.
 */
async function standInCandidates(
  db: Queryable,
  visit: DayOffVisit,
  timezone: string,
  options: { limit: number; order: 'best' | 'nearest' },
): Promise<StandInCandidate[]> {
  const distance = 'distance_km(home.lat, home.lng, dest.lat, dest.lng)';
  const rating = '(SELECT avg(stars) FROM ratings r WHERE r.pro_id = p.user_id)';
  const found = await db.query<StandInCandidate>(
    `SELECT p.user_id AS id, u.first_name AS "firstName", round(${distance}::numeric, 1)::float AS "distanceKm",
       round(${rating}::numeric, 2)::float AS "ratingAverage"
     FROM pro_profiles p
     JOIN users u ON u.id = p.user_id
     JOIN postcodes home ON home.code = p.home_postcode
     JOIN postcodes dest ON dest.code = $2
     WHERE p.user_id <> $6 AND p.user_id IS DISTINCT FROM $8::uuid
       AND ${eligibleProFilter('$1', '$2', '$3::timestamptz', '$4::timestamptz', '$5', '$7::uuid')}
     ORDER BY ${options.order === 'best' ? `COALESCE(${rating}, 4.5) DESC, ${distance}` : distance}, p.user_id
     LIMIT $9`,
    [visit.category_id, visit.postcode, visit.starts_at, visit.ends_at, timezone, visit.pro_id, visit.customer_id, visit.regular_pro_id, options.limit],
  );
  return found.rows;
}

/**
 * Makes `candidate` the visit's stand-in and tells the customer and the stand-in. Returns false, changing nothing,
 * when the candidate was booked for that time at the same moment (the no-overlap rule).
 */
async function giveToStandIn(client: PoolClient, visit: DayOffVisit, candidate: StandInCandidate, timezone: string): Promise<boolean> {
  await client.query('SAVEPOINT stand_in');
  try {
    await client.query(
      `UPDATE subscription_visits SET pro_id = $2, stand_in_for = COALESCE(stand_in_for, $3), handover_requested_at = NULL
       WHERE id = $1`,
      [visit.id, candidate.id, visit.pro_id],
    );
  } catch (error) {
    if (isExclusionViolation(error)) {
      await client.query('ROLLBACK TO SAVEPOINT stand_in');
      return false;
    }
    throw error;
  }
  await client.query('RELEASE SAVEPOINT stand_in');
  const when = formatSlot(visit.starts_at, timezone);
  await enqueue(
    client,
    visit.customer_id,
    'plan_pro_changed',
    messages.visitStandIn(visit.pro_name ?? 'Your pro', candidate.firstName ?? 'Another pro', visit.plan_name, when),
    { link: `/my-plans/${visit.subscription_id}` },
  );
  await enqueue(client, candidate.id, 'plan_pro_changed', messages.standInVisit(visit.plan_name, when, visit.address), {
    link: `/pro/visits/${visit.id}`,
  });
  return true;
}

export type HandOverResult = { outcome: 'reassigned'; standInName: string | null } | { outcome: 'team_asked' };

/**
 * The pro gives their visit to a stand-in. The first free candidate takes it; when a candidate was booked at the
 * same moment, the next one is tried. With nobody free, the team is asked (Needs action) and the visit stays.
 */
export async function handOverVisit(deps: BookingDeps, visitId: string, proId: string): Promise<HandOverResult> {
  const tz = deps.config.timezone;
  const result = await withTransaction(deps.pool, async (client): Promise<HandOverResult> => {
    const visit = await loadVisit(client, visitId, proId, tz, true);
    assertOnDayOff(visit);
    for (const candidate of await standInCandidates(client, visit, tz, { limit: STAND_IN_CANDIDATES, order: 'best' })) {
      if (await giveToStandIn(client, visit, candidate, tz)) {
        return { outcome: 'reassigned', standInName: candidate.firstName };
      }
    }
    await client.query('UPDATE subscription_visits SET handover_requested_at = COALESCE(handover_requested_at, now()) WHERE id = $1', [visit.id]);
    return { outcome: 'team_asked' };
  });
  deps.log.info({ event: result.outcome === 'reassigned' ? 'visit_handed_to_stand_in' : 'visit_stand_in_requested', visitId, proId });
  return result;
}

/** Free pros the team can choose as the visit's stand-in, nearest first. */
export async function teamStandInCandidates(db: Queryable, visitId: string, timezone: string): Promise<StandInCandidate[]> {
  const visit = await loadVisit(db, visitId, null, timezone);
  assertStandInNeeded(visit);
  return standInCandidates(db, visit, timezone, { limit: TEAM_CANDIDATES, order: 'nearest' });
}

/**
 * The team confirms a stand-in for a visit under Needs action. The pro must still be free then. The customer, the
 * stand-in and the regular pro are told, the choice is written in the team's activity log, and the visit leaves
 * Needs action.
 */
export async function teamAssignStandIn(deps: BookingDeps, visitId: string, standInId: string, adminId: string): Promise<void> {
  const tz = deps.config.timezone;
  const regularProId = await withTransaction(deps.pool, async (client) => {
    const visit = await loadVisit(client, visitId, null, tz, true);
    assertStandInNeeded(visit);
    const candidates = await standInCandidates(client, visit, tz, { limit: TEAM_CANDIDATES, order: 'nearest' });
    const candidate = candidates.find((entry) => entry.id === standInId);
    if (!candidate || !(await giveToStandIn(client, visit, candidate, tz))) {
      throw conflict('pro_not_free');
    }
    await enqueue(
      client,
      visit.pro_id,
      'plan_pro_changed',
      messages.standInFound(candidate.firstName ?? 'Another pro', visit.plan_name, formatSlot(visit.starts_at, tz)),
    );
    await logActivity(client, {
      adminId,
      area: 'plans',
      action: 'visit_stand_in_assigned',
      details: { name: `${candidate.firstName ?? ''} · ${visit.number}`, visitId, standInId, regularProId: visit.pro_id },
    });
    return visit.pro_id;
  });
  deps.log.info({ event: 'admin_assigned_stand_in', visitId, standInId, regularProId, adminId });
}

export async function dayOffVisitRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, gateway, config, guards } = ctx;
  const deps = (): BookingDeps => ({ pool, gateway, config, log: app.log });
  const availabilityOf = (proId: string): Promise<Availability> => loadAvailability(pool, proId, config.timezone);

  app.get<{ Params: { id: string } }>(
    '/pro/visits/:id/move-days',
    { preHandler: guards.pro, schema: { params: uuidParams } },
    async (request) => ({ days: await proMoveDays(deps(), request.params.id, currentUser(request).id) }),
  );

  app.post<{ Params: { id: string }; Body: { startsAt: string } }>(
    '/pro/visits/:id/move',
    {
      preHandler: guards.pro,
      schema: {
        params: uuidParams,
        body: {
          type: 'object',
          required: ['startsAt'],
          additionalProperties: false,
          properties: { startsAt: { type: 'string', format: 'date-time' } },
        },
      },
    },
    async (request) => {
      const proId = currentUser(request).id;
      await proMoveVisit(deps(), request.params.id, proId, new Date(request.body.startsAt));
      return { availability: await availabilityOf(proId) };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/pro/visits/:id/hand-over',
    { preHandler: guards.pro, schema: { params: uuidParams } },
    async (request) => {
      const proId = currentUser(request).id;
      const result = await handOverVisit(deps(), request.params.id, proId);
      return { ...result, availability: await availabilityOf(proId) };
    },
  );

  // ---------- The team (Bookings area of the control panel) ----------

  app.get<{ Params: { id: string } }>(
    '/admin/visits/:id/stand-in-candidates',
    { preHandler: guards.admin, schema: { params: uuidParams } },
    async (request) => ({ candidates: await teamStandInCandidates(pool, request.params.id, config.timezone) }),
  );

  app.post<{ Params: { id: string }; Body: { proId: string } }>(
    '/admin/visits/:id/stand-in',
    {
      preHandler: guards.admin,
      schema: {
        params: uuidParams,
        body: { type: 'object', required: ['proId'], additionalProperties: false, properties: { proId: { type: 'string', format: 'uuid' } } },
      },
    },
    async (request, reply) => {
      await teamAssignStandIn(deps(), request.params.id, request.body.proId, currentUser(request).id);
      return reply.code(204).send();
    },
  );
}
