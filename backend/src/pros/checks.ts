import type { Queryable } from '../db.js';

/** The four checks every pro passes before getting jobs, one document each. */
export const DOCUMENT_KINDS = ['id', 'certificate', 'insurance', 'background'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** Documents the pro uploads; the background check is consent plus the partner's result, never a file (D93). */
export const UPLOAD_KINDS = ['id', 'certificate', 'insurance'] as const satisfies readonly DocumentKind[];
export type UploadKind = (typeof UPLOAD_KINDS)[number];

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
  /** Null for a background check, which has no file (D93). */
  uploadId: string | null;
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
  /** False only for the trade certificate of a pro whose trades all need none (cleaning, D93). */
  required: boolean;
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

export function checkOf(kind: DocumentKind, document: DocumentRow | null, today: string, required = true): Check {
  const check = (ok: boolean, state: CheckState): Check => ({ kind, ok, state, document, required });
  if (!document) {
    return check(false, 'missing');
  }
  if (document.reviewStatus === 'rejected') {
    return check(false, 'rejected');
  }
  if (document.reviewStatus === 'pending') {
    return check(false, 'waiting_review');
  }
  if (document.expiresOn && document.expiresOn < today) {
    return check(false, 'expired');
  }
  if (document.expiresOn && document.expiresOn <= addDays(today, EXPIRY_WARNING_DAYS)) {
    return check(true, 'expiring');
  }
  return check(true, 'valid');
}

/**
 * SQL that is true when the pro `proId` (an SQL expression) needs a trade certificate: unless every trade
 * they chose needs none (D93). With no trade chosen yet it counts as needed.
 */
export const certificateRequiredSql = (proId: string) => `(
  EXISTS (SELECT 1 FROM pro_trades rt JOIN categories rc ON rc.id = rt.category_id WHERE rt.pro_id = ${proId} AND rc.needs_certificate)
  OR NOT EXISTS (SELECT 1 FROM pro_trades rt WHERE rt.pro_id = ${proId}))`;

/** Whether the pro needs a trade certificate for the trades they chose. */
export async function certificateRequired(db: Queryable, proId: string): Promise<boolean> {
  const found = await db.query<{ required: boolean }>(`SELECT ${certificateRequiredSql('$1::uuid')} AS required`, [proId]);
  return found.rows[0]?.required ?? true;
}

/** True when every check the pro needs is OK; a certificate they do not need does not count. */
export const checksPassed = (checks: Check[]) => checks.every((c) => !c.required || c.ok);

export const DOCUMENT_COLUMNS = `kind, upload_id AS "uploadId", file_name AS "fileName", uploaded_at AS "uploadedAt",
  to_char(expires_on, 'YYYY-MM-DD') AS "expiresOn", review_status AS "reviewStatus", review_note AS "reviewNote",
  reviewed_at AS "reviewedAt", CASE WHEN valid_until = 'infinity' THEN 'infinity' ELSE to_char(valid_until, 'YYYY-MM-DD') END AS "validUntil"`;

/** All four checks of a pro, in a fixed order, each saying whether the pro needs it. */
export async function loadChecks(db: Queryable, proId: string, timezone: string): Promise<Check[]> {
  const docs = await db.query<DocumentRow>(`SELECT ${DOCUMENT_COLUMNS} FROM pro_documents WHERE pro_id = $1`, [proId]);
  const needsCertificate = await certificateRequired(db, proId);
  const today = marketToday(timezone);
  return DOCUMENT_KINDS.map((kind) =>
    checkOf(kind, docs.rows.find((d) => d.kind === kind) ?? null, today, kind !== 'certificate' || needsCertificate),
  );
}

// ---------- The Application status page (D93) ----------

export type StepKey = 'sent' | 'documents' | 'background' | 'decision';
export const STEP_KEYS: readonly StepKey[] = ['sent', 'documents', 'background', 'decision'];
/** done; current (being worked on); attention (waits for the pro); failed (not clear / not approved); upcoming. */
export type StepState = 'done' | 'current' | 'attention' | 'failed' | 'upcoming';

export interface Timeline {
  steps: { key: StepKey; state: StepState }[];
  /** The step to highlight. */
  current: StepKey;
}

/**
 * Where an application stands, from the pro's status and checks. Documents are checked once every
 * uploaded document the pro needs is accepted; the background check once the partner's result is in
 * ("clear" is an accepted check, "not clear" a rejected one); the decision is the team's. A pro approved
 * earlier (also when later moved to Pending approval or suspended) has passed every step. Null for an
 * application not sent yet.
 */
export function applicationTimeline(status: string, checks: Check[], requestedDocuments: readonly string[]): Timeline | null {
  if (status === 'draft') {
    return null;
  }
  if (status === 'approved' || status === 'pending_approval' || status === 'suspended') {
    return { steps: STEP_KEYS.map((key) => ({ key, state: 'done' })), current: 'decision' };
  }
  const documents = checks.filter((c) => c.kind !== 'background' && c.required);
  const background = checks.find((c) => c.kind === 'background');
  const documentsDone = documents.every((c) => c.ok);
  const documentsWaitForPro =
    (status === 'info_requested' && requestedDocuments.length > 0) ||
    documents.some((c) => c.state === 'rejected' || c.state === 'expired' || c.state === 'missing');
  const documentsState: StepState = documentsDone ? 'done' : documentsWaitForPro ? 'attention' : 'current';
  const backgroundState: StepState = background?.ok
    ? 'done'
    : background?.state === 'rejected'
      ? 'failed'
      : documentsDone
        ? 'current'
        : 'upcoming';
  const steps: Timeline['steps'] = [
    { key: 'sent', state: 'done' },
    { key: 'documents', state: documentsState },
    { key: 'background', state: backgroundState },
    { key: 'decision', state: documentsDone && backgroundState === 'done' ? 'current' : 'upcoming' },
  ];
  if (status === 'rejected') {
    // The decision is made, so nothing else is being worked on.
    return {
      steps: steps.map((step) =>
        step.key === 'decision' ? { key: step.key, state: 'failed' } : step.state === 'current' ? { key: step.key, state: 'upcoming' } : step,
      ),
      current: 'decision',
    };
  }
  const current = steps.find((s) => s.state === 'attention' || s.state === 'failed' || s.state === 'current');
  return { steps, current: current?.key ?? 'decision' };
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
