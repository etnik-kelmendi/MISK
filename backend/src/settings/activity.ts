import type { Queryable } from '../db.js';

export type ActivityArea = 'fees' | 'zones' | 'notifications' | 'team' | 'catalogue';

/** Writes one line in the team's activity log: who did what, and when. */
export async function logActivity(
  db: Queryable,
  input: { adminId: string; area: ActivityArea; action: string; details?: Record<string, unknown> },
) {
  await db.query('INSERT INTO admin_activity (admin_id, area, action, details) VALUES ($1, $2, $3, $4)', [
    input.adminId,
    input.area,
    input.action,
    JSON.stringify(input.details ?? {}),
  ]);
}

/**
 * Everything the team changed, from every log: Settings, bookings, pros and the catalogue, newest first.
 * `subject` names what was changed (a booking number, a pro, a service).
 */
export const ACTIVITY_FEED = `
  SELECT 'settings-' || a.id AS id, a.area, a.action, a.details, a.created_at AS "createdAt", a.admin_id,
    NULL::text AS subject
  FROM admin_activity a
  UNION ALL
  SELECT 'booking-' || ba.id, 'bookings', ba.action, ba.details, ba.created_at, ba.admin_id, 'B-' || b.number
  FROM booking_admin_actions ba JOIN bookings b ON b.id = ba.booking_id
  UNION ALL
  SELECT 'pro-' || pa.id, 'providers', pa.action, pa.details, pa.created_at, pa.admin_id,
    concat_ws(' ', u.first_name, u.last_name)
  FROM pro_admin_actions pa JOIN users u ON u.id = pa.pro_id
  UNION ALL
  SELECT 'catalogue-' || cc.id, 'catalogue', cc.action, cc.details, cc.created_at, cc.admin_id,
    COALESCE(s.name, c.name)
  FROM catalogue_changes cc JOIN categories c ON c.id = cc.category_id LEFT JOIN services s ON s.id = cc.service_id`;
