import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { isForeignKeyViolation, uuidParams } from '../http.js';

export const FREQUENCIES = ['every_2_weeks', 'weekly', 'twice_weekly', 'three_times_weekly'] as const;
type Frequency = (typeof FREQUENCIES)[number];

/** Average visits per month for each frequency (4.33 weeks a month). */
export const VISITS_PER_MONTH: Record<Frequency, number> = {
  every_2_weeks: 2.2,
  weekly: 4.3,
  twice_weekly: 8.7,
  three_times_weekly: 13,
};

export interface PlanBody {
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
  skipsPerMonth: number;
  minTermMonths: number;
  proSharePct: number;
}

const month = { anyOf: [{ type: 'integer', minimum: 1, maximum: 12 }, { type: 'null' }] } as const;
const planProperties = {
  name: { type: 'string', minLength: 1, maxLength: 80, pattern: '\\S' },
  categoryId: { type: 'string', format: 'uuid' },
  priceCents: { type: 'integer', minimum: 500, maximum: 99_900 },
  frequency: { type: 'string', enum: FREQUENCIES },
  visitMinutes: { type: 'integer', minimum: 15, maximum: 600, multipleOf: 15 },
  tasks: {
    type: 'array',
    minItems: 1,
    maxItems: 12,
    items: { type: 'string', minLength: 1, maxLength: 60, pattern: '\\S' },
  },
  addonName: { anyOf: [{ type: 'string', minLength: 1, maxLength: 80, pattern: '\\S' }, { type: 'null' }] },
  addonPriceCents: { anyOf: [{ type: 'integer', minimum: 0, maximum: 99_900 }, { type: 'null' }] },
  seasonal: { type: 'boolean' },
  seasonFrom: month,
  seasonTo: month,
  skipsPerMonth: { type: 'integer', minimum: 0, maximum: 8 },
  minTermMonths: { type: 'integer', minimum: 0, maximum: 12 },
  proSharePct: { type: 'integer', minimum: 50, maximum: 90 },
} as const;

const PLAN_COLUMNS = `p.id, p.name, p.category_id AS "categoryId", c.name AS "categoryName", c.icon AS "categoryIcon",
  p.price_cents AS "priceCents", p.frequency, p.visit_minutes AS "visitMinutes", p.tasks,
  p.addon_name AS "addonName", p.addon_price_cents AS "addonPriceCents", p.seasonal,
  p.season_from AS "seasonFrom", p.season_to AS "seasonTo", p.skips_per_month AS "skipsPerMonth",
  p.min_term_months AS "minTermMonths", p.pro_share_pct AS "proSharePct", p.status,
  p.published_at AS "publishedAt", p.updated_at AS "updatedAt"`;
const PLAN_FROM = 'plans p JOIN categories c ON c.id = p.category_id';

/** Checks rules that span fields and returns the cleaned values to store. */
function clean(body: PlanBody) {
  const tasks = body.tasks.map((task) => task.trim());
  if (new Set(tasks.map((task) => task.toLowerCase())).size !== tasks.length) {
    throw badRequest('duplicate_task');
  }
  const addonName = body.addonName?.trim() || null;
  if ((addonName === null) !== (body.addonPriceCents === null)) {
    throw badRequest('addon_incomplete');
  }
  if (body.seasonal && (body.seasonFrom === null || body.seasonTo === null)) {
    throw badRequest('season_incomplete');
  }
  return [
    body.name.trim(),
    body.categoryId,
    body.priceCents,
    body.frequency,
    body.visitMinutes,
    tasks,
    addonName,
    addonName === null ? null : body.addonPriceCents,
    body.seasonal,
    body.seasonal ? body.seasonFrom : null,
    body.seasonal ? body.seasonTo : null,
    body.skipsPerMonth,
    body.minTermMonths,
    body.proSharePct,
  ];
}

export async function planRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards } = ctx;
  const planSchema = {
    type: 'object',
    required: Object.keys(planProperties),
    additionalProperties: false,
    properties: planProperties,
  } as const;

  async function loadPlan(id: string) {
    const found = await pool.query(`SELECT ${PLAN_COLUMNS} FROM ${PLAN_FROM} WHERE p.id = $1`, [id]);
    if (!found.rows[0]) {
      throw notFound();
    }
    return found.rows[0];
  }

  // Published plans, for the customer app.
  app.get('/plans', async () => {
    const result = await pool.query(
      `SELECT ${PLAN_COLUMNS} FROM ${PLAN_FROM} WHERE p.status = 'published' AND c.active ORDER BY c.sort_order, p.name`,
    );
    return { plans: result.rows };
  });

  app.get('/admin/plans', { preHandler: guards.admin }, async () => {
    const result = await pool.query(`SELECT ${PLAN_COLUMNS} FROM ${PLAN_FROM} ORDER BY p.status DESC, p.name`);
    return { plans: result.rows };
  });

  app.get<{ Params: { id: string } }>(
    '/admin/plans/:id',
    { preHandler: guards.admin, schema: { params: uuidParams } },
    async (request) => ({ plan: await loadPlan(request.params.id) }),
  );

  app.post<{ Body: PlanBody }>(
    '/admin/plans',
    { preHandler: guards.admin, schema: { body: planSchema } },
    async (request, reply) => {
      try {
        const created = await pool.query<{ id: string }>(
          `INSERT INTO plans (name, category_id, price_cents, frequency, visit_minutes, tasks, addon_name,
             addon_price_cents, seasonal, season_from, season_to, skips_per_month, min_term_months, pro_share_pct)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
          clean(request.body),
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
    async (request) => {
      try {
        const updated = await pool.query(
          `UPDATE plans SET name = $2, category_id = $3, price_cents = $4, frequency = $5, visit_minutes = $6,
             tasks = $7, addon_name = $8, addon_price_cents = $9, seasonal = $10, season_from = $11, season_to = $12,
             skips_per_month = $13, min_term_months = $14, pro_share_pct = $15, updated_at = now()
           WHERE id = $1`,
          [request.params.id, ...clean(request.body)],
        );
        if (!updated.rowCount) {
          throw notFound();
        }
        request.log.info({ event: 'plan_updated', planId: request.params.id, by: currentUser(request).id });
        return { plan: await loadPlan(request.params.id) };
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          throw notFound('category_not_found');
        }
        throw error;
      }
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
    async (request) => {
      const { published } = request.body;
      const updated = await pool.query(
        `UPDATE plans SET status = $2, published_at = CASE WHEN $2 = 'published' THEN now() ELSE published_at END,
           updated_at = now()
         WHERE id = $1 AND status <> $2`,
        [request.params.id, published ? 'published' : 'draft'],
      );
      if (!updated.rowCount) {
        await loadPlan(request.params.id);
        throw conflict(published ? 'already_published' : 'not_published');
      }
      request.log.info({ event: published ? 'plan_published' : 'plan_unpublished', planId: request.params.id });
      return { plan: await loadPlan(request.params.id) };
    },
  );
}
