import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth/guard.js';
import { cancelBooking } from '../bookings/lifecycle.js';
import type { BookingDeps } from '../bookings/events.js';
import type { AppContext } from '../context.js';
import { withTransaction, type Queryable } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { uuidParams } from '../http.js';
import { closedNotice, reinstatedNotice, suspendedNotice, type EndedWork, type Notice } from '../notifications/account-notices.js';
import { messages } from '../notifications/messages.js';
import { enqueue, enqueueChannels, type Channel } from '../notifications/outbox.js';
import { loadChecks } from '../pros/checks.js';
import { handOverWork, hasExpiredDocument, logProAction } from '../pros/management.js';
import { dropUnpaidSubscription } from '../subscriptions/service.js';
import { logUserAction } from './actions.js';

/** Rows the Users page loads at once; "Show more" loads the next ones. */
export const USERS_PAGE_SIZE = 50;
const REASON_MAX = 500;
const MESSAGE_MAX = 500;
/** A phone search needs at least this many digits, so a short number does not match nearly everyone. */
export const MIN_PHONE_SEARCH_DIGITS = 4;
/** Bookings that have not started yet: these are cancelled when an account is suspended or closed. */
const NOT_STARTED = ['awaiting_payment', 'searching', 'unassigned', 'accepted', 'on_the_way'];

export type UserType = 'customer' | 'pro';
export type UserStatus = 'active' | 'suspended' | 'deleted';

/**
 * One account as the Users page sees it (D64, D65). A pro who also booked as a customer is one row with
 * both types. Admins are not users here; they are on Settings → Team & access.
 */
const USER_ROW = `
  u.id,
  u.first_name AS "firstName",
  u.last_name AS "lastName",
  u.email,
  u.phone,
  array_remove(ARRAY[
    CASE WHEN u.role = 'customer'
           OR EXISTS (SELECT 1 FROM bookings b WHERE b.customer_id = u.id)
           OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.customer_id = u.id) THEN 'customer' END,
    CASE WHEN u.role = 'pro' THEN 'pro' END
  ], NULL) AS types,
  CASE WHEN u.disabled_at IS NOT NULL THEN 'deleted'
       WHEN u.suspended_at IS NOT NULL OR p.status = 'suspended' THEN 'suspended'
       ELSE 'active' END AS status,
  u.created_at AS "joinedAt",
  (SELECT max(se.last_seen_at) FROM sessions se WHERE se.user_id = u.id) AS "lastActive"`;
const USER_FROM = `FROM users u LEFT JOIN pro_profiles p ON p.user_id = u.id WHERE u.role IS DISTINCT FROM 'admin'`;

/**
 * The digits to look for in stored phone numbers (international, e.g. +4915100000001) for a query typed the
 * way people write numbers: "+49 (0)151 000 00001", "+49 0151-…", "0049 151…", "0151 …", "15100000001".
 * Empty when the query is not a phone number (it has letters, or too few digits).
 */
export function phoneSearchDigits(query: string): string[] {
  if (!/^[\d\s+\-()./]+$/.test(query)) return [];
  // "(0)" is the trunk prefix, dialled only inside the country; stored numbers never have it.
  const typed = query.replace(/\(\s*0\s*\)/g, ' ').trim();
  const digits = typed.replace(/\D/g, '');
  const candidates = new Set<string>();
  if (typed.startsWith('+') || digits.startsWith('00')) {
    const international = digits.replace(/^00/, '');
    candidates.add(international);
    // A trunk 0 typed after the country code ("+49 0151…"); country codes have 1 to 3 digits.
    for (let length = 1; length <= 3; length += 1) {
      if (international[length] === '0') candidates.add(international.slice(0, length) + international.slice(length + 1));
    }
  } else {
    // A national number ("0151…") is stored after the country code, without its leading 0.
    candidates.add(digits.replace(/^0+/, ''));
  }
  return [...candidates].filter((candidate) => candidate.length >= MIN_PHONE_SEARCH_DIGITS);
}

function name(row: { first_name: string | null; last_name: string | null }) {
  return [row.first_name, row.last_name].filter(Boolean).join(' ');
}


/**
 * Ends what an account booked as a customer: bookings that have not started are cancelled (held money is
 * released and the pro is told), and monthly plans end at once, Stripe included. Returns the counts.
 */
async function endCustomerWork(deps: BookingDeps, userId: string): Promise<{ bookings: number; plans: number }> {
  const upcoming = await deps.pool.query<{ id: string }>('SELECT id FROM bookings WHERE customer_id = $1 AND status = ANY($2)', [
    userId,
    NOT_STARTED,
  ]);
  for (const booking of upcoming.rows) {
    await cancelBooking(deps, booking.id, 'admin');
  }
  const plans = await deps.pool.query<{ id: string; status: string; stripe_subscription_id: string | null; pro_id: string | null; plan_name: string }>(
    `SELECT id, status, stripe_subscription_id, pro_id, plan_name FROM subscriptions
     WHERE customer_id = $1 AND status <> 'cancelled' AND (ends_at IS NULL OR ends_at > now())`,
    [userId],
  );
  for (const plan of plans.rows) {
    if (plan.status === 'awaiting_payment') {
      await dropUnpaidSubscription(deps, plan.id);
      continue;
    }
    if (plan.stripe_subscription_id) {
      await deps.gateway.cancelSubscription(plan.stripe_subscription_id, false);
    }
    await withTransaction(deps.pool, async (client) => {
      await client.query("UPDATE subscriptions SET status = 'cancelled', ends_at = now(), updated_at = now() WHERE id = $1", [plan.id]);
      await client.query(
        "UPDATE subscription_visits SET status = 'cancelled' WHERE subscription_id = $1 AND status IN ('pending', 'planned') AND starts_at > now()",
        [plan.id],
      );
      if (plan.pro_id) await enqueue(client, plan.pro_id, 'plan_pro_changed', messages.planEndedByTeam(plan.plan_name));
    });
  }
  return { bookings: upcoming.rows.length, plans: plans.rows.length };
}

export async function usersAdminRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards, config } = ctx;
  const deps = (): BookingDeps => ({ pool, gateway: ctx.gateway, config, log: app.log });

  app.get<{ Querystring: { q?: string; type?: 'all' | UserType; status?: 'all' | UserStatus; offset?: number } }>(
    '/admin/users',
    {
      preHandler: guards.admin,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            q: { type: 'string', maxLength: 100 },
            type: { type: 'string', enum: ['all', 'customer', 'pro'] },
            status: { type: 'string', enum: ['all', 'active', 'suspended', 'deleted'] },
            offset: { type: 'integer', minimum: 0, maximum: 100_000 },
          },
        },
      },
    },
    async (request) => {
      const q = request.query.q?.trim() ?? '';
      const type = request.query.type ?? 'all';
      const status = request.query.status ?? 'all';
      // Name, email or phone; a phone matches however it is typed (see phoneSearchDigits).
      const filtered = `
        WITH listed AS (SELECT ${USER_ROW} ${USER_FROM})
        SELECT * FROM listed
        WHERE ($1 = '' OR concat_ws(' ', "firstName", "lastName") ILIKE '%' || $1 || '%' OR email ILIKE '%' || $1 || '%'
               OR EXISTS (SELECT 1 FROM unnest($2::text[]) AS d(digits)
                          WHERE regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') LIKE '%' || d.digits || '%'))
          AND ($3 = 'all' OR $3 = ANY(types))
          AND ($4 = 'all' OR status = $4)`;
      const params = [q, phoneSearchDigits(q), type, status];
      const [rows, matching, total] = await Promise.all([
        pool.query(`${filtered} ORDER BY "joinedAt" DESC, id LIMIT ${USERS_PAGE_SIZE} OFFSET $5`, [...params, request.query.offset ?? 0]),
        pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${filtered}) f`, params),
        pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM users u WHERE u.role IS DISTINCT FROM 'admin'`),
      ]);
      return { users: rows.rows, matching: matching.rows[0]?.n ?? 0, total: total.rows[0]?.n ?? 0 };
    },
  );

  async function detail(userId: string) {
    const found = await pool.query(
      `SELECT ${USER_ROW},
         u.role, u.email_verified_at IS NOT NULL AS "emailConfirmed", u.password_hash IS NOT NULL AS "hasPassword",
         u.suspended_at AS "suspendedAt", u.suspended_reason AS "suspendedReason", u.suspended_message AS "suspendedMessage",
         u.disabled_at AS "deletedAt", u.deleted_reason AS "deletedReason",
         p.status AS "proStatus"
       ${USER_FROM} AND u.id = $1`,
      [userId],
    );
    const row = found.rows[0] as (Record<string, unknown> & { role: string | null; proStatus: string | null }) | undefined;
    if (!row) {
      throw notFound();
    }
    // Role and pro status decide what is loaded below; the page gets the types and pro section instead.
    const { role, proStatus, ...user } = row;
    const [bookings, plans, actions] = await Promise.all([
      pool.query(
        `SELECT count(*)::int AS total,
           count(*) FILTER (WHERE status = ANY($2))::int AS upcoming,
           count(*) FILTER (WHERE status = 'completed')::int AS completed,
           count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
         FROM bookings WHERE customer_id = $1`,
        [userId, [...NOT_STARTED, 'working']],
      ),
      pool.query(
        `SELECT id, plan_name AS name, status FROM subscriptions
         WHERE customer_id = $1 AND status IN ('active', 'past_due') AND (ends_at IS NULL OR ends_at > now()) ORDER BY created_at`,
        [userId],
      ),
      pool.query(
        `SELECT a.id::text, a.action, a.details, a.created_at AS "createdAt",
           COALESCE(NULLIF(concat_ws(' ', ad.first_name, ad.last_name), ''), ad.email, ad.username) AS "adminName"
         FROM user_admin_actions a LEFT JOIN users ad ON ad.id = a.admin_id WHERE a.user_id = $1 ORDER BY a.id DESC`,
        [userId],
      ),
    ]);
    let pro = null;
    if (role === 'pro') {
      const numbers = await pool.query(
        `SELECT (SELECT round(avg(stars)::numeric, 1)::float FROM ratings WHERE pro_id = $1) AS "ratingAverage",
           (SELECT count(*)::int FROM ratings WHERE pro_id = $1) AS "ratingCount",
           (SELECT count(*)::int FROM bookings WHERE pro_id = $1 AND status = 'completed') AS "jobsDone"`,
        [userId],
      );
      const checks = await loadChecks(pool, userId, config.timezone);
      pro = {
        status: proStatus,
        ...numbers.rows[0],
        documents: checks.map((c) => ({ kind: c.kind, ok: c.ok, state: c.state, expiresOn: c.document?.expiresOn ?? null })),
      };
    }
    return { ...user, bookings: bookings.rows[0], activePlans: plans.rows, pro, actions: actions.rows };
  }

  app.get<{ Params: { id: string } }>('/admin/users/:id', { preHandler: guards.admin, schema: { params: uuidParams } }, async (request) => ({
    user: await detail(request.params.id),
  }));

  /** The account, when the team may still act on it: not an admin and not closed. */
  async function openAccount(db: Queryable, userId: string) {
    const found = await db.query<{ role: string | null; phone: string | null; email: string | null; first_name: string | null; last_name: string | null; suspended: boolean; deleted: boolean }>(
      `SELECT role, phone, email, first_name, last_name, suspended_at IS NOT NULL AS suspended, disabled_at IS NOT NULL AS deleted
       FROM users WHERE id = $1 AND role IS DISTINCT FROM 'admin' FOR UPDATE`,
      [userId],
    );
    const account = found.rows[0];
    if (!account) throw notFound();
    if (account.deleted) throw conflict('account_deleted');
    return account;
  }

  /**
   * How a message went out, for the control panel (D87): always in the app, plus the channels it was queued
   * on; notSetUp lists those the server cannot send on yet (no SMS or mail service), so the team knows.
   */
  const delivery = (channels: Channel[]) => ({ inApp: true, channels, notSetUp: channels.filter((channel) => !ctx.channelsReady[channel]) });

  /** An account notice by every way the person can be reached: they may not be able to open the app (D87). */
  const sendNotice = (db: Queryable, userId: string, notice: Notice) =>
    enqueueChannels(db, userId, 'account', notice.text, { channels: { push: true, sms: true, email: true }, email: notice.email });

  // A message from the team: in the app, by push, by text when there is a phone and by email when there is an email.
  app.post<{ Params: { id: string }; Body: { text: string } }>(
    '/admin/users/:id/message',
    {
      preHandler: guards.admin,
      schema: {
        params: uuidParams,
        body: {
          type: 'object',
          required: ['text'],
          additionalProperties: false,
          properties: { text: { type: 'string', minLength: 1, maxLength: MESSAGE_MAX, pattern: '\\S' } },
        },
      },
    },
    async (request) => {
      const adminId = currentUser(request).id;
      const text = request.body.text.trim();
      const channels = await withTransaction(pool, async (client) => {
        await openAccount(client, request.params.id);
        // A channel the person has no address for is skipped by enqueue.
        const queued = await enqueueChannels(client, request.params.id, 'team_message', messages.fromTeam(text), {
          channels: { push: true, sms: true, email: true },
          email: { subject: 'A message from the MISK team', text: teamMessageEmail(text) },
        });
        await logUserAction(client, request.params.id, adminId, 'messaged', { text, channels: queued });
        return queued;
      });
      request.log.info({ event: 'user_messaged', userId: request.params.id, by: adminId, channels });
      return { user: await detail(request.params.id), delivery: delivery(channels) };
    },
  );

  // The reason stays internal; `message`, when the admin writes one, is what the person is told (D87).
  app.post<{ Params: { id: string }; Body: { reason: string; message?: string } }>(
    '/admin/users/:id/suspend',
    {
      preHandler: guards.admin,
      schema: {
        params: uuidParams,
        body: {
          type: 'object',
          required: ['reason'],
          additionalProperties: false,
          properties: {
            reason: { type: 'string', minLength: 1, maxLength: REASON_MAX, pattern: '\\S' },
            message: { type: 'string', maxLength: MESSAGE_MAX },
          },
        },
      },
    },
    async (request) => {
      const adminId = currentUser(request).id;
      const userId = request.params.id;
      const reason = request.body.reason.trim();
      const note = request.body.message?.trim() || null;
      const account = await withTransaction(pool, async (client) => {
        const found = await openAccount(client, userId);
        if (found.suspended) throw conflict('already_suspended');
        // Sessions are kept but stop working at once (findSessionUser), so the app can show why (D87).
        await client.query('UPDATE users SET suspended_at = now(), suspended_reason = $2, suspended_message = $3 WHERE id = $1', [
          userId,
          reason,
          note,
        ]);
        if (found.role === 'pro') {
          await client.query(
            `UPDATE pro_profiles SET status = 'suspended', suspended_at = now(), suspended_reason = $2, updated_at = now()
             WHERE user_id = $1 AND status IN ('approved', 'pending_approval')`,
            [userId, reason],
          );
        }
        return found;
      });
      // Told after the bookings and plans are ended, so the notice can say what happened to them.
      const tell = (work: EndedWork | null) =>
        sendNotice(pool, userId, suspendedNotice({ firstName: account.first_name, work, note, support: config.support }));
      let customer: { bookings: number; plans: number };
      let handOver: Awaited<ReturnType<typeof handOverWork>> | null;
      try {
        customer = await endCustomerWork(deps(), userId);
        handOver = account.role === 'pro' ? await handOverWork(deps(), userId, adminId) : null;
      } catch (error) {
        // The account is suspended either way; the person still hears it, without the counts.
        await tell(null);
        throw error;
      }
      const channels = await tell({ ...customer, proWorkHandedOver: Boolean(handOver && (handOver.bookings > 0 || handOver.plans > 0)) });
      if (handOver) await logProAction(pool, userId, adminId, 'suspended', { reason, ...handOver });
      await logUserAction(pool, userId, adminId, 'suspended', {
        reason,
        ...(note ? { message: note } : {}),
        cancelledBookings: customer.bookings,
        endedPlans: customer.plans,
        ...(handOver ?? {}),
        channels,
      });
      request.log.warn({ event: 'user_suspended', userId, by: adminId, ...customer, channels });
      return { user: await detail(userId), delivery: delivery(channels) };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/users/:id/reinstate',
    { preHandler: guards.admin, schema: { params: uuidParams } },
    async (request) => {
      const adminId = currentUser(request).id;
      const userId = request.params.id;
      const channels = await withTransaction(pool, async (client) => {
        const found = await openAccount(client, userId);
        const pro = await client.query<{ status: string }>('SELECT status FROM pro_profiles WHERE user_id = $1', [userId]);
        const proSuspended = pro.rows[0]?.status === 'suspended';
        if (!found.suspended && !proSuspended) throw conflict('not_suspended');
        await client.query('UPDATE users SET suspended_at = NULL, suspended_reason = NULL, suspended_message = NULL WHERE id = $1', [userId]);
        if (found.suspended) {
          // The sessions kept while suspended end: the person signs in afresh (D87).
          await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
        }
        let proTo: string | null = null;
        if (proSuspended) {
          // Like Reinstate on the Providers page: back to Active, or to Pending approval if a document ran out.
          proTo = (await hasExpiredDocument(client, userId, config.timezone)) ? 'pending_approval' : 'approved';
          await client.query(
            'UPDATE pro_profiles SET status = $2, suspended_at = NULL, suspended_reason = NULL, updated_at = now() WHERE user_id = $1',
            [userId, proTo],
          );
          await logProAction(client, userId, adminId, 'reinstated', { to: proTo });
        }
        const queued = await sendNotice(client, userId, reinstatedNotice({ firstName: found.first_name, support: config.support }));
        await logUserAction(client, userId, adminId, 'reinstated', { ...(proTo ? { proStatus: proTo } : {}), channels: queued });
        return queued;
      });
      request.log.info({ event: 'user_reinstated', userId, by: adminId, channels });
      return { user: await detail(userId), delivery: delivery(channels) };
    },
  );

  // Closes an account for good: nobody can sign in with it again, and name, phone and email are removed.
  // Bookings, plans and payments stay for the records, without the person's details.
  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/admin/users/:id/delete',
    {
      preHandler: guards.admin,
      schema: {
        params: uuidParams,
        body: {
          type: 'object',
          required: ['reason'],
          additionalProperties: false,
          properties: { reason: { type: 'string', minLength: 1, maxLength: REASON_MAX, pattern: '\\S' } },
        },
      },
    },
    async (request) => {
      const adminId = currentUser(request).id;
      const userId = request.params.id;
      const reason = request.body.reason.trim();
      const { account, channels } = await withTransaction(pool, async (client) => {
        const found = await openAccount(client, userId);
        // Told first, while the phone and email are still there: the queued text and email keep them.
        const queued = await sendNotice(client, userId, closedNotice({ firstName: found.first_name, support: config.support }));
        if (found.role === 'pro') {
          await client.query(
            `UPDATE pro_profiles SET status = 'suspended', suspended_at = COALESCE(suspended_at, now()),
               suspended_reason = $2, updated_at = now() WHERE user_id = $1 AND status <> 'suspended'`,
            [userId, reason],
          );
        }
        return { account: found, channels: queued };
      });
      const customer = await endCustomerWork(deps(), userId);
      const handOver = account.role === 'pro' ? await handOverWork(deps(), userId, adminId) : null;
      await withTransaction(pool, async (client) => {
        await client.query(
          `UPDATE users SET disabled_at = now(), deleted_reason = $2, suspended_at = NULL, suspended_reason = NULL,
             first_name = NULL, last_name = NULL, phone = NULL, email = NULL, username = NULL, password_hash = NULL
           WHERE id = $1`,
          [userId, reason],
        );
        await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
        await client.query('DELETE FROM push_subscriptions WHERE user_id = $1', [userId]);
        await logUserAction(client, userId, adminId, 'deleted', {
          reason,
          name: name(account),
          cancelledBookings: customer.bookings,
          endedPlans: customer.plans,
          ...(handOver ?? {}),
          channels,
        });
      });
      request.log.warn({ event: 'user_deleted', userId, by: adminId, channels });
      return { user: await detail(userId), delivery: delivery(channels) };
    },
  );
}

/** The email version of a team message: the same text with a greeting and where to find it in the app. */
function teamMessageEmail(text: string): string {
  return ['Hello,', `The MISK team sent you this message:\n\n${text}`, 'You can also read it in the MISK app under Messages.', 'The MISK team'].join('\n\n');
}
