import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import { proShareCents } from '../catalogue/pricing.js';
import type { AppContext } from '../context.js';
import { onlyRow, withTransaction, type Queryable } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { uuidParams } from '../http.js';
import { messages } from '../notifications/messages.js';
import { enqueue } from '../notifications/outbox.js';
import { readSingleFile, storeUpload } from '../uploads/uploads.js';
import { acceptOffer, declineOffer, flexibleStarts } from './dispatch.js';
import { eligibleProFilter } from './availability.js';
import { priceList } from './job-tasks.js';
import { setStatus, type BookingDeps } from './events.js';
import { chargeWaitingTime, closeDoorIssueOnStart, warnIfLate } from './on-site.js';
import { loadBooking } from './views.js';

export const MAX_COMPLETION_PHOTOS = 6;
export { MAX_EXTRA_MINUTES, MIN_EXTRA_MINUTES } from './job-tasks.js';
/** The longest note a pro can add to extra work for the customer (D86). */
export const EXTRA_NOTE_MAX = 300;
const NEXT_STEP: Record<string, string> = { accepted: 'on_the_way', on_the_way: 'working' };

/** True while the pro's own "Unsafe to work" report is open: the job is stopped until MISK support resolves it (D94). */
async function stoppedAsUnsafe(db: Queryable, bookingId: string, proId: string): Promise<boolean> {
  const found = await db.query(
    "SELECT 1 FROM booking_issues WHERE booking_id = $1 AND pro_id = $2 AND reason = 'unsafe' AND resolved_at IS NULL",
    [bookingId, proId],
  );
  return (found.rowCount ?? 0) > 0;
}

export async function proJobRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards } = ctx;
  const deps = (): BookingDeps => ({ pool, gateway: ctx.gateway, config: ctx.config, log: app.log });

  /** Loads a job only when it is assigned to the signed-in pro. */
  async function ownJob(proId: string, bookingId: string) {
    const owned = await pool.query('SELECT 1 FROM bookings WHERE id = $1 AND pro_id = $2', [bookingId, proId]);
    const job = owned.rowCount ? await loadBooking(pool, bookingId, 'pro', ctx.config.timezone) : null;
    if (!job) {
      throw notFound();
    }
    return job;
  }

  app.get('/pro/offers', { preHandler: guards.pro }, async (request) => {
    const proId = currentUser(request).id;
    const result = await pool.query<{
      id: string;
      bookingId: string;
      expiresAt: Date;
      serviceName: string;
      size: string;
      startsAt: Date;
      endsAt: Date;
      address: string;
      postcode: string;
      notes: string;
      customerName: string | null;
      customerRating: number | null;
      priceCents: number;
      proSharePct: number;
      distanceKm: number | null;
      photoIds: string[];
      flexibleWindow: string | null;
      startOptions: Date[] | null;
      durationMinutes: number;
    }>(
      `SELECT o.id, o.booking_id AS "bookingId", o.expires_at AS "expiresAt", b.service_name AS "serviceName", b.size,
         b.starts_at AS "startsAt", b.ends_at AS "endsAt", b.address, b.postcode, b.notes,
         cu.first_name AS "customerName",
         -- How pros rated this customer (D86), shown like the pro's own stars.
         (SELECT round(avg(cr.stars)::numeric, 1)::float FROM customer_ratings cr WHERE cr.customer_id = b.customer_id) AS "customerRating",
         b.price_cents AS "priceCents", b.pro_share_pct AS "proSharePct",
         (SELECT round(distance_km(home.lat, home.lng, dest.lat, dest.lng)::numeric, 1)::float
          FROM pro_profiles p, postcodes home, postcodes dest
          WHERE p.user_id = o.pro_id AND home.code = p.home_postcode AND dest.code = b.postcode) AS "distanceKm",
         COALESCE((SELECT array_agg(ph.upload_id ORDER BY ph.created_at) FROM booking_photos ph
                   WHERE ph.booking_id = b.id), '{}') AS "photoIds",
         -- A flexible job (D70): its window and the starts this pro is free for, to pick one when accepting.
         CASE WHEN b.time_confirmed_at IS NULL THEN b.flexible_window END AS "flexibleWindow",
         -- How long the job takes (D94).
         bd.minutes AS "durationMinutes",
         CASE WHEN b.flexible_window IS NOT NULL AND b.time_confirmed_at IS NULL THEN (
           SELECT array_agg(st ORDER BY st)
           FROM pro_profiles p, ${flexibleStarts('b.starts_at', 'b.ends_at', 'bd.minutes')} AS st
           WHERE p.user_id = o.pro_id
             AND ${eligibleProFilter('b.category_id', 'b.postcode', 'st', 'st + make_interval(mins => bd.minutes)', '$2', 'b.customer_id', 'b.id')}
         ) END AS "startOptions"
       FROM booking_offers o JOIN bookings b ON b.id = o.booking_id JOIN users cu ON cu.id = b.customer_id
       CROSS JOIN LATERAL (
         SELECT COALESCE((SELECT sum(duration_minutes)::int FROM booking_services bs WHERE bs.booking_id = b.id),
           (extract(epoch FROM b.ends_at - b.starts_at) / 60)::int) AS minutes
       ) bd
       WHERE o.pro_id = $1 AND o.status = 'pending' AND o.expires_at > now() AND b.status = 'searching'
       ORDER BY o.expires_at`,
      [proId, ctx.config.timezone],
    );
    return {
      offers: result.rows.map(({ priceCents, proSharePct, ...offer }) => ({
        ...offer,
        earningsCents: proShareCents(priceCents, proSharePct),
      })),
    };
  });

  app.post<{ Params: { id: string }; Body: { startsAt?: string } | undefined }>(
    '/pro/offers/:id/accept',
    {
      preHandler: guards.pro,
      schema: {
        params: uuidParams,
        // A flexible job needs the start the pro picked (D70).
        body: { type: ['object', 'null'], additionalProperties: false, properties: { startsAt: { type: 'string', format: 'date-time' } } },
      },
    },
    async (request) => {
      const proId = currentUser(request).id;
      const chosen = request.body?.startsAt ? new Date(request.body.startsAt) : undefined;
      const bookingId = await acceptOffer(deps(), proId, request.params.id, chosen);
      return { job: await ownJob(proId, bookingId) };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/pro/offers/:id/decline',
    { preHandler: guards.pro, schema: { params: uuidParams } },
    async (request, reply) => {
      await declineOffer(deps(), currentUser(request).id, request.params.id);
      return reply.code(204).send();
    },
  );

  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/pro/jobs',
    {
      preHandler: guards.pro,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' } },
        },
      },
    },
    async (request) => {
      const from = request.query.from ? new Date(request.query.from) : new Date(Date.now() - 24 * 3600 * 1000);
      const to = request.query.to ? new Date(request.query.to) : new Date(Date.now() + 8 * 24 * 3600 * 1000);
      if (to <= from || to.getTime() - from.getTime() > 62 * 24 * 3600 * 1000) {
        throw badRequest('invalid_range');
      }
      const result = await pool.query<{
        id: string;
        status: string;
        serviceName: string;
        startsAt: Date;
        endsAt: Date;
        address: string;
        postcode: string;
        priceCents: number;
        extrasCents: number;
        proSharePct: number;
      }>(
        `SELECT b.id, b.status, b.service_name AS "serviceName", b.starts_at AS "startsAt", b.ends_at AS "endsAt",
           b.address, b.postcode, b.price_cents AS "priceCents", b.pro_share_pct AS "proSharePct",
           COALESCE((SELECT sum(price_cents)::int FROM extra_requests e WHERE e.booking_id = b.id AND e.status = 'approved'), 0)
             AS "extrasCents"
         FROM bookings b
         WHERE b.pro_id = $1 AND b.status IN ('accepted', 'on_the_way', 'working', 'completed')
           AND b.starts_at >= $2 AND b.starts_at < $3
         ORDER BY b.starts_at`,
        [currentUser(request).id, from, to],
      );
      return {
        jobs: result.rows.map(({ priceCents, extrasCents, proSharePct, ...job }) => ({
          ...job,
          earningsCents: proShareCents(priceCents, proSharePct) + proShareCents(extrasCents, proSharePct),
        })),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/pro/jobs/:id',
    { preHandler: guards.pro, schema: { params: uuidParams } },
    async (request) => ({ job: await ownJob(currentUser(request).id, request.params.id) }),
  );

  app.post<{ Params: { id: string }; Body: { status: 'on_the_way' | 'working' } }>(
    '/pro/jobs/:id/status',
    {
      preHandler: guards.pro,
      schema: {
        params: uuidParams,
        body: {
          type: 'object',
          required: ['status'],
          additionalProperties: false,
          properties: { status: { type: 'string', enum: ['on_the_way', 'working'] } },
        },
      },
    },
    async (request) => {
      const pro = currentUser(request);
      const { status } = request.body;
      const waiting = await withTransaction(pool, async (client) => {
        const found = await client.query<{ status: string; customer_id: string; service_name: string; price_cents: number }>(
          'SELECT status, customer_id, service_name, price_cents FROM bookings WHERE id = $1 AND pro_id = $2 FOR UPDATE',
          [request.params.id, pro.id],
        );
        const job = found.rows[0];
        if (!job) {
          throw notFound();
        }
        if (NEXT_STEP[job.status] !== status) {
          throw conflict('invalid_status');
        }
        if (await stoppedAsUnsafe(client, request.params.id, pro.id)) {
          throw conflict('job_stopped');
        }
        await setStatus(client, request.params.id, status);
        if (status === 'on_the_way') {
          await enqueue(client, job.customer_id, 'pro_on_the_way', messages.proOnTheWay(pro.firstName ?? 'Your pro'), {
            link: `/bookings/${request.params.id}`,
          });
          return null;
        }
        // The pro got in: a door report is closed, and waiting at a locked door is paid (D94).
        return closeDoorIssueOnStart(client, {
          bookingId: request.params.id,
          proId: pro.id,
          customerId: job.customer_id,
          serviceName: job.service_name,
          priceCents: job.price_cents,
        });
      });
      if (waiting) {
        const fundedBy = await chargeWaitingTime(deps(), waiting.extraId);
        request.log.info({ event: 'waiting_time_added', bookingId: request.params.id, minutes: waiting.minutes, fundedBy });
      }
      return { job: await ownJob(pro.id, request.params.id) };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/pro/jobs/:id/photos',
    { preHandler: guards.pro, schema: { params: uuidParams } },
    async (request, reply) => {
      const proId = currentUser(request).id;
      const content = await readSingleFile(request);
      await withTransaction(pool, async (client) => {
        const found = await client.query<{ status: string }>(
          'SELECT status FROM bookings WHERE id = $1 AND pro_id = $2 FOR UPDATE',
          [request.params.id, proId],
        );
        const status = found.rows[0]?.status;
        if (!status) {
          throw notFound();
        }
        if (status !== 'working') {
          throw conflict('invalid_status');
        }
        const count = await client.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM booking_photos WHERE booking_id = $1 AND kind = 'completion'",
          [request.params.id],
        );
        if (onlyRow(count).n >= MAX_COMPLETION_PHOTOS) {
          throw conflict('too_many_photos');
        }
        const upload = await storeUpload(client, ctx.storage, { ownerId: proId, kind: 'photo', content });
        await client.query("INSERT INTO booking_photos (upload_id, booking_id, kind) VALUES ($1, $2, 'completion')", [
          upload.id,
          request.params.id,
        ]);
      });
      return reply.code(201).send({ job: await ownJob(proId, request.params.id) });
    },
  );

  // The pro's phone shares where they are while they are on the way, so the customer sees them on a map and
  // when they will arrive (D83). Only the latest position is kept, and it is cleared when the job moves on.
  app.post<{ Params: { id: string }; Body: { lat: number; lng: number; accuracy?: number } }>(
    '/pro/jobs/:id/location',
    {
      preHandler: guards.pro,
      schema: {
        params: uuidParams,
        body: {
          type: 'object',
          required: ['lat', 'lng'],
          additionalProperties: false,
          properties: {
            lat: { type: 'number', minimum: -90, maximum: 90 },
            lng: { type: 'number', minimum: -180, maximum: 180 },
            // Metres, as the phone reports it. Checked, not kept.
            accuracy: { type: 'number', minimum: 0, maximum: 100_000 },
          },
        },
      },
    },
    async (request, reply) => {
      const proId = currentUser(request).id;
      const { lat, lng } = request.body;
      // A point that arrives within 5 seconds of the last one is ignored, so a misbehaving app cannot flood the table.
      const updated = await pool.query(
        `UPDATE bookings SET pro_lat = $3, pro_lng = $4, pro_location_at = now()
         WHERE id = $1 AND pro_id = $2 AND status = 'on_the_way'
           AND (pro_location_at IS NULL OR pro_location_at < now() - interval '5 seconds')`,
        [request.params.id, proId, lat, lng],
      );
      if (!updated.rowCount) {
        const owned = await pool.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1 AND pro_id = $2', [
          request.params.id,
          proId,
        ]);
        if (!owned.rowCount) throw notFound();
        if (owned.rows[0]?.status !== 'on_the_way') throw conflict('invalid_status');
      } else {
        // A new position can make the pro late: the customer is warned once, automatically (D94).
        try {
          await warnIfLate(deps(), request.params.id);
        } catch (error) {
          request.log.error({ event: 'late_warning_failed', bookingId: request.params.id, err: error });
        }
      }
      return reply.code(204).send();
    },
  );

  // The MISK price list the pro picks extra work from (D86).
  app.get<{ Params: { id: string } }>(
    '/pro/jobs/:id/price-list',
    { preHandler: guards.pro, schema: { params: uuidParams } },
    async (request) => {
      await ownJob(currentUser(request).id, request.params.id);
      return { items: await priceList(pool, request.params.id) };
    },
  );

  // Extra work from the MISK price list (D86, replacing D83's free text): the name, price and length are
  // the server's, never the app's. The customer approves it before anything is charged.
  app.post<{ Params: { id: string }; Body: { itemId: string; note?: string } }>(
    '/pro/jobs/:id/extras',
    {
      preHandler: guards.pro,
      schema: {
        params: uuidParams,
        body: {
          type: 'object',
          required: ['itemId'],
          additionalProperties: false,
          properties: {
            itemId: { type: 'string', minLength: 1, maxLength: 60, pattern: '^(service:[0-9a-f-]{36}|time:[0-9]{1,3})$' },
            note: { type: 'string', maxLength: EXTRA_NOTE_MAX },
          },
        },
      },
    },
    async (request, reply) => {
      const proId = currentUser(request).id;
      const note = request.body.note?.trim() || null;
      await withTransaction(pool, async (client) => {
        const found = await client.query<{ status: string; customer_id: string }>(
          'SELECT status, customer_id FROM bookings WHERE id = $1 AND pro_id = $2 FOR UPDATE',
          [request.params.id, proId],
        );
        const job = found.rows[0];
        if (!job) {
          throw notFound();
        }
        if (!['accepted', 'on_the_way', 'working'].includes(job.status)) {
          throw conflict('invalid_status');
        }
        const open = await client.query(
          "SELECT 1 FROM extra_requests WHERE booking_id = $1 AND kind = 'work' AND status IN ('pending', 'awaiting_payment')",
          [request.params.id],
        );
        if (open.rowCount) {
          throw conflict('extra_already_pending');
        }
        const item = (await priceList(client, request.params.id)).find((entry) => entry.id === request.body.itemId);
        if (!item) {
          throw badRequest('unknown_price_item');
        }
        await client.query(
          `INSERT INTO extra_requests (booking_id, description, price_cents, duration_minutes, price_item, note)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [request.params.id, item.name, item.priceCents, item.durationMinutes, item.id, note],
        );
        await enqueue(client, job.customer_id, 'extra_requested', messages.extraRequested(item.name, item.priceCents));
      });
      request.log.info({ event: 'extra_requested', bookingId: request.params.id, item: request.body.itemId });
      return reply.code(201).send({ job: await ownJob(proId, request.params.id) });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/pro/jobs/:id/complete',
    { preHandler: guards.pro, schema: { params: uuidParams } },
    async (request) => {
      const proId = currentUser(request).id;
      await withTransaction(pool, async (client) => {
        const found = await client.query<{ status: string; customer_id: string; service_name: string }>(
          'SELECT status, customer_id, service_name FROM bookings WHERE id = $1 AND pro_id = $2 FOR UPDATE',
          [request.params.id, proId],
        );
        const job = found.rows[0];
        if (!job) {
          throw notFound();
        }
        if (job.status !== 'working') {
          throw conflict('invalid_status');
        }
        if (await stoppedAsUnsafe(client, request.params.id, proId)) {
          throw conflict('job_stopped');
        }
        const photos = await client.query(
          "SELECT 1 FROM booking_photos WHERE booking_id = $1 AND kind = 'completion' LIMIT 1",
          [request.params.id],
        );
        if (!photos.rowCount) {
          throw conflict('photos_required');
        }
        // Unanswered extra work is dropped: nothing is charged without the customer's approval.
        await client.query(
          `UPDATE extra_requests SET status = 'cancelled', decided_at = now()
           WHERE booking_id = $1 AND kind = 'work' AND status IN ('pending', 'awaiting_payment')`,
          [request.params.id],
        );
        await setStatus(client, request.params.id, 'completed', ', completed_at = now()');
        await enqueue(client, job.customer_id, 'job_completed', messages.jobCompleted(job.service_name));
      });
      // The card is charged 24 hours from now by the settlement worker, unless the customer reports a problem.
      request.log.info({ event: 'job_completed', bookingId: request.params.id, proId });
      return { job: await ownJob(proId, request.params.id) };
    },
  );
}
