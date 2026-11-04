import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import { normalizePostcode } from '../catalogue/routes.js';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { uuidParams } from '../http.js';
import { messages } from '../notifications/messages.js';
import { enqueue } from '../notifications/outbox.js';
import { readSingleFile, storeUpload } from '../uploads/uploads.js';

export const DOCUMENT_KINDS = ['id', 'certificate', 'insurance'] as const;
type DocumentKind = (typeof DOCUMENT_KINDS)[number];

const EDITABLE_TRADES = new Set(['draft', 'rejected']);

/** Average stars and count per pro, used in profiles, admin lists and dispatch order. */
export const RATING_SQL = `(SELECT round(avg(stars)::numeric, 2)::float FROM ratings r WHERE r.pro_id = p.user_id) AS "ratingAverage",
  (SELECT count(*)::int FROM ratings r WHERE r.pro_id = p.user_id) AS "ratingCount"`;

async function loadProfile(ctx: AppContext, userId: string) {
  const profile = await ctx.pool.query(
    `SELECT p.status, p.home_postcode AS "homePostcode", p.radius_km AS "radiusKm",
       p.working_days AS "workingDays", p.review_note AS "reviewNote", p.payouts_enabled AS "payoutsEnabled",
       p.stripe_account_id IS NOT NULL AS "hasPayoutAccount", ${RATING_SQL},
       COALESCE((SELECT array_agg(category_id) FROM pro_trades WHERE pro_id = p.user_id), '{}') AS trades
     FROM pro_profiles p WHERE p.user_id = $1`,
    [userId],
  );
  const row = profile.rows[0];
  if (!row) {
    throw notFound('profile_not_found');
  }
  const docs = await ctx.pool.query<{ kind: DocumentKind; uploadedAt: Date; uploadId: string }>(
    'SELECT kind, uploaded_at AS "uploadedAt", upload_id AS "uploadId" FROM pro_documents WHERE pro_id = $1',
    [userId],
  );
  const documents = Object.fromEntries(
    DOCUMENT_KINDS.map((kind) => {
      const doc = docs.rows.find((d) => d.kind === kind);
      return [kind, doc ? { uploadId: doc.uploadId, uploadedAt: doc.uploadedAt } : null];
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

  app.post<{ Params: { kind: DocumentKind } }>(
    '/pro/documents/:kind',
    {
      preHandler: guards.pro,
      schema: { params: { type: 'object', properties: { kind: { type: 'string', enum: DOCUMENT_KINDS } } } },
    },
    async (request, reply) => {
      const userId = currentUser(request).id;
      const content = await readSingleFile(request);
      const replaced = await withTransaction(pool, async (client) => {
        const upload = await storeUpload(client, ctx.storage, { ownerId: userId, kind: 'document', content });
        const previous = await client.query<{ storage_key: string; id: string }>(
          `SELECT u.id, u.storage_key FROM pro_documents d JOIN uploads u ON u.id = d.upload_id
           WHERE d.pro_id = $1 AND d.kind = $2`,
          [userId, request.params.kind],
        );
        await client.query(
          `INSERT INTO pro_documents (pro_id, kind, upload_id) VALUES ($1, $2, $3)
           ON CONFLICT (pro_id, kind) DO UPDATE SET upload_id = EXCLUDED.upload_id, uploaded_at = now()`,
          [userId, request.params.kind, upload.id],
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
       WHERE user_id = $1 AND status IN ('draft', 'rejected')`,
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

  // ---------- Admin review ----------

  app.get<{ Querystring: { status?: string } }>(
    '/admin/pros',
    {
      preHandler: guards.admin,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { status: { type: 'string', enum: ['draft', 'submitted', 'approved', 'rejected', 'suspended'] } },
        },
      },
    },
    async (request) => {
      const result = await pool.query(
        `SELECT p.user_id AS id, u.first_name AS "firstName", u.phone, p.status, p.home_postcode AS "homePostcode",
           p.radius_km AS "radiusKm", p.working_days AS "workingDays", p.submitted_at AS "submittedAt",
           p.payouts_enabled AS "payoutsEnabled", ${RATING_SQL},
           COALESCE((SELECT array_agg(c.name ORDER BY c.name) FROM pro_trades t JOIN categories c ON c.id = t.category_id
                     WHERE t.pro_id = p.user_id), '{}') AS trades,
           (SELECT count(*)::int FROM pro_documents d WHERE d.pro_id = p.user_id) AS "documentCount"
         FROM pro_profiles p JOIN users u ON u.id = p.user_id
         WHERE ($1::text IS NULL OR p.status = $1)
         ORDER BY (p.status = 'submitted') DESC, p.submitted_at NULLS LAST, u.first_name
         LIMIT 500`,
        [request.query.status ?? null],
      );
      return { pros: result.rows };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/admin/pros/:id',
    { preHandler: guards.admin, schema: { params: uuidParams } },
    async (request) => {
      const user = await pool.query<{ firstName: string | null; phone: string | null }>(
        `SELECT first_name AS "firstName", phone FROM users WHERE id = $1 AND role = 'pro'`,
        [request.params.id],
      );
      if (!user.rowCount) {
        throw notFound();
      }
      return { pro: { id: request.params.id, ...user.rows[0], ...(await loadProfile(ctx, request.params.id)) } };
    },
  );

  app.post<{ Params: { id: string }; Body: { decision: 'approve' | 'reject' | 'suspend'; note?: string } }>(
    '/admin/pros/:id/review',
    {
      preHandler: guards.admin,
      schema: {
        params: uuidParams,
        body: {
          type: 'object',
          required: ['decision'],
          additionalProperties: false,
          properties: {
            decision: { type: 'string', enum: ['approve', 'reject', 'suspend'] },
            note: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (request) => {
      const { decision } = request.body;
      const note = request.body.note?.trim() || null;
      if (decision === 'reject' && !note) {
        throw badRequest('note_required');
      }
      const rules = {
        approve: { from: ['submitted', 'suspended'], to: 'approved', text: messages.applicationApproved() },
        reject: { from: ['submitted'], to: 'rejected', text: messages.applicationRejected() },
        suspend: { from: ['approved'], to: 'suspended', text: messages.accountSuspended() },
      }[decision];
      await withTransaction(pool, async (client) => {
        const updated = await client.query(
          `UPDATE pro_profiles SET status = $2, review_note = $3, reviewed_at = now(), reviewed_by = $4, updated_at = now()
           WHERE user_id = $1 AND status = ANY($5)`,
          [request.params.id, rules.to, note, currentUser(request).id, rules.from],
        );
        if (!updated.rowCount) {
          throw conflict('invalid_status');
        }
        await enqueue(client, request.params.id, 'application_reviewed', rules.text);
      });
      request.log.info({ event: 'pro_reviewed', proId: request.params.id, decision, by: currentUser(request).id });
      return { pro: { id: request.params.id, ...(await loadProfile(ctx, request.params.id)) } };
    },
  );
}
