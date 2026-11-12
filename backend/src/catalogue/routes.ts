import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import type { AppContext } from '../context.js';
import { conflict, notFound } from '../errors.js';
import { isForeignKeyViolation, isUniqueViolation, uuidParams } from '../http.js';
import { onlyRow, withTransaction, type Queryable } from '../db.js';
import { logActivity } from '../settings/activity.js';

/** A service added this recently is marked "New", in the control panel and in the app. */
export const NEW_SERVICE_DAYS = 14;

type ChangeAction =
  | 'service_removed'
  | 'trade_added'
  | 'trade_published'
  | 'trade_unpublished'
  | 'trade_edited'
  | 'service_added'
  | 'service_edited'
  | 'price_changed'
  | 'service_hidden'
  | 'service_shown';

/** Writes one line in the catalogue's activity log. */
async function logChange(
  db: Queryable,
  input: { adminId: string; categoryId: string; serviceId?: string | null; action: ChangeAction; details?: Record<string, unknown> },
) {
  await db.query('INSERT INTO catalogue_changes (admin_id, category_id, service_id, action, details) VALUES ($1, $2, $3, $4, $5)', [
    input.adminId,
    input.categoryId,
    input.serviceId ?? null,
    input.action,
    JSON.stringify(input.details ?? {}),
  ]);
}

/** "Window cleaning" → "window-cleaning"; letters outside a–z are dropped after removing accents. */
export function slugify(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 34)
      .replace(/-+$/g, '') || 'trade'
  );
}

export const ICONS = ['leaf', 'hammer', 'drop', 'bolt', 'sparkle', 'brush', 'wrench', 'sun'] as const;

const SERVICE_COLUMNS = `s.id, s.category_id AS "categoryId", s.name, s.description, s.price_cents AS "priceCents",
  s.duration_minutes AS "durationMinutes", s.size_small_pct AS "sizeSmallPct", s.size_medium_pct AS "sizeMediumPct",
  s.size_large_pct AS "sizeLargePct", s.sort_order AS "sortOrder", s.active, s.pricing,
  s.created_at > now() - make_interval(days => ${NEW_SERVICE_DAYS}) AS "isNew"`;

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
  pricing: { type: 'string', enum: ['fixed', 'hourly'] },
} as const;

type CategoryBody = { slug?: string; name: string; icon: string; sortOrder?: number; active?: boolean };
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
  pricing?: 'fixed' | 'hourly';
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
  pricing: 'pricing',
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
      pool.query<{ feeCents: number; proSharePct: number }>(
        'SELECT service_fee_cents AS "feeCents", pro_share_pct AS "proSharePct" FROM settings',
      ),
    ]);
    return {
      timezone: ctx.config.timezone,
      feeCents: onlyRow(settings).feeCents,
      // The customer app shows how much of a tip goes to the pro (D34).
      proSharePct: onlyRow(settings).proSharePct,
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
    const [categories, services, settings, changes] = await Promise.all([
      pool.query(
        `SELECT c.id, c.slug, c.name, c.icon, c.sort_order AS "sortOrder", c.active,
           (SELECT count(*)::int FROM services s WHERE s.category_id = c.id AND s.active) AS "visibleServices",
           (SELECT count(*)::int FROM services s WHERE s.category_id = c.id AND s.removed_at IS NULL) AS "totalServices",
           (SELECT count(*)::int FROM pro_trades t JOIN pro_profiles p ON p.user_id = t.pro_id
              WHERE t.category_id = c.id AND p.status NOT IN ('draft', 'rejected')) AS pros,
           (SELECT count(*)::int FROM pro_trades t JOIN pro_profiles p ON p.user_id = t.pro_id
              WHERE t.category_id = c.id AND p.status = 'approved') AS "verifiedPros"
         FROM categories c ORDER BY c.sort_order, c.name`,
      ),
      // Removed services stay only for the bookings made with them.
      pool.query(`SELECT ${SERVICE_COLUMNS} FROM services s WHERE s.removed_at IS NULL ORDER BY s.sort_order, s.name`),
      pool.query<{ proSharePct: number }>('SELECT pro_share_pct AS "proSharePct" FROM settings'),
      pool.query(
        `SELECT ch.id, ch.category_id AS "categoryId", ch.service_id AS "serviceId", ch.action, ch.details,
           ch.created_at AS "createdAt", s.name AS "serviceName", COALESCE(u.email, u.username) AS "adminName"
         FROM catalogue_changes ch LEFT JOIN services s ON s.id = ch.service_id LEFT JOIN users u ON u.id = ch.admin_id
         ORDER BY ch.id DESC LIMIT 300`,
      ),
    ]);
    return {
      categories: categories.rows,
      services: services.rows,
      proSharePct: onlyRow(settings).proSharePct,
      // The customer app's address, for "See in the app".
      appUrl: ctx.config.webOrigin,
      changes: changes.rows,
    };
  });

  app.post<{ Body: CategoryBody }>(
    '/admin/categories',
    {
      preHandler: guards.admin,
      schema: {
        body: { type: 'object', required: ['name', 'icon'], additionalProperties: false, properties: categoryProperties },
      },
    },
    // A new trade is a draft: hidden from customers until the team publishes it.
    async (request, reply) => {
      const { name, icon, sortOrder = 0, active = false } = request.body;
      const chosenSlug = request.body.slug;
      const base = chosenSlug ?? slugify(name);
      // Without a chosen slug, "window-cleaning" becomes "window-cleaning-2" when the first is taken.
      for (let attempt = 1; attempt <= (chosenSlug ? 1 : 20); attempt += 1) {
        const slug = attempt === 1 ? base : `${base}-${attempt}`;
        try {
          const category = await withTransaction(pool, async (client) => {
            const result = await client.query<{ id: string }>(
              `INSERT INTO categories (slug, name, icon, sort_order, active) VALUES ($1, $2, $3, $4, $5)
               RETURNING id, slug, name, icon, sort_order AS "sortOrder", active`,
              [slug, name.trim(), icon, sortOrder, active],
            );
            const row = onlyRow(result);
            await logChange(client, { adminId: currentUser(request).id, categoryId: row.id, action: 'trade_added', details: { name: name.trim() } });
            return row;
          });
          return reply.code(201).send({ category });
        } catch (error) {
          if (!isUniqueViolation(error)) {
            throw error;
          }
        }
      }
      throw conflict('slug_taken');
    },
  );

  /**
   * Removes a trade and its services for good. Only a trade nothing depends on can go: bookings, monthly
   * plans and pros' profiles keep pointing at their trade, so such a trade can only be unpublished.
   */
  app.delete<{ Params: { id: string } }>(
    '/admin/categories/:id',
    { preHandler: guards.admin, schema: { params: uuidParams } },
    async (request, reply) => {
      const categoryId = request.params.id;
      const adminId = currentUser(request).id;
      try {
        const name = await withTransaction(pool, async (client) => {
          const found = await client.query<{ name: string }>('SELECT name FROM categories WHERE id = $1 FOR UPDATE', [categoryId]);
          const category = found.rows[0];
          if (!category) {
            throw notFound();
          }
          const uses = onlyRow(
            await client.query<{ bookings: number; plans: number; pros: number }>(
              `SELECT
                 (SELECT count(*)::int FROM bookings WHERE category_id = $1)
                 + (SELECT count(*)::int FROM subscriptions WHERE category_id = $1) AS bookings,
                 (SELECT count(*)::int FROM plans WHERE category_id = $1) AS plans,
                 (SELECT count(*)::int FROM pro_trades WHERE category_id = $1) AS pros`,
              [categoryId],
            ),
          );
          if (uses.bookings > 0) throw conflict('trade_has_bookings');
          if (uses.plans > 0) throw conflict('trade_has_plans');
          if (uses.pros > 0) throw conflict('trade_has_pros');
          // Its services and change log go with it.
          await client.query('DELETE FROM catalogue_changes WHERE category_id = $1', [categoryId]);
          await client.query('DELETE FROM services WHERE category_id = $1', [categoryId]);
          await client.query('DELETE FROM categories WHERE id = $1', [categoryId]);
          await logActivity(client, { adminId, area: 'catalogue', action: 'trade_removed', details: { name: category.name } });
          return category.name;
        });
        request.log.info({ event: 'trade_removed', categoryId, name, by: adminId });
        return reply.code(204).send();
      } catch (error) {
        // Something started using the trade at the same moment: it stays.
        if (isForeignKeyViolation(error)) {
          throw conflict('trade_in_use');
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
        const category = await withTransaction(pool, async (client) => {
          const before = await client.query<{ active: boolean }>('SELECT active FROM categories WHERE id = $1 FOR UPDATE', [
            request.params.id,
          ]);
          const old = before.rows[0];
          if (!old) {
            throw notFound();
          }
          const result = await client.query(
            `UPDATE categories SET ${set.sql} WHERE id = $1 RETURNING id, slug, name, icon, sort_order AS "sortOrder", active`,
            [request.params.id, ...set.values],
          );
          const { active, ...rest } = request.body;
          const adminId = currentUser(request).id;
          if (active !== undefined && active !== old.active) {
            await logChange(client, {
              adminId,
              categoryId: request.params.id,
              action: active ? 'trade_published' : 'trade_unpublished',
            });
          }
          if (Object.keys(rest).length > 0) {
            await logChange(client, { adminId, categoryId: request.params.id, action: 'trade_edited', details: rest });
          }
          return result.rows[0];
        });
        return { category };
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
        const service = await withTransaction(pool, async (client) => {
          const result = await client.query<{ id: string }>(
          `INSERT INTO services AS s (category_id, name, description, price_cents, duration_minutes,
             size_small_pct, size_medium_pct, size_large_pct, sort_order, active, pricing)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${SERVICE_COLUMNS}`,
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
            b.pricing ?? 'fixed',
          ],
          );
          const row = onlyRow(result);
          await logChange(client, {
            adminId: currentUser(request).id,
            categoryId: b.categoryId,
            serviceId: row.id,
            action: 'service_added',
            details: { name: b.name.trim(), priceCents: b.priceCents, pricing: b.pricing ?? 'fixed' },
          });
          return row;
        });
        return reply.code(201).send({ service });
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          throw notFound('category_not_found');
        }
        throw error;
      }
    },
  );

  /**
   * Removes a service from the catalogue. One that was never booked is deleted, and its lines in the change
   * log keep its name. One with bookings stays in the database for those bookings but is hidden everywhere.
   */
  app.delete<{ Params: { id: string } }>(
    '/admin/services/:id',
    { preHandler: guards.admin, schema: { params: uuidParams } },
    async (request, reply) => {
      const serviceId = request.params.id;
      const adminId = currentUser(request).id;
      const result = await withTransaction(pool, async (client) => {
        const found = await client.query<{ categoryId: string; name: string }>(
          `SELECT category_id AS "categoryId", name FROM services WHERE id = $1 AND removed_at IS NULL FOR UPDATE`,
          [serviceId],
        );
        const service = found.rows[0];
        if (!service) {
          throw notFound();
        }
        const booked = onlyRow(
          await client.query<{ n: number }>('SELECT count(*)::int AS n FROM bookings WHERE service_id = $1', [serviceId]),
        ).n;
        if (booked > 0) {
          await client.query('UPDATE services SET active = false, removed_at = now() WHERE id = $1', [serviceId]);
          await logChange(client, {
            adminId,
            categoryId: service.categoryId,
            serviceId,
            action: 'service_removed',
            details: { name: service.name, keptForBookings: booked },
          });
        } else {
          // The service's earlier log lines keep its name once it is gone.
          await client.query(
            `UPDATE catalogue_changes SET details = details || jsonb_build_object('name', $2::text), service_id = NULL
             WHERE service_id = $1`,
            [serviceId, service.name],
          );
          await client.query('DELETE FROM services WHERE id = $1', [serviceId]);
          await logChange(client, { adminId, categoryId: service.categoryId, action: 'service_removed', details: { name: service.name } });
        }
        return { ...service, booked };
      });
      request.log.info({ event: 'service_removed', serviceId, kept: result.booked > 0, by: adminId });
      return reply.code(204).send();
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
        // Bookings keep the price they were made at, so a new price only applies to new bookings.
        const service = await withTransaction(pool, async (client) => {
          const before = await client.query<{ category_id: string; price_cents: number; active: boolean }>(
            'SELECT category_id, price_cents, active FROM services WHERE id = $1 AND removed_at IS NULL FOR UPDATE',
            [request.params.id],
          );
          const old = before.rows[0];
          if (!old) {
            throw notFound();
          }
          const result = await client.query<{ categoryId: string }>(
            `UPDATE services s SET ${set.sql} WHERE id = $1 RETURNING ${SERVICE_COLUMNS}`,
            [request.params.id, ...set.values],
          );
          const row = onlyRow(result);
          const { priceCents, active, ...rest } = request.body;
          const log = (action: ChangeAction, details: Record<string, unknown> = {}) =>
            logChange(client, { adminId: currentUser(request).id, categoryId: row.categoryId, serviceId: request.params.id, action, details });
          if (priceCents !== undefined && priceCents !== old.price_cents) {
            await log('price_changed', { from: old.price_cents, to: priceCents });
          }
          if (active !== undefined && active !== old.active) {
            await log(active ? 'service_shown' : 'service_hidden');
          }
          if (Object.keys(rest).length > 0) {
            await log('service_edited', { fields: Object.keys(rest) });
          }
          return row;
        });
        return { service };
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          throw notFound('category_not_found');
        }
        throw error;
      }
    },
  );
}

/** Postcodes are stored upper-case with single spaces, so "ab1 2cd" and "AB1  2CD" are the same. */
export function normalizePostcode(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, ' ');
}
