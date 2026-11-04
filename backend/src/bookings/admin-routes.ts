import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import type { AppContext } from '../context.js';
import { onlyRow, withTransaction } from '../db.js';
import { ApiError, conflict, notFound } from '../errors.js';
import { isExclusionViolation, uuidParams } from '../http.js';
import { formatSlot, messages } from '../notifications/messages.js';
import { enqueue } from '../notifications/outbox.js';
import { offerNext } from './dispatch.js';
import { setStatus, type BookingDeps } from './events.js';
import { cancelBooking } from './lifecycle.js';
import { loadBooking } from './views.js';

const STATUSES = ['awaiting_payment', 'searching', 'unassigned', 'accepted', 'on_the_way', 'working', 'completed', 'cancelled'];
const REASSIGNABLE = ['searching', 'unassigned', 'accepted', 'on_the_way'];

export async function adminBookingRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards, gateway } = ctx;
  const deps = (): BookingDeps => ({ pool, gateway, config: ctx.config, log: app.log });

  async function adminView(bookingId: string) {
    const booking = await loadBooking(pool, bookingId, 'admin');
    if (!booking) {
      throw notFound();
    }
    return booking;
  }

  app.get<{ Querystring: { days?: '1' | '7' | '30' } }>(
    '/admin/overview',
    {
      preHandler: guards.admin,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { days: { type: 'string', enum: ['1', '7', '30'] } },
        },
      },
    },
    async (request) => {
      const days = Number(request.query.days ?? 7);
      const [kpis, weekly, attention] = await Promise.all([
        pool.query(
          `WITH period AS (SELECT now() - make_interval(days => $1) AS since)
           SELECT
             (SELECT count(*)::int FROM bookings, period WHERE created_at >= since
                AND status <> 'awaiting_payment' AND cancelled_by IS DISTINCT FROM 'system') AS bookings,
             (SELECT count(*)::int FROM bookings, period WHERE completed_at >= since) AS completed,
             (SELECT COALESCE(sum(price_cents + fee_cents), 0)::int FROM bookings, period
                WHERE completed_at >= since AND payment_status = 'captured')
             + (SELECT COALESCE(sum(e.price_cents), 0)::int FROM extra_requests e JOIN bookings b ON b.id = e.booking_id, period
                WHERE b.completed_at >= since AND e.payment_status = 'captured') AS "grossCents",
             (SELECT COALESCE(sum(p.amount_cents), 0)::int FROM payouts p JOIN bookings b ON b.id = p.booking_id, period
                WHERE b.completed_at >= since) AS "payoutCents",
             (SELECT round(avg(stars)::numeric, 2)::float FROM ratings, period WHERE created_at >= since) AS "ratingAverage",
             (SELECT count(*)::int FROM ratings, period WHERE created_at >= since) AS "ratingCount"`,
          [days],
        ),
        pool.query(
          `SELECT to_char(w, 'YYYY-MM-DD') AS week,
             (SELECT count(*)::int FROM bookings b WHERE b.created_at >= w AND b.created_at < w + interval '7 days'
                AND b.status <> 'awaiting_payment' AND b.cancelled_by IS DISTINCT FROM 'system') AS bookings
           FROM generate_series(date_trunc('week', now()) - interval '7 weeks', date_trunc('week', now()), interval '1 week') AS w
           ORDER BY w`,
        ),
        pool.query(
          `SELECT
             (SELECT count(*)::int FROM pro_profiles WHERE status = 'submitted') AS "pendingApplications",
             (SELECT count(*)::int FROM bookings WHERE status = 'unassigned') AS unassigned,
             (SELECT count(*)::int FROM bookings WHERE status = 'cancelled' AND payment_status = 'held') AS "unreleasedHolds",
             (SELECT count(*)::int FROM payouts WHERE status = 'failed') AS "failedPayouts"`,
        ),
      ]);
      const k = kpis.rows[0];
      return {
        days,
        kpis: { ...k, miskShareCents: k.grossCents - k.payoutCents },
        weekly: weekly.rows,
        attention: attention.rows[0],
      };
    },
  );

  app.get<{ Querystring: { status?: string; q?: string } }>(
    '/admin/bookings',
    {
      preHandler: guards.admin,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { status: { type: 'string', enum: STATUSES }, q: { type: 'string', maxLength: 60 } },
        },
      },
    },
    async (request) => {
      const q = request.query.q?.trim() || null;
      const result = await pool.query(
        `SELECT b.id, b.status, b.service_name AS "serviceName", b.starts_at AS "startsAt", b.created_at AS "createdAt",
           b.postcode, b.address, cu.first_name AS "customerName", pu.first_name AS "proName",
           b.price_cents + b.fee_cents AS "totalCents", b.payment_status AS "paymentStatus"
         FROM bookings b JOIN users cu ON cu.id = b.customer_id LEFT JOIN users pu ON pu.id = b.pro_id
         WHERE ($1::text IS NULL OR b.status = $1)
           AND ($2::text IS NULL OR b.address ILIKE '%' || $2 || '%' OR b.service_name ILIKE '%' || $2 || '%'
                OR cu.first_name ILIKE '%' || $2 || '%' OR pu.first_name ILIKE '%' || $2 || '%' OR b.postcode ILIKE $2 || '%')
         ORDER BY (b.status = 'unassigned') DESC, b.starts_at DESC
         LIMIT 200`,
        [request.query.status ?? null, q],
      );
      return { bookings: result.rows };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/admin/bookings/:id',
    { preHandler: guards.admin, schema: { params: uuidParams } },
    async (request) => ({ booking: await adminView(request.params.id) }),
  );

  // Pros who could take the job now, for the reassign picker. Busy pros are left out.
  app.get<{ Params: { id: string } }>(
    '/admin/bookings/:id/candidates',
    { preHandler: guards.admin, schema: { params: uuidParams } },
    async (request) => {
      const result = await pool.query(
        `SELECT p.user_id AS id, u.first_name AS "firstName",
           round(distance_km(home.lat, home.lng, dest.lat, dest.lng)::numeric, 1)::float AS "distanceKm",
           (SELECT round(avg(stars)::numeric, 2)::float FROM ratings r WHERE r.pro_id = p.user_id) AS "ratingAverage"
         FROM bookings b
         JOIN pro_trades t ON t.category_id = b.category_id
         JOIN pro_profiles p ON p.user_id = t.pro_id
         JOIN users u ON u.id = p.user_id
         JOIN postcodes home ON home.code = p.home_postcode
         JOIN postcodes dest ON dest.code = b.postcode
         WHERE b.id = $1 AND p.status = 'approved' AND p.payouts_enabled AND u.disabled_at IS NULL
           AND p.user_id IS DISTINCT FROM b.pro_id
           AND NOT EXISTS (
             SELECT 1 FROM bookings busy WHERE busy.pro_id = p.user_id AND busy.id <> b.id
               AND busy.status IN ('accepted', 'on_the_way', 'working')
               AND tstzrange(busy.starts_at, busy.ends_at) && tstzrange(b.starts_at, b.ends_at))
         ORDER BY "distanceKm"
         LIMIT 50`,
        [request.params.id],
      );
      return { candidates: result.rows };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/bookings/:id/cancel',
    { preHandler: guards.admin, schema: { params: uuidParams } },
    async (request) => {
      await cancelBooking(deps(), request.params.id, 'admin');
      request.log.info({ event: 'admin_cancelled_booking', bookingId: request.params.id, by: currentUser(request).id });
      return { booking: await adminView(request.params.id) };
    },
  );

  app.post<{ Params: { id: string }; Body: { proId?: string } }>(
    '/admin/bookings/:id/reassign',
    {
      preHandler: guards.admin,
      schema: {
        params: uuidParams,
        body: { type: 'object', additionalProperties: false, properties: { proId: { type: 'string', format: 'uuid' } } },
      },
    },
    async (request) => {
      const bookingId = request.params.id;
      const targetPro = request.body.proId ?? null;
      const restart = await withTransaction(pool, async (client) => {
        const found = await client.query<{
          status: string;
          pro_id: string | null;
          category_id: string;
          customer_id: string;
          service_name: string;
          starts_at: Date;
        }>(
          'SELECT status, pro_id, category_id, customer_id, service_name, starts_at FROM bookings WHERE id = $1 FOR UPDATE',
          [bookingId],
        );
        const booking = found.rows[0];
        if (!booking) {
          throw notFound();
        }
        if (!REASSIGNABLE.includes(booking.status)) {
          throw conflict('invalid_status');
        }
        const when = formatSlot(booking.starts_at, ctx.config.timezone);
        await client.query(
          "UPDATE booking_offers SET status = 'withdrawn', responded_at = now() WHERE booking_id = $1 AND status = 'pending'",
          [bookingId],
        );
        if (booking.pro_id && booking.pro_id !== targetPro) {
          await enqueue(client, booking.pro_id, 'booking_cancelled', messages.bookingCancelledForPro(booking.service_name, when));
        }

        if (!targetPro) {
          // Start the search again; pros who passed before may be asked again.
          await client.query("DELETE FROM booking_offers WHERE booking_id = $1 AND status <> 'withdrawn'", [bookingId]);
          await setStatus(client, bookingId, 'searching', ', pro_id = NULL');
          return true;
        }

        const pro = await client.query<{ firstName: string | null }>(
          `SELECT u.first_name AS "firstName" FROM pro_profiles p JOIN users u ON u.id = p.user_id
           JOIN pro_trades t ON t.pro_id = p.user_id AND t.category_id = $2
           WHERE p.user_id = $1 AND p.status = 'approved' AND p.payouts_enabled AND u.disabled_at IS NULL`,
          [targetPro, booking.category_id],
        );
        if (!pro.rowCount) {
          throw conflict('pro_not_eligible');
        }
        await client.query('SAVEPOINT assign');
        try {
          await setStatus(client, bookingId, 'accepted', ', pro_id = $3', [targetPro]);
        } catch (error) {
          if (isExclusionViolation(error)) {
            throw conflict('schedule_conflict');
          }
          throw error;
        }
        await client.query(
          `INSERT INTO booking_offers (booking_id, pro_id, status, expires_at, responded_at)
           VALUES ($1, $2, 'accepted', now(), now())
           ON CONFLICT (booking_id, pro_id) DO UPDATE SET status = 'accepted', responded_at = now()`,
          [bookingId, targetPro],
        );
        await enqueue(
          client,
          booking.customer_id,
          'pro_assigned',
          messages.proAssigned(booking.service_name, when, onlyRow(pro).firstName ?? 'Your pro'),
        );
        await enqueue(client, targetPro, 'job_offer', messages.assignedByTeam(booking.service_name, when));
        return false;
      });
      request.log.info({ event: 'admin_reassigned_booking', bookingId, proId: targetPro, by: currentUser(request).id });
      if (restart) {
        await offerNext(deps(), bookingId);
      }
      return { booking: await adminView(bookingId) };
    },
  );

  // Gives a completed job's money back and takes the pro's payouts back.
  app.post<{ Params: { id: string } }>(
    '/admin/bookings/:id/refund',
    { preHandler: guards.admin, schema: { params: uuidParams } },
    async (request) => {
      const bookingId = request.params.id;
      const found = await pool.query<{ status: string; payment_intent_id: string | null; payment_status: string }>(
        'SELECT status, payment_intent_id, payment_status FROM bookings WHERE id = $1',
        [bookingId],
      );
      const booking = found.rows[0];
      if (!booking) {
        throw notFound();
      }
      if (booking.status !== 'completed' || booking.payment_status !== 'captured' || !booking.payment_intent_id) {
        throw conflict('not_refundable');
      }
      const extras = await pool.query<{ payment_intent_id: string }>(
        "SELECT payment_intent_id FROM extra_requests WHERE booking_id = $1 AND payment_status = 'captured'",
        [bookingId],
      );
      const transfers = await pool.query<{ transfer_id: string }>(
        "SELECT transfer_id FROM payouts WHERE booking_id = $1 AND status = 'sent' AND transfer_id IS NOT NULL",
        [bookingId],
      );
      try {
        for (const { transfer_id } of transfers.rows) {
          await gateway.reverseTransfer(transfer_id);
          await pool.query("UPDATE payouts SET status = 'reversed', updated_at = now() WHERE transfer_id = $1", [
            transfer_id,
          ]);
        }
        await gateway.refund(booking.payment_intent_id);
        await pool.query("UPDATE bookings SET payment_status = 'refunded', updated_at = now() WHERE id = $1", [bookingId]);
        for (const { payment_intent_id } of extras.rows) {
          await gateway.refund(payment_intent_id);
          await pool.query("UPDATE extra_requests SET payment_status = 'refunded' WHERE payment_intent_id = $1", [
            payment_intent_id,
          ]);
        }
      } catch (error) {
        request.log.error({ event: 'refund_failed', bookingId, err: error });
        throw new ApiError(502, 'payment_unavailable');
      }
      request.log.info({ event: 'admin_refunded_booking', bookingId, by: currentUser(request).id });
      return { booking: await adminView(bookingId) };
    },
  );
}
