import { proShareCents } from '../catalogue/pricing.js';
import type { Queryable } from '../db.js';
import { FREE_CANCEL_HOURS } from './lifecycle.js';

export type Viewer = 'customer' | 'pro' | 'admin';

interface BookingRow {
  id: string;
  status: string;
  serviceName: string;
  categoryId: string;
  size: string;
  address: string;
  postcode: string;
  notes: string;
  startsAt: Date;
  endsAt: Date;
  priceCents: number;
  feeCents: number;
  proSharePct: number;
  paymentStatus: string;
  cancelledBy: string | null;
  createdAt: Date;
  completedAt: Date | null;
  hoursLeft: number;
  customerId: string;
  customerName: string | null;
  customerPhone: string | null;
  proId: string | null;
  proName: string | null;
  proPhone: string | null;
}

export const BOOKING_COLUMNS = `b.id, b.status, b.service_name AS "serviceName", b.category_id AS "categoryId", b.size,
  b.address, b.postcode, b.notes, b.starts_at AS "startsAt", b.ends_at AS "endsAt", b.price_cents AS "priceCents",
  b.fee_cents AS "feeCents", b.pro_share_pct AS "proSharePct", b.payment_status AS "paymentStatus",
  b.cancelled_by AS "cancelledBy", b.created_at AS "createdAt", b.completed_at AS "completedAt",
  extract(epoch FROM b.starts_at - now()) / 3600 AS "hoursLeft",
  b.customer_id AS "customerId", cu.first_name AS "customerName", cu.phone AS "customerPhone",
  b.pro_id AS "proId", pu.first_name AS "proName", pu.phone AS "proPhone"`;

export const BOOKING_FROM = `bookings b JOIN users cu ON cu.id = b.customer_id LEFT JOIN users pu ON pu.id = b.pro_id`;

/** A booking as one viewer may see it. Phone numbers are only shown to admins. */
export async function loadBooking(db: Queryable, bookingId: string, viewer: Viewer) {
  const found = await db.query<BookingRow>(`SELECT ${BOOKING_COLUMNS} FROM ${BOOKING_FROM} WHERE b.id = $1`, [bookingId]);
  const b = found.rows[0];
  if (!b) {
    return null;
  }
  const [events, photos, extras, rating, proRating] = await Promise.all([
    db.query('SELECT status, created_at AS at FROM booking_events WHERE booking_id = $1 ORDER BY id', [bookingId]),
    db.query('SELECT upload_id AS id, kind FROM booking_photos WHERE booking_id = $1 ORDER BY created_at', [bookingId]),
    db.query<{ id: string; description: string; priceCents: number; status: string; createdAt: Date }>(
      `SELECT id, description, price_cents AS "priceCents", status, created_at AS "createdAt"
       FROM extra_requests WHERE booking_id = $1 ORDER BY created_at`,
      [bookingId],
    ),
    db.query('SELECT stars, tags, created_at AS "createdAt" FROM ratings WHERE booking_id = $1', [bookingId]),
    b.proId
      ? db.query<{ average: number | null; count: number }>(
          'SELECT round(avg(stars)::numeric, 2)::float AS average, count(*)::int AS count FROM ratings WHERE pro_id = $1',
          [b.proId],
        )
      : Promise.resolve(null),
  ]);

  const approvedExtras = extras.rows.filter((e) => e.status === 'approved').reduce((sum, e) => sum + e.priceCents, 0);
  const unassigned = ['awaiting_payment', 'searching', 'unassigned'].includes(b.status);
  const base = {
    id: b.id,
    status: b.status,
    serviceName: b.serviceName,
    categoryId: b.categoryId,
    size: b.size,
    address: b.address,
    postcode: b.postcode,
    notes: b.notes,
    startsAt: b.startsAt,
    endsAt: b.endsAt,
    createdAt: b.createdAt,
    completedAt: b.completedAt,
    events: events.rows,
    photos: photos.rows,
    extras: extras.rows,
    rating: rating.rows[0] ?? null,
  };

  if (viewer === 'pro') {
    return {
      ...base,
      customer: { firstName: b.customerName },
      earningsCents: proShareCents(b.priceCents, b.proSharePct) + proShareCents(approvedExtras, b.proSharePct),
    };
  }

  const pro = b.proId
    ? {
        id: b.proId,
        firstName: b.proName,
        ratingAverage: proRating?.rows[0]?.average ?? null,
        ratingCount: proRating?.rows[0]?.count ?? 0,
        ...(viewer === 'admin' ? { phone: b.proPhone } : {}),
      }
    : null;
  const money = {
    priceCents: b.priceCents,
    feeCents: b.feeCents,
    extrasCents: approvedExtras,
    totalCents: b.priceCents + b.feeCents + approvedExtras,
    paymentStatus: b.paymentStatus,
  };

  if (viewer === 'customer') {
    return {
      ...base,
      ...money,
      pro,
      canCancel: unassigned || (b.status === 'accepted' && b.hoursLeft >= FREE_CANCEL_HOURS),
      canRate: b.status === 'completed' && !rating.rowCount,
    };
  }

  const offers = await db.query(
    `SELECT o.id, o.pro_id AS "proId", u.first_name AS "proName", o.status, o.offered_at AS "offeredAt",
       o.expires_at AS "expiresAt", o.responded_at AS "respondedAt"
     FROM booking_offers o JOIN users u ON u.id = o.pro_id WHERE o.booking_id = $1 ORDER BY o.offered_at`,
    [bookingId],
  );
  const payouts = await db.query(
    `SELECT amount_cents AS "amountCents", status, error, created_at AS "createdAt" FROM payouts WHERE booking_id = $1`,
    [bookingId],
  );
  return {
    ...base,
    ...money,
    pro,
    cancelledBy: b.cancelledBy,
    proSharePct: b.proSharePct,
    customer: { id: b.customerId, firstName: b.customerName, phone: b.customerPhone },
    offers: offers.rows,
    payouts: payouts.rows,
  };
}
