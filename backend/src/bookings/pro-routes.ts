import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import { proShareCents } from '../catalogue/pricing.js';
import type { AppContext } from '../context.js';
import { onlyRow, withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { uuidParams } from '../http.js';
import { messages } from '../notifications/messages.js';
import { enqueue } from '../notifications/outbox.js';
import { readSingleFile, storeUpload } from '../uploads/uploads.js';
import { acceptOffer, declineOffer } from './dispatch.js';
import { setStatus, type BookingDeps } from './events.js';
import { settleBooking } from './lifecycle.js';
import { loadBooking } from './views.js';

export const MAX_COMPLETION_PHOTOS = 6;
const NEXT_STEP: Record<string, string> = { accepted: 'on_the_way', on_the_way: 'working' };

export async function proJobRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards } = ctx;
  const deps = (): BookingDeps => ({ pool, gateway: ctx.gateway, config: ctx.config, log: app.log });

  /** Loads a job only when it is assigned to the signed-in pro. */
  async function ownJob(proId: string, bookingId: string) {
    const owned = await pool.query('SELECT 1 FROM bookings WHERE id = $1 AND pro_id = $2', [bookingId, proId]);
    const job = owned.rowCount ? await loadBooking(pool, bookingId, 'pro') : null;
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
      priceCents: number;
      proSharePct: number;
      distanceKm: number | null;
      photoIds: string[];
    }>(
      `SELECT o.id, o.booking_id AS "bookingId", o.expires_at AS "expiresAt", b.service_name AS "serviceName", b.size,
         b.starts_at AS "startsAt", b.ends_at AS "endsAt", b.address, b.postcode, b.notes,
         cu.first_name AS "customerName", b.price_cents AS "priceCents", b.pro_share_pct AS "proSharePct",
         (SELECT round(distance_km(home.lat, home.lng, dest.lat, dest.lng)::numeric, 1)::float
          FROM pro_profiles p, postcodes home, postcodes dest
          WHERE p.user_id = o.pro_id AND home.code = p.home_postcode AND dest.code = b.postcode) AS "distanceKm",
         COALESCE((SELECT array_agg(ph.upload_id ORDER BY ph.created_at) FROM booking_photos ph
                   WHERE ph.booking_id = b.id), '{}') AS "photoIds"
       FROM booking_offers o JOIN bookings b ON b.id = o.booking_id JOIN users cu ON cu.id = b.customer_id
       WHERE o.pro_id = $1 AND o.status = 'pending' AND o.expires_at > now() AND b.status = 'searching'
       ORDER BY o.expires_at`,
      [proId],
    );
    return {
      offers: result.rows.map(({ priceCents, proSharePct, ...offer }) => ({
        ...offer,
        earningsCents: proShareCents(priceCents, proSharePct),
      })),
    };
  });

  app.post<{ Params: { id: string } }>(
    '/pro/offers/:id/accept',
    { preHandler: guards.pro, schema: { params: uuidParams } },
    async (request) => {
      const proId = currentUser(request).id;
      const bookingId = await acceptOffer(deps(), proId, request.params.id);
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
      await withTransaction(pool, async (client) => {
        const found = await client.query<{ status: string; customer_id: string }>(
          'SELECT status, customer_id FROM bookings WHERE id = $1 AND pro_id = $2 FOR UPDATE',
          [request.params.id, pro.id],
        );
        const job = found.rows[0];
        if (!job) {
          throw notFound();
        }
        if (NEXT_STEP[job.status] !== status) {
          throw conflict('invalid_status');
        }
        await setStatus(client, request.params.id, status);
        if (status === 'on_the_way') {
          await enqueue(client, job.customer_id, 'pro_on_the_way', messages.proOnTheWay(pro.firstName ?? 'Your pro'));
        }
      });
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

  app.post<{ Params: { id: string }; Body: { description: string; priceCents: number } }>(
    '/pro/jobs/:id/extras',
    {
      preHandler: guards.pro,
      schema: {
        params: uuidParams,
        body: {
          type: 'object',
          required: ['description', 'priceCents'],
          additionalProperties: false,
          properties: {
            description: { type: 'string', minLength: 3, maxLength: 200, pattern: '\\S' },
            priceCents: { type: 'integer', minimum: 100, maximum: 100_000 },
          },
        },
      },
    },
    async (request, reply) => {
      const proId = currentUser(request).id;
      const description = request.body.description.trim();
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
          "SELECT 1 FROM extra_requests WHERE booking_id = $1 AND status IN ('pending', 'awaiting_payment')",
          [request.params.id],
        );
        if (open.rowCount) {
          throw conflict('extra_already_pending');
        }
        await client.query('INSERT INTO extra_requests (booking_id, description, price_cents) VALUES ($1, $2, $3)', [
          request.params.id,
          description,
          request.body.priceCents,
        ]);
        await enqueue(client, job.customer_id, 'extra_requested', messages.extraRequested(description, request.body.priceCents));
      });
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
           WHERE booking_id = $1 AND status IN ('pending', 'awaiting_payment')`,
          [request.params.id],
        );
        await setStatus(client, request.params.id, 'completed', ', completed_at = now()');
        await enqueue(client, job.customer_id, 'job_completed', messages.jobCompleted(job.service_name));
      });
      request.log.info({ event: 'job_completed', bookingId: request.params.id, proId });
      try {
        await settleBooking(deps(), request.params.id);
      } catch (error) {
        // The job is done either way; the settlement worker finishes the payment.
        request.log.error({ event: 'settle_failed', bookingId: request.params.id, err: error });
      }
      return { job: await ownJob(proId, request.params.id) };
    },
  );

  app.get('/pro/earnings', { preHandler: guards.pro }, async (request) => {
    const result = await pool.query<{ sentCents: number; pendingCents: number; last30Cents: number }>(
      `SELECT
         COALESCE(sum(amount_cents) FILTER (WHERE status = 'sent'), 0)::int AS "sentCents",
         COALESCE(sum(amount_cents) FILTER (WHERE status IN ('pending', 'failed')), 0)::int AS "pendingCents",
         COALESCE(sum(amount_cents) FILTER (WHERE created_at > now() - interval '30 days'), 0)::int AS "last30Cents"
       FROM payouts WHERE pro_id = $1`,
      [currentUser(request).id],
    );
    return { earnings: result.rows[0] };
  });
}
