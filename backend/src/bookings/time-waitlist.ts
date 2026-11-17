import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import { normalizePostcode } from '../catalogue/routes.js';
import type { AppContext } from '../context.js';
import { isUniqueViolation, uuidParams } from '../http.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { formatDay, formatSlot, messages } from '../notifications/messages.js';
import { enqueue } from '../notifications/outbox.js';
import { BOOKING_DAYS, findSlots, localDayHour } from './availability.js';
import type { BookingDeps } from './events.js';

/** How many waiting entries one pass checks, so a pass stays short. */
const TICK_LIMIT = 200;

export interface WaitlistEntry {
  id: string;
  day: string;
  startsAt: string | null;
  notifiedAt: string | null;
}

/** The customer's waiting entries for one trade and postcode, for the Choose time page. */
export async function waitlistFor(db: AppContext['pool'], customerId: string, categoryId: string, postcode: string): Promise<WaitlistEntry[]> {
  const rows = await db.query<WaitlistEntry>(
    `SELECT id, to_char(day, 'YYYY-MM-DD') AS day, starts_at AS "startsAt", notified_at AS "notifiedAt"
     FROM time_waitlist WHERE customer_id = $1 AND category_id = $2 AND postcode = $3 ORDER BY day, starts_at NULLS FIRST`,
    [customerId, categoryId, postcode],
  );
  return rows.rows;
}

/**
 * The waiting list for full times (D70): a customer waits for one time, or any time on a day, in one trade.
 * When a pro becomes free there, they are told by push and in the app. Nothing is held for them: the first
 * to book gets it.
 */
export async function timeWaitlistRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards, config } = ctx;

  app.post<{ Body: { serviceIds: string[]; postcode: string; day: string; startsAt?: string } }>(
    '/time-waitlist',
    {
      preHandler: guards.customer,
      schema: {
        body: {
          type: 'object',
          required: ['serviceIds', 'postcode', 'day'],
          additionalProperties: false,
          properties: {
            serviceIds: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: { type: 'string', format: 'uuid' } },
            postcode: { type: 'string', minLength: 2, maxLength: 10 },
            day: { type: 'string', format: 'date' },
            startsAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request, reply) => {
      const customerId = currentUser(request).id;
      const { serviceIds, day } = request.body;
      const postcode = normalizePostcode(request.body.postcode);
      const services = await pool.query<{ category_id: string }>(
        `SELECT DISTINCT s.category_id FROM services s JOIN categories c ON c.id = s.category_id
         WHERE s.id = ANY($1::uuid[]) AND s.active AND c.active`,
        [serviceIds],
      );
      const categoryId = services.rows[0]?.category_id;
      if (!categoryId || services.rowCount !== 1) {
        throw badRequest('invalid_services');
      }
      const served = await pool.query('SELECT 1 FROM postcodes WHERE code = $1 AND active', [postcode]);
      if (!served.rowCount) {
        throw badRequest('postcode_not_served');
      }
      // Only days the customer could book: today and the following bookable days.
      const inRange = await pool.query<{ ok: boolean }>(
        `SELECT $1::date BETWEEN (now() AT TIME ZONE $2)::date AND (now() AT TIME ZONE $2)::date + ($3::int - 1) AS ok`,
        [day, config.timezone, BOOKING_DAYS],
      );
      if (!inRange.rows[0]?.ok) {
        throw badRequest('day_not_bookable');
      }
      const startsAt = request.body.startsAt ? new Date(request.body.startsAt) : null;
      if (startsAt && (localDayHour(startsAt, config.timezone).day !== day || startsAt.getTime() <= Date.now())) {
        throw badRequest('time_not_on_day');
      }
      try {
        const inserted = await pool.query<WaitlistEntry>(
          `INSERT INTO time_waitlist (customer_id, category_id, service_ids, postcode, day, starts_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, to_char(day, 'YYYY-MM-DD') AS day, starts_at AS "startsAt", notified_at AS "notifiedAt"`,
          [customerId, categoryId, serviceIds, postcode, day, startsAt],
        );
        request.log.info({ event: 'time_waitlist_joined', customerId, day, whole: !startsAt });
        return await reply.code(201).send({ entry: inserted.rows[0] });
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict('already_waiting');
        throw error;
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/time-waitlist/:id', { preHandler: guards.customer, schema: { params: uuidParams } }, async (request, reply) => {
    const removed = await pool.query('DELETE FROM time_waitlist WHERE id = $1 AND customer_id = $2', [request.params.id, currentUser(request).id]);
    if (!removed.rowCount) throw notFound();
    return reply.code(204).send();
  });
}

/**
 * One pass over the waiting list: tells each customer whose time (or day) now has a free pro, once, and
 * drops entries for days that have passed. Returns how many were told.
 */
export async function timeWaitlistTick(deps: BookingDeps): Promise<number> {
  const tz = deps.config.timezone;
  await deps.pool.query('DELETE FROM time_waitlist WHERE day < (now() AT TIME ZONE $1)::date', [tz]);
  const waiting = await deps.pool.query<{
    id: string;
    customer_id: string;
    category_id: string;
    postcode: string;
    day: string;
    starts_at: Date | null;
    names: string;
    duration: number;
    services_left: number;
    wanted: number;
  }>(
    `SELECT w.id, w.customer_id, w.category_id, w.postcode, to_char(w.day, 'YYYY-MM-DD') AS day, w.starts_at,
       string_agg(s.name, ' + ' ORDER BY array_position(w.service_ids, s.id)) AS names,
       COALESCE(sum(s.duration_minutes), 0)::int AS duration,
       count(s.id)::int AS services_left, cardinality(w.service_ids) AS wanted
     FROM time_waitlist w LEFT JOIN services s ON s.id = ANY (w.service_ids) AND s.active
     WHERE w.notified_at IS NULL AND (w.starts_at IS NULL OR w.starts_at > now())
     GROUP BY w.id
     ORDER BY w.created_at LIMIT $1`,
    [TICK_LIMIT],
  );
  let told = 0;
  for (const entry of waiting.rows) {
    // A service that is no longer offered ends the wait: the customer chooses again in the app.
    if (entry.services_left !== entry.wanted || entry.duration <= 0) {
      await deps.pool.query('DELETE FROM time_waitlist WHERE id = $1', [entry.id]);
      continue;
    }
    const slots = await findSlots(deps.pool, {
      categoryId: entry.category_id,
      postcode: entry.postcode,
      durationMinutes: entry.duration,
      timezone: tz,
      customerId: entry.customer_id,
    });
    const free = slots.find(
      (slot) =>
        slot.available &&
        (entry.starts_at ? slot.startsAt.getTime() === entry.starts_at.getTime() : localDayHour(slot.startsAt, tz).day === entry.day),
    );
    if (!free) continue;
    // Claimed first, so two servers never tell the same customer twice.
    const claimed = await deps.pool.query('UPDATE time_waitlist SET notified_at = now() WHERE id = $1 AND notified_at IS NULL', [entry.id]);
    if (!claimed.rowCount) continue;
    const when = entry.starts_at ? formatSlot(free.startsAt, tz) : formatDay(free.startsAt, tz);
    await enqueue(deps.pool, entry.customer_id, 'time_free', messages.timeFree(entry.names, when));
    deps.log.info({ event: 'time_waitlist_told', entryId: entry.id });
    told += 1;
  }
  return told;
}
