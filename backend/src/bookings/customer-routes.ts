import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import { MAX_PACKAGE_SERVICES, packagePrice, proShareCents, type JobSize } from '../catalogue/pricing.js';
import { normalizePostcode } from '../catalogue/routes.js';
import type { AppContext } from '../context.js';
import { onlyRow, withTransaction } from '../db.js';
import { ApiError, badRequest, conflict, notFound } from '../errors.js';
import { isUniqueViolation, uuidParams } from '../http.js';
import { readSingleFile, storeUpload } from '../uploads/uploads.js';
import {
  FLEXIBLE_CONFIRM_HOUR,
  FLEXIBLE_WINDOWS,
  findSlots,
  windowSlots,
  type FlexibleWindow,
  type Slot,
} from './availability.js';
import { setStatus, type BookingDeps } from './events.js';
import { cancelBooking, CHARGE_DELAY_HOURS, confirmHold, settleBooking } from './lifecycle.js';
import { loadBooking } from './views.js';
import { heldFor, waitlistFor } from './time-waitlist.js';

export const MAX_CUSTOMER_PHOTOS = 3;
/** Photos a customer can add to a problem report. */
export const MAX_PROBLEM_PHOTOS = 5;
export const RATING_TAGS = ['on_time', 'tidy', 'friendly', 'great_value', 'extra_mile'] as const;

/** Tips from €1 to €200. */
export const MIN_TIP_CENTS = 100;
export const MAX_TIP_CENTS = 20_000;

interface ServiceRow {
  id: string;
  categoryId: string;
  name: string;
  priceCents: number;
  durationMinutes: number;
  sizeSmallPct: number;
  sizeMediumPct: number;
  sizeLargePct: number;
  pricing: 'fixed' | 'hourly';
}

interface BookingBody {
  /** One service (older apps) or several of one trade in `serviceIds` (D68). */
  serviceId?: string;
  serviceIds?: string[];
  size: JobSize;
  address: string;
  postcode: string;
  notes?: string;
  /** A fixed start, or for a flexible booking `flexibleWindow` on `day` (D70). */
  startsAt?: string;
  flexibleWindow?: FlexibleWindow;
  /** How the customer pays (D73); without it, a new card in the browser. */
  paymentMethod?: { type: PaymentChoice; cardId?: string };
  day?: string;
}

const paymentUnavailable = () => new ApiError(502, 'payment_unavailable');
/** The ways to pay on Review & pay (D73). */
export const PAYMENT_CHOICES = ['card', 'new_card', 'apple_pay', 'google_pay'] as const;
export type PaymentChoice = (typeof PAYMENT_CHOICES)[number];
/** Comma-separated service ids in a query string (D68). */
const UUID_LIST = '^[0-9a-fA-F-]{36}(,[0-9a-fA-F-]{36})*$';

export async function customerBookingRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards, gateway } = ctx;
  const deps = (): BookingDeps => ({ pool, gateway, config: ctx.config, log: app.log });

  async function activeService(serviceId: string): Promise<ServiceRow> {
    const found = await pool.query<ServiceRow>(
      `SELECT s.id, s.category_id AS "categoryId", s.name, s.price_cents AS "priceCents",
         s.duration_minutes AS "durationMinutes", s.size_small_pct AS "sizeSmallPct",
         s.size_medium_pct AS "sizeMediumPct", s.size_large_pct AS "sizeLargePct", s.pricing
       FROM services s JOIN categories c ON c.id = s.category_id
       WHERE s.id = $1 AND s.active AND c.active`,
      [serviceId],
    );
    if (!found.rows[0]) {
      throw notFound('service_not_found');
    }
    return found.rows[0];
  }

  /**
   * The services of one visit, in the order chosen: all active, all of one trade (D68). An empty or
   * mixed list is refused.
   */
  async function activeServices(ids: string[]): Promise<[ServiceRow, ...ServiceRow[]]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0 || unique.length > MAX_PACKAGE_SERVICES) {
      throw badRequest('invalid_services');
    }
    const services = await Promise.all(unique.map((id) => activeService(id)));
    const [first, ...rest] = services;
    if (!first) throw badRequest('invalid_services');
    if (rest.some((service) => service.categoryId !== first.categoryId)) {
      throw badRequest('services_mixed_trades');
    }
    return [first, ...rest];
  }

  /** The services a request names, from `serviceIds` or the older single `serviceId`. */
  function requestedServices(input: { serviceId?: string; serviceIds?: string[] | string }): string[] {
    if (input.serviceIds !== undefined) {
      return Array.isArray(input.serviceIds) ? input.serviceIds : input.serviceIds.split(',');
    }
    if (input.serviceId) return [input.serviceId];
    throw badRequest('invalid_services');
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

  app.get<{ Querystring: { serviceId?: string; serviceIds?: string; postcode: string } }>(
    '/availability',
    {
      preHandler: guards.customer,
      schema: {
        querystring: {
          type: 'object',
          required: ['postcode'],
          additionalProperties: false,
          properties: {
            serviceId: { type: 'string', format: 'uuid' },
            // Several services of one visit, comma-separated (D68).
            serviceIds: { type: 'string', pattern: UUID_LIST, maxLength: 400 },
            postcode: { type: 'string', minLength: 2, maxLength: 10 },
          },
        },
      },
    },
    async (request) => {
      const services = await activeServices(requestedServices(request.query));
      const postcode = await servedPostcode(request.query.postcode);
      const slots = await findSlots(pool, {
        categoryId: services[0].categoryId,
        postcode,
        durationMinutes: packagePrice(services, 'M').durationMinutes,
        timezone: ctx.config.timezone,
        customerId: currentUser(request).id,
      });
      // The times (or days) this customer waits for in this trade (D70).
      const waitlist = await waitlistFor(pool, currentUser(request).id, services[0].categoryId, postcode);
      // Times held for this customer because they waited for them (D74).
      const held = await heldFor(pool, currentUser(request).id, services[0].categoryId, postcode);
      return { timezone: ctx.config.timezone, slots, waitlist, held };
    },
  );

  app.post<{ Body: BookingBody }>(
    '/bookings',
    {
      preHandler: guards.customer,
      schema: {
        body: {
          type: 'object',
          required: ['size', 'address', 'postcode'],
          additionalProperties: false,
          properties: {
            serviceId: { type: 'string', format: 'uuid' },
            serviceIds: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_PACKAGE_SERVICES,
              uniqueItems: true,
              items: { type: 'string', format: 'uuid' },
            },
            size: { type: 'string', enum: ['S', 'M', 'L'] },
            address: { type: 'string', minLength: 3, maxLength: 200, pattern: '\\S' },
            postcode: { type: 'string', minLength: 2, maxLength: 10 },
            notes: { type: 'string', maxLength: 1000 },
            startsAt: { type: 'string', format: 'date-time' },
            flexibleWindow: { type: 'string', enum: FLEXIBLE_WINDOWS },
            day: { type: 'string', format: 'date' },
            paymentMethod: {
              type: 'object',
              required: ['type'],
              additionalProperties: false,
              properties: {
                type: { type: 'string', enum: PAYMENT_CHOICES },
                cardId: { type: 'string', minLength: 1, maxLength: 255 },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const customer = currentUser(request);
      const body = request.body;
      const services = await activeServices(requestedServices(body));
      const service = services[0];
      const postcode = await servedPostcode(body.postcode);
      // Either a fixed time, or a window on a day for a flexible booking.
      const flexible = body.flexibleWindow && body.day ? { window: body.flexibleWindow, day: body.day } : null;
      if (!flexible && !body.startsAt) {
        throw badRequest('time_missing');
      }
      // A saved card must be one of this customer's cards; checked before anything is booked (D73).
      const choice: PaymentChoice = body.paymentMethod?.type ?? 'new_card';
      const cardId = choice === 'card' ? (body.paymentMethod?.cardId ?? null) : null;
      if (choice === 'card') {
        if (!cardId) throw badRequest('card_not_found');
        const owner = await pool.query<{ ref: string | null }>('SELECT stripe_customer_id AS ref FROM users WHERE id = $1', [customer.id]);
        const ref = owner.rows[0]?.ref ?? null;
        let cards: { id: string }[] = [];
        try {
          cards = ref ? await gateway.listCards(ref) : [];
        } catch (error) {
          request.log.error({ event: 'card_list_failed', err: error });
          throw paymentUnavailable();
        }
        if (!cards.some((card) => card.id === cardId)) throw badRequest('card_not_found');
      }
      const price = packagePrice(services, body.size);
      const priceCents = price.jobCents;
      const serviceName = services.map((s) => s.name).join(' + ');

      const created = await withTransaction(pool, async (client) => {
        // One booking per trade at a time, so two customers cannot both take the last free pro.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`book:${service.categoryId}`]);
        const query = {
          categoryId: service.categoryId,
          postcode,
          durationMinutes: price.durationMinutes,
          timezone: ctx.config.timezone,
          customerId: customer.id,
        };
        let slot: Slot;
        let confirmBy: Date | null = null;
        if (flexible) {
          const deadline = await client.query<{ confirmBy: Date; open: boolean }>(
            `SELECT (($1::date - 1) + make_interval(hours => $2)) AT TIME ZONE $3 AS "confirmBy",
               (($1::date - 1) + make_interval(hours => $2)) AT TIME ZONE $3 > now() AS open`,
            [flexible.day, FLEXIBLE_CONFIRM_HOUR, ctx.config.timezone],
          );
          // A pro needs until the evening before to pick the time, so flexible jobs start tomorrow at the earliest.
          if (!onlyRow(deadline).open) {
            throw conflict('too_late_for_flexible');
          }
          confirmBy = onlyRow(deadline).confirmBy;
          // The booking covers every start in the window until a pro picks one (D70).
          const starts = windowSlots(await findSlots(client, query), flexible.day, flexible.window, ctx.config.timezone);
          const first = starts[0];
          const last = starts.at(-1);
          if (!first || !last || !starts.some((s) => s.available)) {
            throw conflict('slot_unavailable');
          }
          slot = { startsAt: first.startsAt, endsAt: last.endsAt, freePros: 0, available: true };
        } else {
          const [fixed] = await findSlots(client, query, new Date(body.startsAt ?? ''));
          if (!fixed?.available) {
            throw conflict('slot_unavailable');
          }
          slot = fixed;
        }
        const settings = await client.query<{ fee: number; share: number }>(
          'SELECT service_fee_cents AS fee, pro_share_pct AS share FROM settings',
        );
        const { fee, share } = onlyRow(settings);
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO bookings (customer_id, service_id, category_id, service_name, size, address, postcode, notes,
             starts_at, ends_at, price_cents, fee_cents, pro_share_pct, package_discount_cents, flexible_window, confirm_by,
             payment_choice, payment_card_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id`,
          [
            customer.id,
            service.id,
            service.categoryId,
            serviceName,
            body.size,
            body.address.trim(),
            postcode,
            body.notes?.trim() ?? '',
            slot.startsAt,
            slot.endsAt,
            priceCents,
            fee,
            share,
            price.discountCents,
            flexible?.window ?? null,
            confirmBy,
            choice,
            cardId,
          ],
        );
        const id = onlyRow(inserted).id;
        // Booking in a trade ends the customer's holds there, so others can have those times again (D74).
        await client.query('DELETE FROM slot_holds WHERE customer_id = $1 AND category_id = $2', [customer.id, service.categoryId]);
        await client.query(
          `INSERT INTO booking_services (booking_id, position, service_id, name, price_cents, duration_minutes)
           SELECT $1, ord - 1, x.service_id, x.name, x.price_cents, x.duration_minutes
           FROM unnest($2::uuid[], $3::text[], $4::int[], $5::int[]) WITH ORDINALITY
             AS x(service_id, name, price_cents, duration_minutes, ord)`,
          [id, services.map((s) => s.id), services.map((s) => s.name), price.lines, services.map((s) => s.durationMinutes)],
        );
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
          description: `MISK ${serviceName}`.slice(0, 200),
          idempotencyKey: `booking-${created.id}`,
          metadata: { bookingId: created.id },
          ...(cardId ? { paymentMethodId: cardId } : {}),
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

  // Review & pay (D73): the customer's saved cards and how they paid last time, which starts selected.
  app.get('/payment-methods', { preHandler: guards.customer }, async (request) => {
    const customerId = currentUser(request).id;
    const owner = await pool.query<{ ref: string | null }>('SELECT stripe_customer_id AS ref FROM users WHERE id = $1', [customerId]);
    const ref = owner.rows[0]?.ref ?? null;
    let cards: Awaited<ReturnType<typeof gateway.listCards>> = [];
    let cardsAvailable = true;
    if (ref) {
      try {
        cards = await gateway.listCards(ref);
      } catch (error) {
        // The page still offers a new card and wallets; the saved cards are just not listed this time.
        request.log.error({ event: 'card_list_failed', err: error });
        cardsAvailable = false;
      }
    }
    const last = await pool.query<{ choice: PaymentChoice; cardId: string | null }>(
      `SELECT payment_choice AS choice, payment_card_id AS "cardId" FROM bookings
       WHERE customer_id = $1 AND payment_choice IS NOT NULL AND payment_status IN ('held', 'captured', 'released', 'refunded')
       ORDER BY created_at DESC LIMIT 1`,
      [customerId],
    );
    return { cards, cardsAvailable, last: last.rows[0] ?? null, publishableKey: gateway.publishableKey };
  });

  // The Bookings page (D67): upcoming and past bookings with what each row offers (receipt, report, chat),
  // and the next visits of the customer's plans.
  app.get('/bookings', { preHandler: guards.customer }, async (request) => {
    const customerId = currentUser(request).id;
    const [result, visits] = await Promise.all([
      pool.query(
        `SELECT b.id, b.status, b.service_name AS "serviceName", b.category_id AS "categoryId", b.starts_at AS "startsAt",
           b.ends_at AS "endsAt", b.completed_at AS "completedAt", b.payment_status AS "paymentStatus",
           b.address, b.postcode,
           -- A flexible booking still waiting for its time shows its window (D70).
           CASE WHEN b.time_confirmed_at IS NULL THEN b.flexible_window END AS "flexibleWindow",
           b.price_cents + CASE WHEN b.late_cancel THEN 0 ELSE b.fee_cents END
             + COALESCE((SELECT sum(x.price_cents) FROM extra_requests x WHERE x.booking_id = b.id AND x.status = 'approved'), 0)::int
             AS "totalCents",
           pu.first_name AS "proName", c.slug AS "categorySlug", c.icon AS "categoryIcon", c.active AS "categoryActive",
           (b.status = 'completed' AND NOT EXISTS (SELECT 1 FROM ratings r WHERE r.booking_id = b.id)) AS "canRate",
           (b.status = 'completed' OR (b.status = 'cancelled' AND b.late_cancel)) AS "hasReceipt",
           (b.status = 'completed' AND b.payment_status = 'held' AND b.problem_reported_at IS NULL
             AND b.completed_at + make_interval(hours => $2) > now()) AS "canReportProblem",
           (b.problem_reported_at IS NOT NULL AND b.problem_resolved_at IS NULL) AS "problemOpen",
           (SELECT count(*)::int FROM booking_messages m WHERE m.booking_id = b.id AND m.sender_role = 'pro' AND m.read_at IS NULL)
             AS "unreadMessages"
         FROM bookings b LEFT JOIN users pu ON pu.id = b.pro_id JOIN categories c ON c.id = b.category_id
         WHERE b.customer_id = $1
         ORDER BY (b.status IN ('completed', 'cancelled')), b.starts_at DESC
         LIMIT 200`,
        [customerId, CHARGE_DELAY_HOURS],
      ),
      pool.query(
        `SELECT v.id, v.starts_at AS "startsAt", v.ends_at AS "endsAt", s.id AS "subscriptionId", s.plan_name AS "planName",
           s.category_id AS "categoryId", c.icon AS "categoryIcon", pu.first_name AS "proName"
         FROM subscription_visits v JOIN subscriptions s ON s.id = v.subscription_id JOIN categories c ON c.id = s.category_id
         LEFT JOIN users pu ON pu.id = COALESCE(v.pro_id, s.pro_id)
         WHERE s.customer_id = $1 AND v.status = 'planned' AND v.starts_at > now()
         ORDER BY v.starts_at LIMIT 3`,
        [customerId],
      ),
    ]);
    return { bookings: result.rows, planVisits: visits.rows };
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

  // Less than 24 hours before the start, cancelling costs the full price: the app asks first and then sends
  // `acceptLateCharge` (D34).
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/bookings/:id/cancel',
    { preHandler: guards.customer, schema: { params: uuidParams } },
    async (request) => {
      const customerId = currentUser(request).id;
      // The body is optional (older apps send none), so it is checked here rather than by a schema.
      const body = request.body ?? {};
      const keys = typeof body === 'object' && body !== null && !Array.isArray(body) ? Object.keys(body) : null;
      const accept = (body as { acceptLateCharge?: unknown }).acceptLateCharge;
      if (!keys || keys.some((key) => key !== 'acceptLateCharge') || (accept !== undefined && typeof accept !== 'boolean')) {
        throw badRequest('validation_failed');
      }
      await cancelBooking(deps(), request.params.id, 'customer', customerId, { acceptLateCharge: accept === true });
      return { booking: await ownBooking(customerId, request.params.id) };
    },
  );

  // A tip for the pro after the job. It is split by today's commission, like a job (D34).
  app.post<{ Params: { id: string }; Body: { amountCents: number } }>(
    '/bookings/:id/tip',
    {
      preHandler: guards.customer,
      schema: {
        params: uuidParams,
        body: {
          type: 'object',
          required: ['amountCents'],
          additionalProperties: false,
          properties: { amountCents: { type: 'integer', minimum: MIN_TIP_CENTS, maximum: MAX_TIP_CENTS } },
        },
      },
    },
    async (request, reply) => {
      const customerId = currentUser(request).id;
      const bookingId = request.params.id;
      const { amountCents } = request.body;
      const found = await pool.query<{
        pro_id: string;
        payment_intent_id: string | null;
        stripe_customer_id: string | null;
        share: number;
      }>(
        `SELECT b.pro_id, b.payment_intent_id, u.stripe_customer_id, (SELECT pro_share_pct FROM settings) AS share
         FROM bookings b JOIN users u ON u.id = b.customer_id
         WHERE b.id = $1 AND b.customer_id = $2 AND b.status = 'completed'`,
        [bookingId, customerId],
      );
      const booking = found.rows[0];
      if (!booking) {
        throw conflict('not_tippable');
      }
      const proCents = proShareCents(amountCents, booking.share);
      // One tip per job; a refused card can be tried again.
      const claimed = await pool.query<{ id: string }>(
        `INSERT INTO tips (booking_id, amount_cents, pro_share_pct, pro_cents) VALUES ($1, $2, $3, $4)
         ON CONFLICT (booking_id) DO UPDATE SET amount_cents = EXCLUDED.amount_cents, pro_share_pct = EXCLUDED.pro_share_pct,
           pro_cents = EXCLUDED.pro_cents, status = 'pending', payment_intent_id = NULL, created_at = now()
         WHERE tips.status = 'failed'
         RETURNING id`,
        [bookingId, amountCents, booking.share, proCents],
      );
      const tip = claimed.rows[0];
      if (!tip) {
        throw conflict('already_tipped');
      }
      try {
        if (!booking.payment_intent_id || !booking.stripe_customer_id) {
          throw new Error('Booking has no saved card');
        }
        const hold = await gateway.holdOnSavedCard({
          customerRef: booking.stripe_customer_id,
          fromIntentId: booking.payment_intent_id,
          amountCents,
          description: 'MISK tip for your pro',
          idempotencyKey: `tip-${tip.id}`,
          metadata: { bookingId, tipId: tip.id },
        });
        if (!hold.held) {
          // The bank wants the customer to confirm; a tip is not worth that step, so nothing is charged.
          await gateway.release(hold.intentId).catch((error: unknown) => request.log.warn({ event: 'tip_release_failed', err: error }));
          throw new Error('Card needs the customer to confirm');
        }
        const { chargeId } = await gateway.capture(hold.intentId);
        await withTransaction(pool, async (client) => {
          await client.query("UPDATE tips SET status = 'captured', payment_intent_id = $2 WHERE id = $1", [tip.id, hold.intentId]);
          await client.query(
            `INSERT INTO payouts (booking_id, pro_id, payment_intent_id, charge_id, amount_cents)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (payment_intent_id) DO NOTHING`,
            [bookingId, booking.pro_id, hold.intentId, chargeId, proCents],
          );
        });
      } catch (error) {
        request.log.error({ event: 'tip_failed', bookingId, err: error });
        await pool.query("UPDATE tips SET status = 'failed' WHERE id = $1", [tip.id]);
        throw new ApiError(402, 'tip_failed');
      }
      // Paid out with the job: at once if the job is already charged, otherwise when it is.
      try {
        await settleBooking(deps(), bookingId);
      } catch (error) {
        request.log.error({ event: 'tip_payout_deferred', bookingId, err: error });
      }
      return reply.code(201).send({ booking: await ownBooking(customerId, bookingId) });
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

  // Stops the 24-hour charge until the MISK team has looked at it.
  app.post<{ Params: { id: string }; Body: { note: string } }>(
    '/bookings/:id/problem',
    {
      preHandler: guards.customer,
      schema: {
        params: uuidParams,
        body: {
          type: 'object',
          required: ['note'],
          additionalProperties: false,
          properties: { note: { type: 'string', minLength: 3, maxLength: 1000, pattern: '\\S' } },
        },
      },
    },
    async (request) => {
      const customerId = currentUser(request).id;
      const reported = await pool.query(
        `UPDATE bookings SET problem_reported_at = now(), problem_note = $3, updated_at = now()
         WHERE id = $1 AND customer_id = $2 AND status = 'completed' AND payment_status = 'held'
           AND problem_reported_at IS NULL AND completed_at > now() - make_interval(hours => $4)`,
        [request.params.id, customerId, request.body.note.trim(), CHARGE_DELAY_HOURS],
      );
      if (!reported.rowCount) {
        throw conflict('too_late_to_report');
      }
      request.log.warn({ event: 'problem_reported', bookingId: request.params.id });
      return { booking: await ownBooking(customerId, request.params.id) };
    },
  );

  // Photos of what went wrong, while the reported problem is still open. Only the customer and the team see them.
  app.post<{ Params: { id: string } }>(
    '/bookings/:id/problem/photos',
    { preHandler: guards.customer, schema: { params: uuidParams } },
    async (request, reply) => {
      const customerId = currentUser(request).id;
      const content = await readSingleFile(request);
      await withTransaction(pool, async (client) => {
        const found = await client.query<{ open: boolean }>(
          `SELECT problem_reported_at IS NOT NULL AND problem_resolved_at IS NULL AS open
           FROM bookings WHERE id = $1 AND customer_id = $2 FOR UPDATE`,
          [request.params.id, customerId],
        );
        const booking = found.rows[0];
        if (!booking) {
          throw notFound();
        }
        if (!booking.open) {
          throw conflict('no_open_problem');
        }
        const count = await client.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM booking_photos WHERE booking_id = $1 AND kind = 'problem'",
          [request.params.id],
        );
        if (onlyRow(count).n >= MAX_PROBLEM_PHOTOS) {
          throw conflict('too_many_photos');
        }
        const upload = await storeUpload(client, ctx.storage, { ownerId: customerId, kind: 'photo', content });
        await client.query("INSERT INTO booking_photos (upload_id, booking_id, kind) VALUES ($1, $2, 'problem')", [
          upload.id,
          request.params.id,
        ]);
      });
      request.log.info({ event: 'problem_photo_added', bookingId: request.params.id });
      return reply.code(201).send({ booking: await ownBooking(customerId, request.params.id) });
    },
  );

  app.post<{ Params: { id: string }; Body: { stars: number; tags?: string[]; review?: string } }>(
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
            review: { type: 'string', maxLength: 1000 },
          },
        },
      },
    },
    async (request, reply) => {
      const customerId = currentUser(request).id;
      try {
        const inserted = await pool.query(
          `INSERT INTO ratings (booking_id, pro_id, customer_id, stars, tags, review)
           SELECT id, pro_id, customer_id, $3, $4, $5 FROM bookings
           WHERE id = $1 AND customer_id = $2 AND status = 'completed'`,
          [request.params.id, customerId, request.body.stars, request.body.tags ?? [], request.body.review?.trim() || null],
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
