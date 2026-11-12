import type { Queryable } from '../db.js';

export interface CustomerProfile {
  id: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  /** How they sign in: with their phone number or with email and password. */
  signIn: 'phone' | 'email';
  emailConfirmed: boolean;
  memberSince: Date;
  disabled: boolean;
  bookings: { total: number; completed: number; cancelled: number; upcoming: number };
  /** Paid for finished one-off jobs and approved extras, without tips. */
  spentCents: number;
  tipsCents: number;
  /** Names of the monthly plans that are running now. */
  activePlans: string[];
  ratingsGiven: number;
  averageStarsGiven: number | null;
  problemsReported: number;
  lateCancellations: number;
  lastBookingAt: Date | null;
}

/** What the team needs to know about a customer at a glance, for the booking and plan visit panels. */
export async function loadCustomerProfile(db: Queryable, customerId: string): Promise<CustomerProfile | null> {
  const result = await db.query<CustomerProfile>(
    `SELECT u.id, u.first_name AS "firstName", u.last_name AS "lastName", u.phone, u.email,
       CASE WHEN u.password_hash IS NOT NULL THEN 'email' ELSE 'phone' END AS "signIn",
       u.email_verified_at IS NOT NULL AS "emailConfirmed",
       u.created_at AS "memberSince", u.disabled_at IS NOT NULL AS disabled,
       json_build_object(
         'total', (SELECT count(*)::int FROM bookings b WHERE b.customer_id = u.id AND b.status <> 'awaiting_payment'),
         'completed', (SELECT count(*)::int FROM bookings b WHERE b.customer_id = u.id AND b.status = 'completed'),
         'cancelled', (SELECT count(*)::int FROM bookings b WHERE b.customer_id = u.id AND b.status = 'cancelled'),
         'upcoming', (SELECT count(*)::int FROM bookings b WHERE b.customer_id = u.id
                        AND b.status IN ('searching', 'unassigned', 'accepted', 'on_the_way', 'working'))
       ) AS bookings,
       ((SELECT COALESCE(sum(b.price_cents + b.fee_cents), 0) FROM bookings b
           WHERE b.customer_id = u.id AND b.payment_status = 'captured')
        + (SELECT COALESCE(sum(e.price_cents), 0) FROM extra_requests e JOIN bookings b ON b.id = e.booking_id
           WHERE b.customer_id = u.id AND e.payment_status = 'captured'))::int AS "spentCents",
       (SELECT COALESCE(sum(t.amount_cents), 0)::int FROM tips t JOIN bookings b ON b.id = t.booking_id
          WHERE b.customer_id = u.id AND t.status = 'captured') AS "tipsCents",
       COALESCE((SELECT array_agg(s.plan_name ORDER BY s.started_at) FROM subscriptions s
                 WHERE s.customer_id = u.id AND s.status IN ('active', 'past_due')), '{}') AS "activePlans",
       (SELECT count(*)::int FROM ratings r JOIN bookings b ON b.id = r.booking_id WHERE b.customer_id = u.id) AS "ratingsGiven",
       (SELECT round(avg(r.stars)::numeric, 1)::float FROM ratings r JOIN bookings b ON b.id = r.booking_id
          WHERE b.customer_id = u.id) AS "averageStarsGiven",
       (SELECT count(*)::int FROM bookings b WHERE b.customer_id = u.id AND b.problem_reported_at IS NOT NULL) AS "problemsReported",
       (SELECT count(*)::int FROM bookings b WHERE b.customer_id = u.id AND b.late_cancel) AS "lateCancellations",
       (SELECT max(b.created_at) FROM bookings b WHERE b.customer_id = u.id AND b.status <> 'awaiting_payment') AS "lastBookingAt"
     FROM users u WHERE u.id = $1`,
    [customerId],
  );
  return result.rows[0] ?? null;
}
