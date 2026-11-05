import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import type { AppContext } from '../context.js';
import { conflict, notFound } from '../errors.js';
import { isForeignKeyViolation, uuidParams } from '../http.js';

export const FREQUENCIES = ['every_2_weeks', 'weekly', 'twice_weekly', 'three_times_weekly'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

/** Average visits per month for each frequency (4.33 weeks a month). */
export const VISITS_PER_MONTH: Record<Frequency, number> = {
  every_2_weeks: 2.2,
  weekly: 4.3,
  twice_weekly: 8.7,
  three_times_weekly: 13,
};

/** Days a customer picks per week for each frequency. */
export const DAYS_PER_WEEK: Record<Frequency, number> = {
  every_2_weeks: 1,
  weekly: 1,
  twice_weekly: 2,
  three_times_weekly: 3,
};

/** Seasonal plans run from April to October and pause in winter (from the design). */
export const SEASON_FROM = 4;
export const SEASON_TO = 10;
export const MIN_PLAN_PRICE_CENTS = 500;

export interface PlanBody {
  name: string | null;
  categoryId: string | null;
  priceCents: number | null;
  frequency: Frequency;
  visitMinutes: number;
  tasks: string[];
  addonName: string | null;
  addonPriceCents: number | null;
  seasonal: boolean;
  skipsPerMonth: number;
  minTermMonths: number;
  proSharePct: number;
}

export type MissingField = 'name' | 'category' | 'price' | 'tasks' | 'addonPrice' | 'addonName';

const nullable = <T extends object>(schema: T) => ({ anyOf: [schema, { type: 'null' }] });
const planProperties = {
  name: nullable({ type: 'string', maxLength: 80 }),
  categoryId: nullable({ type: 'string', format: 'uuid' }),
  priceCents: nullable({ type: 'integer', minimum: 0, maximum: 99_900 }),
  frequency: { type: 'string', enum: FREQUENCIES },
  visitMinutes: { type: 'integer', minimum: 15, maximum: 600, multipleOf: 15 },
  tasks: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 60, pattern: '\\S' } },
  addonName: nullable({ type: 'string', maxLength: 80 }),
  addonPriceCents: nullable({ type: 'integer', minimum: 0, maximum: 99_900 }),
  seasonal: { type: 'boolean' },
  skipsPerMonth: { type: 'integer', minimum: 0, maximum: 8 },
  minTermMonths: { type: 'integer', minimum: 0, maximum: 12 },
  proSharePct: { type: 'integer', minimum: 50, maximum: 90 },
} as const;

export const PLAN_COLUMNS = `p.id, p.name, p.category_id AS "categoryId", c.name AS "categoryName", c.icon AS "categoryIcon",
  p.price_cents AS "priceCents", p.frequency, p.visit_minutes AS "visitMinutes", p.tasks,
  p.addon_name AS "addonName", p.addon_price_cents AS "addonPriceCents", p.seasonal,
  p.season_from AS "seasonFrom", p.season_to AS "seasonTo", p.skips_per_month AS "skipsPerMonth",
  p.min_term_months AS "minTermMonths", p.pro_share_pct AS "proSharePct", p.status,
  p.published_at AS "publishedAt", p.updated_at AS "updatedAt"`;
export const PLAN_FROM = 'plans p LEFT JOIN categories c ON c.id = p.category_id';

/** Cleans a body for storing: trimmed text, no blank names, no duplicate tasks, the fixed season. */
function clean(body: PlanBody) {
  const seen = new Set<string>();
  const tasks = body.tasks.map((task) => task.trim()).filter((task) => {
    const key = task.toLowerCase();
    if (!task || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return {
    name: body.name?.trim() || null,
    categoryId: body.categoryId,
    priceCents: body.priceCents,
    frequency: body.frequency,
    visitMinutes: body.visitMinutes,
    tasks,
    addonName: body.addonName?.trim() || null,
    addonPriceCents: body.addonPriceCents,
    seasonal: body.seasonal,
    seasonFrom: body.seasonal ? SEASON_FROM : null,
    seasonTo: body.seasonal ? SEASON_TO : null,
    skipsPerMonth: body.skipsPerMonth,
    minTermMonths: body.minTermMonths,
    proSharePct: body.proSharePct,
  };
}

/** What a plan still needs before it can be published, in the order the form shows the fields. */
export function missingFields(plan: ReturnType<typeof clean>): MissingField[] {
  const missing: MissingField[] = [];
  if (!plan.name) missing.push('name');
  if (!plan.categoryId) missing.push('category');
  if (plan.priceCents === null || plan.priceCents < MIN_PLAN_PRICE_CENTS) missing.push('price');
  if (plan.tasks.length === 0) missing.push('tasks');
  if (plan.addonName !== null && plan.addonPriceCents === null) missing.push('addonPrice');
  if (plan.addonName === null && plan.addonPriceCents !== null) missing.push('addonName');
  return missing;
}

const values = (p: ReturnType<typeof clean>) => [
  p.name,
  p.categoryId,
  p.priceCents,
  p.frequency,
  p.visitMinutes,
  p.tasks,
  p.addonName,
  p.addonName === null ? null : p.addonPriceCents,
  p.seasonal,
  p.seasonFrom,
  p.seasonTo,
  p.skipsPerMonth,
  p.minTermMonths,
  p.proSharePct,
];

export async function planRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards } = ctx;
  const planSchema = {
    type: 'object',
    required: Object.keys(planProperties),
    additionalProperties: false,
    properties: planProperties,
  } as const;

  async function loadPlan(id: string) {
    const found = await pool.query(
      `SELECT ${PLAN_COLUMNS},
         (SELECT count(*)::int FROM subscriptions s WHERE s.plan_id = p.id AND s.status IN ('active', 'past_due')) AS subscribers
       FROM ${PLAN_FROM} WHERE p.id = $1`,
      [id],
    );
    if (!found.rows[0]) {
      throw notFound();
    }
    return found.rows[0];
  }

  // Published plans of active categories, for the customer and pro apps.
  app.get('/plans', async () => {
    const result = await pool.query(
      `SELECT ${PLAN_COLUMNS} FROM ${PLAN_FROM} WHERE p.status = 'published' AND c.active ORDER BY c.sort_order, p.name`,
    );
    return { plans: result.rows };
  });

  app.get('/admin/plans', { preHandler: guards.admin }, async () => {
    const result = await pool.query(
      `SELECT ${PLAN_COLUMNS},
         (SELECT count(*)::int FROM subscriptions s WHERE s.plan_id = p.id AND s.status IN ('active', 'past_due')) AS subscribers
       FROM ${PLAN_FROM} ORDER BY p.status DESC, p.name NULLS LAST`,
    );
    return { plans: result.rows };
  });

  app.get<{ Params: { id: string } }>(
    '/admin/plans/:id',
    { preHandler: guards.admin, schema: { params: uuidParams } },
    async (request) => ({ plan: await loadPlan(request.params.id) }),
  );

  // Drafts are saved however incomplete; the admin finishes them later.
  app.post<{ Body: PlanBody }>(
    '/admin/plans',
    { preHandler: guards.admin, schema: { body: planSchema } },
    async (request, reply) => {
      try {
        const created = await pool.query<{ id: string }>(
          `INSERT INTO plans (name, category_id, price_cents, frequency, visit_minutes, tasks, addon_name,
             addon_price_cents, seasonal, season_from, season_to, skips_per_month, min_term_months, pro_share_pct)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
          values(clean(request.body)),
        );
        const id = created.rows[0]?.id ?? '';
        request.log.info({ event: 'plan_created', planId: id, by: currentUser(request).id });
        return reply.code(201).send({ plan: await loadPlan(id) });
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          throw notFound('category_not_found');
        }
        throw error;
      }
    },
  );

  app.put<{ Params: { id: string }; Body: PlanBody }>(
    '/admin/plans/:id',
    { preHandler: guards.admin, schema: { params: uuidParams, body: planSchema } },
    async (request, reply) => {
      const plan = clean(request.body);
      const current = await loadPlan(request.params.id);
      // A live plan stays complete: customers can subscribe to it at any moment.
      const missing = missingFields(plan);
      if (current.status === 'published' && missing.length) {
        return reply.code(400).send({ error: 'plan_incomplete', missing });
      }
      try {
        await pool.query(
          `UPDATE plans SET name = $2, category_id = $3, price_cents = $4, frequency = $5, visit_minutes = $6,
             tasks = $7, addon_name = $8, addon_price_cents = $9, seasonal = $10, season_from = $11, season_to = $12,
             skips_per_month = $13, min_term_months = $14, pro_share_pct = $15, updated_at = now()
           WHERE id = $1`,
          [request.params.id, ...values(plan)],
        );
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          throw notFound('category_not_found');
        }
        throw error;
      }
      request.log.info({ event: 'plan_updated', planId: request.params.id, by: currentUser(request).id });
      return { plan: await loadPlan(request.params.id) };
    },
  );

  app.post<{ Params: { id: string }; Body: { published: boolean } }>(
    '/admin/plans/:id/status',
    {
      preHandler: guards.admin,
      schema: {
        params: uuidParams,
        body: { type: 'object', required: ['published'], additionalProperties: false, properties: { published: { type: 'boolean' } } },
      },
    },
    async (request, reply) => {
      const { published } = request.body;
      const plan = await loadPlan(request.params.id);
      if ((plan.status === 'published') === published) {
        throw conflict(published ? 'already_published' : 'not_published');
      }
      if (published) {
        const missing = missingFields(clean({ ...plan, tasks: plan.tasks }));
        if (missing.length) {
          return reply.code(400).send({ error: 'plan_incomplete', missing });
        }
      }
      await pool.query(
        `UPDATE plans SET status = $2, published_at = CASE WHEN $2 = 'published' THEN now() ELSE published_at END,
           updated_at = now()
         WHERE id = $1`,
        [request.params.id, published ? 'published' : 'draft'],
      );
      request.log.info({ event: published ? 'plan_published' : 'plan_unpublished', planId: request.params.id });
      return { plan: await loadPlan(request.params.id) };
    },
  );
}
