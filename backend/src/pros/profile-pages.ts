import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import type { AppContext } from '../context.js';
import type { Queryable } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { RATING_TAGS } from '../bookings/customer-routes.js';
import {
  addDays,
  certificateRequired,
  DOCUMENT_COLUMNS,
  EXPIRING_KINDS,
  EXPIRY_WARNING_DAYS,
  marketToday,
  UPLOAD_KINDS,
  type DocumentRow,
  type UploadKind,
} from './checks.js';
import { GOALS, loadPerformance } from './performance.js';
import { CHARGE_DELAY_HOURS, FREE_CANCEL_HOURS } from '../bookings/lifecycle.js';
import { LATE_CANCEL_LIMIT, LATE_CANCEL_PAUSE_DAYS, LATE_CANCEL_WINDOW_DAYS } from '../bookings/dispatch.js';
import { NO_SHOW_WAIT_MINUTES } from '../bookings/on-site.js';
import type { PayoutInterval } from '../payments/payouts.js';
import { loadBankSummary } from './bank-account.js';

/**
 * The pro Profile and its read pages (D100): the numbers behind the Profile rows, Documents with their status,
 * Ratings & reviews with one reply per review, and Performance. Every route only ever reads or changes the
 * signed-in pro's own data.
 */

/** What the pro sees for a document: one of Valid, Expiring soon, Being checked or Expired (or not uploaded). */
export type DocumentStatus = 'valid' | 'expiring' | 'checking' | 'expired' | 'missing';

export interface ProDocument {
  kind: UploadKind;
  status: DocumentStatus;
  /** The date shown: the new copy's while it is being checked, otherwise the date the pro is covered until. */
  expiresOn: string | null;
  /** True for documents that run out, which need a date when a new copy is uploaded. */
  expires: boolean;
  fileName: string | null;
  /** The team did not accept the latest copy, with their reason; an earlier copy may still cover the pro. */
  notAccepted: boolean;
  reviewNote: string | null;
  required: boolean;
}

/** The status of one document for the pro, judged in the market's day `today`. */
export function documentStatus(doc: DocumentRow | null, today: string): Pick<ProDocument, 'status' | 'expiresOn'> {
  if (!doc) {
    return { status: 'missing', expiresOn: null };
  }
  if (doc.reviewStatus === 'pending') {
    return { status: 'checking', expiresOn: doc.expiresOn };
  }
  // What covers the pro: the accepted copy's date. A copy the team turned down leaves the earlier cover in place.
  const cover = doc.reviewStatus === 'accepted' ? (doc.validUntil ?? doc.expiresOn ?? 'infinity') : doc.validUntil;
  if (!cover) {
    return { status: 'missing', expiresOn: null };
  }
  if (cover === 'infinity') {
    return { status: 'valid', expiresOn: null };
  }
  if (cover < today) {
    return { status: 'expired', expiresOn: cover };
  }
  return { status: cover <= addDays(today, EXPIRY_WARNING_DAYS) ? 'expiring' : 'valid', expiresOn: cover };
}

/** The pro's uploaded documents for the Documents page. The background check is a check, not a document (D93). */
export async function loadDocuments(db: Queryable, proId: string, timezone: string): Promise<ProDocument[]> {
  const [docs, needsCertificate, pendingNeedsCertificate] = await Promise.all([
    db.query<DocumentRow>(`SELECT ${DOCUMENT_COLUMNS} FROM pro_documents WHERE pro_id = $1`, [proId]),
    certificateRequired(db, proId),
    // A trade waiting for the team's check that needs a certificate asks for one too (D100).
    db.query(
      `SELECT 1 FROM pro_trades t JOIN categories c ON c.id = t.category_id WHERE t.pro_id = $1 AND NOT t.approved AND c.needs_certificate`,
      [proId],
    ),
  ]);
  const today = marketToday(timezone);
  return UPLOAD_KINDS.flatMap((kind) => {
    const doc = docs.rows.find((d) => d.kind === kind) ?? null;
    const required = kind !== 'certificate' || needsCertificate || Boolean(pendingNeedsCertificate.rowCount);
    if (!doc && !required) {
      return [];
    }
    return [
      {
        kind,
        ...documentStatus(doc, today),
        expires: EXPIRING_KINDS.has(kind),
        fileName: doc?.fileName || null,
        notAccepted: doc?.reviewStatus === 'rejected',
        reviewNote: doc?.reviewStatus === 'rejected' ? doc.reviewNote : null,
        required,
      },
    ];
  });
}

/** How many ratings the Latest reviews list shows per page, and the furthest it can go. */
export const REVIEWS_PAGE = 10;
const REVIEWS_MAX_PAGE = 50;
const REVIEWS_MAX_OFFSET = 10_000;
/** The tags shown under "Customers mention", most chosen first. */
export const TOP_TAGS = 5;
export const REPLY_MAX_LENGTH = 500;

export interface ReviewSummary {
  average: number | null;
  count: number;
  /** 5 stars down to 1, each with its share of all ratings in whole percent. */
  stars: { stars: number; count: number; pct: number }[];
  tags: { tag: string; count: number }[];
}

export async function loadReviewSummary(db: Queryable, proId: string): Promise<ReviewSummary> {
  const [totals, perStar, tags] = await Promise.all([
    db.query<{ average: number | null; count: number }>(
      'SELECT round(avg(stars)::numeric, 1)::float AS average, count(*)::int AS count FROM ratings WHERE pro_id = $1',
      [proId],
    ),
    db.query<{ stars: number; count: number }>('SELECT stars, count(*)::int AS count FROM ratings WHERE pro_id = $1 GROUP BY stars', [proId]),
    db.query<{ tag: string; count: number }>(
      `SELECT tag, count(*)::int AS count FROM ratings r, unnest(r.tags) AS tag
       WHERE r.pro_id = $1 AND tag = ANY($2::text[]) GROUP BY tag ORDER BY count(*) DESC, tag LIMIT ${TOP_TAGS}`,
      [proId, [...RATING_TAGS]],
    ),
  ]);
  const { average, count } = totals.rows[0] ?? { average: null, count: 0 };
  return {
    average,
    count,
    stars: [5, 4, 3, 2, 1].map((stars) => {
      const n = perStar.rows.find((row) => row.stars === stars)?.count ?? 0;
      return { stars, count: n, pct: count ? Math.round((n * 100) / count) : 0 };
    }),
    tags: tags.rows,
  };
}

/** One review as the pro sees it: the customer's first name only. */
export interface Review {
  bookingId: string;
  stars: number;
  tags: string[];
  review: string | null;
  customerName: string | null;
  createdAt: Date;
  reply: string | null;
  repliedAt: Date | null;
}

const REVIEW_COLUMNS = `r.booking_id AS "bookingId", r.stars, r.tags, r.review, cu.first_name AS "customerName",
  r.created_at AS "createdAt", r.reply, r.replied_at AS "repliedAt"`;

export async function loadReviews(db: Queryable, proId: string, offset: number, limit: number): Promise<{ reviews: Review[]; hasMore: boolean }> {
  const found = await db.query<Review>(
    `SELECT ${REVIEW_COLUMNS} FROM ratings r JOIN users cu ON cu.id = r.customer_id
     WHERE r.pro_id = $1 ORDER BY r.created_at DESC, r.booking_id LIMIT $2 OFFSET $3`,
    [proId, limit + 1, offset],
  );
  return { reviews: found.rows.slice(0, limit), hasMore: found.rows.length > limit };
}

/** The badge-sized numbers on the Profile rows and the header. */
export interface ProfileOverview {
  jobsDone: number;
  documents: { expiring: number; expired: number; checking: number };
  bankLast4: string | null;
  topPercent: number | null;
}

export async function profilePagesRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards } = ctx;
  const tz = ctx.config.timezone;

  // The Profile page (D100): finished jobs and plan visits for the header, and what the Documents, Bank account
  // and Performance rows show. The rating and the availability come with GET /pro/profile.
  app.get('/pro/profile/overview', { preHandler: guards.pro }, async (request): Promise<{ overview: ProfileOverview }> => {
    const proId = currentUser(request).id;
    const [jobs, documents, bank, performance] = await Promise.all([
      pool.query<{ done: number }>(
        `SELECT (SELECT count(*)::int FROM bookings WHERE pro_id = $1 AND status = 'completed')
           + (SELECT count(*)::int FROM subscription_visits WHERE pro_id = $1 AND status = 'completed') AS done`,
        [proId],
      ),
      loadDocuments(pool, proId, tz),
      loadBankSummary(ctx, proId, request.log),
      loadPerformance(pool, proId),
    ]);
    const count = (status: DocumentStatus) => documents.filter((d) => d.status === status).length;
    return {
      overview: {
        jobsDone: jobs.rows[0]?.done ?? 0,
        documents: { expiring: count('expiring'), expired: count('expired'), checking: count('checking') },
        bankLast4: bank.bank?.last4 ?? null,
        topPercent: performance.rank?.topPercent ?? null,
      },
    };
  });

  app.get('/pro/documents', { preHandler: guards.pro }, async (request) => ({
    documents: await loadDocuments(pool, currentUser(request).id, tz),
  }));

  app.get<{ Querystring: { offset?: string; limit?: string } }>(
    '/pro/reviews',
    {
      preHandler: guards.pro,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          // Query strings are not coerced to numbers (app.ts), so they are checked as digits here.
          properties: {
            offset: { type: 'string', pattern: '^[0-9]{1,5}$' },
            limit: { type: 'string', pattern: '^[1-9][0-9]?$' },
          },
        },
      },
    },
    async (request) => {
      const proId = currentUser(request).id;
      const offset = Number(request.query.offset ?? 0);
      const limit = Number(request.query.limit ?? REVIEWS_PAGE);
      if (offset > REVIEWS_MAX_OFFSET || limit > REVIEWS_MAX_PAGE) {
        throw badRequest('page_invalid');
      }
      const [summary, page] = await Promise.all([loadReviewSummary(pool, proId), loadReviews(pool, proId, offset, limit)]);
      return { summary, ...page, replyMaxLength: REPLY_MAX_LENGTH };
    },
  );

  // One reply per review, only on the pro's own reviews, and no edits once sent (D100). The customer sees it under
  // their review on the booking page; the team sees it on the pro's profile.
  app.post<{ Params: { bookingId: string }; Body: { text: string } }>(
    '/pro/reviews/:bookingId/reply',
    {
      preHandler: guards.pro,
      schema: {
        params: { type: 'object', required: ['bookingId'], properties: { bookingId: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object',
          required: ['text'],
          additionalProperties: false,
          properties: { text: { type: 'string', minLength: 1, maxLength: REPLY_MAX_LENGTH, pattern: '\\S' } },
        },
      },
    },
    async (request) => {
      const proId = currentUser(request).id;
      const { bookingId } = request.params;
      const text = request.body.text.trim();
      const saved = await pool.query<{ bookingId: string }>(
        `UPDATE ratings SET reply = $3, replied_at = now() WHERE booking_id = $1 AND pro_id = $2 AND reply IS NULL
         RETURNING booking_id AS "bookingId"`,
        [bookingId, proId, text],
      );
      if (!saved.rowCount) {
        const mine = await pool.query('SELECT 1 FROM ratings WHERE booking_id = $1 AND pro_id = $2', [bookingId, proId]);
        // Someone else's review is answered as if it did not exist.
        throw mine.rowCount ? conflict('already_replied') : notFound('review_not_found');
      }
      request.log.info({ event: 'review_replied', proId, bookingId });
      const found = await pool.query<Review>(
        `SELECT ${REVIEW_COLUMNS} FROM ratings r JOIN users cu ON cu.id = r.customer_id WHERE r.booking_id = $1`,
        [bookingId],
      );
      return { review: found.rows[0] };
    },
  );

  // The numbers the pro Help & support answers quote (D100), from Settings and the rules in force, so they are true.
  app.get('/pro/help', { preHandler: guards.pro }, async () => {
    const found = await pool.query<{ interval: PayoutInterval; callOutFeeCents: number; sharePct: number }>(
      'SELECT payout_interval AS interval, no_show_fee_cents AS "callOutFeeCents", pro_share_pct AS "sharePct" FROM settings',
    );
    const row = found.rows[0] ?? { interval: 'weekly' as const, callOutFeeCents: 0, sharePct: 0 };
    return {
      help: {
        payoutInterval: row.interval,
        releaseHours: CHARGE_DELAY_HOURS,
        notHomeWaitMinutes: NO_SHOW_WAIT_MINUTES,
        callOutFeeCents: row.callOutFeeCents,
        freeCancelHours: FREE_CANCEL_HOURS,
        lateCancelLimit: LATE_CANCEL_LIMIT,
        lateCancelWindowDays: LATE_CANCEL_WINDOW_DAYS,
        lateCancelPauseDays: LATE_CANCEL_PAUSE_DAYS,
        goals: GOALS,
        support: ctx.config.support,
      },
    };
  });

  app.get('/pro/performance', { preHandler: guards.pro }, async (request) => ({
    performance: await loadPerformance(pool, currentUser(request).id),
  }));
}
