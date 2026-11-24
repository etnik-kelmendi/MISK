import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import type { AppContext } from '../context.js';
import type { Queryable } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { uuidParams } from '../http.js';
import { addDays, marketToday } from './checks.js';

/**
 * Working hours, days off and holidays (D94). Outside them a pro is offline automatically: no new offers come
 * in, whatever the switch says, and their accepted jobs and plan visits stay. "Go online" overrides this until
 * the end of that day in the market time zone.
 */

/** Why a pro is offline although their switch is on. */
export type AutoOfflineReason = 'holiday' | 'day_off' | 'outside_hours';

/** The longest holiday a pro can block at once, and how far ahead. */
export const HOLIDAY_MAX_DAYS = 92;
export const HOLIDAY_AHEAD_DAYS = 366;
export const MAX_HOLIDAYS = 20;
/** "HH:MM" on the hour or half hour; the end may be 24:00. */
export const START_PATTERN = '^([01][0-9]|2[0-3]):(00|30)$';
export const END_PATTERN = '^(([01][0-9]|2[0-3]):(00|30)|24:00)$';

/** SQL: the local "now" of the market, for the pro alias `p`. */
const localNow = (tz: string) => `(now() AT TIME ZONE ${tz})`;

/**
 * SQL for why the pro `p` is offline automatically right now, or NULL when they are not: a holiday, a day
 * that is not one of their working days, or a time outside their working hours. `tz` is an SQL expression for
 * the market time zone.
 */
export function autoOfflineReasonSql(tz: string): string {
  return `CASE
    WHEN EXISTS (SELECT 1 FROM pro_holidays hol WHERE hol.pro_id = p.user_id
                 AND ${localNow(tz)}::date BETWEEN hol.starts_on AND hol.ends_on) THEN 'holiday'
    WHEN NOT (extract(isodow FROM ${localNow(tz)})::smallint = ANY (p.working_days)) THEN 'day_off'
    WHEN ${localNow(tz)}::time < p.work_start OR ${localNow(tz)}::time >= p.work_end THEN 'outside_hours'
  END`;
}

/** SQL: true while the pro `p` gets new offers: the switch is on and they are inside their hours, or overrode them. */
export function onlineNowSql(tz: string): string {
  return `(p.online AND (COALESCE(p.online_override_until > now(), false) OR (${autoOfflineReasonSql(tz)}) IS NULL))`;
}

/** SQL: true when the job starting at `s` falls on one of the pro `p`'s holidays (no offers for those days). */
export function onHolidaySql(s: string, tz: string): string {
  return `EXISTS (SELECT 1 FROM pro_holidays hol WHERE hol.pro_id = p.user_id
    AND ((${s}) AT TIME ZONE ${tz})::date BETWEEN hol.starts_on AND hol.ends_on)`;
}

export interface Availability {
  workStart: string;
  workEnd: string;
  holidays: { id: string; startsOn: string; endsOn: string }[];
  /** Whether new offers come in right now. */
  onlineNow: boolean;
  /** Why the pro is offline although the switch is on; null when the switch decides. */
  autoOffline: { reason: AutoOfflineReason; until: string | null } | null;
  /** "Go online" outside the pro's hours lasts until this moment. */
  overrideUntil: Date | null;
}

/** The pro's hours, holidays and whether they are online now, for the Jobs page and the Profile. */
export async function loadAvailability(db: Queryable, proId: string, timezone: string): Promise<Availability> {
  const found = await db.query<{
    workStart: string;
    workEnd: string;
    online: boolean;
    onlineNow: boolean;
    reason: AutoOfflineReason | null;
    overrideUntil: Date | null;
    holidayUntil: string | null;
  }>(
    `SELECT to_char(p.work_start, 'HH24:MI') AS "workStart",
       CASE WHEN p.work_end = '24:00' THEN '24:00' ELSE to_char(p.work_end, 'HH24:MI') END AS "workEnd",
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
  const holidays = await db.query<{ id: string; startsOn: string; endsOn: string }>(
    `SELECT id, to_char(starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(ends_on, 'YYYY-MM-DD') AS "endsOn"
     FROM pro_holidays WHERE pro_id = $1 AND ends_on >= $2::date ORDER BY starts_on`,
    [proId, marketToday(timezone)],
  );
  // The switch is on but the hours say offline, and no "Go online" overrides them.
  const auto = row.online && !row.onlineNow && row.reason ? { reason: row.reason, until: row.reason === 'holiday' ? row.holidayUntil : null } : null;
  return {
    workStart: row.workStart,
    workEnd: row.workEnd,
    holidays: holidays.rows,
    onlineNow: row.onlineNow,
    autoOffline: auto,
    overrideUntil: row.overrideUntil,
  };
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

  // Working hours, the same on every working day. Days off are the days that are not working days, which the
  // pro chooses with their working days.
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

  app.delete<{ Params: { id: string } }>(
    '/pro/holidays/:id',
    { preHandler: guards.pro, schema: { params: uuidParams } },
    async (request) => {
      const proId = currentUser(request).id;
      const deleted = await pool.query('DELETE FROM pro_holidays WHERE id = $1 AND pro_id = $2', [request.params.id, proId]);
      if (!deleted.rowCount) {
        throw notFound();
      }
      request.log.info({ event: 'pro_holiday_removed', proId, holidayId: request.params.id });
      return { availability: await loadAvailability(pool, proId, tz) };
    },
  );
}
