import type { Queryable } from '../db.js';

/** The four checks every pro passes before getting jobs, one document each. */
export const DOCUMENT_KINDS = ['id', 'certificate', 'insurance', 'background'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** Documents that run out: the pro must give the expiry date when uploading them. */
export const EXPIRING_KINDS: ReadonlySet<DocumentKind> = new Set(['id', 'insurance']);

/** A document running out within this many days counts as expiring. */
export const EXPIRY_WARNING_DAYS = 30;

/** Below these, a pro gets a quality warning, once there is enough to judge by. */
export const QUALITY = {
  minAcceptancePct: 85,
  minOnTimePct: 90,
  minRating: 4,
  /** Offers, timed jobs or ratings needed before a number can trigger a warning. */
  minSample: 5,
  /** A pro who starts work this many minutes after the booked time is late. */
  graceMinutes: 10,
} as const;

/** Where a check stands, for the admin's "OK / Open" with a short explanation. */
export type CheckState = 'missing' | 'waiting_review' | 'rejected' | 'expired' | 'expiring' | 'valid';

export interface DocumentRow {
  kind: DocumentKind;
  uploadId: string;
  fileName: string;
  uploadedAt: Date;
  /** "YYYY-MM-DD" or null. */
  expiresOn: string | null;
  reviewStatus: 'pending' | 'accepted' | 'rejected';
  reviewNote: string | null;
  reviewedAt: Date | null;
  /** "YYYY-MM-DD", "infinity" or null. */
  validUntil: string | null;
}

export interface Check {
  kind: DocumentKind;
  ok: boolean;
  state: CheckState;
  document: DocumentRow | null;
}

/** Today's date in the market, "YYYY-MM-DD". */
export function marketToday(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function checkOf(kind: DocumentKind, document: DocumentRow | null, today: string): Check {
  if (!document) {
    return { kind, ok: false, state: 'missing', document };
  }
  if (document.reviewStatus === 'rejected') {
    return { kind, ok: false, state: 'rejected', document };
  }
  if (document.reviewStatus === 'pending') {
    return { kind, ok: false, state: 'waiting_review', document };
  }
  if (document.expiresOn && document.expiresOn < today) {
    return { kind, ok: false, state: 'expired', document };
  }
  if (document.expiresOn && document.expiresOn <= addDays(today, EXPIRY_WARNING_DAYS)) {
    return { kind, ok: true, state: 'expiring', document };
  }
  return { kind, ok: true, state: 'valid', document };
}

export const DOCUMENT_COLUMNS = `kind, upload_id AS "uploadId", file_name AS "fileName", uploaded_at AS "uploadedAt",
  to_char(expires_on, 'YYYY-MM-DD') AS "expiresOn", review_status AS "reviewStatus", review_note AS "reviewNote",
  reviewed_at AS "reviewedAt", CASE WHEN valid_until = 'infinity' THEN 'infinity' ELSE to_char(valid_until, 'YYYY-MM-DD') END AS "validUntil"`;

/** All four checks of a pro, in a fixed order. */
export async function loadChecks(db: Queryable, proId: string, timezone: string): Promise<Check[]> {
  const docs = await db.query<DocumentRow>(`SELECT ${DOCUMENT_COLUMNS} FROM pro_documents WHERE pro_id = $1`, [proId]);
  const today = marketToday(timezone);
  return DOCUMENT_KINDS.map((kind) => checkOf(kind, docs.rows.find((d) => d.kind === kind) ?? null, today));
}

/**
 * SQL joined as `st` onto `pro_profiles p`: the last 30 days' numbers behind the quality columns.
 * On time means work started at most `graceMinutes` after the booked time.
 */
export const PRO_STATS = `LEFT JOIN LATERAL (
  SELECT
    ((SELECT count(*) FROM bookings b WHERE b.pro_id = p.user_id AND b.status = 'completed'
        AND b.completed_at > now() - interval '30 days')
     + (SELECT count(*) FROM subscription_visits v WHERE v.pro_id = p.user_id AND v.status = 'completed'
        AND v.completed_at > now() - interval '30 days'))::int AS jobs30,
    (SELECT count(*) FROM booking_offers o WHERE o.pro_id = p.user_id AND o.status IN ('accepted', 'declined', 'expired')
        AND o.offered_at > now() - interval '30 days')::int AS offers30,
    (SELECT count(*) FROM booking_offers o WHERE o.pro_id = p.user_id AND o.status = 'accepted'
        AND o.offered_at > now() - interval '30 days')::int AS accepted30,
    (SELECT count(*) FROM bookings b WHERE b.pro_id = p.user_id AND b.status = 'completed'
        AND b.completed_at > now() - interval '30 days')::int AS timed30,
    (SELECT count(*) FROM bookings b WHERE b.pro_id = p.user_id AND b.status = 'completed'
        AND b.completed_at > now() - interval '30 days'
        AND (SELECT min(e.created_at) FROM booking_events e WHERE e.booking_id = b.id AND e.status = 'working')
            <= b.starts_at + make_interval(mins => ${QUALITY.graceMinutes}))::int AS ontime30,
    (SELECT count(*) FROM subscriptions s WHERE s.pro_id = p.user_id AND s.status IN ('active', 'past_due'))::int AS regulars,
    (SELECT round(avg(stars)::numeric, 2)::float FROM ratings r WHERE r.pro_id = p.user_id) AS rating_avg,
    (SELECT count(*) FROM ratings r WHERE r.pro_id = p.user_id)::int AS rating_count
) st ON true`;

export const PRO_STATS_COLUMNS = `st.jobs30, st.offers30, st.accepted30, st.timed30, st.ontime30, st.regulars,
  st.rating_avg, st.rating_count`;

export interface StatsRow {
  jobs30: number;
  offers30: number;
  accepted30: number;
  timed30: number;
  ontime30: number;
  regulars: number;
  rating_avg: number | null;
  rating_count: number;
}

export type QualityReason = 'low_acceptance' | 'late' | 'low_rating';

export function proNumbers(row: StatsRow) {
  const acceptancePct = row.offers30 ? Math.round((row.accepted30 * 100) / row.offers30) : null;
  const onTimePct = row.timed30 ? Math.round((row.ontime30 * 100) / row.timed30) : null;
  const reasons: QualityReason[] = [];
  if (acceptancePct !== null && row.offers30 >= QUALITY.minSample && acceptancePct < QUALITY.minAcceptancePct) {
    reasons.push('low_acceptance');
  }
  if (onTimePct !== null && row.timed30 >= QUALITY.minSample && onTimePct < QUALITY.minOnTimePct) {
    reasons.push('late');
  }
  if (row.rating_avg !== null && row.rating_count >= QUALITY.minSample && row.rating_avg < QUALITY.minRating) {
    reasons.push('low_rating');
  }
  return {
    jobs30: row.jobs30,
    acceptancePct,
    onTimePct,
    regularCustomers: row.regulars,
    ratingAverage: row.rating_avg,
    ratingCount: row.rating_count,
    qualityReasons: reasons,
  };
}
