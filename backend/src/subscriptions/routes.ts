import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import type { BookingDeps } from '../bookings/events.js';
import { proShareCents } from '../catalogue/pricing.js';
import { normalizePostcode, POSTCODE_INPUT_MAX_LENGTH } from '../catalogue/routes.js';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import { ApiError, badRequest, conflict, notFound } from '../errors.js';
import type { PaymentMethodInfo, SubscriptionConfirm } from '../payments/gateway.js';
import { PAYMENT_CHOICES, type PaymentChoice } from '../bookings/customer-routes.js';
import {
  CANCEL_NOTICE_DAYS,
  DAYS_PER_WEEK,
  FREQUENCIES,
  PLAN_COLUMNS,
  PLAN_FROM,
  VISITS_PER_MONTH,
  type Frequency,
} from '../plans/routes.js';
import { callOffPause, createPause, pauseOptions, pausesOf, settlePausesAfterPlanEnd } from './pause.js';
import {
  acceptMove,
  declineMove,
  loadMovableVisit,
  moveBlock,
  moveDays,
  pendingMovesForPro,
  requestMove,
  withdrawMove,
} from './moves.js';
import {
  activateSubscription,
  BILLING_START,
  billingStart,
  chooseRegularPro,
  dayAnchor,
  dropUnpaidSubscription,
  firstVisitDay,
  monthlyPrice,
  plannedStarts,
  planVisits,
  recordPaidMonth,
  START_OFFSET_DAYS,
  SUBSCRIPTION_PATTERN,
  type PlanSize,
  type StartOption,
  type SubscriptionRow,
  type TimeWindow,
} from './service.js';
import { MAX_SKIPS_PER_MONTH, skipVisit, undoSkip } from './skips.js';

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
  /** How often the pro comes; the plan's own frequency when left out (D90). */
  frequency?: Frequency;
  size: PlanSize;
  days: number[];
  timeWindow: TimeWindow;
  /** When the first visit is (D90); as soon as possible when left out. */
  start?: StartOption;
  address: string;
  postcode: string;
  notes?: string;
  withAddon: boolean;
  /** How the first month is paid (D90); without it, a new card in the browser. */
  paymentMethod?: { type: PaymentChoice; cardId?: string };
  /** The customer ticked "I agree to the subscription terms" (D90). */
  acceptTerms: true;
}

/**
 * When a cancelled plan ends (D90): its minimum term's end, or 30 days' notice from now if that is later. The
 * minimum term counts from when billing starts, the first visit day (D91).
 */
const CANCEL_ENDS_AT = `GREATEST(${BILLING_START} + make_interval(months => s.min_term_months),
  now() + make_interval(days => ${CANCEL_NOTICE_DAYS}))`;

const SUBSCRIPTION_COLUMNS = `s.id, s.plan_id AS "planId", s.plan_name AS "planName", s.category_id AS "categoryId", s.tasks, s.size,
  s.frequency, s.days, s.time_window AS "timeWindow", s.visit_minutes AS "visitMinutes", s.address, s.postcode, s.notes,
  s.with_addon AS "withAddon", s.addon_name AS "addonName", s.price_cents AS "priceCents", s.seasonal,
  s.season_from AS "seasonFrom", s.season_to AS "seasonTo", s.min_term_months AS "minTermMonths",
  s.pause_notice_days AS "pauseNoticeDays", s.max_pause_weeks AS "maxPauseWeeks", s.status,
  s.billing_paused AS "billingPaused", s.started_at AS "startedAt",
  s.current_period_end AS "currentPeriodEnd", s.ends_at AS "endsAt", s.created_at AS "createdAt",
  pu.first_name AS "proName",
  (SELECT c.icon FROM categories c WHERE c.id = s.category_id) AS "categoryIcon",
  CASE WHEN s.status = 'awaiting_payment' THEN NULL ELSE ${BILLING_START} + make_interval(months => s.min_term_months) END AS "cancelableFrom",
  to_char(s.first_visit_on, 'YYYY-MM-DD') AS "firstVisitOn",
  -- When billing starts: the first visit day, or sign-up when the first month was charged at once (D91).
  ${BILLING_START} AS "billingStartsAt",
  -- The end of the minimum term, counted from when billing starts (D91), and when the plan would end if the
  -- customer cancelled now (D90).
  ${BILLING_START} + make_interval(months => s.min_term_months) AS "minTermEndsAt",
  ${CANCEL_ENDS_AT} AS "cancelEndsAt",
  (SELECT min(fv.starts_at) FROM subscription_visits fv
   WHERE fv.subscription_id = s.id AND fv.status IN ('pending', 'planned') AND fv.starts_at > now()) AS "nextVisitAt"`;

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

  /**
   * A customer's own plan, with the visits planned ahead, any move waiting for the pro (D77), its pauses (D78)
   * and the skips used in each visit's calendar month and this month (D90).
   */
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
         v.moved_from AS "movedFrom", v.skipped_at AS "skippedAt",
         (SELECT count(*)::int FROM subscription_visits x
          WHERE x.subscription_id = v.subscription_id AND x.status = 'skipped'
            AND date_trunc('month', x.starts_at AT TIME ZONE $2) = date_trunc('month', v.starts_at AT TIME ZONE $2)) AS "skipsUsedInMonth",
         -- The pause that called this visit off (D78), while that pause stands.
         (SELECT pz.id FROM subscription_pauses pz WHERE pz.id = v.paused_by AND pz.status = 'active') AS "pausedBy",
         (SELECT json_build_object('toStartsAt', m.to_starts_at, 'toEndsAt', m.to_ends_at, 'respondBy', m.respond_by)
          FROM subscription_visit_moves m WHERE m.visit_id = v.id AND m.status = 'pending') AS "pendingMove"
       FROM subscription_visits v WHERE v.subscription_id = $1 AND v.status <> 'pending'
         AND v.starts_at > now() - interval '14 days'
       ORDER BY v.starts_at LIMIT 40`,
      [id, config.timezone],
    );
    const skipped = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM subscription_visits
       WHERE subscription_id = $1 AND status = 'skipped'
         AND date_trunc('month', starts_at AT TIME ZONE $2) = date_trunc('month', now() AT TIME ZONE $2)`,
      [id, config.timezone],
    );
    return {
      ...subscription,
      visits: visits.rows,
      pauses: await pausesOf(pool, id),
      skipsPerMonth: MAX_SKIPS_PER_MONTH,
      skipsLeftThisMonth: Math.max(0, MAX_SKIPS_PER_MONTH - (skipped.rows[0]?.n ?? 0)),
    };
  }

  app.post<{ Body: SubscribeBody }>(
    '/subscriptions',
    {
      preHandler: guards.customer,
      schema: {
        body: {
          type: 'object',
          required: ['planId', 'size', 'days', 'timeWindow', 'address', 'postcode', 'withAddon', 'acceptTerms'],
          additionalProperties: false,
          properties: {
            planId: { type: 'string', format: 'uuid' },
            frequency: { type: 'string', enum: FREQUENCIES },
            size: { type: 'string', enum: ['S', 'M', 'L'] },
            days: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 7 } },
            timeWindow: { type: 'string', enum: ['morning', 'afternoon'] },
            start: { type: 'string', enum: Object.keys(START_OFFSET_DAYS) },
            address: { type: 'string', minLength: 3, maxLength: 200, pattern: '\\S' },
            postcode: { type: 'string', minLength: 2, maxLength: POSTCODE_INPUT_MAX_LENGTH },
            notes: { type: 'string', maxLength: 1000 },
            withAddon: { type: 'boolean' },
            paymentMethod: {
              type: 'object',
              required: ['type'],
              additionalProperties: false,
              properties: {
                type: { type: 'string', enum: PAYMENT_CHOICES },
                cardId: { type: 'string', minLength: 1, maxLength: 255 },
              },
            },
            // Ticking "I agree to the subscription terms" is required; anything but true is refused.
            acceptTerms: { type: 'boolean', const: true },
          },
        },
      },
    },
    async (request, reply) => {
      const customer = currentUser(request);
      const body = request.body;
      const plan = await publishedPlan(body.planId);
      const frequency = body.frequency ?? plan.frequency;
      // One day a week for every 2 weeks and once a week, two for twice and three for three times a week.
      if (body.days.length !== DAYS_PER_WEEK[frequency]) {
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
      // A saved card must be one of this customer's cards, checked before anything is held (as in D73).
      const choice: PaymentChoice = body.paymentMethod?.type ?? 'new_card';
      const cardId = choice === 'card' ? (body.paymentMethod?.cardId ?? null) : null;
      if (choice === 'card') {
        if (!cardId) {
          throw badRequest('card_not_found');
        }
        const owner = await pool.query<{ ref: string | null }>('SELECT stripe_customer_id AS ref FROM users WHERE id = $1', [customer.id]);
        const ref = owner.rows[0]?.ref ?? null;
        let cards: { id: string }[] = [];
        try {
          cards = ref ? await gateway.listCards(ref) : [];
        } catch (error) {
          request.log.error({ event: 'card_list_failed', err: error });
          throw new ApiError(502, 'payment_unavailable');
        }
        if (!cards.some((card) => card.id === cardId)) {
          throw badRequest('card_not_found');
        }
      }
      const days = [...body.days].sort();
      // The server's one pricing rule (D90): the Plan builder shows the same numbers, sent by /plans.
      const priceCents = monthlyPrice(plan, { frequency, size: body.size, withAddon: body.withAddon });

      const created = await withTransaction(pool, async (client) => {
        // One sign-up per trade at a time, so two customers cannot both take the last free pro.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`book:${plan.categoryId}`]);
        const seasonRule = { seasonal: plan.seasonal, seasonFrom: plan.seasonFrom, seasonTo: plan.seasonTo };
        const firstDay = await firstVisitDay(client, { days, start: body.start ?? 'asap', ...seasonRule }, config.timezone);
        if (!firstDay) {
          // A seasonal plan whose season ends before the first visit could be.
          throw conflict('off_season');
        }
        // Billing starts on the first visit day (D91), or now when that day begins within 24 hours.
        const billing = await billingStart(client, firstDay, config.timezone);
        const pattern = {
          days,
          frequency,
          timeWindow: body.timeWindow,
          visitMinutes: plan.visitMinutes,
          ...seasonRule,
          // Every-2-weeks plans visit in the first visit's week, then every other week.
          anchor: dayAnchor(firstDay),
          until: null,
          from: firstDay,
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
             season_from, season_to, skips_per_month, min_term_months, pause_notice_days, max_pause_weeks, pro_id,
             first_visit_on, terms_accepted_at, billing_starts_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $25, $21, $22, $23, $24,
             $26, now(), $27)
           RETURNING id, created_at`,
          [
            customer.id,
            plan.id,
            plan.categoryId,
            plan.name,
            plan.tasks,
            body.size,
            frequency,
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
            MAX_SKIPS_PER_MONTH,
            firstDay,
            billing.at,
          ],
        );
        const saved = inserted.rows[0];
        if (!saved) {
          throw new Error('Subscription insert returned nothing');
        }
        const row = { ...saved, billing };
        // The pro's time is held while the customer pays; the planner keeps it filled afterwards.
        await client.query(
          `INSERT INTO subscription_visits (subscription_id, pro_id, starts_at, ends_at, status)
           SELECT $1, $2, s, s + make_interval(mins => $4::int), 'pending' FROM unnest($3::timestamptz[]) AS s`,
          [row.id, proId, starts, plan.visitMinutes],
        );
        return row;
      });

      let payment: { clientSecret: string; confirm: SubscriptionConfirm } | null = null;
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
          ...(cardId ? { paymentMethodId: cardId } : {}),
          // Nothing is charged before the first visit day (D91), unless that day begins within 24 hours.
          ...(created.billing.chargeNow ? {} : { firstChargeAt: created.billing.at }),
        });
        await pool.query('UPDATE subscriptions SET stripe_subscription_id = $2 WHERE id = $1', [created.id, start.subscriptionId]);
        payment = start.clientSecret ? { clientSecret: start.clientSecret, confirm: start.confirm } : null;
        if (start.paid) {
          const periodEnd = new Date(created.billing.at);
          periodEnd.setMonth(periodEnd.getMonth() + 1);
          await recordPaidMonth(deps(), {
            subscriptionId: start.subscriptionId,
            // The real invoice id, so its paid-invoice webhook later finds this month already recorded.
            invoiceId: start.invoiceId ?? `first-${start.subscriptionId}`,
            amountCents: priceCents,
            periodEnd,
          });
        } else if (start.active) {
          // The saved card is now the plan's card (D91): the plan starts, and its first month is charged later.
          await activateSubscription(deps(), start.subscriptionId);
        }
      } catch (error) {
        request.log.error({ event: 'subscription_payment_start_failed', subscriptionId: created.id, err: error });
        await dropUnpaidSubscription(deps(), created.id);
        throw new ApiError(502, 'payment_unavailable');
      }
      request.log.info({ event: 'subscription_created', subscriptionId: created.id, customerId: customer.id, frequency, payment: choice });
      return reply.code(201).send({
        subscription: await loadSubscription(created.id, customer.id),
        payment: payment ? { ...payment, publishableKey: gateway.publishableKey } : null,
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

  // My plan (D90): the plan, and the card or wallet it is billed to, which only the payment provider knows.
  app.get<{ Params: { id: string } }>(
    '/subscriptions/:id',
    { preHandler: guards.customer, schema: { params: idParams } },
    async (request) => {
      const subscription = await loadSubscription(request.params.id, currentUser(request).id);
      const billing = await pool.query<{ ref: string | null }>('SELECT stripe_subscription_id AS ref FROM subscriptions WHERE id = $1', [
        request.params.id,
      ]);
      const ref = billing.rows[0]?.ref ?? null;
      let paymentMethod: PaymentMethodInfo | null = null;
      if (ref) {
        try {
          paymentMethod = await gateway.subscriptionPaymentMethod(ref);
        } catch (error) {
          // The page still works; it just does not name the card this time.
          request.log.error({ event: 'subscription_payment_method_failed', subscriptionId: request.params.id, err: error });
        }
      }
      return { subscription: { ...subscription, paymentMethod } };
    },
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
      const waiting = await gateway.subscriptionClientSecret(row.stripe_subscription_id);
      return { payment: waiting ? { ...waiting, publishableKey: gateway.publishableKey } : null };
    },
  );

  // The browser set up the card for a plan billed from its first visit day (D91): asks the payment provider and
  // starts the plan when the card is there, without waiting for the webhook. Answers the plan as it is now.
  app.post<{ Params: { id: string } }>(
    '/subscriptions/:id/payment/check',
    { preHandler: guards.customer, schema: { params: idParams } },
    async (request) => {
      const customerId = currentUser(request).id;
      const found = await pool.query<{ stripe_subscription_id: string | null; status: string }>(
        'SELECT stripe_subscription_id, status FROM subscriptions WHERE id = $1 AND customer_id = $2',
        [request.params.id, customerId],
      );
      const row = found.rows[0];
      if (!row) {
        throw notFound();
      }
      if (row.status === 'awaiting_payment' && row.stripe_subscription_id) {
        let ready = false;
        try {
          ready = await gateway.subscriptionCardReady(row.stripe_subscription_id);
        } catch (error) {
          // The webhook or the planning job starts the plan instead.
          request.log.error({ event: 'subscription_card_check_failed', subscriptionId: request.params.id, err: error });
        }
        if (ready) {
          await activateSubscription(deps(), row.stripe_subscription_id);
        }
      }
      return { subscription: await loadSubscription(request.params.id, customerId) };
    },
  );

  const visitParams = {
    type: 'object',
    required: ['id', 'visitId'],
    properties: { id: { type: 'string', format: 'uuid' }, visitId: { type: 'string', format: 'uuid' } },
  } as const;

  // Skipping a visit is back (D90): up to 2 a calendar month, until 24 hours before; a skip can be undone until then.
  app.post<{ Params: { id: string; visitId: string } }>(
    '/subscriptions/:id/visits/:visitId/skip',
    { preHandler: guards.customer, schema: { params: visitParams } },
    async (request) => {
      const customerId = currentUser(request).id;
      await skipVisit(deps(), { subscriptionId: request.params.id, visitId: request.params.visitId, customerId });
      return { subscription: await loadSubscription(request.params.id, customerId) };
    },
  );

  app.post<{ Params: { id: string; visitId: string } }>(
    '/subscriptions/:id/visits/:visitId/unskip',
    { preHandler: guards.customer, schema: { params: visitParams } },
    async (request) => {
      const customerId = currentUser(request).id;
      await undoSkip(deps(), { subscriptionId: request.params.id, visitId: request.params.visitId, customerId });
      return { subscription: await loadSubscription(request.params.id, customerId) };
    },
  );

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
        return { options: [], days: [], reason: block };
      }
      // The nearby days with whether the pro is free (D90); only free ones can be asked for.
      const days = await moveDays(pool, visit, config.timezone);
      const options = days.filter((day) => day.free).map(({ startsAt, endsAt }) => ({ startsAt, endsAt }));
      return { options, days, reason: options.length ? null : 'no_free_day' };
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

  // A plan can be cancelled at any time (D90): it ends when its minimum term is over, or 30 days from now if
  // that is later (the notice of D77). Visits until then still take place and are charged (the last part-month
  // pro rata); later visits are cancelled. "Keep my plan" takes the cancellation back until the end.
  app.post<{ Params: { id: string } }>(
    '/subscriptions/:id/cancel',
    { preHandler: guards.customer, schema: { params: idParams } },
    async (request) => {
      const customerId = currentUser(request).id;
      const found = await pool.query<{ stripe_subscription_id: string | null; status: string; ends_at: Date | null; cancel_ends_at: Date }>(
        `SELECT s.stripe_subscription_id, s.status, s.ends_at, ${CANCEL_ENDS_AT} AS cancel_ends_at
         FROM subscriptions s WHERE s.id = $1 AND s.customer_id = $2`,
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
      const endsAt = row.cancel_ends_at;
      if (row.stripe_subscription_id) {
        await gateway.cancelSubscriptionAt(row.stripe_subscription_id, endsAt);
      }
      await withTransaction(pool, async (client) => {
        const ended = await client.query('UPDATE subscriptions SET ends_at = $2, updated_at = now() WHERE id = $1 AND ends_at IS NULL', [
          request.params.id,
          endsAt,
        ]);
        if (!ended.rowCount) {
          // A second tap at the same moment.
          throw conflict('already_cancelled');
        }
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

  // "Keep my plan" (D90): takes a cancellation back while the plan has not ended. Billing goes on, the visits the
  // cancellation called off are planned again where the pro is still free, and the credit for paused visits after
  // the planned end, which the cancellation took back (D78), is given again.
  app.post<{ Params: { id: string } }>(
    '/subscriptions/:id/keep',
    { preHandler: guards.customer, schema: { params: idParams } },
    async (request) => {
      const customerId = currentUser(request).id;
      const found = await pool.query<{ stripe_subscription_id: string | null; status: string; ends_at: Date | null; ended: boolean }>(
        'SELECT stripe_subscription_id, status, ends_at, ends_at <= now() AS ended FROM subscriptions WHERE id = $1 AND customer_id = $2',
        [request.params.id, customerId],
      );
      const row = found.rows[0];
      if (!row) {
        throw notFound();
      }
      if (!row.ends_at || row.ended || (row.status !== 'active' && row.status !== 'past_due')) {
        throw conflict('not_cancelled');
      }
      const endedAt = row.ends_at;
      if (row.stripe_subscription_id) {
        await gateway.resumeSubscription(row.stripe_subscription_id);
      }
      await withTransaction(pool, async (client) => {
        const kept = await client.query<SubscriptionRow>(
          `UPDATE subscriptions SET ends_at = NULL, updated_at = now()
           WHERE id = $1 AND ends_at = $2 AND ends_at > now() AND status IN ('active', 'past_due')
           RETURNING ${SUBSCRIPTION_PATTERN}`,
          [request.params.id, endedAt],
        );
        const subscription = kept.rows[0];
        if (!subscription) {
          throw conflict('not_cancelled');
        }
        // The visits the cancellation called off never happened: they are planned again from scratch (paused
        // visits stay paused, past ones stay as they were).
        await client.query(
          `DELETE FROM subscription_visits
           WHERE subscription_id = $1 AND status = 'cancelled' AND paused_by IS NULL AND ends_at > $2 AND starts_at > now()`,
          [request.params.id, endedAt],
        );
        await planVisits(client, subscription, config.timezone, 'planned');
      });
      request.log.info({ event: 'subscription_kept', subscriptionId: request.params.id, endedAt });
      // A failure here is retried by the planning job.
      await settlePausesAfterPlanEnd(deps(), request.params.id).catch((error: unknown) =>
        request.log.error({ event: 'pause_settle_after_keep_failed', subscriptionId: request.params.id, err: error }),
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
         -- Skipped visits are listed as skipped, so the pro sees they are not expected then (D90).
         WHERE v.pro_id = $1 AND v.status IN ('planned', 'completed', 'skipped') AND v.starts_at >= $2 AND v.starts_at < $3
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
