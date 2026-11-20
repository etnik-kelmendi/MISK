import { jobPriceCents, type JobSize, type Pricing } from '../catalogue/pricing.js';
import type { Queryable } from '../db.js';

/** How long extra work may take, in minutes (D83). */
export const MIN_EXTRA_MINUTES = 5;
export const MAX_EXTRA_MINUTES = 480;

/** One line of a job's checklist (D86): a task of a booked service, or approved extra work. */
export interface JobTask {
  key: string;
  label: string;
  done: boolean;
}

/**
 * The checklist of a one-off job (D86): the tasks of each booked service as copied at booking time (a
 * service without tasks is one task, its name), then every approved extra work request. `done` comes from
 * what the pro ticked off.
 */
export async function loadTasks(db: Queryable, bookingId: string): Promise<JobTask[]> {
  // One after the other: `db` may be a single client inside a transaction.
  const services = await db.query<{ label: string }>(
    `WITH svc AS (
       SELECT bs.position, CASE WHEN cardinality(bs.tasks) > 0 THEN bs.tasks ELSE ARRAY[bs.name] END AS tasks
       FROM booking_services bs WHERE bs.booking_id = $1
       UNION ALL
       -- Bookings from before packages have no service rows: the booked service as it is now.
       SELECT 0, CASE WHEN cardinality(s.tasks) > 0 THEN s.tasks ELSE ARRAY[b.service_name] END
       FROM bookings b JOIN services s ON s.id = b.service_id
       WHERE b.id = $1 AND NOT EXISTS (SELECT 1 FROM booking_services x WHERE x.booking_id = $1)
     )
     SELECT t.label FROM svc, unnest(svc.tasks) WITH ORDINALITY AS t(label, n) ORDER BY svc.position, t.n`,
    [bookingId],
  );
  const extras = await db.query<{ id: string; description: string }>(
    "SELECT id, description FROM extra_requests WHERE booking_id = $1 AND status = 'approved' ORDER BY created_at",
    [bookingId],
  );
  const checks = await db.query<{ key: string }>('SELECT task_key AS key FROM booking_task_checks WHERE booking_id = $1', [bookingId]);
  const done = new Set(checks.rows.map((row) => row.key));
  return [
    ...services.rows.map((row, index) => ({ key: `t${index}`, label: row.label })),
    ...extras.rows.map((row) => ({ key: `x-${row.id}`, label: row.description })),
  ].map((task) => ({ ...task, done: done.has(task.key) }));
}

/** "Extra 30 minutes of work" is priced at the booked job's own rate per minute (D86). */
export const EXTRA_TIME_MINUTES = 30;
/** The least a price-list item may cost, as extra work requests require. */
const MIN_ITEM_CENTS = 100;
const MAX_ITEM_CENTS = 100_000;

/** One item of the MISK price list a pro picks extra work from (D86). Prices are always the server's. */
export interface PriceItem {
  /** "service:<uuid>" for a catalogue service, "time:30" for extra time. */
  id: string;
  name: string;
  priceCents: number;
  durationMinutes: number;
}

/**
 * The MISK price list for a job (D86): every other active fixed-price service of the job's trade at the
 * job's size, then extra time at the job's own rate. Services already in the booking, hourly ones and ones
 * longer than an extra may take are left out.
 */
export async function priceList(db: Queryable, bookingId: string): Promise<PriceItem[]> {
  const booking = await db.query<{ size: JobSize; priceCents: number; minutes: number }>(
    `SELECT b.size, b.price_cents AS "priceCents",
       GREATEST(1, COALESCE((SELECT sum(duration_minutes)::int FROM booking_services bs WHERE bs.booking_id = b.id),
         (extract(epoch FROM b.ends_at - b.starts_at) / 60)::int)) AS minutes
     FROM bookings b WHERE b.id = $1`,
    [bookingId],
  );
  const job = booking.rows[0];
  if (!job) return [];
  const services = await db.query<{
    id: string;
    name: string;
    priceCents: number;
    durationMinutes: number;
    sizeSmallPct: number;
    sizeMediumPct: number;
    sizeLargePct: number;
    pricing: Pricing;
  }>(
    `SELECT s.id, s.name, s.price_cents AS "priceCents", s.duration_minutes AS "durationMinutes",
       s.size_small_pct AS "sizeSmallPct", s.size_medium_pct AS "sizeMediumPct", s.size_large_pct AS "sizeLargePct", s.pricing
     FROM services s JOIN bookings b ON b.category_id = s.category_id
     WHERE b.id = $1 AND s.active AND s.removed_at IS NULL AND s.pricing = 'fixed' AND s.duration_minutes <= $2
       AND s.id <> b.service_id
       AND NOT EXISTS (SELECT 1 FROM booking_services bs WHERE bs.booking_id = b.id AND bs.service_id = s.id)
     ORDER BY s.sort_order, s.name`,
    [bookingId, MAX_EXTRA_MINUTES],
  );
  const items: PriceItem[] = services.rows
    .map((service) => ({
      id: `service:${service.id}`,
      name: service.name,
      priceCents: jobPriceCents(service, job.size),
      durationMinutes: service.durationMinutes,
    }))
    .filter((item) => item.priceCents >= MIN_ITEM_CENTS && item.priceCents <= MAX_ITEM_CENTS);
  const timeCents = Math.min(MAX_ITEM_CENTS, Math.max(MIN_ITEM_CENTS, Math.round((job.priceCents * EXTRA_TIME_MINUTES) / job.minutes)));
  items.push({ id: `time:${EXTRA_TIME_MINUTES}`, name: 'Extra 30 minutes of work', priceCents: timeCents, durationMinutes: EXTRA_TIME_MINUTES });
  return items;
}
