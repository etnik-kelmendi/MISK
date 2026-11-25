import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import type { AppContext } from '../context.js';
import type { Queryable } from '../db.js';
import { notFound } from '../errors.js';
import { uuidParams } from '../http.js';
import { planSizePrice } from '../subscriptions/service.js';

/** "Top rated near you" lists at most this many pros (D89). */
export const HOME_PROS_LIMIT = 6;
/** A rating average counts for the ranking once a pro has at least this many ratings; others follow them. */
export const MIN_RATINGS_FOR_RANKING = 3;

export interface HomeTrade {
  id: string;
  slug: string;
  name: string;
  icon: string;
}

/** A pro as Home shows them: first name only, never a surname or phone number. */
export interface HomePro {
  id: string;
  firstName: string | null;
  photoId: string | null;
  /** The pro's published trades in the order the team set; the first is the one Home books. */
  trades: HomeTrade[];
  ratingAverage: number | null;
  ratingCount: number;
  jobsDone: number;
  isFavourite: boolean;
}

/**
 * SQL that keeps only pros a customer can book: approved, able to receive payouts, not paused, with an
 * account that is not suspended, and with at least one published trade. `p` is `pro_profiles`.
 */
const BOOKABLE_PRO = `p.status = 'approved' AND p.payouts_enabled AND p.jobs_paused_at IS NULL
  AND EXISTS (SELECT 1 FROM users pu WHERE pu.id = p.user_id AND pu.disabled_at IS NULL)
  AND EXISTS (SELECT 1 FROM pro_trades t JOIN categories c ON c.id = t.category_id WHERE t.pro_id = p.user_id AND t.approved AND c.active)`;

/** The card columns of `p` for the customer `$1`. */
const PRO_CARD_COLUMNS = `p.user_id AS id, u.first_name AS "firstName", p.photo_upload_id AS "photoId",
  (SELECT COALESCE(json_agg(json_build_object('id', c.id, 'slug', c.slug, 'name', c.name, 'icon', c.icon) ORDER BY c.sort_order, c.name), '[]')
   FROM pro_trades t JOIN categories c ON c.id = t.category_id WHERE t.pro_id = p.user_id AND t.approved AND c.active) AS trades,
  r.average AS "ratingAverage", r.count AS "ratingCount", jobs.done AS "jobsDone",
  EXISTS (SELECT 1 FROM customer_favourite_pros f WHERE f.customer_id = $1 AND f.pro_id = p.user_id) AS "isFavourite"`;

const PRO_CARD_JOINS = `JOIN users u ON u.id = p.user_id
  CROSS JOIN LATERAL (SELECT round(avg(stars)::numeric, 2)::float AS average, count(*)::int AS count FROM ratings WHERE pro_id = p.user_id) r
  CROSS JOIN LATERAL (
    SELECT (SELECT count(*)::int FROM bookings WHERE pro_id = p.user_id AND status = 'completed')
      + (SELECT count(*)::int FROM subscription_visits WHERE pro_id = p.user_id AND status = 'completed') AS done
  ) jobs`;

/**
 * The best-rated pros who work at the customer's selected address: pros with enough ratings by their
 * average, then the rest, then by finished jobs. Without a selected address in a served zone there is no
 * "near you", so the list is empty. The customer never sees themselves (a pro booking for themselves, D64).
 */
export async function topProsNear(db: Queryable, customerId: string): Promise<HomePro[]> {
  const result = await db.query<HomePro>(
    `SELECT ${PRO_CARD_COLUMNS}
     FROM customer_addresses a
     JOIN postcodes here ON here.code = a.postcode AND here.active
     JOIN pro_profiles p ON true
     JOIN postcodes home ON home.code = p.home_postcode
     ${PRO_CARD_JOINS}
     WHERE a.customer_id = $1 AND a.is_selected AND p.user_id <> $1 AND ${BOOKABLE_PRO}
       AND distance_km(home.lat, home.lng, here.lat, here.lng) <= p.radius_km
     ORDER BY (r.count >= $2) DESC, r.average DESC NULLS LAST, jobs.done DESC, u.first_name, p.user_id
     LIMIT $3`,
    [customerId, MIN_RATINGS_FOR_RANKING, HOME_PROS_LIMIT],
  );
  return result.rows;
}

/** One bookable pro's card, for the "Booking with Daniel" choice on the Services page. */
export async function proCard(db: Queryable, customerId: string, proId: string): Promise<HomePro | null> {
  const result = await db.query<HomePro>(
    `SELECT ${PRO_CARD_COLUMNS} FROM pro_profiles p ${PRO_CARD_JOINS} WHERE p.user_id = $2 AND ${BOOKABLE_PRO}`,
    [customerId, proId],
  );
  return result.rows[0] ?? null;
}

/** The plans banner: the published plan with the lowest starting price (a small home or garden). */
export async function cheapestPlan(db: Queryable): Promise<{ id: string; name: string; categoryId: string; fromCents: number } | null> {
  const result = await db.query<{ id: string; name: string; categoryId: string; priceCents: number }>(
    `SELECT p.id, p.name, p.category_id AS "categoryId", p.price_cents AS "priceCents"
     FROM plans p JOIN categories c ON c.id = p.category_id
     WHERE p.status = 'published' AND p.deleted_at IS NULL AND c.active AND p.price_cents IS NOT NULL AND p.name IS NOT NULL
     ORDER BY p.price_cents, c.sort_order, p.name
     LIMIT 1`,
  );
  const plan = result.rows[0];
  return plan ? { id: plan.id, name: plan.name, categoryId: plan.categoryId, fromCents: planSizePrice(plan.priceCents, 'S') } : null;
}

/** The customer Home page (D89): the plans banner and "Top rated near you" for the selected address. */
export async function homeRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards } = ctx;

  app.get('/home', { preHandler: guards.customer }, async (request) => {
    const customerId = currentUser(request).id;
    const [plan, pros] = await Promise.all([cheapestPlan(pool), topProsNear(pool, customerId)]);
    return { plan, pros };
  });

  app.get<{ Params: { id: string } }>('/home/pros/:id', { preHandler: guards.customer, schema: { params: uuidParams } }, async (request) => {
    const pro = await proCard(pool, currentUser(request).id, request.params.id);
    if (!pro) throw notFound('pro_not_found');
    return { pro };
  });
}
