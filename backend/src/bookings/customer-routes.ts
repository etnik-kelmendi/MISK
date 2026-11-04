import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import { jobPriceCents, type JobSize } from '../catalogue/pricing.js';
import { normalizePostcode } from '../catalogue/routes.js';
import type { AppContext } from '../context.js';
import { onlyRow, withTransaction } from '../db.js';
import { ApiError, badRequest, conflict, notFound } from '../errors.js';
import { isUniqueViolation, uuidParams } from '../http.js';
import { readSingleFile, storeUpload } from '../uploads/uploads.js';
import { findSlots } from './availability.js';
import { setStatus, type BookingDeps } from './events.js';
import { cancelBooking, confirmHold } from './lifecycle.js';
import { loadBooking } from './views.js';

export const MAX_CUSTOMER_PHOTOS = 3;
export const RATING_TAGS = ['on_time', 'tidy', 'friendly', 'great_value', 'extra_mile'] as const;

interface ServiceRow {
  id: string;
  categoryId: string;
  name: string;
  priceCents: number;
  durationMinutes: number;
  sizeSmallPct: number;
  sizeMediumPct: number;
  sizeLargePct: number;
}

interface BookingBody {
  serviceId: string;
  size: JobSize;
  address: string;
  postcode: string;
  notes?: string;
  startsAt: string;
}

const paymentUnavailable = () => new ApiError(502, 'payment_unavailable');

export async function customerBookingRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards, gateway } = ctx;
  const deps = (): BookingDeps => ({ pool, gateway, config: ctx.config, log: app.log });

  async function activeService(serviceId: string): Promise<ServiceRow> {
    const found = await pool.query<ServiceRow>(
      `SELECT s.id, s.category_id AS "categoryId", s.name, s.price_cents AS "priceCents",
         s.duration_minutes AS "durationMinutes", s.size_small_pct AS "sizeSmallPct",
         s.size_medium_pct AS "sizeMediumPct", s.size_large_pct AS "sizeLargePct"
       FROM services s JOIN categories c ON c.id = s.category_id
       WHERE s.id = $1 AND s.active AND c.active`,
      [serviceId],
    );
    if (!found.rows[0]) {
      throw notFound('service_not_found');
    }
    return found.rows[0];
  }

  async function servedPostcode(input: string): Promise<string> {
    const code = normalizePostcode(input);
    const found = await pool.query('SELECT 1 FROM postcodes WHERE code = $1 AND active', [code]);
    if (!found.rowCount) {
      throw badRequest('postcode_not_served');
    }
    return code;
  }

  /** Loads a booking only when it belongs to the signed-in customer. */
  async function ownBooking(customerId: string, bookingId: string) {
    const booking = await loadBooking(pool, bookingId, 'customer');
    const owner = await pool.query('SELECT 1 FROM bookings WHERE id = $1 AND customer_id = $2', [bookingId, customerId]);
    if (!booking || !owner.rowCount) {
      throw notFound();
    }
    return booking;
  }

  app.get<{ Querystring: { serviceId: string; postcode: string } }>(
    '/availability',
    {
      preHandler: guards.customer,
      schema: {
        querystring: {
          type: 'object',
          required: ['serviceId', 'postcode'],
          additionalProperties: false,
          properties: {
            serviceId: { type: 'string', format: 'uuid' },
            postcode: { type: 'string', minLength: 2, maxLength: 10 },
          },
        },
      },
    },
    async (request) => {
      const service = await activeService(request.query.serviceId);
      const postcode = await servedPostcode(request.query.postcode);
      const slots = await findSlots(pool, {
        categoryId: service.categoryId,
        postcode,
        durationMinutes: service.durationMinutes,
        timezone: ctx.config.timezone,
      });
      return { timezone: ctx.config.timezone, slots };
    },
  );

  app.post<{ Body: BookingBody }>(
    '/bookings',
    {
      preHandler: guards.customer,
      schema: {
        body: {
          type: 'object',
          required: ['serviceId', 'size', 'address', 'postcode', 'startsAt'],
          additionalProperties: false,
          properties: {
            serviceId: { type: 'string', format: 'uuid' },
            size: { type: 'string', enum: ['S', 'M', 'L'] },
            address: { type: 'string', minLength: 3, maxLength: 200, pattern: '\\S' },
            postcode: { type: 'string', minLength: 2, maxLength: 10 },
            notes: { type: 'string', maxLength: 1000 },
            startsAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request, reply) => {
      const customer = currentUser(request);
      const body = request.body;
      const service = await activeService(body.serviceId);
      const postcode = await servedPostcode(body.postcode);
      const startsAt = new Date(body.startsAt);
      const priceCents = jobPriceCents(service, body.size);

      const created = await withTransaction(pool, async (client) => {
        // One booking per trade at a time, so two customers cannot both take the last free pro.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`book:${service.categoryId}`]);
        const [slot] = await findSlots(
          client,
          { categoryId: service.categoryId, postcode, durationMinutes: service.durationMinutes, timezone: ctx.config.timezone },
          startsAt,
        );
        if (!slot?.available) {
          throw conflict('slot_unavailable');
        }
        const settings = await client.query<{ fee: number; share: number }>(
          'SELECT service_fee_cents AS fee, pro_share_pct AS share FROM settings',
        );
        const { fee, share } = onlyRow(settings);
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO bookings (customer_id, service_id, category_id, service_name, size, address, postcode, notes,
             starts_at, ends_at, price_cents, fee_cents, pro_share_pct)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
          [
            customer.id,
            service.id,
            service.categoryId,
            service.name,
            body.size,
            body.address.trim(),
            postcode,
            body.notes?.trim() ?? '',
            slot.startsAt,
            slot.endsAt,
            priceCents,
            fee,
            share,
          ],
        );
        const id = onlyRow(inserted).id;
        await client.query('INSERT INTO booking_events (booking_id, status) VALUES ($1, $2)', [id, 'awaiting_payment']);
        return { id, totalCents: priceCents + fee };
      });

      // The payment provider is called outside the transaction, so a slow provider never holds locks.
      let clientSecret: string | null;
      try {
        const existing = await pool.query<{ stripe_customer_id: string | null }>(
          'SELECT stripe_customer_id FROM users WHERE id = $1',
          [customer.id],
        );
        const customerRef = await gateway.ensureCustomer({
          userId: customer.id,
          existing: existing.rows[0]?.stripe_customer_id ?? null,
        });
        await pool.query('UPDATE users SET stripe_customer_id = $2 WHERE id = $1 AND stripe_customer_id IS NULL', [
          customer.id,
          customerRef,
        ]);
        const hold = await gateway.createHold({
          customerRef,
          amountCents: created.totalCents,
          description: `MISK ${service.name}`,
          idempotencyKey: `booking-${created.id}`,
          metadata: { bookingId: created.id },
        });
        await pool.query('UPDATE bookings SET payment_intent_id = $2 WHERE id = $1', [created.id, hold.intentId]);
        clientSecret = hold.clientSecret;
        if (hold.held) {
          await confirmHold(deps(), hold.intentId);
        }
      } catch (error) {
        request.log.error({ event: 'payment_start_failed', bookingId: created.id, err: error });
        await withTransaction(pool, (client) => setStatus(client, created.id, 'cancelled', ", cancelled_by = 'system'"));
        throw paymentUnavailable();
      }

      request.log.info({ event: 'booking_created', bookingId: created.id, customerId: customer.id });
      return reply.code(201).send({
        booking: await loadBooking(pool, created.id, 'customer'),
        payment: clientSecret ? { clientSecret, publishableKey: gateway.publishableKey } : null,
      });
    },
  );

  app.get('/bookings', { preHandler: guards.customer }, async (request) => {
    const result = await pool.query(
      `SELECT b.id, b.status, b.service_name AS "serviceName", b.category_id AS "categoryId", b.starts_at AS "startsAt",
         b.price_cents + b.fee_cents AS "totalCents", pu.first_name AS "proName",
         (b.status = 'completed' AND NOT EXISTS (SELECT 1 FROM ratings r WHERE r.booking_id = b.id)) AS "canRate"
       FROM bookings b LEFT JOIN users pu ON pu.id = b.pro_id
       WHERE b.customer_id = $1
       ORDER BY (b.status IN ('completed', 'cancelled')), b.starts_at DESC
       LIMIT 200`,
      [currentUser(request).id],
    );
    return { bookings: result.rows };
  });

  app.get<{ Params: { id: string } }>(
    '/bookings/:id',
    { preHandler: guards.customer, schema: { params: uuidParams } },
    async (request) => ({ booking: await ownBooking(currentUser(request).id, request.params.id) }),
  );

  app.get<{ Params: { id: string } }>(
    '/bookings/:id/payment',
    { preHandler: guards.customer, schema: { params: uuidParams } },
    async (request) => {
      const found = await pool.query<{ payment_intent_id: string | null; status: string }>(
        'SELECT payment_intent_id, status FROM bookings WHERE id = $1 AND customer_id = $2',
        [request.params.id, currentUser(request).id],
      );
      const booking = found.rows[0];
      if (!booking) {
        throw notFound();
      }
      if (booking.status !== 'awaiting_payment' || !booking.payment_intent_id) {
        return { payment: null };
      }
      const clientSecret = await gateway.clientSecretFor(booking.payment_intent_id);
      return { payment: clientSecret ? { clientSecret, publishableKey: gateway.publishableKey } : null };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/bookings/:id/photos',
    { preHandler: guards.customer, schema: { params: uuidParams } },
    async (request, reply) => {
      const customerId = currentUser(request).id;
      const content = await readSingleFile(request);
      await withTransaction(pool, async (client) => {
        const found = await client.query<{ status: string }>(
          'SELECT status FROM bookings WHERE id = $1 AND customer_id = $2 FOR UPDATE',
          [request.params.id, customerId],
        );
        const status = found.rows[0]?.status;
        if (!status) {
          throw notFound();
        }
        if (status === 'completed' || status === 'cancelled') {
          throw conflict('invalid_status');
        }
        const count = await client.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM booking_photos WHERE booking_id = $1 AND kind = 'customer'",
          [request.params.id],
        );
        if (onlyRow(count).n >= MAX_CUSTOMER_PHOTOS) {
          throw conflict('too_many_photos');
        }
        const upload = await storeUpload(client, ctx.storage, { ownerId: customerId, kind: 'photo', content });
        await client.query("INSERT INTO booking_photos (upload_id, booking_id, kind) VALUES ($1, $2, 'customer')", [
          upload.id,
          request.params.id,
        ]);
      });
      return reply.code(201).send({ booking: await ownBooking(customerId, request.params.id) });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/bookings/:id/cancel',
    { preHandler: guards.customer, schema: { params: uuidParams } },
    async (request) => {
      const customerId = currentUser(request).id;
      await cancelBooking(deps(), request.params.id, 'customer', customerId);
      return { booking: await ownBooking(customerId, request.params.id) };
    },
  );

  const extraParams = {
    type: 'object',
    properties: { id: { type: 'string', format: 'uuid' }, extraId: { type: 'string', format: 'uuid' } },
  } as const;

  app.post<{ Params: { id: string; extraId: string } }>(
    '/bookings/:id/extras/:extraId/approve',
    { preHandler: guards.customer, schema: { params: extraParams } },
    async (request) => {
      const customerId = currentUser(request).id;
      const found = await pool.query<{
        price_cents: number;
        description: string;
        booking_intent: string | null;
        stripe_customer_id: string | null;
      }>(
        `UPDATE extra_requests e SET status = 'awaiting_payment', payment_status = 'pending'
         FROM bookings b JOIN users u ON u.id = b.customer_id
         WHERE e.id = $1 AND e.booking_id = $2 AND b.id = e.booking_id AND b.customer_id = $3
           AND e.status = 'pending' AND b.status IN ('accepted', 'on_the_way', 'working')
         RETURNING e.price_cents, e.description, b.payment_intent_id AS booking_intent, u.stripe_customer_id`,
        [request.params.extraId, request.params.id, customerId],
      );
      const extra = found.rows[0];
      if (!extra) {
        throw conflict('extra_not_pending');
      }
      let clientSecret: string | null = null;
      try {
        if (!extra.booking_intent || !extra.stripe_customer_id) {
          throw new Error('Booking has no saved card');
        }
        const hold = await gateway.holdOnSavedCard({
          customerRef: extra.stripe_customer_id,
          fromIntentId: extra.booking_intent,
          amountCents: extra.price_cents,
          description: `MISK extra: ${extra.description}`,
          // A new key per attempt, so a refused card can be tried again.
          idempotencyKey: `extra-${request.params.extraId}-${Date.now()}`,
          metadata: { bookingId: request.params.id, extraId: request.params.extraId },
        });
        await pool.query('UPDATE extra_requests SET payment_intent_id = $2 WHERE id = $1', [
          request.params.extraId,
          hold.intentId,
        ]);
        clientSecret = hold.clientSecret;
        if (hold.held) {
          await confirmHold(deps(), hold.intentId);
        }
      } catch (error) {
        request.log.error({ event: 'extra_hold_failed', extraId: request.params.extraId, err: error });
        await pool.query(
          "UPDATE extra_requests SET status = 'pending', payment_status = 'failed' WHERE id = $1 AND status = 'awaiting_payment'",
          [request.params.extraId],
        );
        throw paymentUnavailable();
      }
      return {
        booking: await ownBooking(customerId, request.params.id),
        payment: clientSecret ? { clientSecret, publishableKey: gateway.publishableKey } : null,
      };
    },
  );

  app.post<{ Params: { id: string; extraId: string } }>(
    '/bookings/:id/extras/:extraId/decline',
    { preHandler: guards.customer, schema: { params: extraParams } },
    async (request) => {
      const customerId = currentUser(request).id;
      const declined = await pool.query(
        `UPDATE extra_requests e SET status = 'declined', decided_at = now()
         FROM bookings b
         WHERE e.id = $1 AND e.booking_id = $2 AND b.id = e.booking_id AND b.customer_id = $3 AND e.status = 'pending'`,
        [request.params.extraId, request.params.id, customerId],
      );
      if (!declined.rowCount) {
        throw conflict('extra_not_pending');
      }
      return { booking: await ownBooking(customerId, request.params.id) };
    },
  );

  app.post<{ Params: { id: string }; Body: { stars: number; tags?: string[] } }>(
    '/bookings/:id/rating',
    {
      preHandler: guards.customer,
      schema: {
        params: uuidParams,
        body: {
          type: 'object',
          required: ['stars'],
          additionalProperties: false,
          properties: {
            stars: { type: 'integer', minimum: 1, maximum: 5 },
            tags: { type: 'array', uniqueItems: true, maxItems: 5, items: { type: 'string', enum: RATING_TAGS } },
          },
        },
      },
    },
    async (request, reply) => {
      const customerId = currentUser(request).id;
      try {
        const inserted = await pool.query(
          `INSERT INTO ratings (booking_id, pro_id, customer_id, stars, tags)
           SELECT id, pro_id, customer_id, $3, $4 FROM bookings
           WHERE id = $1 AND customer_id = $2 AND status = 'completed'`,
          [request.params.id, customerId, request.body.stars, request.body.tags ?? []],
        );
        if (!inserted.rowCount) {
          throw conflict('not_ratable');
        }
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict('already_rated');
        }
        throw error;
      }
      return reply.code(201).send({ booking: await ownBooking(customerId, request.params.id) });
    },
  );
}
