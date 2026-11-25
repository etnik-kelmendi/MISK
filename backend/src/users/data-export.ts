import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { currentUser } from '../auth/guard.js';
import type { AppContext } from '../context.js';
import { withTransaction, type Queryable } from '../db.js';
import { ApiError, conflict } from '../errors.js';
import type { EmailSender } from '../notifications/email.js';

/**
 * "Download my data" (D100): a signed-in customer or pro asks for a copy of their own data, which is emailed to their
 * own address as one JSON file within 48 hours (in practice within minutes, by a background job). One request a day.
 * The copy holds what MISK keeps about the person themselves: other people appear by first name only, uploaded files
 * are listed (name, dates, check) but not attached, and nothing from the team's notes about them is included.
 */

/** One request per this many hours. */
export const EXPORT_INTERVAL_HOURS = 24;
/** The promise made on the page; the worker normally takes minutes. */
export const EXPORT_PROMISE_HOURS = 48;
/** Sending is tried this many times before the request is marked failed. */
const MAX_ATTEMPTS = 5;
/** The most bookings, visits and other rows listed per section, so the file stays small enough for email. */
const SECTION_LIMIT = 2000;

/** "d•••@example.com": enough to recognise the address without showing it whole. */
export function maskEmail(email: string): string {
  const [name = '', domain = ''] = email.split('@');
  return `${name.slice(0, 1)}•••@${domain}`;
}

export interface ExportStatus {
  /** The address the copy goes to, masked; null when the account has no email address. */
  email: string | null;
  pending: boolean;
  requestedAt: Date | null;
  sentAt: Date | null;
  /** When the next request can be made; null when it can be made now. */
  nextAllowedAt: Date | null;
}

async function loadStatus(db: Queryable, userId: string): Promise<ExportStatus> {
  const found = await db.query<{ email: string | null; requestedAt: Date | null; sentAt: Date | null; failed: boolean; nextAllowedAt: Date | null }>(
    `SELECT u.email, x.requested_at AS "requestedAt", x.sent_at AS "sentAt", x.failed_at IS NOT NULL AS failed,
       CASE WHEN x.requested_at > now() - make_interval(hours => ${EXPORT_INTERVAL_HOURS})
         THEN x.requested_at + make_interval(hours => ${EXPORT_INTERVAL_HOURS}) END AS "nextAllowedAt"
     FROM users u
     LEFT JOIN LATERAL (SELECT * FROM data_exports d WHERE d.user_id = u.id ORDER BY d.requested_at DESC LIMIT 1) x ON true
     WHERE u.id = $1`,
    [userId],
  );
  const row = found.rows[0];
  return {
    email: row?.email ? maskEmail(row.email) : null,
    pending: Boolean(row?.requestedAt && !row.sentAt && !row.failed),
    requestedAt: row?.requestedAt ?? null,
    sentAt: row?.sentAt ?? null,
    // A failed request may be made again at once.
    nextAllowedAt: row?.failed ? null : (row?.nextAllowedAt ?? null),
  };
}

/** Everything the copy holds, built from the person's own rows. */
export async function buildUserData(db: Queryable, userId: string): Promise<Record<string, unknown>> {
  const one = async (sql: string) => (await db.query(sql, [userId])).rows[0] ?? null;
  const many = async (sql: string) => (await db.query(`${sql} LIMIT ${SECTION_LIMIT}`, [userId])).rows;
  const [account, notificationSwitches, addresses, pro, trades, documents, holidays, daysOff] = await Promise.all([
    one(`SELECT first_name AS "firstName", last_name AS "lastName", phone, email, role, language, created_at AS "createdAt"
         FROM users WHERE id = $1`),
    many(`SELECT topic, enabled, updated_at AS "updatedAt" FROM user_notification_prefs WHERE user_id = $1 ORDER BY topic`),
    many(`SELECT label, address, postcode, notes, is_selected AS selected, created_at AS "createdAt" FROM customer_addresses WHERE customer_id = $1 ORDER BY created_at`),
    one(`SELECT status, home_address AS "homeAddress", home_postcode AS "homePostcode", radius_km AS "radiusKm",
           working_days AS "workingDays", to_char(work_start, 'HH24:MI') AS "workStart", to_char(work_end, 'HH24:MI') AS "workEnd",
           years_experience AS "yearsExperience", about, online, background_consent_at AS "backgroundConsentAt",
           submitted_at AS "submittedAt", created_at AS "createdAt"
         FROM pro_profiles WHERE user_id = $1`),
    many(`SELECT c.name AS trade, t.approved, t.requested_at AS "addedAt" FROM pro_trades t JOIN categories c ON c.id = t.category_id
          WHERE t.pro_id = $1 ORDER BY c.name`),
    many(`SELECT kind, NULLIF(file_name, '') AS "fileName", uploaded_at AS "uploadedAt", to_char(expires_on, 'YYYY-MM-DD') AS "expiresOn",
            review_status AS "checkStatus", reviewed_at AS "checkedAt"
          FROM pro_documents WHERE pro_id = $1 ORDER BY kind`),
    many(`SELECT to_char(starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(ends_on, 'YYYY-MM-DD') AS "endsOn" FROM pro_holidays WHERE pro_id = $1 ORDER BY starts_on`),
    many(`SELECT to_char(day, 'YYYY-MM-DD') AS day FROM pro_days_off WHERE pro_id = $1 ORDER BY day`),
  ]);
  const [bookingsAsCustomer, plansAsCustomer, ratingsGiven, jobsAsPro, plansAsPro, ratingsReceived, payouts, tips] = await Promise.all([
    many(`SELECT b.number, b.service_name AS service, b.starts_at AS "startsAt", b.status, b.address, b.postcode,
            b.price_cents AS "priceCents", b.fee_cents AS "feeCents", pu.first_name AS "proFirstName", b.created_at AS "createdAt"
          FROM bookings b LEFT JOIN users pu ON pu.id = b.pro_id WHERE b.customer_id = $1 ORDER BY b.starts_at DESC`),
    many(`SELECT s.plan_name AS plan, s.status, s.frequency, s.address, s.price_cents AS "priceCents", s.started_at AS "startedAt",
            pu.first_name AS "proFirstName"
          FROM subscriptions s LEFT JOIN users pu ON pu.id = s.pro_id WHERE s.customer_id = $1 ORDER BY s.created_at DESC`),
    many(`SELECT b.number AS "bookingNumber", r.stars, r.tags, r.review, r.reply AS "proReply", r.created_at AS "createdAt",
            pu.first_name AS "proFirstName"
          FROM ratings r JOIN bookings b ON b.id = r.booking_id LEFT JOIN users pu ON pu.id = r.pro_id
          WHERE r.customer_id = $1 ORDER BY r.created_at DESC`),
    // Jobs done as a pro: the customer by first name and the postcode only, never their street.
    many(`SELECT b.number, b.service_name AS service, b.starts_at AS "startsAt", b.status, b.postcode,
            cu.first_name AS "customerFirstName", b.price_cents AS "priceCents", b.pro_share_pct AS "proSharePct"
          FROM bookings b JOIN users cu ON cu.id = b.customer_id WHERE b.pro_id = $1 ORDER BY b.starts_at DESC`),
    many(`SELECT s.plan_name AS plan, s.status, s.frequency, cu.first_name AS "customerFirstName", s.started_at AS "startedAt"
          FROM subscriptions s JOIN users cu ON cu.id = s.customer_id WHERE s.pro_id = $1 ORDER BY s.created_at DESC`),
    many(`SELECT b.number AS "bookingNumber", r.stars, r.tags, r.review, r.reply, r.replied_at AS "repliedAt", r.created_at AS "createdAt",
            cu.first_name AS "customerFirstName"
          FROM ratings r JOIN bookings b ON b.id = r.booking_id JOIN users cu ON cu.id = r.customer_id
          WHERE r.pro_id = $1 ORDER BY r.created_at DESC`),
    many(`SELECT x.source, x.amount_cents AS "amountCents", x.status, x.created_at AS "createdAt" FROM (
            SELECT 'job' AS source, amount_cents, status, created_at FROM payouts WHERE pro_id = $1
            UNION ALL
            SELECT 'plan', amount_cents, status, created_at FROM subscription_payouts WHERE pro_id = $1
          ) x ORDER BY x.created_at DESC`),
    many(`SELECT b.number AS "bookingNumber", t.amount_cents AS "amountCents", t.status, t.created_at AS "createdAt"
          FROM tips t JOIN bookings b ON b.id = t.booking_id WHERE b.customer_id = $1 ORDER BY t.created_at DESC`),
  ]);
  return {
    about: 'Your data at MISK. Other people are named by first name only; uploaded files are listed, not attached.',
    createdAt: new Date().toISOString(),
    account,
    notificationSwitches,
    asCustomer: { addresses, bookings: bookingsAsCustomer, plans: plansAsCustomer, ratingsGiven, tipsGiven: tips },
    asPro: pro ? { profile: pro, trades, documents, holidays, daysOff, jobs: jobsAsPro, plans: plansAsPro, ratingsReceived, payouts } : null,
  };
}

/**
 * Sends every waiting copy, a few at a time. Each is claimed with SKIP LOCKED, so two servers never send the same
 * one. A copy whose sending keeps failing is marked failed after MAX_ATTEMPTS tries; the person may then ask again.
 * Without a mail server nothing is sent and the requests wait. Returns how many were sent.
 */
export async function dataExportTick(pool: Pool, email: EmailSender | null, log: FastifyBaseLogger): Promise<number> {
  if (!email) {
    return 0;
  }
  let sent = 0;
  for (let i = 0; i < 5; i += 1) {
    const done = await withTransaction(pool, async (client) => {
      const claimed = await client.query<{ id: string; userId: string; email: string }>(
        `SELECT id, user_id AS "userId", email FROM data_exports
         WHERE sent_at IS NULL AND failed_at IS NULL ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      const job = claimed.rows[0];
      if (!job) return null;
      try {
        // Read with the pool: the queries run side by side, and none of them changes anything.
        const data = await buildUserData(pool, job.userId);
        await email({
          to: job.email,
          subject: 'Your data at MISK',
          text: [
            'Hello,',
            '',
            'as you asked in the MISK app, your data is attached as one JSON file (misk-my-data.json).',
            'It holds your account, your settings, your bookings and plans, and, if you work as a pro, your work information,',
            'documents (listed, not attached), jobs, ratings and payouts. Other people are named by first name only.',
            '',
            'If you did not ask for this, please contact MISK support.',
            '',
            'The MISK team',
          ].join('\n'),
          attachments: [{ filename: 'misk-my-data.json', content: Buffer.from(JSON.stringify(data, null, 2), 'utf8'), contentType: 'application/json' }],
        });
        await client.query('UPDATE data_exports SET sent_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1', [job.id]);
        log.info({ event: 'data_export_sent', exportId: job.id, userId: job.userId });
        return true;
      } catch (error) {
        await client.query(
          `UPDATE data_exports SET attempts = attempts + 1, last_error = left($2, 500),
             failed_at = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN now() END
           WHERE id = $1`,
          [job.id, error instanceof Error ? error.message : String(error)],
        );
        log.error({ event: 'data_export_failed', exportId: job.id, userId: job.userId, err: error });
        return false;
      }
    });
    if (done === null) break;
    if (done) sent += 1;
  }
  return sent;
}

export async function dataExportRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards } = ctx;

  app.get('/account/data-export', { preHandler: guards.signedIn }, async (request) => ({
    export: await loadStatus(pool, currentUser(request).id),
  }));

  // Queues one copy to the account's own email address; one request a day.
  app.post('/account/data-export', { preHandler: guards.signedIn }, async (request, reply) => {
    const userId = currentUser(request).id;
    if (ctx.config.production && !ctx.channelsReady.email) {
      throw new ApiError(503, 'email_unavailable');
    }
    await withTransaction(pool, async (client) => {
      // One request at a time per person, even when two arrive together.
      const person = await client.query<{ email: string | null }>('SELECT email FROM users WHERE id = $1 FOR UPDATE', [userId]);
      const address = person.rows[0]?.email;
      if (!address) {
        throw conflict('email_missing');
      }
      const recent = await client.query(
        `SELECT 1 FROM data_exports WHERE user_id = $1 AND failed_at IS NULL
           AND requested_at > now() - make_interval(hours => ${EXPORT_INTERVAL_HOURS})`,
        [userId],
      );
      if (recent.rowCount) {
        throw new ApiError(429, 'export_limited');
      }
      await client.query('INSERT INTO data_exports (user_id, email) VALUES ($1, $2)', [userId, address]);
    });
    request.log.info({ event: 'data_export_requested', userId });
    return reply.code(202).send({ export: await loadStatus(pool, userId) });
  });
}
