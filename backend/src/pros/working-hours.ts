import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import type { AppContext } from '../context.js';
import type { Queryable } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { isUniqueViolation, uuidParams } from '../http.js';
import { addDays, marketToday } from './checks.js';

/**
 * Working hours, working days, days off and holidays (D94, D99). Outside them a pro is offline automatically: no
 * new offers come in, whatever the switch says, and their accepted jobs and plan visits stay. "Go online"
 * overrides this until the end of that day in the market time zone.
 *
 * Weekly working days and hours only decide which new offers come in. A day off (a single date) and a holiday (a
 * range of dates) also mean no job is offered for that date; plan visits already on it are listed for the pro,
 * who moves each one or gives it to a stand-in (see day-off-visits.ts), and accepted one-off jobs stay.
 */

/** Why a pro is offline although their switch is on. */
export type AutoOfflineReason = 'holiday' | 'day_off' | 'outside_hours';

/** The longest holiday a pro can block at once, and how far ahead. */
export const HOLIDAY_MAX_DAYS = 92;
export const HOLIDAY_AHEAD_DAYS = 366;
export const MAX_HOLIDAYS = 20;
/** Days off (single dates) a pro can have planned at once, and how far ahead (D99). */
export const MAX_DAYS_OFF = 60;
export const DAYS_OFF_AHEAD = 366;
/** "HH:MM" on the hour or half hour; the end may be 24:00. */
export const START_PATTERN = '^([01][0-9]|2[0-3]):(00|30)$';
export const END_PATTERN = '^(([01][0-9]|2[0-3]):(00|30)|24:00)$';
/** The most plan visits and jobs listed as falling on the pro's days off. */
const MAX_LISTED_ON_DAYS_OFF = 50;

/** SQL: the local "now" of the market, for the pro alias `p`. */
const localNow = (tz: string) => `(now() AT TIME ZONE ${tz})`;

/** SQL: true when the local date `day` is one of the pro `p`'s holidays or days off (D99). */
export function blockedDateSql(day: string, pro = 'p.user_id'): string {
  return `(EXISTS (SELECT 1 FROM pro_holidays hol WHERE hol.pro_id = ${pro} AND ${day} BETWEEN hol.starts_on AND hol.ends_on)
    OR EXISTS (SELECT 1 FROM pro_days_off doff WHERE doff.pro_id = ${pro} AND doff.day = ${day}))`;
}

/**
 * SQL for why the pro `p` is offline automatically right now, or NULL when they are not: a holiday, a day off
 * (a date they took off, or a day that is not one of their working days), or a time outside their working
 * hours. `tz` is an SQL expression for the market time zone.
 */
export function autoOfflineReasonSql(tz: string): string {
  return `CASE
    WHEN EXISTS (SELECT 1 FROM pro_holidays hol WHERE hol.pro_id = p.user_id
                 AND ${localNow(tz)}::date BETWEEN hol.starts_on AND hol.ends_on) THEN 'holiday'
    WHEN EXISTS (SELECT 1 FROM pro_days_off doff WHERE doff.pro_id = p.user_id AND doff.day = ${localNow(tz)}::date) THEN 'day_off'
    WHEN NOT (extract(isodow FROM ${localNow(tz)})::smallint = ANY (p.working_days)) THEN 'day_off'
    WHEN ${localNow(tz)}::time < p.work_start OR ${localNow(tz)}::time >= p.work_end THEN 'outside_hours'
  END`;
}

/** SQL: true while the pro `p` gets new offers: the switch is on and they are inside their hours, or overrode them. */
export function onlineNowSql(tz: string): string {
  return `(p.online AND (COALESCE(p.online_override_until > now(), false) OR (${autoOfflineReasonSql(tz)}) IS NULL))`;
}

/** SQL: true when the job starting at `s` falls on one of the pro `p`'s holidays or days off (no offers then). */
export function offThatDaySql(s: string, tz: string): string {
  return blockedDateSql(`((${s}) AT TIME ZONE ${tz})::date`);
}

/** A plan visit of the pro on one of their days off or holidays, still to be moved or handed over (D99). */
export interface VisitOnDayOff {
  id: string;
  startsAt: Date;
  planName: string;
  customerName: string | null;
  address: string;
  /** The pro asked for a stand-in and none was free: the MISK team is sorting it out. */
  teamAsked: boolean;
}

/** An accepted one-off job on one of the pro's days off or holidays: it stays theirs (D99). */
export interface JobOnDayOff {
  id: string;
  startsAt: Date;
  serviceName: string;
}

export interface Availability {
  workStart: string;
  workEnd: string;
  /** ISO weekdays, 1 (Monday) to 7. */
  workingDays: number[];
  holidays: { id: string; startsOn: string; endsOn: string }[];
  /** Single days off from today on, "YYYY-MM-DD". */
  daysOff: { id: string; day: string }[];
  visitsOnDaysOff: VisitOnDayOff[];
  jobsOnDaysOff: JobOnDayOff[];
  /** Whether new offers come in right now. */
  onlineNow: boolean;
  /** Why the pro is offline although the switch is on; null when the switch decides. */
  autoOffline: { reason: AutoOfflineReason; until: string | null } | null;
  /** "Go online" outside the pro's hours lasts until this moment. */
  overrideUntil: Date | null;
}

/** The pro's hours, days off, holidays and whether they are online now, for the pro app. */
export async function loadAvailability(db: Queryable, proId: string, timezone: string): Promise<Availability> {
  const found = await db.query<{
    workStart: string;
    workEnd: string;
    workingDays: number[];
    online: boolean;
    onlineNow: boolean;
    reason: AutoOfflineReason | null;
    overrideUntil: Date | null;
    holidayUntil: string | null;
  }>(
    `SELECT to_char(p.work_start, 'HH24:MI') AS "workStart",
       CASE WHEN p.work_end = '24:00' THEN '24:00' ELSE to_char(p.work_end, 'HH24:MI') END AS "workEnd",
       p.working_days::int[] AS "workingDays",
       p.online, ${onlineNowSql('$2')} AS "onlineNow", ${autoOfflineReasonSql('$2')} AS reason,
       CASE WHEN p.online_override_until > now() THEN p.online_override_until END AS "overrideUntil",
       (SELECT to_char(max(hol.ends_on), 'YYYY-MM-DD') FROM pro_holidays hol WHERE hol.pro_id = p.user_id
          AND ${localNow('$2')}::date BETWEEN hol.starts_on AND hol.ends_on) AS "holidayUntil"
     FROM pro_profiles p WHERE p.user_id = $1`,
    [proId, timezone],
  );
  const row = found.rows[0];
  if (!row) {
    throw notFound('profile_not_found');
  }
  const today = marketToday(timezone);
  const visitDay = `(v.starts_at AT TIME ZONE $2)::date`;
  const jobDay = `(b.starts_at AT TIME ZONE $2)::date`;
  const [holidays, daysOff, visits, jobs] = await Promise.all([
    db.query<{ id: string; startsOn: string; endsOn: string }>(
      `SELECT id, to_char(starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(ends_on, 'YYYY-MM-DD') AS "endsOn"
       FROM pro_holidays WHERE pro_id = $1 AND ends_on >= $2::date ORDER BY starts_on`,
      [proId, today],
    ),
    db.query<{ id: string; day: string }>(
      `SELECT id, to_char(day, 'YYYY-MM-DD') AS day FROM pro_days_off WHERE pro_id = $1 AND day >= $2::date ORDER BY day`,
      [proId, today],
    ),
    db.query<VisitOnDayOff>(
      `SELECT v.id, v.starts_at AS "startsAt", s.plan_name AS "planName", cu.first_name AS "customerName", s.address,
         v.handover_requested_at IS NOT NULL AS "teamAsked"
       FROM subscription_visits v JOIN subscriptions s ON s.id = v.subscription_id JOIN users cu ON cu.id = s.customer_id
       WHERE v.pro_id = $1 AND v.status = 'planned' AND v.starts_at > now() AND ${blockedDateSql(visitDay, 'v.pro_id')}
       ORDER BY v.starts_at LIMIT ${MAX_LISTED_ON_DAYS_OFF}`,
      [proId, timezone],
    ),
    db.query<JobOnDayOff>(
      `SELECT b.id, b.starts_at AS "startsAt", b.service_name AS "serviceName"
       FROM bookings b
       WHERE b.pro_id = $1 AND b.status = 'accepted' AND b.starts_at > now() AND ${blockedDateSql(jobDay, 'b.pro_id')}
       ORDER BY b.starts_at LIMIT ${MAX_LISTED_ON_DAYS_OFF}`,
      [proId, timezone],
    ),
  ]);
  // The switch is on but the hours say offline, and no "Go online" overrides them.
  const auto = row.online && !row.onlineNow && row.reason ? { reason: row.reason, until: row.reason === 'holiday' ? row.holidayUntil : null } : null;
  return {
    workStart: row.workStart,
    workEnd: row.workEnd,
    workingDays: row.workingDays,
    holidays: holidays.rows,
    daysOff: daysOff.rows,
    visitsOnDaysOff: visits.rows,
    jobsOnDaysOff: jobs.rows,
    onlineNow: row.onlineNow,
    autoOffline: auto,
    overrideUntil: row.overrideUntil,
  };
}

/**
 * A day off or holiday was removed (D99): plan visits waiting for the team because of it are the pro's again as
 * normal, so they leave Needs action.
 */
async function clearHandoverRequests(db: Queryable, proId: string, timezone: string): Promise<void> {
  await db.query(
    `UPDATE subscription_visits v SET handover_requested_at = NULL
     WHERE v.pro_id = $1 AND v.handover_requested_at IS NOT NULL
       AND NOT ${blockedDateSql('(v.starts_at AT TIME ZONE $2)::date', 'v.pro_id')}`,
    [proId, timezone],
  );
}

const minutesOf = (value: string) => {
  const [h, m] = value.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

export async function workingHoursRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards } = ctx;
  const tz = ctx.config.timezone;

  app.get('/pro/availability', { preHandler: guards.pro }, async (request) => ({
    availability: await loadAvailability(pool, currentUser(request).id, tz),
  }));

  // Working hours, the same on every working day. They only decide which new offers come in: accepted jobs and
  // plan visits outside them stay.
  app.put<{ Body: { workStart: string; workEnd: string } }>(
    '/pro/working-hours',
    {
      preHandler: guards.pro,
      schema: {
        body: {
          type: 'object',
          required: ['workStart', 'workEnd'],
          additionalProperties: false,
          properties: {
            workStart: { type: 'string', pattern: START_PATTERN },
            workEnd: { type: 'string', pattern: END_PATTERN },
          },
        },
      },
    },
    async (request) => {
      const proId = currentUser(request).id;
      const { workStart, workEnd } = request.body;
      if (minutesOf(workStart) >= minutesOf(workEnd)) {
        throw badRequest('hours_invalid');
      }
      await pool.query('UPDATE pro_profiles SET work_start = $2, work_end = $3, updated_at = now() WHERE user_id = $1', [
        proId,
        workStart,
        workEnd,
      ]);
      request.log.info({ event: 'pro_working_hours_changed', proId, workStart, workEnd });
      return { availability: await loadAvailability(pool, proId, tz) };
    },
  );

  // The weekly working days, Monday (1) to Sunday (7), at least one (D99). Like the hours, they only decide which
  // new offers come in: accepted jobs and plan visits on other days stay.
  app.put<{ Body: { workingDays: number[] } }>(
    '/pro/working-days',
    {
      preHandler: guards.pro,
      schema: {
        body: {
          type: 'object',
          required: ['workingDays'],
          additionalProperties: false,
          properties: {
            workingDays: { type: 'array', uniqueItems: true, minItems: 1, maxItems: 7, items: { type: 'integer', minimum: 1, maximum: 7 } },
          },
        },
      },
    },
    async (request) => {
      const proId = currentUser(request).id;
      const days = [...request.body.workingDays].sort((a, b) => a - b);
      await pool.query('UPDATE pro_profiles SET working_days = $2, updated_at = now() WHERE user_id = $1', [proId, days]);
      request.log.info({ event: 'pro_working_days_changed', proId, workingDays: days });
      return { availability: await loadAvailability(pool, proId, tz) };
    },
  );

  // A single day off, today or later (D99). The answer lists plan visits on the pro's days off, which the app
  // then asks them to move or hand over.
  app.post<{ Body: { day: string } }>(
    '/pro/days-off',
    {
      preHandler: guards.pro,
      schema: {
        body: {
          type: 'object',
          required: ['day'],
          additionalProperties: false,
          properties: { day: { type: 'string', format: 'date' } },
        },
      },
    },
    async (request, reply) => {
      const proId = currentUser(request).id;
      const { day } = request.body;
      const today = marketToday(tz);
      if (day < today || day > addDays(today, DAYS_OFF_AHEAD)) {
        throw badRequest('day_off_invalid');
      }
      const count = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM pro_days_off WHERE pro_id = $1 AND day >= $2::date', [
        proId,
        today,
      ]);
      if ((count.rows[0]?.n ?? 0) >= MAX_DAYS_OFF) {
        throw conflict('too_many_days_off');
      }
      try {
        await pool.query('INSERT INTO pro_days_off (pro_id, day) VALUES ($1, $2)', [proId, day]);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict('day_off_exists');
        }
        throw error;
      }
      request.log.info({ event: 'pro_day_off_added', proId, day });
      return reply.code(201).send({ availability: await loadAvailability(pool, proId, tz) });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/pro/days-off/:id',
    { preHandler: guards.pro, schema: { params: uuidParams } },
    async (request) => {
      const proId = currentUser(request).id;
      const deleted = await pool.query('DELETE FROM pro_days_off WHERE id = $1 AND pro_id = $2', [request.params.id, proId]);
      if (!deleted.rowCount) {
        throw notFound();
      }
      await clearHandoverRequests(pool, proId, tz);
      request.log.info({ event: 'pro_day_off_removed', proId, dayOffId: request.params.id });
      return { availability: await loadAvailability(pool, proId, tz) };
    },
  );

  // A holiday: whole days, first and last included, today or later.
  app.post<{ Body: { startsOn: string; endsOn: string } }>(
    '/pro/holidays',
    {
      preHandler: guards.pro,
      schema: {
        body: {
          type: 'object',
          required: ['startsOn', 'endsOn'],
          additionalProperties: false,
          properties: { startsOn: { type: 'string', format: 'date' }, endsOn: { type: 'string', format: 'date' } },
        },
      },
    },
    async (request, reply) => {
      const proId = currentUser(request).id;
      const { startsOn, endsOn } = request.body;
      const today = marketToday(tz);
      if (endsOn < startsOn || startsOn < today || startsOn > addDays(today, HOLIDAY_AHEAD_DAYS)) {
        throw badRequest('holiday_invalid');
      }
      if (endsOn > addDays(startsOn, HOLIDAY_MAX_DAYS)) {
        throw badRequest('holiday_too_long');
      }
      const count = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM pro_holidays WHERE pro_id = $1 AND ends_on >= $2::date', [
        proId,
        today,
      ]);
      if ((count.rows[0]?.n ?? 0) >= MAX_HOLIDAYS) {
        throw conflict('too_many_holidays');
      }
      await pool.query('INSERT INTO pro_holidays (pro_id, starts_on, ends_on) VALUES ($1, $2, $3)', [proId, startsOn, endsOn]);
      request.log.info({ event: 'pro_holiday_added', proId, startsOn, endsOn });
      return reply.code(201).send({ availability: await loadAvailability(pool, proId, tz) });
    },
  );

  // "I'm going on holiday" switched off (D99): every holiday from today on ends, so offers come in again.
  app.delete('/pro/holidays', { preHandler: guards.pro }, async (request) => {
    const proId = currentUser(request).id;
    const deleted = await pool.query('DELETE FROM pro_holidays WHERE pro_id = $1 AND ends_on >= $2::date', [proId, marketToday(tz)]);
    await clearHandoverRequests(pool, proId, tz);
    request.log.info({ event: 'pro_holidays_cleared', proId, removed: deleted.rowCount ?? 0 });
    return { availability: await loadAvailability(pool, proId, tz) };
  });

  app.delete<{ Params: { id: string } }>(
    '/pro/holidays/:id',
    { preHandler: guards.pro, schema: { params: uuidParams } },
    async (request) => {
      const proId = currentUser(request).id;
      const deleted = await pool.query('DELETE FROM pro_holidays WHERE id = $1 AND pro_id = $2', [request.params.id, proId]);
      if (!deleted.rowCount) {
        throw notFound();
      }
      await clearHandoverRequests(pool, proId, tz);
      request.log.info({ event: 'pro_holiday_removed', proId, holidayId: request.params.id });
      return { availability: await loadAvailability(pool, proId, tz) };
    },
  );
}
