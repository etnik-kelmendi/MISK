import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { isUniqueViolation, uuidParams } from '../http.js';
import { formatSlot, messages } from '../notifications/messages.js';
import { enqueue } from '../notifications/outbox.js';
import { withdrawOffers } from '../pros/management.js';
import { autoOfflineReasonSql, loadAvailability } from '../pros/working-hours.js';
import { logAction } from './admin-routes.js';
import { offerNext } from './dispatch.js';
import { setStatus, type BookingDeps } from './events.js';
import { loadTasks } from './job-tasks.js';
import { alertSupport, leaveAsNoShow } from './on-site.js';
import { FREE_CANCEL_HOURS, releaseHolds } from './lifecycle.js';
import { CUSTOMER_RATING_DAYS, loadBooking, PRO_CANCELLABLE } from './views.js';

/** What a pro can report on site (D86). */
export const ISSUE_REASONS = ['customer_not_home', 'no_access', 'bigger_job', 'unsafe', 'other'] as const;
export type IssueReason = (typeof ISSUE_REASONS)[number];
/** Why a pro gives back a job (D86). */
export const CANCEL_REASONS = ['ill', 'vehicle', 'family', 'double_booked', 'other'] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];
/** What a pro can say about a customer with their stars (D86). */
export const CUSTOMER_RATING_TAGS = ['easy_access', 'clear_instructions', 'friendly', 'on_time'] as const;
/** At most this many on-site reports per job, so a stuck button cannot flood support (D86). */
export const MAX_ISSUES_PER_JOB = 5;
export const ISSUE_DETAILS_MAX = 500;
export const CANCEL_NOTE_MAX = 300;
/** The pro's optional comment with their rating of the customer (D94). */
export const CUSTOMER_COMMENT_MAX = 500;
/** The "You cancelled this job" card stays on the Jobs page this long, unless the pro closes it (D94). */
export const CANCELLED_CARD_HOURS = 24;
/** On-site issues that mean the pro is waiting at the door: the customer is told to get in touch. */
const WAITING_AT_DOOR: IssueReason[] = ['customer_not_home', 'no_access'];

/**
 * A pro gives back a job they accepted, before work starts (D86). The job goes back to the search (it is
 * not cancelled for the customer), pending extra work is dropped and held extra money released, the
 * customer is told, and the booking log records it. Under 24 hours before the start it is a late
 * cancellation, which counts towards a pause of new offers. This pro is never offered the job again.
 */
export async function proCancelJob(
  deps: BookingDeps,
  proId: string,
  bookingId: string,
  reason: CancelReason,
  note: string | null,
): Promise<{ late: boolean }> {
  const result = await withTransaction(deps.pool, async (client) => {
    const found = await client.query<{
      status: string;
      customer_id: string;
      service_name: string;
      starts_at: Date;
      hours_left: number;
      pro_name: string | null;
      was_locked: boolean;
    }>(
      `SELECT b.status, b.customer_id, b.service_name, b.starts_at, extract(epoch FROM b.starts_at - now()) / 3600 AS hours_left,
         b.assignment_locked_at IS NOT NULL AS was_locked,
         (SELECT first_name FROM users WHERE id = b.pro_id) AS pro_name
       FROM bookings b WHERE b.id = $1 AND b.pro_id = $2 FOR UPDATE`,
      [bookingId, proId],
    );
    const job = found.rows[0];
    if (!job) {
      throw notFound();
    }
    if (!PRO_CANCELLABLE.includes(job.status)) {
      throw conflict('job_started');
    }
    const late = job.hours_left < FREE_CANCEL_HOURS;
    await client.query('INSERT INTO pro_cancellations (booking_id, pro_id, reason, note, late) VALUES ($1, $2, $3, $4, $5)', [
      bookingId,
      proId,
      reason,
      note,
      late,
    ]);
    // The accepted offer now counts as declined in the pro's acceptance rate, and keeps them from being
    // offered this job again. Pros who passed before may be asked again, as when the team restarts a search.
    await client.query("UPDATE booking_offers SET status = 'declined', responded_at = now() WHERE booking_id = $1 AND pro_id = $2", [
      bookingId,
      proId,
    ]);
    await client.query("DELETE FROM booking_offers WHERE booking_id = $1 AND pro_id <> $2 AND status <> 'withdrawn'", [bookingId, proId]);
    // Extra work this pro asked for goes with them: unanswered requests are dropped and held money released.
    const heldExtras = await client.query<{ payment_intent_id: string }>(
      `UPDATE extra_requests SET status = 'cancelled', decided_at = now()
       WHERE booking_id = $1 AND status IN ('pending', 'awaiting_payment', 'approved')
       RETURNING payment_intent_id`,
      [bookingId],
    );
    await client.query('DELETE FROM booking_task_checks WHERE booking_id = $1', [bookingId]);
    await setStatus(client, bookingId, 'searching', ', pro_id = NULL');
    const when = formatSlot(job.starts_at, deps.config.timezone);
    await enqueue(client, job.customer_id, 'pro_assigned', messages.proCancelledJob(job.service_name, when, job.pro_name ?? 'Your pro'));
    // The team's confirmed assignment (D88) ended with the pro: setStatus cleared the lock, so the team can pick again.
    await logAction(client, bookingId, null, 'pro_cancelled', {
      proName: job.pro_name,
      reason,
      note,
      late,
      ...(job.was_locked ? { assignmentUnlocked: true } : {}),
    });
    return {
      late,
      holds: heldExtras.rows
        .filter((row) => row.payment_intent_id)
        .map((row) => ({ intentId: row.payment_intent_id, table: 'extra_requests' as const })),
    };
  });
  deps.log.info({ event: 'pro_cancelled_job', bookingId, proId, reason, late: result.late });
  await releaseHolds(deps, result.holds);
  await offerNext(deps, bookingId);
  return { late: result.late };
}

/**
 * The pro's actions in the Jobs area (D86): the online switch, ticking off tasks, reporting an issue on
 * site, cancelling a job and rating the customer. Every route only acts on the signed-in pro's own jobs.
 */
export async function proJobActionRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards } = ctx;
  const deps = (): BookingDeps => ({ pool, gateway: ctx.gateway, config: ctx.config, log: app.log });

  async function ownJob(proId: string, bookingId: string) {
    const owned = await pool.query('SELECT 1 FROM bookings WHERE id = $1 AND pro_id = $2', [bookingId, proId]);
    const job = owned.rowCount ? await loadBooking(pool, bookingId, 'pro', ctx.config.timezone) : null;
    if (!job) {
      throw notFound();
    }
    return job;
  }

  // Online: new offers come in. Offline: none do, and offers not yet answered go to other pros. Accepted
  // jobs and plan visits are not affected either way. Outside the pro's working hours, on a day off or on
  // holiday, going online lasts until the end of that day in the market time zone (D94).
  app.put<{ Body: { online: boolean } }>(
    '/pro/online',
    {
      preHandler: guards.pro,
      schema: {
        body: { type: 'object', required: ['online'], additionalProperties: false, properties: { online: { type: 'boolean' } } },
      },
    },
    async (request) => {
      const proId = currentUser(request).id;
      const { online } = request.body;
      const updated = await pool.query<{ online: boolean }>(
        `UPDATE pro_profiles p SET online = $2,
           online_override_until = CASE WHEN $2 AND (${autoOfflineReasonSql('$3')}) IS NOT NULL
             THEN (((now() AT TIME ZONE $3)::date + 1)::timestamp AT TIME ZONE $3) END,
           online_changed_at = CASE WHEN p.online = $2 AND NOT ($2 AND (${autoOfflineReasonSql('$3')}) IS NOT NULL)
             THEN p.online_changed_at ELSE now() END,
           updated_at = now()
         WHERE p.user_id = $1 AND p.status = 'approved' RETURNING p.online`,
        [proId, online, ctx.config.timezone],
      );
      if (!updated.rowCount) {
        throw conflict('not_approved');
      }
      if (!online) {
        await withdrawOffers(deps(), proId);
      }
      const availability = await loadAvailability(pool, proId, ctx.config.timezone);
      request.log.info({ event: online ? 'pro_online' : 'pro_offline', proId, overrideUntil: availability.overrideUntil });
      return { online, availability };
    },
  );

  // Ticks a task of the checklist off, or back on, while the pro is working (D86).
  app.post<{ Params: { id: string }; Body: { key: string; done: boolean } }>(
    '/pro/jobs/:id/tasks',
    {
      preHandler: guards.pro,
      schema: {
        params: uuidParams,
        body: {
          type: 'object',
          required: ['key', 'done'],
          additionalProperties: false,
          properties: { key: { type: 'string', minLength: 2, maxLength: 40 }, done: { type: 'boolean' } },
        },
      },
    },
    async (request) => {
      const proId = currentUser(request).id;
      const { key, done } = request.body;
      await withTransaction(pool, async (client) => {
        const found = await client.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1 AND pro_id = $2 FOR UPDATE', [
          request.params.id,
          proId,
        ]);
        const status = found.rows[0]?.status;
        if (!status) throw notFound();
        if (status !== 'working') throw conflict('invalid_status');
        const tasks = await loadTasks(client, request.params.id);
        if (!tasks.some((task) => task.key === key)) throw badRequest('unknown_task');
        if (done) {
          await client.query('INSERT INTO booking_task_checks (booking_id, task_key) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
            request.params.id,
            key,
          ]);
        } else {
          await client.query('DELETE FROM booking_task_checks WHERE booking_id = $1 AND task_key = $2', [request.params.id, key]);
        }
      });
      return { job: await ownJob(proId, request.params.id) };
    },
  );

  // A problem on site, reported to MISK support (D86). It shows in the booking log and puts the booking
  // under Needs action until the team resolves it.
  app.post<{ Params: { id: string }; Body: { reason: IssueReason; details?: string } }>(
    '/pro/jobs/:id/issue',
    {
      preHandler: guards.pro,
      schema: {
        params: uuidParams,
        body: {
          type: 'object',
          required: ['reason'],
          additionalProperties: false,
          properties: {
            reason: { type: 'string', enum: ISSUE_REASONS },
            details: { type: 'string', maxLength: ISSUE_DETAILS_MAX },
          },
        },
      },
    },
    async (request, reply) => {
      const pro = currentUser(request);
      const { reason } = request.body;
      const details = request.body.details?.trim() || null;
      if (reason === 'other' && !details) {
        throw badRequest('details_required');
      }
      await withTransaction(pool, async (client) => {
        const found = await client.query<{ status: string; customer_id: string; service_name: string; address: string; number: string }>(
          `SELECT status, customer_id, service_name, address, 'B-' || number AS number FROM bookings
           WHERE id = $1 AND pro_id = $2 FOR UPDATE`,
          [request.params.id, pro.id],
        );
        const job = found.rows[0];
        if (!job) throw notFound();
        if (!['accepted', 'on_the_way', 'working'].includes(job.status)) throw conflict('invalid_status');
        const earlier = await client.query<{ total: number; open: number }>(
          `SELECT count(*)::int AS total, count(*) FILTER (WHERE resolved_at IS NULL)::int AS open
           FROM booking_issues WHERE booking_id = $1`,
          [request.params.id],
        );
        const counts = earlier.rows[0] ?? { total: 0, open: 0 };
        if (counts.open > 0) throw conflict('issue_already_open');
        if (counts.total >= MAX_ISSUES_PER_JOB) throw conflict('too_many_issues');
        try {
          await client.query('INSERT INTO booking_issues (booking_id, pro_id, reason, details) VALUES ($1, $2, $3, $4)', [
            request.params.id,
            pro.id,
            reason,
            details,
          ]);
        } catch (error) {
          // Only one report per job can be open, also when two arrive at once.
          if (isUniqueViolation(error)) throw conflict('issue_already_open');
          throw error;
        }
        await logAction(client, request.params.id, null, 'issue_reported', { proName: pro.firstName, reason, note: details ?? undefined });
        // The team is told at once (D94): it calls the customer for a door problem and the pro when it is unsafe.
        await alertSupport(client, { bookingNumber: job.number, reason, address: job.address }, { supportEmail: ctx.config.support.email, log: request.log });
        if (WAITING_AT_DOOR.includes(reason)) {
          await enqueue(
            client,
            job.customer_id,
            'chat_message',
            messages.proWaitingAtDoor(pro.firstName ?? 'Your pro', job.service_name, job.address),
            { link: `/bookings/${request.params.id}/chat` },
          );
        }
      });
      // Support works from the Needs action list, like the customers' problem reports.
      request.log.warn({ event: 'pro_issue_reported', bookingId: request.params.id, proId: pro.id, reason });
      return reply.code(201).send({ job: await ownJob(pro.id, request.params.id) });
    },
  );

  // "Leave and get the call-out fee" (D94): 15 minutes after a "not home" or "can't get in" report.
  app.post<{ Params: { id: string } }>(
    '/pro/jobs/:id/no-show',
    { preHandler: guards.pro, schema: { params: uuidParams } },
    async (request) => {
      const proId = currentUser(request).id;
      await leaveAsNoShow(deps(), proId, request.params.id);
      return { job: await ownJob(proId, request.params.id) };
    },
  );

  // The "You cancelled this job" cards of the Jobs page (D94): the last 24 hours, with the pro the job went to
  // next (first name only) while it is offered to them or they took it.
  app.get('/pro/cancellations', { preHandler: guards.pro }, async (request) => {
    const result = await pool.query(
      `SELECT c.id, c.booking_id AS "bookingId", c.reason, c.note, c.late, c.created_at AS "createdAt",
         b.service_name AS "serviceName", b.starts_at AS "startsAt",
         COALESCE(
           CASE WHEN b.pro_id IS NOT NULL AND b.pro_id <> c.pro_id AND b.status IN ('accepted', 'on_the_way', 'working', 'completed')
             THEN (SELECT first_name FROM users WHERE id = b.pro_id) END,
           (SELECT u.first_name FROM booking_offers o JOIN users u ON u.id = o.pro_id
            WHERE o.booking_id = c.booking_id AND o.pro_id <> c.pro_id AND o.status = 'pending' AND b.status = 'searching'
            ORDER BY o.offered_at DESC LIMIT 1)
         ) AS "nextProName"
       FROM pro_cancellations c JOIN bookings b ON b.id = c.booking_id
       WHERE c.pro_id = $1 AND c.dismissed_at IS NULL AND c.created_at > now() - make_interval(hours => $2)
       ORDER BY c.created_at DESC`,
      [currentUser(request).id, CANCELLED_CARD_HOURS],
    );
    return { cancellations: result.rows };
  });

  app.post<{ Params: { id: string } }>(
    '/pro/cancellations/:id/dismiss',
    { preHandler: guards.pro, schema: { params: uuidParams } },
    async (request, reply) => {
      const updated = await pool.query(
        'UPDATE pro_cancellations SET dismissed_at = COALESCE(dismissed_at, now()) WHERE id = $1 AND pro_id = $2',
        [request.params.id, currentUser(request).id],
      );
      if (!updated.rowCount) throw notFound();
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: CancelReason; note?: string } }>(
    '/pro/jobs/:id/cancel',
    {
      preHandler: guards.pro,
      schema: {
        params: uuidParams,
        body: {
          type: 'object',
          required: ['reason'],
          additionalProperties: false,
          properties: {
            reason: { type: 'string', enum: CANCEL_REASONS },
            note: { type: 'string', maxLength: CANCEL_NOTE_MAX },
          },
        },
      },
    },
    async (request) => {
      const note = request.body.note?.trim() || null;
      if (request.body.reason === 'other' && !note) {
        throw badRequest('reason_note_required');
      }
      const { late } = await proCancelJob(deps(), currentUser(request).id, request.params.id, request.body.reason, note);
      return { cancelled: { reason: request.body.reason, late } };
    },
  );

  // The pro's private rating of the customer (D86): once per job, only after it is done, for 7 days.
  app.post<{ Params: { id: string }; Body: { stars: number; tags?: string[]; comment?: string } }>(
    '/pro/jobs/:id/customer-rating',
    {
      preHandler: guards.pro,
      schema: {
        params: uuidParams,
        body: {
          type: 'object',
          required: ['stars'],
          additionalProperties: false,
          properties: {
            stars: { type: 'integer', minimum: 1, maximum: 5 },
            tags: { type: 'array', uniqueItems: true, maxItems: CUSTOMER_RATING_TAGS.length, items: { type: 'string', enum: CUSTOMER_RATING_TAGS } },
            comment: { type: 'string', maxLength: CUSTOMER_COMMENT_MAX },
          },
        },
      },
    },
    async (request, reply) => {
      const proId = currentUser(request).id;
      try {
        const inserted = await pool.query(
          `INSERT INTO customer_ratings (booking_id, pro_id, customer_id, stars, tags, comment)
           SELECT id, pro_id, customer_id, $3, $4, $6 FROM bookings
           WHERE id = $1 AND pro_id = $2 AND status = 'completed' AND completed_at > now() - make_interval(days => $5)`,
          [request.params.id, proId, request.body.stars, request.body.tags ?? [], CUSTOMER_RATING_DAYS, request.body.comment?.trim() || null],
        );
        if (!inserted.rowCount) {
          const owned = await pool.query('SELECT 1 FROM bookings WHERE id = $1 AND pro_id = $2', [request.params.id, proId]);
          if (!owned.rowCount) throw notFound();
          throw conflict('customer_not_ratable');
        }
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict('already_rated');
        throw error;
      }
      request.log.info({ event: 'customer_rated', bookingId: request.params.id, proId });
      return reply.code(201).send({ job: await ownJob(proId, request.params.id) });
    },
  );
}
