import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import type { BookingDeps } from '../bookings/events.js';
import { proShareCents } from '../catalogue/pricing.js';
import { normalizePostcode, POSTCODE_INPUT_MAX_LENGTH } from '../catalogue/routes.js';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import { ApiError, badRequest, conflict, notFound } from '../errors.js';
import { CANCEL_NOTICE_DAYS, DAYS_PER_WEEK, PLAN_COLUMNS, PLAN_FROM, VISITS_PER_MONTH, type Frequency } from '../plans/routes.js';
import { callOffPause, createPause, pauseOptions, pausesOf, settlePausesAfterPlanEnd } from './pause.js';
import { acceptMove, declineMove, loadMovableVisit, moveBlock, moveTargets, pendingMovesForPro, requestMove, withdrawMove } from './moves.js';
import {
  chooseRegularPro,
  dropUnpaidSubscription,
  planSizePrice,
  plannedStarts,
  recordPaidMonth,
  type PlanSize,
  type TimeWindow,
} from './service.js';

interface PlanRow {
  id: string;
  name: string;
  categoryId: string;
  priceCents: number;
  frequency: Frequency;
  visitMinutes: number;
  tasks: string[];
  addonName: string | null;
  addonPriceCents: number | null;
  seasonal: boolean;
  seasonFrom: number | null;
  seasonTo: number | null;
  minTermMonths: number;
  pauseNoticeDays: number;
  maxPauseWeeks: number;
  proSharePct: number;
  stripeProductId: string | null;
}

interface SubscribeBody {
  planId: string;
  size: PlanSize;
  days: number[];
  timeWindow: TimeWindow;
  address: string;
  postcode: string;
  notes?: string;
  withAddon: boolean;
}

const SUBSCRIPTION_COLUMNS = `s.id, s.plan_id AS "planId", s.plan_name AS "planName", s.category_id AS "categoryId", s.tasks, s.size,
  s.frequency, s.days, s.time_window AS "timeWindow", s.visit_minutes AS "visitMinutes", s.address, s.postcode, s.notes,
  s.with_addon AS "withAddon", s.addon_name AS "addonName", s.price_cents AS "priceCents", s.seasonal,
  s.season_from AS "seasonFrom", s.season_to AS "seasonTo", s.min_term_months AS "minTermMonths",
  s.pause_notice_days AS "pauseNoticeDays", s.max_pause_weeks AS "maxPauseWeeks", s.status,
  s.billing_paused AS "billingPaused", s.started_at AS "startedAt",
  s.current_period_end AS "currentPeriodEnd", s.ends_at AS "endsAt", s.created_at AS "createdAt",
  pu.first_name AS "proName",
  CASE WHEN s.started_at IS NULL THEN NULL ELSE s.started_at + make_interval(months => s.min_term_months) END AS "cancelableFrom"`;

export async function subscriptionRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards, gateway, config } = ctx;
  const deps = (): BookingDeps => ({ pool, gateway, config, log: app.log });

  async function publishedPlan(planId: string): Promise<PlanRow> {
    const found = await pool.query<PlanRow>(
      `SELECT ${PLAN_COLUMNS}, p.stripe_product_id AS "stripeProductId" FROM ${PLAN_FROM}
       WHERE p.id = $1 AND p.status = 'published' AND c.active`,
      [planId],
    );
    if (!found.rows[0]) {
      throw notFound('plan_not_found');
    }
    return found.rows[0];
  }

  /** A customer's own plan, with the visits planned ahead, any move waiting for the pro (D77) and its pauses (D78). */
  async function loadSubscription(id: string, customerId: string) {
    const found = await pool.query(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions s LEFT JOIN users pu ON pu.id = s.pro_id
       WHERE s.id = $1 AND s.customer_id = $2`,
      [id, customerId],
    );
    const subscription = found.rows[0];
    if (!subscription) {
      throw notFound();
    }
    const visits = await pool.query(
      `SELECT v.id, v.starts_at AS "startsAt", v.ends_at AS "endsAt", v.status, v.tasks_done AS "tasksDone",
         v.moved_from AS "movedFrom",
         -- The pause that called this visit off (D78), while that pause stands.
         (SELECT pz.id FROM subscription_pauses pz WHERE pz.id = v.paused_by AND pz.status = 'active') AS "pausedBy",
         (SELECT json_build_object('toStartsAt', m.to_starts_at, 'toEndsAt', m.to_ends_at, 'respondBy', m.respond_by)
          FROM subscription_visit_moves m WHERE m.visit_id = v.id AND m.status = 'pending') AS "pendingMove"
       FROM subscription_visits v WHERE v.subscription_id = $1 AND v.status <> 'pending'
         AND v.starts_at > now() - interval '14 days'
       ORDER BY v.starts_at LIMIT 40`,
      [id],
    );
    return { ...subscription, visits: visits.rows, pauses: await pausesOf(pool, id) };
  }

  app.post<{ Body: SubscribeBody }>(
    '/subscriptions',
    {
      preHandler: guards.customer,
      schema: {
        body: {
          type: 'object',
          required: ['planId', 'size', 'days', 'timeWindow', 'address', 'postcode', 'withAddon'],
          additionalProperties: false,
          properties: {
            planId: { type: 'string', format: 'uuid' },
            size: { type: 'string', enum: ['S', 'M', 'L'] },
            days: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 7 } },
            timeWindow: { type: 'string', enum: ['morning', 'afternoon'] },
            address: { type: 'string', minLength: 3, maxLength: 200, pattern: '\\S' },
            postcode: { type: 'string', minLength: 2, maxLength: POSTCODE_INPUT_MAX_LENGTH },
            notes: { type: 'string', maxLength: 1000 },
            withAddon: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const customer = currentUser(request);
      const body = request.body;
      const plan = await publishedPlan(body.planId);
      if (body.days.length !== DAYS_PER_WEEK[plan.frequency]) {
        throw badRequest('wrong_number_of_days');
      }
      if (body.withAddon && !plan.addonName) {
        throw badRequest('plan_has_no_extra');
      }
      const postcode = normalizePostcode(body.postcode);
      const served = await pool.query('SELECT 1 FROM postcodes WHERE code = $1 AND active', [postcode]);
      if (!served.rowCount) {
        throw badRequest('postcode_not_served');
      }
      if (plan.seasonal) {
        const month = await pool.query<{ m: number }>('SELECT extract(month FROM now() AT TIME ZONE $1)::int AS m', [config.timezone]);
        const now = month.rows[0]?.m ?? 1;
        if (now < (plan.seasonFrom ?? 1) || now > (plan.seasonTo ?? 12)) {
          throw conflict('off_season');
        }
      }
      const days = [...body.days].sort();
      const priceCents = planSizePrice(plan.priceCents, body.size) + (body.withAddon ? (plan.addonPriceCents ?? 0) : 0);

      const created = await withTransaction(pool, async (client) => {
        // One sign-up per trade at a time, so two customers cannot both take the last free pro.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`book:${plan.categoryId}`]);
        const pattern = {
          days,
          frequency: plan.frequency,
          timeWindow: body.timeWindow,
          visitMinutes: plan.visitMinutes,
          seasonal: plan.seasonal,
          seasonFrom: plan.seasonFrom,
          seasonTo: plan.seasonTo,
          anchor: new Date(),
          until: null,
        };
        const starts = await plannedStarts(client, pattern, config.timezone);
        const proId = await chooseRegularPro(client, {
          categoryId: plan.categoryId,
          postcode,
          days,
          starts,
          visitMinutes: plan.visitMinutes,
          customerId: customer.id,
        });
        if (!proId) {
          throw conflict('no_pro_available');
        }
        const inserted = await client.query<{ id: string; created_at: Date }>(
          `INSERT INTO subscriptions (customer_id, plan_id, category_id, plan_name, tasks, size, frequency, days, time_window,
             visit_minutes, address, postcode, notes, with_addon, addon_name, price_cents, pro_share_pct, seasonal,
             season_from, season_to, skips_per_month, min_term_months, pause_notice_days, max_pause_weeks, pro_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, 0, $21, $22, $23, $24)
           RETURNING id, created_at`,
          [
            customer.id,
            plan.id,
            plan.categoryId,
            plan.name,
            plan.tasks,
            body.size,
            plan.frequency,
            days,
            body.timeWindow,
            plan.visitMinutes,
            body.address.trim(),
            postcode,
            body.notes?.trim() ?? '',
            body.withAddon,
            body.withAddon ? plan.addonName : null,
            priceCents,
            plan.proSharePct,
            plan.seasonal,
            plan.seasonFrom,
            plan.seasonTo,
            plan.minTermMonths,
            plan.pauseNoticeDays,
            plan.maxPauseWeeks,
            proId,
          ],
        );
        const row = inserted.rows[0];
        if (!row) {
          throw new Error('Subscription insert returned nothing');
        }
        // The pro's time is held while the customer pays; the planner keeps it filled afterwards.
        await client.query(
          `INSERT INTO subscription_visits (subscription_id, pro_id, starts_at, ends_at, status)
           SELECT $1, $2, s, s + make_interval(mins => $4::int), 'pending' FROM unnest($3::timestamptz[]) AS s`,
          [row.id, proId, starts, plan.visitMinutes],
        );
        return row;
      });

      let clientSecret: string | null = null;
      try {
        const existing = await pool.query<{ stripe_customer_id: string | null }>('SELECT stripe_customer_id FROM users WHERE id = $1', [customer.id]);
        const customerRef = await gateway.ensureCustomer({ userId: customer.id, existing: existing.rows[0]?.stripe_customer_id ?? null });
        await pool.query('UPDATE users SET stripe_customer_id = $2 WHERE id = $1 AND stripe_customer_id IS NULL', [customer.id, customerRef]);
        const productId = await gateway.ensureProduct({ planId: plan.id, name: plan.name, existing: plan.stripeProductId });
        await pool.query('UPDATE plans SET stripe_product_id = $2 WHERE id = $1 AND stripe_product_id IS NULL', [plan.id, productId]);
        const start = await gateway.createSubscription({
          customerRef,
          productId,
          amountCents: priceCents,
          idempotencyKey: `subscription-${created.id}`,
          metadata: { subscriptionId: created.id },
        });
        await pool.query('UPDATE subscriptions SET stripe_subscription_id = $2 WHERE id = $1', [created.id, start.subscriptionId]);
        clientSecret = start.clientSecret;
        if (start.active) {
          const periodEnd = new Date(created.created_at);
          periodEnd.setMonth(periodEnd.getMonth() + 1);
          await recordPaidMonth(deps(), {
            subscriptionId: start.subscriptionId,
            invoiceId: `first-${start.subscriptionId}`,
            amountCents: priceCents,
            periodEnd,
          });
        }
      } catch (error) {
        request.log.error({ event: 'subscription_payment_start_failed', subscriptionId: created.id, err: error });
        await dropUnpaidSubscription(deps(), created.id);
        throw new ApiError(502, 'payment_unavailable');
      }
      request.log.info({ event: 'subscription_created', subscriptionId: created.id, customerId: customer.id });
      return reply.code(201).send({
        subscription: await loadSubscription(created.id, customer.id),
        payment: clientSecret ? { clientSecret, publishableKey: gateway.publishableKey } : null,
      });
    },
  );

  app.get('/subscriptions', { preHandler: guards.customer }, async (request) => {
    const customerId = currentUser(request).id;
    const ids = await pool.query<{ id: string }>(
      `SELECT id FROM subscriptions WHERE customer_id = $1 AND (status <> 'cancelled' OR ends_at > now() - interval '30 days')
       ORDER BY created_at DESC LIMIT 20`,
      [customerId],
    );
    return { subscriptions: await Promise.all(ids.rows.map((row) => loadSubscription(row.id, customerId))) };
  });

  const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;

  app.get<{ Params: { id: string } }>(
    '/subscriptions/:id',
    { preHandler: guards.customer, schema: { params: idParams } },
    async (request) => ({ subscription: await loadSubscription(request.params.id, currentUser(request).id) }),
  );

  app.get<{ Params: { id: string } }>(
    '/subscriptions/:id/payment',
    { preHandler: guards.customer, schema: { params: idParams } },
    async (request) => {
      const found = await pool.query<{ stripe_subscription_id: string | null; status: string }>(
        'SELECT stripe_subscription_id, status FROM subscriptions WHERE id = $1 AND customer_id = $2',
        [request.params.id, currentUser(request).id],
      );
      const row = found.rows[0];
      if (!row) {
        throw notFound();
      }
      if (row.status !== 'awaiting_payment' || !row.stripe_subscription_id) {
        return { payment: null };
      }
      const clientSecret = await gateway.subscriptionClientSecret(row.stripe_subscription_id);
      return { payment: clientSecret ? { clientSecret, publishableKey: gateway.publishableKey } : null };
    },
  );

  const visitParams = {
    type: 'object',
    required: ['id', 'visitId'],
    properties: { id: { type: 'string', format: 'uuid' }, visitId: { type: 'string', format: 'uuid' } },
  } as const;

  // Skipping visits was removed (D77): visits can be moved within their week instead.
  for (const action of ['skip', 'unskip']) {
    app.post(`/subscriptions/:id/visits/:visitId/${action}`, { preHandler: guards.customer, schema: { params: visitParams } }, async () => {
      throw new ApiError(410, 'skips_removed');
    });
  }

  // The days this visit can move to: other days of its week when the pro is free at the same time (D77).
  app.get<{ Params: { id: string; visitId: string } }>(
    '/subscriptions/:id/visits/:visitId/move-options',
    { preHandler: guards.customer, schema: { params: visitParams } },
    async (request) => {
      const visit = await loadMovableVisit(pool, {
        subscriptionId: request.params.id,
        visitId: request.params.visitId,
        customerId: currentUser(request).id,
      });
      const block = moveBlock(visit);
      if (block) {
        return { options: [], reason: block };
      }
      const options = await moveTargets(pool, visit, config.timezone);
      return { options, reason: options.length ? null : 'no_free_day' };
    },
  );

  app.post<{ Params: { id: string; visitId: string }; Body: { startsAt: string } }>(
    '/subscriptions/:id/visits/:visitId/move',
    {
      preHandler: guards.customer,
      schema: {
        params: visitParams,
        body: {
          type: 'object',
          required: ['startsAt'],
          additionalProperties: false,
          properties: { startsAt: { type: 'string', format: 'date-time' } },
        },
      },
    },
    async (request) => {
      const customerId = currentUser(request).id;
      const ids = { subscriptionId: request.params.id, visitId: request.params.visitId, customerId };
      await requestMove(deps(), ids, new Date(request.body.startsAt));
      return { subscription: await loadSubscription(request.params.id, customerId) };
    },
  );

  app.post<{ Params: { id: string; visitId: string } }>(
    '/subscriptions/:id/visits/:visitId/move/withdraw',
    { preHandler: guards.customer, schema: { params: visitParams } },
    async (request) => {
      const customerId = currentUser(request).id;
      await withdrawMove(deps(), { subscriptionId: request.params.id, visitId: request.params.visitId, customerId });
      return { subscription: await loadSubscription(request.params.id, customerId) };
    },
  );

  // After the minimum term a plan can be cancelled with 30 days' notice (D77). Visits until then still take
  // place and are charged (the last part-month pro rata); later visits are cancelled.
  app.post<{ Params: { id: string } }>(
    '/subscriptions/:id/cancel',
    { preHandler: guards.customer, schema: { params: idParams } },
    async (request) => {
      const customerId = currentUser(request).id;
      const found = await pool.query<{ stripe_subscription_id: string | null; status: string; in_term: boolean; ends_at: Date | null }>(
        `SELECT stripe_subscription_id, status, ends_at,
           started_at IS NULL OR now() < started_at + make_interval(months => min_term_months) AS in_term
         FROM subscriptions WHERE id = $1 AND customer_id = $2`,
        [request.params.id, customerId],
      );
      const row = found.rows[0];
      if (!row) {
        throw notFound();
      }
      if (row.status === 'awaiting_payment') {
        await dropUnpaidSubscription(deps(), request.params.id);
        return { subscription: await loadSubscription(request.params.id, customerId) };
      }
      if (row.status === 'cancelled' || row.ends_at) {
        throw conflict('already_cancelled');
      }
      if (row.in_term) {
        throw conflict('in_minimum_term');
      }
      const endsAt = new Date(Date.now() + CANCEL_NOTICE_DAYS * 24 * 3600 * 1000);
      if (row.stripe_subscription_id) {
        await gateway.cancelSubscriptionAt(row.stripe_subscription_id, endsAt);
      }
      await withTransaction(pool, async (client) => {
        await client.query('UPDATE subscriptions SET ends_at = $2, updated_at = now() WHERE id = $1', [request.params.id, endsAt]);
        await client.query(
          `UPDATE subscription_visits SET status = 'cancelled'
           WHERE subscription_id = $1 AND status IN ('pending', 'planned') AND ends_at > $2`,
          [request.params.id, endsAt],
        );
        // A move to a time after the end can no longer happen.
        await client.query(
          `UPDATE subscription_visit_moves m SET status = 'withdrawn', responded_at = now()
           FROM subscription_visits v
           WHERE m.subscription_id = $1 AND m.status = 'pending' AND v.id = m.visit_id
             AND (v.status <> 'planned' OR m.to_ends_at > $2)`,
          [request.params.id, endsAt],
        );
      });
      request.log.info({ event: 'subscription_cancelled', subscriptionId: request.params.id, endsAt });
      // Paused visits after the new end would not take place anyway: their credit is taken back (D78). A failure
      // here is retried by the planning job.
      await settlePausesAfterPlanEnd(deps(), request.params.id).catch((error: unknown) =>
        request.log.error({ event: 'pause_settle_after_cancel_failed', subscriptionId: request.params.id, err: error }),
      );
      return { subscription: await loadSubscription(request.params.id, customerId) };
    },
  );

  // ---------- Pausing (D78) ----------

  app.get<{ Params: { id: string } }>(
    '/subscriptions/:id/pause-options',
    { preHandler: guards.customer, schema: { params: idParams } },
    async (request) => pauseOptions(pool, { subscriptionId: request.params.id, customerId: currentUser(request).id }, config.timezone),
  );

  app.post<{ Params: { id: string }; Body: { startsOn: string; weeks: number } }>(
    '/subscriptions/:id/pause',
    {
      preHandler: guards.customer,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['startsOn', 'weeks'],
          additionalProperties: false,
          properties: {
            startsOn: { type: 'string', format: 'date' },
            weeks: { type: 'integer', minimum: 1, maximum: 8 },
          },
        },
      },
    },
    async (request) => {
      const customerId = currentUser(request).id;
      await createPause(deps(), { subscriptionId: request.params.id, customerId }, request.body);
      return { subscription: await loadSubscription(request.params.id, customerId) };
    },
  );

  app.post<{ Params: { id: string; pauseId: string } }>(
    '/subscriptions/:id/pause/:pauseId/cancel',
    {
      preHandler: guards.customer,
      schema: {
        params: {
          type: 'object',
          required: ['id', 'pauseId'],
          properties: { id: { type: 'string', format: 'uuid' }, pauseId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request) => {
      const customerId = currentUser(request).id;
      await callOffPause(deps(), { subscriptionId: request.params.id, customerId, pauseId: request.params.pauseId });
      return { subscription: await loadSubscription(request.params.id, customerId) };
    },
  );

  // ---------- Pros ----------

  app.get('/pro/plans', { preHandler: guards.pro }, async (request) => {
    const proId = currentUser(request).id;
    const result = await pool.query(
      `SELECT ${PLAN_COLUMNS},
         (SELECT count(*)::int FROM subscriptions s WHERE s.plan_id = p.id AND s.pro_id = $1 AND s.status = 'active') AS "mySubscribers"
       FROM ${PLAN_FROM}
       WHERE p.status = 'published' AND c.active
         AND EXISTS (SELECT 1 FROM pro_trades t WHERE t.pro_id = $1 AND t.category_id = p.category_id)
       ORDER BY c.sort_order, p.name`,
      [proId],
    );
    return {
      plans: result.rows.map((plan) => ({
        ...plan,
        earningsPerMonthCents: proShareCents(plan.priceCents, plan.proSharePct),
        visitsPerMonth: VISITS_PER_MONTH[plan.frequency as Frequency],
      })),
    };
  });

  // Customers' requests to move one visit (D77), for the pro to accept or decline.
  app.get('/pro/visit-moves', { preHandler: guards.pro }, async (request) => ({
    moves: await pendingMovesForPro(pool, currentUser(request).id),
  }));

  app.post<{ Params: { id: string } }>(
    '/pro/visit-moves/:id/accept',
    { preHandler: guards.pro, schema: { params: idParams } },
    async (request) => {
      const proId = currentUser(request).id;
      await acceptMove(deps(), request.params.id, proId);
      return { moves: await pendingMovesForPro(pool, proId) };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/pro/visit-moves/:id/decline',
    { preHandler: guards.pro, schema: { params: idParams } },
    async (request) => {
      const proId = currentUser(request).id;
      await declineMove(deps(), request.params.id, proId);
      return { moves: await pendingMovesForPro(pool, proId) };
    },
  );

  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/pro/visits',
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
      const result = await pool.query<{ priceCents: number; proSharePct: number; frequency: Frequency }>(
        `SELECT v.id, v.subscription_id AS "subscriptionId", v.starts_at AS "startsAt", v.ends_at AS "endsAt", v.status,
           v.tasks_done AS "tasksDone", s.tasks, s.plan_name AS "planName", s.address, s.postcode, s.notes,
           cu.first_name AS "customerName", s.price_cents AS "priceCents", s.pro_share_pct AS "proSharePct", s.frequency
         FROM subscription_visits v JOIN subscriptions s ON s.id = v.subscription_id JOIN users cu ON cu.id = s.customer_id
         WHERE v.pro_id = $1 AND v.status IN ('planned', 'completed') AND v.starts_at >= $2 AND v.starts_at < $3
         ORDER BY v.starts_at`,
        [currentUser(request).id, from, to],
      );
      return {
        visits: result.rows.map(({ priceCents, proSharePct, frequency, ...visit }) => ({
          ...visit,
          // What one visit is worth: the monthly share spread over the month's visits.
          earningsCents: Math.round(proShareCents(priceCents, proSharePct) / VISITS_PER_MONTH[frequency]),
        })),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/pro/visits/:id',
    { preHandler: guards.pro, schema: { params: idParams } },
    async (request) => {
      const found = await pool.query<{ priceCents: number; proSharePct: number; frequency: Frequency }>(
        `SELECT v.id, v.subscription_id AS "subscriptionId", v.starts_at AS "startsAt", v.ends_at AS "endsAt", v.status,
           v.tasks_done AS "tasksDone", s.tasks, s.plan_name AS "planName", s.address, s.postcode, s.notes, s.size,
           cu.first_name AS "customerName", s.price_cents AS "priceCents", s.pro_share_pct AS "proSharePct", s.frequency
         FROM subscription_visits v JOIN subscriptions s ON s.id = v.subscription_id JOIN users cu ON cu.id = s.customer_id
         WHERE v.id = $1 AND v.pro_id = $2`,
        [request.params.id, currentUser(request).id],
      );
      const row = found.rows[0];
      if (!row) {
        throw notFound();
      }
      const { priceCents, proSharePct, frequency, ...visit } = row;
      return { visit: { ...visit, earningsCents: Math.round(proShareCents(priceCents, proSharePct) / VISITS_PER_MONTH[frequency]) } };
    },
  );

  app.post<{ Params: { id: string }; Body: { tasksDone: string[] } }>(
    '/pro/visits/:id/complete',
    {
      preHandler: guards.pro,
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['tasksDone'],
          additionalProperties: false,
          properties: { tasksDone: { type: 'array', maxItems: 12, uniqueItems: true, items: { type: 'string', maxLength: 60 } } },
        },
      },
    },
    async (request) => {
      const proId = currentUser(request).id;
      const found = await pool.query<{ tasks: string[]; status: string; too_early: boolean }>(
        `SELECT s.tasks, v.status, v.starts_at > now() + interval '12 hours' AS too_early
         FROM subscription_visits v JOIN subscriptions s ON s.id = v.subscription_id
         WHERE v.id = $1 AND v.pro_id = $2`,
        [request.params.id, proId],
      );
      const visit = found.rows[0];
      if (!visit) {
        throw notFound();
      }
      if (visit.status !== 'planned') {
        throw conflict('invalid_status');
      }
      if (visit.too_early) {
        throw conflict('visit_not_started');
      }
      if (request.body.tasksDone.some((task) => !visit.tasks.includes(task))) {
        throw badRequest('unknown_task');
      }
      const done = await pool.query(
        `UPDATE subscription_visits SET status = 'completed', tasks_done = $3, completed_at = now()
         WHERE id = $1 AND pro_id = $2 AND status = 'planned'
         RETURNING id, starts_at AS "startsAt", status, tasks_done AS "tasksDone"`,
        [request.params.id, proId, request.body.tasksDone],
      );
      request.log.info({ event: 'subscription_visit_completed', visitId: request.params.id, proId });
      return { visit: done.rows[0] };
    },
  );
}
