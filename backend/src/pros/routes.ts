import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import { normalizePostcode } from '../catalogue/routes.js';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { readNamedFile, storeUpload } from '../uploads/uploads.js';
import { nextPayoutDate, type PayoutInterval } from '../payments/payouts.js';
import { DOCUMENT_KINDS, EXPIRING_KINDS, checkOf, marketToday, DOCUMENT_COLUMNS, type DocumentKind, type DocumentRow } from './checks.js';

export { DOCUMENT_KINDS };

/** States in which the pro can still change their application and send it (again). */
const EDITABLE_TRADES = new Set(['draft', 'rejected', 'info_requested']);

/** Average stars and count per pro, used in profiles, admin lists and dispatch order. */
export const RATING_SQL = `(SELECT round(avg(stars)::numeric, 2)::float FROM ratings r WHERE r.pro_id = p.user_id) AS "ratingAverage",
  (SELECT count(*)::int FROM ratings r WHERE r.pro_id = p.user_id) AS "ratingCount"`;

async function loadProfile(ctx: AppContext, userId: string) {
  const profile = await ctx.pool.query(
    `SELECT p.status, p.home_postcode AS "homePostcode", p.radius_km AS "radiusKm",
       p.working_days AS "workingDays", p.review_note AS "reviewNote", p.payouts_enabled AS "payoutsEnabled",
       p.jobs_paused_at IS NOT NULL AS "jobsPaused", p.suspended_reason AS "suspendedReason",
       p.stripe_account_id IS NOT NULL AS "hasPayoutAccount", ${RATING_SQL},
       COALESCE((SELECT array_agg(category_id) FROM pro_trades WHERE pro_id = p.user_id), '{}') AS trades
     FROM pro_profiles p WHERE p.user_id = $1`,
    [userId],
  );
  const row = profile.rows[0];
  if (!row) {
    throw notFound('profile_not_found');
  }
  const docs = await ctx.pool.query<DocumentRow>(`SELECT ${DOCUMENT_COLUMNS} FROM pro_documents WHERE pro_id = $1`, [userId]);
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
              reviewNote: doc.reviewNote,
              state: checkOf(kind, doc, today).state,
            }
          : null,
      ];
    }),
  );
  return { ...row, documents };
}

export async function proRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards } = ctx;

  app.get('/pro/profile', { preHandler: guards.pro }, async (request) => ({
    profile: await loadProfile(ctx, currentUser(request).id),
  }));

  app.patch<{ Body: { homePostcode?: string; radiusKm?: number; workingDays?: number[]; trades?: string[] } }>(
    '/pro/profile',
    {
      preHandler: guards.pro,
      schema: {
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: {
            homePostcode: { type: 'string', minLength: 2, maxLength: 10 },
            radiusKm: { type: 'integer', minimum: 3, maximum: 30 },
            workingDays: { type: 'array', uniqueItems: true, maxItems: 7, items: { type: 'integer', minimum: 1, maximum: 7 } },
            trades: { type: 'array', uniqueItems: true, maxItems: 20, items: { type: 'string', format: 'uuid' } },
          },
        },
      },
    },
    async (request) => {
      const userId = currentUser(request).id;
      const { homePostcode, radiusKm, workingDays, trades } = request.body;
      await withTransaction(pool, async (client) => {
        const current = await client.query<{ status: string }>(
          'SELECT status FROM pro_profiles WHERE user_id = $1 FOR UPDATE',
          [userId],
        );
        const status = current.rows[0]?.status;
        if (!status) {
          throw notFound('profile_not_found');
        }
        if (homePostcode !== undefined) {
          const code = normalizePostcode(homePostcode);
          const served = await client.query('SELECT 1 FROM postcodes WHERE code = $1 AND active', [code]);
          if (!served.rowCount) {
            throw badRequest('postcode_not_served');
          }
          await client.query('UPDATE pro_profiles SET home_postcode = $2 WHERE user_id = $1', [userId, code]);
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
        await client.query('UPDATE pro_profiles SET updated_at = now() WHERE user_id = $1', [userId]);
      });
      return { profile: await loadProfile(ctx, userId) };
    },
  );

  // A new copy always waits for the team's check. An accepted earlier copy keeps covering the pro until it
  // runs out, so renewing in good time never stops their jobs.
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
      const expiresOn = request.query.expiresOn ?? null;
      if (!expiresOn && EXPIRING_KINDS.has(request.params.kind)) {
        throw badRequest('expiry_required');
      }
      if (expiresOn && expiresOn < marketToday(ctx.config.timezone)) {
        throw badRequest('document_expired');
      }
      const { content, fileName } = await readNamedFile(request);
      const replaced = await withTransaction(pool, async (client) => {
        const upload = await storeUpload(client, ctx.storage, { ownerId: userId, kind: 'document', content });
        const previous = await client.query<{ storage_key: string; id: string }>(
          `SELECT u.id, u.storage_key FROM pro_documents d JOIN uploads u ON u.id = d.upload_id
           WHERE d.pro_id = $1 AND d.kind = $2`,
          [userId, request.params.kind],
        );
        await client.query(
          `INSERT INTO pro_documents (pro_id, kind, upload_id, file_name, expires_on) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (pro_id, kind) DO UPDATE SET upload_id = EXCLUDED.upload_id, uploaded_at = now(),
             file_name = EXCLUDED.file_name, expires_on = EXCLUDED.expires_on, review_status = 'pending',
             review_note = NULL, reviewed_at = NULL, reviewed_by = NULL`,
          [userId, request.params.kind, upload.id, fileName, expiresOn],
        );
        const old = previous.rows[0];
        if (old) {
          await client.query('DELETE FROM uploads WHERE id = $1', [old.id]);
        }
        return old?.storage_key ?? null;
      });
      if (replaced) {
        await ctx.storage.remove(replaced);
      }
      return reply.code(201).send({ profile: await loadProfile(ctx, userId) });
    },
  );

  app.post('/pro/submit', { preHandler: guards.pro }, async (request) => {
    const userId = currentUser(request).id;
    const profile = await loadProfile(ctx, userId);
    if (!EDITABLE_TRADES.has(profile.status)) {
      throw conflict('already_submitted');
    }
    const missing: string[] = [];
    if (!profile.trades.length) missing.push('trades');
    if (!profile.homePostcode) missing.push('homePostcode');
    if (!profile.workingDays.length) missing.push('workingDays');
    for (const kind of DOCUMENT_KINDS) {
      if (!profile.documents[kind]) missing.push(`document:${kind}`);
    }
    if (missing.length) {
      throw badRequest('application_incomplete');
    }
    await pool.query(
      `UPDATE pro_profiles SET status = 'submitted', submitted_at = now(), review_note = NULL, updated_at = now()
       WHERE user_id = $1 AND status IN ('draft', 'rejected', 'info_requested')`,
      [userId],
    );
    request.log.info({ event: 'pro_application_submitted', userId });
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
