import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { conflict, notFound } from '../errors.js';
import { isForeignKeyViolation, isUniqueViolation, uuidParams } from '../http.js';
import { onlyRow } from '../db.js';

export const ICONS = ['leaf', 'hammer', 'drop', 'bolt', 'sparkle', 'brush', 'wrench', 'sun'] as const;

const SERVICE_COLUMNS = `s.id, s.category_id AS "categoryId", s.name, s.description, s.price_cents AS "priceCents",
  s.duration_minutes AS "durationMinutes", s.size_small_pct AS "sizeSmallPct", s.size_medium_pct AS "sizeMediumPct",
  s.size_large_pct AS "sizeLargePct", s.sort_order AS "sortOrder", s.active`;

const categoryProperties = {
  slug: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 40 },
  name: { type: 'string', minLength: 1, maxLength: 60, pattern: '\\S' },
  icon: { type: 'string', enum: ICONS },
  sortOrder: { type: 'integer', minimum: 0, maximum: 1000 },
  active: { type: 'boolean' },
} as const;

const pct = { type: 'integer', minimum: 50, maximum: 500 } as const;
const serviceProperties = {
  categoryId: { type: 'string', format: 'uuid' },
  name: { type: 'string', minLength: 1, maxLength: 80, pattern: '\\S' },
  description: { type: 'string', maxLength: 300 },
  priceCents: { type: 'integer', minimum: 100, maximum: 1_000_000 },
  durationMinutes: { type: 'integer', minimum: 15, maximum: 600, multipleOf: 15 },
  sizeSmallPct: pct,
  sizeMediumPct: pct,
  sizeLargePct: pct,
  sortOrder: { type: 'integer', minimum: 0, maximum: 1000 },
  active: { type: 'boolean' },
} as const;

const postcodeProperties = {
  name: { type: 'string', minLength: 1, maxLength: 80, pattern: '\\S' },
  lat: { type: 'number', minimum: -90, maximum: 90 },
  lng: { type: 'number', minimum: -180, maximum: 180 },
  active: { type: 'boolean' },
} as const;

type CategoryBody = { slug: string; name: string; icon: string; sortOrder?: number; active?: boolean };
type ServiceBody = {
  categoryId: string;
  name: string;
  description?: string;
  priceCents: number;
  durationMinutes: number;
  sizeSmallPct?: number;
  sizeMediumPct?: number;
  sizeLargePct?: number;
  sortOrder?: number;
  active?: boolean;
};

const CATEGORY_FIELDS: Record<string, string> = { slug: 'slug', name: 'name', icon: 'icon', sortOrder: 'sort_order', active: 'active' };
const SERVICE_FIELDS: Record<string, string> = {
  categoryId: 'category_id',
  name: 'name',
  description: 'description',
  priceCents: 'price_cents',
  durationMinutes: 'duration_minutes',
  sizeSmallPct: 'size_small_pct',
  sizeMediumPct: 'size_medium_pct',
  sizeLargePct: 'size_large_pct',
  sortOrder: 'sort_order',
  active: 'active',
};

/** Builds "col = $n" pairs from a validated body, using only the columns in `fields`. */
function updateSet(body: Record<string, unknown>, fields: Record<string, string>, firstIndex: number) {
  const columns: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(fields)) {
    if (body[key] !== undefined) {
      values.push(typeof body[key] === 'string' && key !== 'description' ? (body[key] as string).trim() : body[key]);
      columns.push(`${column} = $${firstIndex + values.length - 1}`);
    }
  }
  return { sql: columns.join(', '), values };
}

export async function catalogueRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards } = ctx;

  // Readable without signing in, so people can see what MISK offers before they sign up.
  app.get('/catalogue', async () => {
    const [categories, services, settings] = await Promise.all([
      pool.query(
        `SELECT c.id, c.slug, c.name, c.icon,
           (SELECT count(*)::int FROM pro_trades t JOIN pro_profiles p ON p.user_id = t.pro_id
            WHERE t.category_id = c.id AND p.status = 'approved') AS "approvedPros"
         FROM categories c WHERE c.active ORDER BY c.sort_order, c.name`,
      ),
      pool.query(`SELECT ${SERVICE_COLUMNS} FROM services s WHERE s.active ORDER BY s.sort_order, s.name`),
      pool.query<{ feeCents: number }>('SELECT service_fee_cents AS "feeCents" FROM settings'),
    ]);
    return {
      timezone: ctx.config.timezone,
      feeCents: onlyRow(settings).feeCents,
      categories: categories.rows.map((category) => ({
        ...category,
        services: services.rows.filter((service) => service.categoryId === category.id),
      })),
    };
  });

  app.get('/postcodes', async () => {
    const result = await pool.query('SELECT code, name FROM postcodes WHERE active ORDER BY code');
    return { postcodes: result.rows };
  });

  // ---------- Admin ----------

  app.get('/admin/catalogue', { preHandler: guards.admin }, async () => {
    const [categories, services] = await Promise.all([
      pool.query(
        'SELECT id, slug, name, icon, sort_order AS "sortOrder", active FROM categories ORDER BY sort_order, name',
      ),
      pool.query(`SELECT ${SERVICE_COLUMNS} FROM services s ORDER BY s.sort_order, s.name`),
    ]);
    return { categories: categories.rows, services: services.rows };
  });

  app.post<{ Body: CategoryBody }>(
    '/admin/categories',
    {
      preHandler: guards.admin,
      schema: {
        body: { type: 'object', required: ['slug', 'name', 'icon'], additionalProperties: false, properties: categoryProperties },
      },
    },
    async (request, reply) => {
      const { slug, name, icon, sortOrder = 0, active = true } = request.body;
      try {
        const result = await pool.query(
          `INSERT INTO categories (slug, name, icon, sort_order, active) VALUES ($1, $2, $3, $4, $5)
           RETURNING id, slug, name, icon, sort_order AS "sortOrder", active`,
          [slug, name.trim(), icon, sortOrder, active],
        );
        return reply.code(201).send({ category: result.rows[0] });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict('slug_taken');
        }
        throw error;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: Partial<CategoryBody> }>(
    '/admin/categories/:id',
    {
      preHandler: guards.admin,
      schema: {
        params: uuidParams,
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: categoryProperties },
      },
    },
    async (request) => {
      const set = updateSet(request.body, CATEGORY_FIELDS, 2);
      try {
        const result = await pool.query(
          `UPDATE categories SET ${set.sql} WHERE id = $1 RETURNING id, slug, name, icon, sort_order AS "sortOrder", active`,
          [request.params.id, ...set.values],
        );
        if (!result.rowCount) {
          throw notFound();
        }
        return { category: result.rows[0] };
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict('slug_taken');
        }
        throw error;
      }
    },
  );

  app.post<{ Body: ServiceBody }>(
    '/admin/services',
    {
      preHandler: guards.admin,
      schema: {
        body: {
          type: 'object',
          required: ['categoryId', 'name', 'priceCents', 'durationMinutes'],
          additionalProperties: false,
          properties: serviceProperties,
        },
      },
    },
    async (request, reply) => {
      const b = request.body;
      try {
        const result = await pool.query(
          `INSERT INTO services AS s (category_id, name, description, price_cents, duration_minutes,
             size_small_pct, size_medium_pct, size_large_pct, sort_order, active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${SERVICE_COLUMNS}`,
          [
            b.categoryId,
            b.name.trim(),
            b.description?.trim() ?? '',
            b.priceCents,
            b.durationMinutes,
            b.sizeSmallPct ?? 100,
            b.sizeMediumPct ?? 130,
            b.sizeLargePct ?? 170,
            b.sortOrder ?? 0,
            b.active ?? true,
          ],
        );
        return reply.code(201).send({ service: result.rows[0] });
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          throw notFound('category_not_found');
        }
        throw error;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: Partial<ServiceBody> }>(
    '/admin/services/:id',
    {
      preHandler: guards.admin,
      schema: {
        params: uuidParams,
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: serviceProperties },
      },
    },
    async (request) => {
      const set = updateSet(request.body, SERVICE_FIELDS, 2);
      try {
        const result = await pool.query(`UPDATE services s SET ${set.sql} WHERE id = $1 RETURNING ${SERVICE_COLUMNS}`, [
          request.params.id,
          ...set.values,
        ]);
        if (!result.rowCount) {
          throw notFound();
        }
        return { service: result.rows[0] };
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          throw notFound('category_not_found');
        }
        throw error;
      }
    },
  );

  app.get('/admin/postcodes', { preHandler: guards.admin }, async () => {
    const result = await pool.query('SELECT code, name, lat, lng, active FROM postcodes ORDER BY code');
    return { postcodes: result.rows };
  });

  app.put<{ Params: { code: string }; Body: { name: string; lat: number; lng: number; active?: boolean } }>(
    '/admin/postcodes/:code',
    {
      preHandler: guards.admin,
      schema: {
        params: { type: 'object', properties: { code: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9 -]{1,9}$' } } },
        body: { type: 'object', required: ['name', 'lat', 'lng'], additionalProperties: false, properties: postcodeProperties },
      },
    },
    async (request) => {
      const code = normalizePostcode(request.params.code);
      const { name, lat, lng, active = true } = request.body;
      const result = await pool.query(
        `INSERT INTO postcodes (code, name, lat, lng, active) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, lat = EXCLUDED.lat, lng = EXCLUDED.lng, active = EXCLUDED.active
         RETURNING code, name, lat, lng, active`,
        [code, name.trim(), lat, lng, active],
      );
      return { postcode: result.rows[0] };
    },
  );

  app.get('/admin/settings', { preHandler: guards.admin }, async () => {
    const result = await pool.query(
      'SELECT service_fee_cents AS "serviceFeeCents", pro_share_pct AS "proSharePct" FROM settings',
    );
    return { settings: result.rows[0] };
  });

  app.patch<{ Body: { serviceFeeCents?: number; proSharePct?: number } }>(
    '/admin/settings',
    {
      preHandler: guards.admin,
      schema: {
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: {
            serviceFeeCents: { type: 'integer', minimum: 0, maximum: 10_000 },
            proSharePct: { type: 'integer', minimum: 50, maximum: 95 },
          },
        },
      },
    },
    async (request) => {
      const { serviceFeeCents, proSharePct } = request.body;
      const result = await pool.query(
        `UPDATE settings SET service_fee_cents = COALESCE($1, service_fee_cents),
           pro_share_pct = COALESCE($2, pro_share_pct), updated_at = now()
         RETURNING service_fee_cents AS "serviceFeeCents", pro_share_pct AS "proSharePct"`,
        [serviceFeeCents ?? null, proSharePct ?? null],
      );
      request.log.info({ event: 'settings_changed', by: request.user?.id, serviceFeeCents, proSharePct });
      return { settings: result.rows[0] };
    },
  );
}

/** Postcodes are stored upper-case with single spaces, so "ab1 2cd" and "AB1  2CD" are the same. */
export function normalizePostcode(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, ' ');
}
