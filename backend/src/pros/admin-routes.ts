import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import type { BookingDeps } from '../bookings/events.js';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import { ApiError, badRequest, conflict, notFound } from '../errors.js';
import { uuidParams } from '../http.js';
import { formatSlot, messages } from '../notifications/messages.js';
import { enqueue } from '../notifications/outbox.js';
import {
  addDays,
  DOCUMENT_COLUMNS,
  DOCUMENT_KINDS,
  EXPIRING_KINDS,
  EXPIRY_WARNING_DAYS,
  loadChecks,
  marketToday,
  PRO_STATS,
  PRO_STATS_COLUMNS,
  proNumbers,
  type DocumentKind,
  type DocumentRow,
  type StatsRow,
} from './checks.js';
import {
  backToActiveIfCovered,
  DOCUMENT_NAMES,
  handOverWork,
  hasExpiredDocument,
  logProAction,
  withdrawOffers,
} from './management.js';

export const PRO_TABS = ['applications', 'active', 'pending_approval', 'suspended'] as const;
type ProTab = (typeof PRO_TABS)[number];

const TAB_STATUSES: Record<ProTab, string[]> = {
  applications: ['submitted', 'info_requested'],
  active: ['approved'],
  pending_approval: ['pending_approval'],
  suspended: ['suspended'],
};

/** A pro counts as online while their app has talked to MISK this recently. */
const ONLINE_MINUTES = 15;
/** The team can text a reminder about the same document at most once per this many minutes. */
const REMINDER_GAP_MINUTES = 60;

const kindParams = {
  type: 'object',
  required: ['id', 'kind'],
  properties: { id: { type: 'string', format: 'uuid' }, kind: { type: 'string', enum: DOCUMENT_KINDS } },
} as const;

const noteBody = (field: string, min = 3) =>
  ({
    type: 'object',
    required: [field],
    additionalProperties: false,
    properties: { [field]: { type: 'string', minLength: min, maxLength: 500, pattern: '\\S' } },
  }) as const;

interface ListRow extends StatsRow {
  id: string;
  firstName: string | null;
  lastName: string | null;
  status: string;
  trades: string[];
  submittedAt: Date | null;
  suspendedAt: Date | null;
  suspendedReason: string | null;
  reviewNote: string | null;
  jobsPaused: boolean;
  watchList: boolean;
  checksDone: number;
  expiringDocuments: number;
  expiredDocuments: number;
  waitingDocuments: number;
}

export async function adminProRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards } = ctx;
  const deps = (): BookingDeps => ({ pool, gateway: ctx.gateway, config: ctx.config, log: app.log });
  const today = () => marketToday(ctx.config.timezone);

  /** Moves a pro from one of `from` to `to`, or answers 409 when they are in another state. */
  async function move(proId: string, from: string[], to: string, extraSql = '', extra: unknown[] = []) {
    const updated = await pool.query(
      `UPDATE pro_profiles SET status = $2, updated_at = now()${extraSql} WHERE user_id = $1 AND status = ANY($3)`,
      [proId, to, from, ...extra],
    );
    if (!updated.rowCount) {
      const exists = await pool.query('SELECT 1 FROM pro_profiles WHERE user_id = $1', [proId]);
      throw exists.rowCount ? conflict('invalid_status') : notFound();
    }
  }

  async function detail(proId: string) {
    const found = await pool.query<
      StatsRow & {
        id: string;
        firstName: string | null;
        lastName: string | null;
        phone: string | null;
        email: string | null;
        status: string;
        homePostcode: string | null;
        postcodeName: string | null;
        radiusKm: number;
        workingDays: number[];
        trades: string[];
        submittedAt: Date | null;
        reviewNote: string | null;
        suspendedAt: Date | null;
        suspendedReason: string | null;
        jobsPausedAt: Date | null;
        watchListAt: Date | null;
        coachingCallAt: Date | null;
        payoutsEnabled: boolean;
        stripeAccountId: string | null;
        earnedThisMonthCents: number;
      }
    >(
      `SELECT p.user_id AS id, u.first_name AS "firstName", u.last_name AS "lastName", u.phone, u.email, p.status,
         p.home_postcode AS "homePostcode", pc.name AS "postcodeName", p.radius_km AS "radiusKm",
         p.working_days AS "workingDays", p.submitted_at AS "submittedAt", p.review_note AS "reviewNote",
         p.suspended_at AS "suspendedAt", p.suspended_reason AS "suspendedReason", p.jobs_paused_at AS "jobsPausedAt",
         p.watch_list_at AS "watchListAt", p.coaching_call_at AS "coachingCallAt", p.payouts_enabled AS "payoutsEnabled",
         p.stripe_account_id AS "stripeAccountId",
         COALESCE((SELECT array_agg(c.name ORDER BY c.name) FROM pro_trades t JOIN categories c ON c.id = t.category_id
                   WHERE t.pro_id = p.user_id), '{}') AS trades,
         (SELECT COALESCE(sum(x.amount_cents), 0)::int FROM (
            SELECT amount_cents, created_at FROM payouts WHERE pro_id = p.user_id AND status <> 'reversed'
            UNION ALL
            SELECT amount_cents, created_at FROM subscription_payouts WHERE pro_id = p.user_id
          ) x WHERE x.created_at >= (date_trunc('month', now() AT TIME ZONE $2) AT TIME ZONE $2)) AS "earnedThisMonthCents",
         ${PRO_STATS_COLUMNS}
       FROM pro_profiles p JOIN users u ON u.id = p.user_id LEFT JOIN postcodes pc ON pc.code = p.home_postcode
       ${PRO_STATS}
       WHERE p.user_id = $1`,
      [proId, ctx.config.timezone],
    );
    const pro = found.rows[0];
    if (!pro) {
      throw notFound();
    }
    const [checks, regulars, reviews, payouts, actions] = await Promise.all([
      loadChecks(pool, proId, ctx.config.timezone),
      pool.query(
        `SELECT s.id, cu.first_name AS "firstName", s.plan_name AS "planName", s.started_at AS "since"
         FROM subscriptions s JOIN users cu ON cu.id = s.customer_id
         WHERE s.pro_id = $1 AND s.status IN ('active', 'past_due') ORDER BY s.started_at`,
        [proId],
      ),
      pool.query(
        `SELECT r.stars, r.tags, r.created_at AS "createdAt", cu.first_name AS "customerName", b.service_name AS "service"
         FROM ratings r JOIN bookings b ON b.id = r.booking_id JOIN users cu ON cu.id = b.customer_id
         WHERE r.pro_id = $1 ORDER BY r.created_at DESC LIMIT 10`,
        [proId],
      ),
      pool.query(
        `SELECT amount_cents AS "amountCents", status, created_at AS "createdAt", 'job' AS source FROM payouts WHERE pro_id = $1
         UNION ALL
         SELECT amount_cents, status, created_at, 'plan' FROM subscription_payouts WHERE pro_id = $1
         ORDER BY "createdAt" DESC LIMIT 10`,
        [proId],
      ),
      pool.query(
        `SELECT a.id, a.action, a.details, a.created_at AS "createdAt", COALESCE(u.email, u.username) AS "adminName"
         FROM pro_admin_actions a LEFT JOIN users u ON u.id = a.admin_id WHERE a.pro_id = $1 ORDER BY a.id DESC LIMIT 100`,
        [proId],
      ),
    ]);

    let bank: { bankLast4: string | null; nextPayout: { amountCents: number; arrivesOn: Date } | null } | null = null;
    if (pro.stripeAccountId) {
      try {
        bank = await ctx.gateway.payoutDetails(pro.stripeAccountId);
      } catch (error) {
        // The profile still opens; the panel says the bank details could not be loaded.
        app.log.error({ event: 'payout_details_failed', proId, err: error });
      }
    }

    const { stripeAccountId, jobsPausedAt, watchListAt, ...rest } = pro;
    const numbers = proNumbers(pro);
    return {
      id: rest.id,
      firstName: rest.firstName,
      lastName: rest.lastName,
      phone: rest.phone,
      email: rest.email,
      status: rest.status,
      homePostcode: rest.homePostcode,
      postcodeName: rest.postcodeName,
      radiusKm: rest.radiusKm,
      workingDays: rest.workingDays,
      trades: rest.trades,
      submittedAt: rest.submittedAt,
      reviewNote: rest.reviewNote,
      suspendedAt: rest.suspendedAt,
      suspendedReason: rest.suspendedReason,
      jobsPausedAt,
      watchListAt,
      coachingCallAt: rest.coachingCallAt,
      payoutsEnabled: rest.payoutsEnabled,
      hasPayoutAccount: stripeAccountId !== null,
      ...numbers,
      earnedThisMonthCents: rest.earnedThisMonthCents,
      checks,
      allChecksOk: checks.every((c) => c.ok),
      regulars: regulars.rows,
      reviews: reviews.rows,
      payouts: payouts.rows,
      bank,
      actions: actions.rows,
    };
  }

  // Numbers for the top of the page and the tab counts, plus the invite link.
  app.get('/admin/pros/summary', { preHandler: guards.admin }, async () => {
    const result = await pool.query<{
      activePros: number;
      onlineNow: number;
      offers: number;
      accepted: number;
      documentsExpiring: number;
      applications: number;
      active: number;
      pendingApproval: number;
      suspended: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM pro_profiles WHERE status = 'approved') AS "activePros",
         (SELECT count(*)::int FROM pro_profiles p WHERE p.status = 'approved' AND p.jobs_paused_at IS NULL
            AND EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = p.user_id AND s.expires_at > now()
                          AND s.last_seen_at > now() - make_interval(mins => $3))) AS "onlineNow",
         (SELECT count(*)::int FROM booking_offers o JOIN pro_profiles p ON p.user_id = o.pro_id
            WHERE p.status = 'approved' AND o.status IN ('accepted', 'declined', 'expired')
              AND o.offered_at > now() - interval '30 days') AS offers,
         (SELECT count(*)::int FROM booking_offers o JOIN pro_profiles p ON p.user_id = o.pro_id
            WHERE p.status = 'approved' AND o.status = 'accepted' AND o.offered_at > now() - interval '30 days') AS accepted,
         (SELECT count(*)::int FROM pro_documents d JOIN pro_profiles p ON p.user_id = d.pro_id
            WHERE p.status IN ('approved', 'pending_approval') AND d.valid_until <> 'infinity'
              AND d.valid_until BETWEEN $1::date AND $2::date) AS "documentsExpiring",
         (SELECT count(*)::int FROM pro_profiles WHERE status IN ('submitted', 'info_requested')) AS applications,
         (SELECT count(*)::int FROM pro_profiles WHERE status = 'approved') AS active,
         (SELECT count(*)::int FROM pro_profiles WHERE status = 'pending_approval') AS "pendingApproval",
         (SELECT count(*)::int FROM pro_profiles WHERE status = 'suspended') AS suspended`,
      [today(), addDays(today(), EXPIRY_WARNING_DAYS), ONLINE_MINUTES],
    );
    const r = result.rows[0];
    if (!r) {
      throw new Error('Summary query returned nothing');
    }
    return {
      kpis: {
        activePros: r.activePros,
        onlineNow: r.onlineNow,
        avgAcceptancePct: r.offers ? Math.round((r.accepted * 100) / r.offers) : null,
        documentsExpiring: r.documentsExpiring,
      },
      counts: {
        applications: r.applications,
        active: r.active,
        pending_approval: r.pendingApproval,
        suspended: r.suspended,
      },
      // Pros sign in with their phone (job offers come by text); the link opens that sign-in with "pro" chosen.
      inviteUrl: `${ctx.config.webOrigin}/signin?as=pro&method=phone`,
    };
  });

  // The red badge in the menu: applications waiting for the team.
  app.get('/admin/badges', { preHandler: guards.admin }, async () => {
    const result = await pool.query<{ applications: number }>(
      "SELECT count(*)::int AS applications FROM pro_profiles WHERE status = 'submitted'",
    );
    return { applications: result.rows[0]?.applications ?? 0 };
  });

  app.get<{ Querystring: { tab?: ProTab; q?: string } }>(
    '/admin/pros',
    {
      preHandler: guards.admin,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { tab: { type: 'string', enum: PRO_TABS }, q: { type: 'string', maxLength: 60 } },
        },
      },
    },
    async (request) => {
      const tab = request.query.tab ?? 'applications';
      const result = await pool.query<ListRow>(
        `SELECT p.user_id AS id, u.first_name AS "firstName", u.last_name AS "lastName", p.status,
           COALESCE((SELECT array_agg(c.name ORDER BY c.name) FROM pro_trades t JOIN categories c ON c.id = t.category_id
                     WHERE t.pro_id = p.user_id), '{}') AS trades,
           p.submitted_at AS "submittedAt", p.suspended_at AS "suspendedAt", p.suspended_reason AS "suspendedReason",
           p.review_note AS "reviewNote", p.jobs_paused_at IS NOT NULL AS "jobsPaused", p.watch_list_at IS NOT NULL AS "watchList",
           (SELECT count(*)::int FROM pro_documents d WHERE d.pro_id = p.user_id AND d.review_status = 'accepted'
              AND (d.expires_on IS NULL OR d.expires_on >= $2::date)) AS "checksDone",
           (SELECT count(*)::int FROM pro_documents d WHERE d.pro_id = p.user_id AND d.valid_until <> 'infinity'
              AND d.valid_until BETWEEN $2::date AND $3::date) AS "expiringDocuments",
           (SELECT count(*)::int FROM pro_documents d WHERE d.pro_id = p.user_id AND d.valid_until < $2::date) AS "expiredDocuments",
           (SELECT count(*)::int FROM pro_documents d WHERE d.pro_id = p.user_id AND d.review_status = 'pending') AS "waitingDocuments",
           ${PRO_STATS_COLUMNS}
         FROM pro_profiles p JOIN users u ON u.id = p.user_id
         ${PRO_STATS}
         WHERE p.status = ANY($1)
           AND ($4::text IS NULL OR u.first_name ILIKE '%' || $4 || '%' OR u.last_name ILIKE '%' || $4 || '%'
                OR u.phone ILIKE '%' || $4 || '%' OR u.email ILIKE '%' || $4 || '%')
         ORDER BY CASE WHEN $5 = 'applications' THEN p.submitted_at END ASC NULLS LAST,
                  CASE WHEN $5 = 'suspended' THEN p.suspended_at END DESC NULLS LAST,
                  u.first_name, p.user_id
         LIMIT 500`,
        [TAB_STATUSES[tab], today(), addDays(today(), EXPIRY_WARNING_DAYS), request.query.q?.trim() || null, tab],
      );
      return {
        pros: result.rows.map((row) => {
          const numbers = proNumbers(row);
          return {
            id: row.id,
            firstName: row.firstName,
            lastName: row.lastName,
            status: row.status,
            trades: row.trades,
            submittedAt: row.submittedAt,
            suspendedAt: row.suspendedAt,
            suspendedReason: row.suspendedReason,
            reviewNote: row.reviewNote,
            jobsPaused: row.jobsPaused,
            watchList: row.watchList,
            checksDone: row.checksDone,
            checksTotal: DOCUMENT_KINDS.length,
            ready: row.checksDone === DOCUMENT_KINDS.length,
            expiringDocument: row.expiringDocuments > 0,
            expiredDocument: row.expiredDocuments > 0,
            waitingDocuments: row.waitingDocuments,
            ...numbers,
          };
        }),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/admin/pros/:id',
    { preHandler: guards.admin, schema: { params: uuidParams } },
    async (request) => ({ pro: await detail(request.params.id) }),
  );

  // ---------- Applications ----------

  app.post<{ Params: { id: string } }>(
    '/admin/pros/:id/approve',
    { preHandler: guards.admin, schema: { params: uuidParams } },
    async (request) => {
      const proId = request.params.id;
      const checks = await loadChecks(pool, proId, ctx.config.timezone);
      if (!checks.every((c) => c.ok)) {
        throw conflict('checks_open');
      }
      await withTransaction(pool, async (client) => {
        const updated = await client.query(
          `UPDATE pro_profiles SET status = 'approved', review_note = NULL, reviewed_at = now(), reviewed_by = $2, updated_at = now()
           WHERE user_id = $1 AND status IN ('submitted', 'info_requested')`,
          [proId, currentUser(request).id],
        );
        if (!updated.rowCount) {
          throw conflict('invalid_status');
        }
        await logProAction(client, proId, currentUser(request).id, 'approved');
        await enqueue(client, proId, 'application_reviewed', messages.applicationApproved());
      });
      request.log.info({ event: 'pro_approved', proId, by: currentUser(request).id });
      return { pro: await detail(proId) };
    },
  );

  app.post<{ Params: { id: string }; Body: { message: string } }>(
    '/admin/pros/:id/request-info',
    { preHandler: guards.admin, schema: { params: uuidParams, body: noteBody('message') } },
    async (request) => {
      const proId = request.params.id;
      const message = request.body.message.trim();
      await withTransaction(pool, async (client) => {
        const updated = await client.query(
          `UPDATE pro_profiles SET status = 'info_requested', review_note = $2, reviewed_at = now(), reviewed_by = $3, updated_at = now()
           WHERE user_id = $1 AND status IN ('submitted', 'info_requested')`,
          [proId, message, currentUser(request).id],
        );
        if (!updated.rowCount) {
          throw conflict('invalid_status');
        }
        await logProAction(client, proId, currentUser(request).id, 'info_requested', { message });
        await enqueue(client, proId, 'application_reviewed', messages.infoRequested(message));
      });
      return { pro: await detail(proId) };
    },
  );

  app.post<{ Params: { id: string }; Body: { note: string } }>(
    '/admin/pros/:id/reject',
    { preHandler: guards.admin, schema: { params: uuidParams, body: noteBody('note') } },
    async (request) => {
      const proId = request.params.id;
      const note = request.body.note.trim();
      await withTransaction(pool, async (client) => {
        const updated = await client.query(
          `UPDATE pro_profiles SET status = 'rejected', review_note = $2, reviewed_at = now(), reviewed_by = $3, updated_at = now()
           WHERE user_id = $1 AND status IN ('submitted', 'info_requested')`,
          [proId, note, currentUser(request).id],
        );
        if (!updated.rowCount) {
          throw conflict('invalid_status');
        }
        await logProAction(client, proId, currentUser(request).id, 'rejected', { note });
        await enqueue(client, proId, 'application_reviewed', messages.applicationRejected());
      });
      request.log.info({ event: 'pro_rejected', proId, by: currentUser(request).id });
      return { pro: await detail(proId) };
    },
  );

  // ---------- Documents ----------

  app.post<{ Params: { id: string; kind: DocumentKind }; Body: { expiresOn?: string } }>(
    '/admin/pros/:id/documents/:kind/accept',
    {
      preHandler: guards.admin,
      schema: {
        params: kindParams,
        body: { type: 'object', additionalProperties: false, properties: { expiresOn: { type: 'string', format: 'date' } } },
      },
    },
    async (request) => {
      const { id: proId, kind } = request.params;
      const adminId = currentUser(request).id;
      const moved = await withTransaction(pool, async (client) => {
        const found = await client.query<DocumentRow>(
          `SELECT ${DOCUMENT_COLUMNS} FROM pro_documents WHERE pro_id = $1 AND kind = $2 FOR UPDATE`,
          [proId, kind],
        );
        const doc = found.rows[0];
        if (!doc) {
          throw notFound('document_not_found');
        }
        const expiresOn = request.body.expiresOn ?? doc.expiresOn;
        if (!expiresOn && EXPIRING_KINDS.has(kind)) {
          throw badRequest('expiry_required');
        }
        if (expiresOn && expiresOn < today()) {
          throw badRequest('document_expired');
        }
        await client.query(
          `UPDATE pro_documents SET review_status = 'accepted', review_note = NULL, reviewed_at = now(), reviewed_by = $3,
             expires_on = $4, valid_until = COALESCE($4::date, 'infinity'::date)
           WHERE pro_id = $1 AND kind = $2`,
          [proId, kind, adminId, expiresOn],
        );
        await logProAction(client, proId, adminId, 'document_accepted', { document: kind, expiresOn });
        return backToActiveIfCovered(client, proId, adminId, ctx.config.timezone);
      });
      return { pro: await detail(proId), backToActive: moved };
    },
  );

  app.post<{ Params: { id: string; kind: DocumentKind }; Body: { note: string } }>(
    '/admin/pros/:id/documents/:kind/reject',
    { preHandler: guards.admin, schema: { params: kindParams, body: noteBody('note') } },
    async (request) => {
      const { id: proId, kind } = request.params;
      const note = request.body.note.trim();
      await withTransaction(pool, async (client) => {
        const updated = await client.query(
          `UPDATE pro_documents SET review_status = 'rejected', review_note = $3, reviewed_at = now(), reviewed_by = $4
           WHERE pro_id = $1 AND kind = $2`,
          [proId, kind, note, currentUser(request).id],
        );
        if (!updated.rowCount) {
          throw notFound('document_not_found');
        }
        await logProAction(client, proId, currentUser(request).id, 'document_rejected', { document: kind, note });
        await enqueue(client, proId, 'pro_documents', messages.documentRejected(DOCUMENT_NAMES[kind], note));
      });
      return { pro: await detail(proId) };
    },
  );

  app.post<{ Params: { id: string; kind: DocumentKind } }>(
    '/admin/pros/:id/documents/:kind/remind',
    { preHandler: guards.admin, schema: { params: kindParams } },
    async (request) => {
      const { id: proId, kind } = request.params;
      const checks = await loadChecks(pool, proId, ctx.config.timezone);
      const check = checks.find((c) => c.kind === kind);
      const exists = await pool.query('SELECT 1 FROM pro_profiles WHERE user_id = $1', [proId]);
      if (!check || !exists.rowCount) {
        throw notFound();
      }
      if (check.state === 'valid' || check.state === 'waiting_review') {
        throw conflict('nothing_to_remind');
      }
      const recent = await pool.query(
        `SELECT 1 FROM pro_admin_actions WHERE pro_id = $1 AND action = 'reminder_sent' AND details->>'document' = $2
           AND created_at > now() - make_interval(mins => $3)`,
        [proId, kind, REMINDER_GAP_MINUTES],
      );
      if (recent.rowCount) {
        throw conflict('reminder_recent');
      }
      const name = DOCUMENT_NAMES[kind];
      const text =
        check.state === 'expiring' && check.document?.expiresOn
          ? messages.documentExpiringReminder(name, check.document.expiresOn)
          : messages.documentReminder(name);
      await withTransaction(pool, async (client) => {
        await enqueue(client, proId, 'pro_documents', text);
        await logProAction(client, proId, currentUser(request).id, 'reminder_sent', { document: kind, state: check.state });
      });
      return { pro: await detail(proId) };
    },
  );

  // ---------- Quality ----------

  app.post<{ Params: { id: string }; Body: { on: boolean } }>(
    '/admin/pros/:id/watch-list',
    {
      preHandler: guards.admin,
      schema: {
        params: uuidParams,
        body: { type: 'object', required: ['on'], additionalProperties: false, properties: { on: { type: 'boolean' } } },
      },
    },
    async (request) => {
      const proId = request.params.id;
      const updated = await pool.query(
        `UPDATE pro_profiles SET watch_list_at = CASE WHEN $2 THEN COALESCE(watch_list_at, now()) END, updated_at = now()
         WHERE user_id = $1 AND (watch_list_at IS NOT NULL) <> $2`,
        [proId, request.body.on],
      );
      if (updated.rowCount) {
        await logProAction(pool, proId, currentUser(request).id, request.body.on ? 'watch_list_on' : 'watch_list_off');
      }
      return { pro: await detail(proId) };
    },
  );

  app.post<{ Params: { id: string }; Body: { startsAt: string } }>(
    '/admin/pros/:id/coaching',
    {
      preHandler: guards.admin,
      schema: {
        params: uuidParams,
        body: {
          type: 'object',
          required: ['startsAt'],
          additionalProperties: false,
          properties: { startsAt: { type: 'string', format: 'date-time' } },
        },
      },
    },
    async (request) => {
      const proId = request.params.id;
      const startsAt = new Date(request.body.startsAt);
      if (startsAt.getTime() <= Date.now()) {
        throw new ApiError(400, 'time_in_past');
      }
      await withTransaction(pool, async (client) => {
        const updated = await client.query(
          `UPDATE pro_profiles SET coaching_call_at = $2, updated_at = now()
           WHERE user_id = $1 AND status IN ('approved', 'pending_approval')`,
          [proId, startsAt],
        );
        if (!updated.rowCount) {
          throw conflict('invalid_status');
        }
        await enqueue(client, proId, 'pro_account', messages.coachingCall(formatSlot(startsAt, ctx.config.timezone)));
        await logProAction(client, proId, currentUser(request).id, 'coaching_booked', { at: startsAt.toISOString() });
      });
      return { pro: await detail(proId) };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/pros/:id/pause',
    { preHandler: guards.admin, schema: { params: uuidParams } },
    async (request) => {
      const proId = request.params.id;
      const updated = await pool.query(
        `UPDATE pro_profiles SET jobs_paused_at = now(), updated_at = now()
         WHERE user_id = $1 AND jobs_paused_at IS NULL AND status IN ('approved', 'pending_approval')`,
        [proId],
      );
      if (!updated.rowCount) {
        throw conflict('invalid_status');
      }
      await logProAction(pool, proId, currentUser(request).id, 'jobs_paused');
      await enqueue(pool, proId, 'pro_account', messages.jobsPaused());
      await withdrawOffers(deps(), proId);
      request.log.info({ event: 'pro_jobs_paused', proId, by: currentUser(request).id });
      return { pro: await detail(proId) };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/pros/:id/resume',
    { preHandler: guards.admin, schema: { params: uuidParams } },
    async (request) => {
      const proId = request.params.id;
      const updated = await pool.query(
        'UPDATE pro_profiles SET jobs_paused_at = NULL, updated_at = now() WHERE user_id = $1 AND jobs_paused_at IS NOT NULL',
        [proId],
      );
      if (!updated.rowCount) {
        throw conflict('invalid_status');
      }
      await logProAction(pool, proId, currentUser(request).id, 'jobs_resumed');
      await enqueue(pool, proId, 'pro_account', messages.jobsResumed());
      return { pro: await detail(proId) };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/admin/pros/:id/suspend',
    { preHandler: guards.admin, schema: { params: uuidParams, body: noteBody('reason') } },
    async (request) => {
      const proId = request.params.id;
      const adminId = currentUser(request).id;
      const reason = request.body.reason.trim();
      await move(proId, ['approved', 'pending_approval'], 'suspended', ', suspended_at = now(), suspended_reason = $4', [reason]);
      await enqueue(pool, proId, 'pro_account', messages.accountSuspended());
      const handOver = await handOverWork(deps(), proId, adminId);
      await logProAction(pool, proId, adminId, 'suspended', { reason, ...handOver });
      request.log.warn({ event: 'pro_suspended', proId, by: adminId, ...handOver });
      return { pro: await detail(proId), handOver };
    },
  );

  // Back to Active, or to Pending approval when a document ran out meanwhile.
  app.post<{ Params: { id: string } }>(
    '/admin/pros/:id/reinstate',
    { preHandler: guards.admin, schema: { params: uuidParams } },
    async (request) => {
      const proId = request.params.id;
      const adminId = currentUser(request).id;
      const to = (await hasExpiredDocument(pool, proId, ctx.config.timezone)) ? 'pending_approval' : 'approved';
      await move(proId, ['suspended'], to, ', suspended_at = NULL, suspended_reason = NULL');
      await logProAction(pool, proId, adminId, 'reinstated', { to });
      await enqueue(
        pool,
        proId,
        'pro_account',
        to === 'approved' ? messages.accountReinstated() : messages.reinstatedNeedsDocuments(),
      );
      request.log.info({ event: 'pro_reinstated', proId, by: adminId, to });
      return { pro: await detail(proId) };
    },
  );
}

