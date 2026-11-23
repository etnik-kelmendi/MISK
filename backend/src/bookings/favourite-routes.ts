import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';

const proParams = {
  type: 'object',
  required: ['proId'],
  properties: { proId: { type: 'string', format: 'uuid' } },
} as const;

/** A pro counts as "worked for" a customer after a finished booking or plan visit for them. */
const WORKED_FOR_SQL = `(
  EXISTS (SELECT 1 FROM bookings WHERE customer_id = $1 AND pro_id = $2 AND status = 'completed')
  OR EXISTS (
    SELECT 1 FROM subscription_visits v JOIN subscriptions s ON s.id = v.subscription_id
    WHERE s.customer_id = $1 AND v.pro_id = $2 AND v.status = 'completed'
  )
)`;

/**
 * A customer's favourite pros (D83): saved with the heart after rating a job. Only a pro who did a job for
 * the customer can be saved; saving and removing are idempotent, so a double tap does no harm.
 */
export async function favouriteRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards } = ctx;

  app.put<{ Params: { proId: string } }>(
    '/favourites/pros/:proId',
    { preHandler: guards.customer, schema: { params: proParams } },
    async (request) => {
      const customerId = currentUser(request).id;
      const { proId } = request.params;
      const saved = await pool.query(
        `INSERT INTO customer_favourite_pros (customer_id, pro_id)
         SELECT $1, $2 WHERE ${WORKED_FOR_SQL}
         ON CONFLICT (customer_id, pro_id) DO NOTHING`,
        [customerId, proId],
      );
      if (!saved.rowCount) {
        // Already saved, or not a pro of this customer.
        const known = await pool.query('SELECT 1 FROM customer_favourite_pros WHERE customer_id = $1 AND pro_id = $2', [customerId, proId]);
        if (!known.rowCount) throw notFound('not_your_pro');
      }
      request.log.info({ event: 'favourite_pro_saved', proId });
      return { favourite: true };
    },
  );

  app.delete<{ Params: { proId: string } }>(
    '/favourites/pros/:proId',
    { preHandler: guards.customer, schema: { params: proParams } },
    async (request) => {
      await pool.query('DELETE FROM customer_favourite_pros WHERE customer_id = $1 AND pro_id = $2', [
        currentUser(request).id,
        request.params.proId,
      ]);
      request.log.info({ event: 'favourite_pro_removed', proId: request.params.proId });
      return { favourite: false };
    },
  );

  app.get('/favourites/pros', { preHandler: guards.customer }, async (request) => {
    const result = await pool.query(
      `SELECT f.pro_id AS id, u.first_name AS "firstName", p.photo_upload_id AS "photoId",
         (SELECT round(avg(stars)::numeric, 2)::float FROM ratings r WHERE r.pro_id = f.pro_id) AS "ratingAverage",
         (SELECT count(*)::int FROM ratings r WHERE r.pro_id = f.pro_id) AS "ratingCount",
         (SELECT count(*)::int FROM bookings b WHERE b.pro_id = f.pro_id AND b.status = 'completed')
           + (SELECT count(*)::int FROM subscription_visits v WHERE v.pro_id = f.pro_id AND v.status = 'completed') AS "jobsDone",
         -- The published trades to book the pro in (D89); none while the pro cannot take jobs.
         CASE WHEN p.status = 'approved' AND p.payouts_enabled AND p.jobs_paused_at IS NULL THEN
           (SELECT COALESCE(json_agg(json_build_object('id', c.id, 'slug', c.slug, 'name', c.name, 'icon', c.icon)
              ORDER BY c.sort_order, c.name), '[]')
            FROM pro_trades t JOIN categories c ON c.id = t.category_id WHERE t.pro_id = f.pro_id AND c.active)
         ELSE '[]' END AS trades,
         f.created_at AS "savedAt"
       FROM customer_favourite_pros f JOIN users u ON u.id = f.pro_id LEFT JOIN pro_profiles p ON p.user_id = f.pro_id
       WHERE f.customer_id = $1 AND u.disabled_at IS NULL
       ORDER BY f.created_at DESC`,
      [currentUser(request).id],
    );
    return { pros: result.rows };
  });
}
