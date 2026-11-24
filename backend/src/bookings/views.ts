import { proShareCents } from '../catalogue/pricing.js';
import type { Queryable } from '../db.js';
import { nextPayoutDate, type PayoutInterval } from '../payments/payouts.js';
import { marketToday } from '../pros/checks.js';
import { FREE_CANCEL_LATE_MINUTES, loadArrival } from './arrival.js';
import { loadCustomerProfile } from './customer-profile.js';
import { loadTasks } from './job-tasks.js';
import { CHARGE_DELAY_HOURS, CUSTOMER_RESCHEDULABLE, FREE_CANCEL_HOURS, noShowAmounts } from './lifecycle.js';
import { leaveAllowedAt, NO_SHOW_WAIT_MINUTES } from './on-site.js';

/** Pros can cancel a job they accepted until they start work (D86). */
export const PRO_CANCELLABLE = ['accepted', 'on_the_way'];
/** A pro can rate the customer for this long after the job is done (D86). */
export const CUSTOMER_RATING_DAYS = 7;

export type Viewer = 'customer' | 'pro' | 'admin';

interface BookingRow {
  id: string;
  number: string;
  categoryName: string;
  problemReportedAt: Date | null;
  problemNote: string | null;
  problemResolvedAt: Date | null;
  chargeAt: Date | null;
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
  packageDiscountCents: number;
  flexibleWindow: string | null;
  timeConfirmedAt: Date | null;
  confirmBy: Date | null;
  feeCents: number;
  proSharePct: number;
  paymentStatus: string;
  cancelledBy: string | null;
  createdAt: Date;
  completedAt: Date | null;
  hoursLeft: number;
  lateCancel: boolean;
  customerId: string;
  customerName: string | null;
  customerPhone: string | null;
  proId: string | null;
  proName: string | null;
  proPhone: string | null;
  preferredProId: string | null;
  preferredProName: string | null;
  noShowAt: Date | null;
  noShowFeeCents: number | null;
  noShowWaitingCents: number | null;
}

export const BOOKING_COLUMNS = `b.id, 'B-' || b.number AS number, cat.name AS "categoryName",
  b.problem_reported_at AS "problemReportedAt", b.problem_note AS "problemNote", b.problem_resolved_at AS "problemResolvedAt",
  b.completed_at + make_interval(hours => ${CHARGE_DELAY_HOURS}) AS "chargeAt", b.status, b.service_name AS "serviceName", b.category_id AS "categoryId", b.size,
  b.address, b.postcode, b.notes, b.starts_at AS "startsAt", b.ends_at AS "endsAt", b.price_cents AS "priceCents", b.package_discount_cents AS "packageDiscountCents",
  b.flexible_window AS "flexibleWindow", b.time_confirmed_at AS "timeConfirmedAt", b.confirm_by AS "confirmBy",
  b.fee_cents AS "feeCents", b.pro_share_pct AS "proSharePct", b.payment_status AS "paymentStatus",
  b.cancelled_by AS "cancelledBy", b.created_at AS "createdAt", b.completed_at AS "completedAt",
  extract(epoch FROM b.starts_at - now()) / 3600 AS "hoursLeft", b.late_cancel AS "lateCancel",
  b.customer_id AS "customerId", cu.first_name AS "customerName", cu.phone AS "customerPhone",
  b.pro_id AS "proId", pu.first_name AS "proName", pu.phone AS "proPhone",
  b.preferred_pro_id AS "preferredProId", ppu.first_name AS "preferredProName",
  b.no_show_at AS "noShowAt", b.no_show_fee_cents AS "noShowFeeCents", b.no_show_waiting_cents AS "noShowWaitingCents"`;

export const BOOKING_FROM = `bookings b JOIN users cu ON cu.id = b.customer_id LEFT JOIN users pu ON pu.id = b.pro_id
  LEFT JOIN users ppu ON ppu.id = b.preferred_pro_id
  JOIN categories cat ON cat.id = b.category_id`;

/**
 * A booking as one viewer may see it. Phone numbers are only shown to admins. `timezone` is the market's, for
 * the pro's payout day.
 */
export async function loadBooking(db: Queryable, bookingId: string, viewer: Viewer, timezone = 'UTC') {
  const found = await db.query<BookingRow>(`SELECT ${BOOKING_COLUMNS} FROM ${BOOKING_FROM} WHERE b.id = $1`, [bookingId]);
  const b = found.rows[0];
  if (!b) {
    return null;
  }
  const [events, photos, extras, rating, proRating, tip, unread, services, tasks, issues] = await Promise.all([
    db.query('SELECT status, created_at AS at FROM booking_events WHERE booking_id = $1 ORDER BY id', [bookingId]),
    db.query('SELECT upload_id AS id, kind FROM booking_photos WHERE booking_id = $1 ORDER BY created_at', [bookingId]),
    db.query<{
      id: string;
      description: string;
      priceCents: number;
      durationMinutes: number | null;
      status: string;
      createdAt: Date;
      kind: 'work' | 'waiting';
      fundedBy: 'customer' | 'misk';
    }>(
      // Paid waiting at the door (D94) is a line of its own: kind 'waiting', paid by the customer or by MISK.
      `SELECT id, description, price_cents AS "priceCents", duration_minutes AS "durationMinutes", status, created_at AS "createdAt",
         kind, funded_by AS "fundedBy"
       FROM extra_requests WHERE booking_id = $1 ORDER BY created_at`,
      [bookingId],
    ),
    db.query('SELECT stars, tags, review, created_at AS "createdAt" FROM ratings WHERE booking_id = $1', [bookingId]),
    // The pro as the customer sees them (D83): rating, photo, finished jobs and plan visits, and whether this
    // customer saved them as a favourite.
    b.proId
      ? db.query<{ average: number | null; count: number; photoId: string | null; jobsDone: number; isFavourite: boolean }>(
          `SELECT (SELECT round(avg(stars)::numeric, 2)::float FROM ratings WHERE pro_id = $1) AS average,
             (SELECT count(*)::int FROM ratings WHERE pro_id = $1) AS count,
             (SELECT photo_upload_id FROM pro_profiles WHERE user_id = $1) AS "photoId",
             (SELECT count(*)::int FROM bookings WHERE pro_id = $1 AND status = 'completed')
               + (SELECT count(*)::int FROM subscription_visits WHERE pro_id = $1 AND status = 'completed') AS "jobsDone",
             EXISTS (SELECT 1 FROM customer_favourite_pros WHERE pro_id = $1 AND customer_id = $2) AS "isFavourite"`,
          [b.proId, b.customerId],
        )
      : Promise.resolve(null),
    db.query<{ amountCents: number; proCents: number; status: string }>(
      'SELECT amount_cents AS "amountCents", pro_cents AS "proCents", status FROM tips WHERE booking_id = $1',
      [bookingId],
    ),
    // Chat messages the viewer has not seen yet (D67).
    db.query<{ n: number }>(
      // A pro counts only messages from their own time on the job, like the chat shows them (D86).
      `SELECT count(*)::int AS n FROM booking_messages m WHERE m.booking_id = $1 AND m.sender_role <> $2 AND m.read_at IS NULL
         AND ($2 <> 'pro' OR m.pro_id = (SELECT pro_id FROM bookings WHERE id = $1))`,
      [bookingId, viewer === 'pro' ? 'pro' : 'customer'],
    ),
    // The services of the visit, more than one for a package (D68).
    db.query<{ id: string; name: string; priceCents: number; durationMinutes: number }>(
      `SELECT service_id AS id, name, price_cents AS "priceCents", duration_minutes AS "durationMinutes"
       FROM booking_services WHERE booking_id = $1 ORDER BY position`,
      [bookingId],
    ),
    // The job's checklist (D86).
    loadTasks(db, bookingId),
    // Problems the pro reported on site (D86), newest first.
    db.query<{ id: string; proId: string; proName: string | null; reason: string; details: string | null; createdAt: Date; resolvedAt: Date | null }>(
      `SELECT i.id, i.pro_id AS "proId", u.first_name AS "proName", i.reason, i.details, i.created_at AS "createdAt",
         i.resolved_at AS "resolvedAt"
       FROM booking_issues i JOIN users u ON u.id = i.pro_id WHERE i.booking_id = $1 ORDER BY i.created_at DESC`,
      [bookingId],
    ),
  ]);
  // A job handed to another pro does not show them the previous pro's report.
  const openIssue = issues.rows.find((issue) => issue.resolvedAt === null && issue.proId === b.proId) ?? null;

  // What the customer pays for extra work and waiting time; waiting MISK paid for is the pro's, not the customer's.
  const approvedExtras = extras.rows
    .filter((e) => e.status === 'approved' && e.fundedBy === 'customer')
    .reduce((sum, e) => sum + e.priceCents, 0);
  const proExtras = extras.rows.filter((e) => e.status === 'approved').reduce((sum, e) => sum + e.priceCents, 0);
  const noShow =
    b.noShowAt && b.noShowFeeCents !== null
      ? {
          at: b.noShowAt,
          feeCents: b.noShowFeeCents,
          waitingCents: b.noShowWaitingCents ?? 0,
          ...noShowAmounts({
            feeCents: b.noShowFeeCents,
            waitingCents: b.noShowWaitingCents ?? 0,
            heldCents: b.priceCents + b.feeCents,
            proSharePct: b.proSharePct,
          }),
        }
      : null;
  const unassigned = ['awaiting_payment', 'searching', 'unassigned'].includes(b.status);
  const base = {
    id: b.id,
    number: b.number,
    categoryName: b.categoryName,
    problemReportedAt: b.problemReportedAt,
    problemNote: b.problemNote,
    problemResolvedAt: b.problemResolvedAt,
    chargeAt: b.chargeAt,
    status: b.status,
    serviceName: b.serviceName,
    services: services.rows,
    // A flexible booking (D70): its window, and whether the pro has picked the time yet.
    flexibleWindow: b.flexibleWindow,
    timeConfirmed: !b.flexibleWindow || b.timeConfirmedAt !== null,
    confirmBy: b.confirmBy,
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
    // Problem photos are between the customer and the MISK team.
    photos: viewer === 'pro' ? photos.rows.filter((photo) => photo.kind !== 'problem') : photos.rows,
    // Who funds a line is between the pro and MISK; the customer sees only what they pay.
    extras:
      viewer === 'customer'
        ? extras.rows.filter((extra) => extra.fundedBy === 'customer').map((extra) => ({
            id: extra.id,
            description: extra.description,
            priceCents: extra.priceCents,
            durationMinutes: extra.durationMinutes,
            status: extra.status,
            createdAt: extra.createdAt,
            kind: extra.kind,
          }))
        : extras.rows,
    rating: rating.rows[0] ?? null,
    tasks,
    // The customer was not home and the pro left with the call-out fee (D94).
    noShow: noShow ? { at: noShow.at, chargeCents: noShow.chargeCents, waitingCents: noShow.waitingCents } : null,
  };
  // The pro the customer picked on Home, who was offered the job first (D89): for the customer and the team
  // only, first name only.
  const preferredPro = b.preferredProId ? { id: b.preferredProId, firstName: b.preferredProName } : null;

  if (viewer === 'pro') {
    const [customerStars, customerRating, payoutSettings] = await Promise.all([
      db.query<{ average: number | null; count: number }>(
        `SELECT round(avg(stars)::numeric, 1)::float AS average, count(*)::int AS count FROM customer_ratings WHERE customer_id = $1`,
        [b.customerId],
      ),
      db.query<{ stars: number; tags: string[]; comment: string | null }>(
        'SELECT stars, tags, comment FROM customer_ratings WHERE booking_id = $1',
        [bookingId],
      ),
      db.query<{ interval: PayoutInterval; noShowFeeCents: number }>(
        'SELECT payout_interval AS interval, no_show_fee_cents AS "noShowFeeCents" FROM settings',
      ),
    ]);
    const interval = payoutSettings.rows[0]?.interval ?? 'weekly';
    // The day the money reaches the pro's bank (D94): the first payout day once it is released, 24 hours after
    // the job (at once for a no-show's call-out fee).
    const releasedAt = noShow ? noShow.at : b.completedAt ? new Date(b.completedAt.getTime() + CHARGE_DELAY_HOURS * 3600 * 1000) : null;
    const payoutOn = releasedAt ? nextPayoutDate(interval, marketToday(timezone, releasedAt)) : null;
    const issueOpen = openIssue && ['accepted', 'on_the_way', 'working'].includes(b.status) ? openIssue : null;
    const leaveAt = issueOpen && ['accepted', 'on_the_way'].includes(b.status) ? leaveAllowedAt(issueOpen) : null;
    const ratingWindowOpen =
      b.completedAt !== null && b.completedAt.getTime() > Date.now() - CUSTOMER_RATING_DAYS * 24 * 3600 * 1000;
    return {
      ...base,
      customer: {
        firstName: b.customerName,
        ratingAverage: customerStars.rows[0]?.average ?? null,
        ratingCount: customerStars.rows[0]?.count ?? 0,
      },
      // Extra work and paid waiting count for the pro whoever pays for them; a no-show pays the call-out fee (D94).
      earningsCents: noShow ? noShow.proCents : proShareCents(b.priceCents, b.proSharePct) + proShareCents(proExtras, b.proSharePct),
      // The pro's share of the job and of extra work (D86).
      proSharePct: b.proSharePct,
      unreadMessages: unread.rows[0]?.n ?? 0,
      openIssue: issueOpen ? { id: issueOpen.id, reason: issueOpen.reason, createdAt: issueOpen.createdAt } : null,
      // "Unsafe to work" stops the job until MISK support resolves it (D94).
      stopped: issueOpen?.reason === 'unsafe',
      // "Leave and get the call-out fee" from this moment (D94).
      leaveAt,
      noShowWaitMinutes: NO_SHOW_WAIT_MINUTES,
      callOutFeeCents: noShow ? noShow.feeCents : (payoutSettings.rows[0]?.noShowFeeCents ?? 0),
      payoutOn,
      // Cancelling under 24 hours before the start is a late cancellation (D86).
      canCancel: PRO_CANCELLABLE.includes(b.status),
      cancelIsLate: b.hoursLeft < FREE_CANCEL_HOURS,
      customerRating: customerRating.rows[0] ?? null,
      canRateCustomer: b.status === 'completed' && !customerRating.rowCount && ratingWindowOpen,
    };
  }

  const proInfo = proRating?.rows[0];
  const pro = b.proId
    ? {
        id: b.proId,
        firstName: b.proName,
        ratingAverage: proInfo?.average ?? null,
        ratingCount: proInfo?.count ?? 0,
        photoId: proInfo?.photoId ?? null,
        jobsDone: proInfo?.jobsDone ?? 0,
        ...(viewer === 'customer' ? { isFavourite: proInfo?.isFavourite ?? false } : {}),
        ...(viewer === 'admin' ? { phone: b.proPhone } : {}),
      }
    : null;
  const money = {
    priceCents: b.priceCents,
    packageDiscountCents: b.packageDiscountCents,
    feeCents: b.feeCents,
    extrasCents: approvedExtras,
    totalCents: noShow ? noShow.chargeCents : b.priceCents + b.feeCents + approvedExtras,
    paymentStatus: b.paymentStatus,
  };

  if (viewer === 'customer') {
    // Where the pro is and when they arrive, while they are booked and not there yet (D83).
    const arrival = b.proId ? await loadArrival(db, bookingId) : null;
    // A pro more than 30 minutes late lets the customer cancel for free (D83).
    const proVeryLate = arrival !== null && arrival.lateMinutes > FREE_CANCEL_LATE_MINUTES;
    return {
      ...base,
      ...money,
      pro,
      preferredPro,
      arrival,
      canCancel: unassigned || b.status === 'accepted' || b.status === 'on_the_way',
      // Cancelling now costs the full price: a pro is booked and the start is less than 24 hours away (D34).
      lateCancelCents:
        (b.status === 'accepted' || b.status === 'on_the_way') &&
        b.hoursLeft < FREE_CANCEL_HOURS &&
        b.paymentStatus === 'held' &&
        !proVeryLate
          ? b.priceCents + b.feeCents
          : null,
      freeCancelProLate: proVeryLate,
      lateCancel: b.lateCancel,
      // What a no-show costs (D94), shown in the booking's help text.
      callOutFeeCents: (await db.query<{ fee: number }>('SELECT no_show_fee_cents AS fee FROM settings')).rows[0]?.fee ?? 0,
      // Free to move until 24 hours before the start, unless the pro has set off (D75).
      canReschedule: CUSTOMER_RESCHEDULABLE.includes(b.status) && b.hoursLeft > FREE_CANCEL_HOURS,
      tip: tip.rows[0] ?? null,
      unreadMessages: unread.rows[0]?.n ?? 0,
      canTip: b.status === 'completed' && b.proId !== null && (!tip.rows[0] || tip.rows[0].status === 'failed'),
      canRate: b.status === 'completed' && !rating.rowCount,
      // Until the card is charged, the customer can tell MISK something went wrong.
      canReportProblem:
        b.status === 'completed' && b.paymentStatus === 'held' && !b.problemReportedAt && b.chargeAt !== null && b.chargeAt > new Date(),
      // The pro asked MISK support for help on site (D86); the details stay between the pro and the team.
      proIssueOpen: openIssue !== null && ['accepted', 'on_the_way', 'working'].includes(b.status),
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
  const actions = await db.query(
    `SELECT a.id, a.action, a.details, a.created_at AS "createdAt", COALESCE(u.email, u.username) AS "adminName"
     FROM booking_admin_actions a LEFT JOIN users u ON u.id = a.admin_id WHERE a.booking_id = $1 ORDER BY a.id DESC`,
    [bookingId],
  );
  const [customerRating, proCancellations] = await Promise.all([
    db.query<{ stars: number; tags: string[]; createdAt: Date }>(
      'SELECT stars, tags, created_at AS "createdAt" FROM customer_ratings WHERE booking_id = $1',
      [bookingId],
    ),
    db.query<{ proName: string | null; reason: string; note: string | null; late: boolean; createdAt: Date }>(
      `SELECT u.first_name AS "proName", c.reason, c.note, c.late, c.created_at AS "createdAt"
       FROM pro_cancellations c JOIN users u ON u.id = c.pro_id WHERE c.booking_id = $1 ORDER BY c.created_at DESC`,
      [bookingId],
    ),
  ]);
  const lock = await db.query<{ at: Date | null; by: string | null }>(
    `SELECT b.assignment_locked_at AS at, COALESCE(u.email, u.username) AS by
     FROM bookings b LEFT JOIN users u ON u.id = b.assignment_locked_by WHERE b.id = $1`,
    [bookingId],
  );
  const proCents = noShow ? noShow.proCents : proShareCents(b.priceCents, b.proSharePct) + proShareCents(proExtras, b.proSharePct);
  return {
    ...base,
    ...money,
    pro,
    preferredPro,
    // The team confirmed this pro; the assignment is final until the pro gives the job back (D88).
    assignmentLocked: lock.rows[0]?.at != null,
    assignmentLockedAt: lock.rows[0]?.at ?? null,
    assignmentLockedBy: lock.rows[0]?.by ?? null,
    cancelledBy: b.cancelledBy,
    proSharePct: b.proSharePct,
    customer: { id: b.customerId, firstName: b.customerName, phone: b.customerPhone },
    customerProfile: await loadCustomerProfile(db, b.customerId),
    offers: offers.rows,
    payouts: payouts.rows,
    actions: actions.rows,
    split: { proCents, miskCents: money.totalCents - proCents },
    lateCancel: b.lateCancel,
    tip: tip.rows[0] ?? null,
    issues: issues.rows,
    customerRating: customerRating.rows[0] ?? null,
    proCancellations: proCancellations.rows,
  };
}
