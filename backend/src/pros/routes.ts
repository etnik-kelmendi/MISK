import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import { normalizePostcode, POSTCODE_INPUT_MAX_LENGTH } from '../catalogue/routes.js';
import type { AppContext } from '../context.js';
import { withTransaction, type Queryable } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { messages } from '../notifications/messages.js';
import { enqueue } from '../notifications/outbox.js';
import { readNamedFile, storeUpload } from '../uploads/uploads.js';
import { LATE_CANCEL_PAUSE_DAYS, LATE_CANCEL_PAUSED } from '../bookings/dispatch.js';
import { nextPayoutDate, type PayoutInterval } from '../payments/payouts.js';
import {
  applicationTimeline,
  certificateRequiredSql,
  checkOf,
  DOCUMENT_COLUMNS,
  DOCUMENT_KINDS,
  EXPIRING_KINDS,
  loadChecks,
  marketToday,
  type DocumentKind,
  type DocumentRow,
} from './checks.js';
import { logProAction } from './management.js';
import { loadAvailability } from './working-hours.js';

export { DOCUMENT_KINDS };

/** States in which the pro can still change their application and send it (again). */
const EDITABLE_TRADES = new Set(['draft', 'rejected', 'info_requested']);
/** States in which the pro may still take back their consent to the background check. */
const CONSENT_OPEN = new Set(['draft', 'rejected']);
/** A turned-down applicant can apply again this long after the decision (D93). */
export const REAPPLY_INTERVAL = "interval '6 months'";
/** Where every message about the application leads in the app. */
export const APPLICATION_LINK = '/pro/application';

/** Average stars and count per pro, used in profiles, admin lists and dispatch order. */
export const RATING_SQL = `(SELECT round(avg(stars)::numeric, 2)::float FROM ratings r WHERE r.pro_id = p.user_id) AS "ratingAverage",
  (SELECT count(*)::int FROM ratings r WHERE r.pro_id = p.user_id) AS "ratingCount"`;

interface ProfileRow {
  status: string;
  homePostcode: string | null;
  homeAddress: string | null;
  radiusKm: number;
  workingDays: number[];
  trades: string[];
  backgroundConsentAt: Date | null;
  requestedDocuments: DocumentKind[];
  reapplyOn: string | null;
  mayReapply: boolean;
  certificateRequired: boolean;
  [key: string]: unknown;
}

/**
 * The pro's own profile and application. The home address is private: it is only ever sent to the pro
 * themselves and to the MISK team, never to customers (D93).
 */
async function loadProfile(ctx: AppContext, userId: string, db: Queryable = ctx.pool) {
  const profile = await db.query<ProfileRow>(
    `SELECT p.status, p.home_postcode AS "homePostcode", p.home_address AS "homeAddress", p.radius_km AS "radiusKm",
       p.working_days AS "workingDays", p.review_note AS "reviewNote", p.payouts_enabled AS "payoutsEnabled",
       p.jobs_paused_at IS NOT NULL AS "jobsPaused", p.suspended_reason AS "suspendedReason",
       p.stripe_account_id IS NOT NULL AS "hasPayoutAccount", p.photo_upload_id AS "photoId", ${RATING_SQL},
       COALESCE((SELECT array_agg(category_id) FROM pro_trades WHERE pro_id = p.user_id), '{}') AS trades,
       -- The Jobs page (D86): the online switch, the trade names, and a pause after late cancellations.
       p.online,
       COALESCE((SELECT array_agg(c.name ORDER BY c.sort_order, c.name) FROM pro_trades t JOIN categories c ON c.id = t.category_id
                 WHERE t.pro_id = p.user_id), '{}') AS "tradeNames",
       (SELECT max(c.created_at) + make_interval(days => ${LATE_CANCEL_PAUSE_DAYS}) FROM pro_cancellations c
        WHERE c.pro_id = p.user_id AND c.late AND c.created_at > now() - make_interval(days => ${LATE_CANCEL_PAUSE_DAYS})
          AND ${LATE_CANCEL_PAUSED}) AS "offersPausedUntil",
       -- The application (D93).
       p.submitted_at AS "submittedAt", p.background_consent_at AS "backgroundConsentAt",
       p.requested_documents AS "requestedDocuments", p.rejected_at AS "rejectedAt",
       CASE WHEN p.status = 'rejected' AND p.rejected_at IS NOT NULL
         THEN to_char((p.rejected_at + ${REAPPLY_INTERVAL}) AT TIME ZONE $2, 'YYYY-MM-DD') END AS "reapplyOn",
       (p.rejected_at IS NULL OR p.rejected_at + ${REAPPLY_INTERVAL} <= now()) AS "mayReapply",
       ${certificateRequiredSql('p.user_id')} AS "certificateRequired"
     FROM pro_profiles p WHERE p.user_id = $1`,
    [userId, ctx.config.timezone],
  );
  const row = profile.rows[0];
  if (!row) {
    throw notFound('profile_not_found');
  }
  const { mayReapply, ...rest } = row;
  const docs = await db.query<DocumentRow>(`SELECT ${DOCUMENT_COLUMNS} FROM pro_documents WHERE pro_id = $1`, [userId]);
  const today = marketToday(ctx.config.timezone);
  const documents = Object.fromEntries(
    DOCUMENT_KINDS.map((kind) => {
      const doc = docs.rows.find((d) => d.kind === kind) ?? null;
      return [
        kind,
        doc
          ? {
              uploadId: doc.uploadId,
              fileName: doc.fileName,
              uploadedAt: doc.uploadedAt,
              expiresOn: doc.expiresOn,
              reviewStatus: doc.reviewStatus,
              // The team's note on a background check stays with the team: the pro sees "clear" or "not clear".
              reviewNote: kind === 'background' ? null : doc.reviewNote,
              state: checkOf(kind, doc, today).state,
            }
          : null,
      ];
    }),
  ) as Record<DocumentKind, { uploadId: string | null; expiresOn: string | null; state: string } | null>;
  // Whether the pro can change the application and send it: a turned-down applicant waits 6 months.
  const editable = EDITABLE_TRADES.has(row.status) && (row.status !== 'rejected' || mayReapply);
  // Working hours, holidays and whether offers come in right now (D94).
  const availability = await loadAvailability(db, userId, ctx.config.timezone);
  return { ...rest, editable, documents, availability };
}

type Profile = Awaited<ReturnType<typeof loadProfile>>;

/**
 * Locks the pro's profile for a change. A pro whose application was turned down less than 6 months ago
 * cannot change or send it yet (D93).
 */
async function lockProfile(db: Queryable, userId: string) {
  const current = await db.query<{ status: string; mayReapply: boolean; requestedDocuments: DocumentKind[] }>(
    `SELECT status, (rejected_at IS NULL OR rejected_at + ${REAPPLY_INTERVAL} <= now()) AS "mayReapply",
       requested_documents AS "requestedDocuments"
     FROM pro_profiles WHERE user_id = $1 FOR UPDATE`,
    [userId],
  );
  const row = current.rows[0];
  if (!row) {
    throw notFound('profile_not_found');
  }
  if (row.status === 'rejected' && !row.mayReapply) {
    throw conflict('reapply_not_yet');
  }
  return row;
}

/**
 * Checks that an application can be sent, in the order of the page, with one clear reason each.
 * Required documents: ID, liability insurance and, unless every chosen trade needs none, the trade
 * certificate; each uploaded, not turned down and not run out.
 */
function checkComplete(profile: Profile, today: string) {
  // A document waiting for review still has its date, so judge the date itself, not only the check state.
  for (const kind of DOCUMENT_KINDS) {
    const doc = profile.documents[kind];
    if (doc && (doc.state === 'expired' || (doc.expiresOn && doc.expiresOn < today))) {
      throw badRequest('document_expired');
    }
  }
  if (!profile.trades.length) {
    throw badRequest('trades_missing');
  }
  if (!profile.homeAddress || !profile.homePostcode) {
    throw badRequest('home_address_missing');
  }
  if (!Number.isInteger(profile.radiusKm) || profile.radiusKm < 3 || profile.radiusKm > 30) {
    throw badRequest('radius_invalid');
  }
  const needed: DocumentKind[] = profile.certificateRequired ? ['id', 'certificate', 'insurance'] : ['id', 'insurance'];
  if (needed.some((kind) => !profile.documents[kind] || profile.documents[kind]?.state === 'rejected')) {
    throw badRequest('documents_missing');
  }
  if (!profile.backgroundConsentAt) {
    throw badRequest('background_consent_missing');
  }
  if (!profile.workingDays.length) {
    throw badRequest('working_days_missing');
  }
}

export async function proRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards } = ctx;

  app.get('/pro/profile', { preHandler: guards.pro }, async (request) => ({
    profile: await loadProfile(ctx, currentUser(request).id),
  }));

  // The Application status page (D93): the profile, where the application stands, and how to reach support.
  app.get('/pro/application', { preHandler: guards.pro }, async (request) => {
    const userId = currentUser(request).id;
    const profile = await loadProfile(ctx, userId);
    const checks = await loadChecks(pool, userId, ctx.config.timezone);
    return {
      profile,
      timeline: applicationTimeline(profile.status, checks, profile.requestedDocuments),
      support: ctx.config.support,
    };
  });

  app.patch<{
    Body: {
      homePostcode?: string;
      homeAddress?: string;
      radiusKm?: number;
      workingDays?: number[];
      trades?: string[];
      backgroundConsent?: boolean;
    };
  }>(
    '/pro/profile',
    {
      preHandler: guards.pro,
      schema: {
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: {
            homePostcode: { type: 'string', minLength: 2, maxLength: POSTCODE_INPUT_MAX_LENGTH },
            homeAddress: { type: 'string', minLength: 3, maxLength: 200, pattern: '\\S' },
            radiusKm: { type: 'integer', minimum: 3, maximum: 30 },
            workingDays: { type: 'array', uniqueItems: true, maxItems: 7, items: { type: 'integer', minimum: 1, maximum: 7 } },
            trades: { type: 'array', uniqueItems: true, maxItems: 20, items: { type: 'string', format: 'uuid' } },
            backgroundConsent: { type: 'boolean' },
          },
        },
      },
    },
    async (request) => {
      const userId = currentUser(request).id;
      const { homePostcode, homeAddress, radiusKm, workingDays, trades, backgroundConsent } = request.body;
      await withTransaction(pool, async (client) => {
        const { status } = await lockProfile(client, userId);
        if (homePostcode !== undefined) {
          const code = normalizePostcode(homePostcode);
          const served = await client.query('SELECT 1 FROM postcodes WHERE code = $1 AND active', [code]);
          if (!served.rowCount) {
            throw badRequest('postcode_not_served');
          }
          await client.query('UPDATE pro_profiles SET home_postcode = $2 WHERE user_id = $1', [userId, code]);
        }
        if (homeAddress !== undefined) {
          const address = homeAddress.trim().replace(/\s+/g, ' ');
          if (address.length < 3) {
            throw badRequest('home_address_missing');
          }
          await client.query('UPDATE pro_profiles SET home_address = $2 WHERE user_id = $1', [userId, address]);
        }
        if (radiusKm !== undefined) {
          await client.query('UPDATE pro_profiles SET radius_km = $2 WHERE user_id = $1', [userId, radiusKm]);
        }
        if (workingDays !== undefined) {
          await client.query('UPDATE pro_profiles SET working_days = $2 WHERE user_id = $1', [
            userId,
            [...workingDays].sort(),
          ]);
        }
        if (trades !== undefined) {
          // Approved trades were checked by the team; changing them needs a new review.
          if (!EDITABLE_TRADES.has(status)) {
            throw conflict('trades_locked');
          }
          const known = await client.query('SELECT id FROM categories WHERE id = ANY($1) AND active', [trades]);
          if (known.rowCount !== trades.length) {
            throw badRequest('unknown_trade');
          }
          await client.query('DELETE FROM pro_trades WHERE pro_id = $1', [userId]);
          await client.query(
            'INSERT INTO pro_trades (pro_id, category_id) SELECT $1, unnest($2::uuid[])',
            [userId, trades],
          );
        }
        if (backgroundConsent !== undefined) {
          // Consent can be taken back until the application is sent; the check is under way after that.
          if (!backgroundConsent && !CONSENT_OPEN.has(status)) {
            throw conflict('consent_locked');
          }
          await client.query(
            `UPDATE pro_profiles SET background_consent_at = CASE WHEN $2 THEN COALESCE(background_consent_at, now()) END
             WHERE user_id = $1`,
            [userId, backgroundConsent],
          );
        }
        await client.query('UPDATE pro_profiles SET updated_at = now() WHERE user_id = $1', [userId]);
      });
      return { profile: await loadProfile(ctx, userId) };
    },
  );

  // A new copy always waits for the team's check. An accepted earlier copy keeps covering the pro until it
  // runs out, so renewing in good time never stops their jobs. When the team asked for this document, the
  // review carries on by itself once every document they named is in (D93).
  app.post<{ Params: { kind: DocumentKind }; Querystring: { expiresOn?: string } }>(
    '/pro/documents/:kind',
    {
      preHandler: guards.pro,
      schema: {
        params: { type: 'object', properties: { kind: { type: 'string', enum: DOCUMENT_KINDS } } },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { expiresOn: { type: 'string', format: 'date' } },
        },
      },
    },
    async (request, reply) => {
      const userId = currentUser(request).id;
      const { kind } = request.params;
      if (kind === 'background') {
        // The background check is a consent, not a file (D93).
        throw badRequest('background_is_a_check');
      }
      const expiresOn = request.query.expiresOn ?? null;
      if (!expiresOn && EXPIRING_KINDS.has(kind)) {
        throw badRequest('expiry_required');
      }
      if (expiresOn && expiresOn < marketToday(ctx.config.timezone)) {
        throw badRequest('document_expired');
      }
      const { content, fileName } = await readNamedFile(request);
      const replaced = await withTransaction(pool, async (client) => {
        const profile = await lockProfile(client, userId);
        const upload = await storeUpload(client, ctx.storage, { ownerId: userId, kind: 'document', content });
        const previous = await client.query<{ storage_key: string; id: string }>(
          `SELECT u.id, u.storage_key FROM pro_documents d JOIN uploads u ON u.id = d.upload_id
           WHERE d.pro_id = $1 AND d.kind = $2`,
          [userId, kind],
        );
        await client.query(
          `INSERT INTO pro_documents (pro_id, kind, upload_id, file_name, expires_on) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (pro_id, kind) DO UPDATE SET upload_id = EXCLUDED.upload_id, uploaded_at = now(),
             file_name = EXCLUDED.file_name, expires_on = EXCLUDED.expires_on, review_status = 'pending',
             review_note = NULL, reviewed_at = NULL, reviewed_by = NULL`,
          [userId, kind, upload.id, fileName, expiresOn],
        );
        const old = previous.rows[0];
        if (old) {
          await client.query('DELETE FROM uploads WHERE id = $1', [old.id]);
        }
        if (profile.status === 'info_requested' && profile.requestedDocuments.includes(kind)) {
          const left = profile.requestedDocuments.filter((k) => k !== kind);
          await logProAction(client, userId, null, 'info_provided', { document: kind });
          if (left.length === 0) {
            // Back to the team at the same place in the queue: no new application.
            await client.query(
              `UPDATE pro_profiles SET status = 'submitted', requested_documents = '{}', review_note = NULL, updated_at = now()
               WHERE user_id = $1`,
              [userId],
            );
            await enqueue(client, userId, 'application_reviewed', messages.applicationResumed(), { link: APPLICATION_LINK });
          } else {
            await client.query('UPDATE pro_profiles SET requested_documents = $2, updated_at = now() WHERE user_id = $1', [
              userId,
              left,
            ]);
          }
        }
        return old?.storage_key ?? null;
      });
      if (replaced) {
        await ctx.storage.remove(replaced);
      }
      return reply.code(201).send({ profile: await loadProfile(ctx, userId) });
    },
  );

  // The pro's profile photo (D83): customers see it on their booking, the rating page and the chat. A JPEG or
  // PNG of up to 8 MB; a new photo replaces the old one, whose file is deleted.
  async function replacePhoto(userId: string, content: Buffer | null) {
    const oldKey = await withTransaction(pool, async (client) => {
      const current = await client.query<{ id: string | null; storage_key: string | null }>(
        `SELECT u.id, u.storage_key FROM pro_profiles p LEFT JOIN uploads u ON u.id = p.photo_upload_id
         WHERE p.user_id = $1 FOR UPDATE OF p`,
        [userId],
      );
      const row = current.rows[0];
      if (!row) {
        throw notFound('profile_not_found');
      }
      const upload = content ? await storeUpload(client, ctx.storage, { ownerId: userId, kind: 'photo', content }) : null;
      await client.query('UPDATE pro_profiles SET photo_upload_id = $2, updated_at = now() WHERE user_id = $1', [userId, upload?.id ?? null]);
      if (row.id) {
        await client.query('DELETE FROM uploads WHERE id = $1', [row.id]);
      }
      return row.storage_key;
    });
    if (oldKey) {
      try {
        await ctx.storage.remove(oldKey);
      } catch (error) {
        // The photo is already replaced; a file left behind does no harm.
        app.log.warn({ event: 'pro_photo_file_not_removed', err: error });
      }
    }
  }

  app.post('/pro/photo', { preHandler: guards.pro }, async (request, reply) => {
    const userId = currentUser(request).id;
    const { content } = await readNamedFile(request);
    await replacePhoto(userId, content);
    request.log.info({ event: 'pro_photo_changed', userId });
    return reply.code(201).send({ profile: await loadProfile(ctx, userId) });
  });

  app.delete('/pro/photo', { preHandler: guards.pro }, async (request) => {
    const userId = currentUser(request).id;
    await replacePhoto(userId, null);
    request.log.info({ event: 'pro_photo_removed', userId });
    return { profile: await loadProfile(ctx, userId) };
  });

  // Sends the application to the team. Sent again after "Request info", it keeps its place in the queue.
  // Agreeing to the background check starts it: the check waits for the partner's result (D93).
  app.post('/pro/submit', { preHandler: guards.pro }, async (request) => {
    const userId = currentUser(request).id;
    const resumed = await withTransaction(pool, async (client) => {
      const { status } = await lockProfile(client, userId);
      if (!EDITABLE_TRADES.has(status)) {
        throw conflict('already_submitted');
      }
      checkComplete(await loadProfile(ctx, userId, client), marketToday(ctx.config.timezone));
      await client.query(
        `UPDATE pro_profiles SET status = 'submitted', review_note = NULL, requested_documents = '{}', updated_at = now(),
           submitted_at = CASE WHEN status = 'info_requested' AND submitted_at IS NOT NULL THEN submitted_at ELSE now() END
         WHERE user_id = $1`,
        [userId],
      );
      // A check that came back "not clear" before is run again for a new application.
      await client.query(
        `INSERT INTO pro_documents (pro_id, kind, upload_id, file_name) VALUES ($1, 'background', NULL, '')
         ON CONFLICT (pro_id, kind) DO UPDATE SET review_status = 'pending', review_note = NULL, reviewed_at = NULL,
           reviewed_by = NULL, valid_until = NULL
         WHERE pro_documents.review_status = 'rejected'`,
        [userId],
      );
      const isResumed = status === 'info_requested';
      await enqueue(
        client,
        userId,
        'application_reviewed',
        isResumed ? messages.applicationResumed() : messages.applicationSent(),
        { link: APPLICATION_LINK },
      );
      return isResumed;
    });
    request.log.info({ event: resumed ? 'pro_application_resumed' : 'pro_application_submitted', userId });
    return { profile: await loadProfile(ctx, userId) };
  });

  // ---------- Payouts (Stripe Connect Express) ----------

  app.post('/pro/payouts/link', { preHandler: guards.pro }, async (request) => {
    const userId = currentUser(request).id;
    const found = await pool.query<{ status: string; stripe_account_id: string | null }>(
      'SELECT status, stripe_account_id FROM pro_profiles WHERE user_id = $1',
      [userId],
    );
    const profile = found.rows[0];
    if (!profile) {
      throw notFound('profile_not_found');
    }
    if (profile.status !== 'approved') {
      throw conflict('not_approved');
    }
    let accountId = profile.stripe_account_id;
    if (!accountId) {
      accountId = await ctx.gateway.createConnectedAccount({ userId, idempotencyKey: `account-${userId}` });
      await pool.query('UPDATE pro_profiles SET stripe_account_id = $2 WHERE user_id = $1 AND stripe_account_id IS NULL', [
        userId,
        accountId,
      ]);
    }
    const base = `${ctx.config.webOrigin}/pro/profile`;
    const url = await ctx.gateway.onboardingLink({
      accountId,
      returnUrl: `${base}?payouts=return`,
      refreshUrl: `${base}?payouts=refresh`,
    });
    return { url };
  });

  // What the pro earns per job now, and when and where their money goes, from the Settings page.
  app.get('/pro/payouts', { preHandler: guards.pro }, async (request) => {
    const found = await pool.query<{ share: number; interval: PayoutInterval; account: string | null }>(
      `SELECT s.pro_share_pct AS share, s.payout_interval AS interval, p.stripe_account_id AS account
       FROM settings s, pro_profiles p WHERE p.user_id = $1`,
      [currentUser(request).id],
    );
    const row = found.rows[0];
    if (!row) {
      throw notFound('profile_not_found');
    }
    let bankLast4: string | null = null;
    if (row.account) {
      try {
        bankLast4 = (await ctx.gateway.payoutDetails(row.account)).bankLast4;
      } catch (error) {
        request.log.error({ event: 'payout_details_failed', err: error });
      }
    }
    return {
      payouts: {
        sharePct: row.share,
        interval: row.interval,
        nextPayoutOn: nextPayoutDate(row.interval, marketToday(ctx.config.timezone)),
        bankLast4,
      },
    };
  });

  app.post('/pro/payouts/refresh', { preHandler: guards.pro }, async (request) => {
    const userId = currentUser(request).id;
    const found = await pool.query<{ stripe_account_id: string | null }>(
      'SELECT stripe_account_id FROM pro_profiles WHERE user_id = $1',
      [userId],
    );
    const accountId = found.rows[0]?.stripe_account_id;
    if (accountId) {
      const { payoutsEnabled } = await ctx.gateway.accountStatus(accountId);
      await pool.query('UPDATE pro_profiles SET payouts_enabled = $2, updated_at = now() WHERE user_id = $1', [
        userId,
        payoutsEnabled,
      ]);
    }
    return { profile: await loadProfile(ctx, userId) };
  });
}
