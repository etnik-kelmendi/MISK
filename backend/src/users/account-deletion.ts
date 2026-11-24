import type { FastifyInstance, FastifyRequest } from 'fastify';
import { currentUser, sessionCookieFor, siteOf } from '../auth/guard.js';
import { slowDownFailedLogin, verifyPassword } from '../auth/passwords.js';
import { cookieOptionsFor, refuseWrongSite } from '../auth/routes.js';
import { deleteExpiredRows, recordAttempt, type User } from '../auth/sessions.js';
import { FREE_CANCEL_HOURS } from '../bookings/lifecycle.js';
import type { BookingDeps } from '../bookings/events.js';
import type { AppContext } from '../context.js';
import type { Queryable } from '../db.js';
import { badRequest, conflict, forbidden } from '../errors.js';
import { selfClosedNotice } from '../notifications/account-notices.js';
import { closeAccount, NOT_STARTED } from './close-account.js';

/** Tries at "Delete account" per account and per address in ATTEMPT_WINDOW_SECONDS, wrong passwords included. */
export const MAX_DELETE_TRIES_PER_ACCOUNT = 5;
export const MAX_DELETE_TRIES_PER_IP = 20;
/** What an account without a password types to confirm. */
export const DELETE_WORD = 'DELETE';
/** Saved on the closed account, for the team. */
export const SELF_DELETE_REASON = 'Deleted by the person in the app';

/**
 * Something that must end before the account can be deleted (D97): a plan that is still running (it ends at
 * `at`, or never when not cancelled yet), a booking under way, or with a pro and starting within 24 hours (it
 * could no longer be cancelled for free), an open problem report, money still held on a card for a job that is
 * done or cancelled, or a payment that did not go through.
 */
export interface DeleteBlocker {
  kind: 'plan' | 'booking_in_progress' | 'booking_soon' | 'problem_open' | 'money_held' | 'payment_due';
  /** The plan's or the booking's id, to link to it. */
  id: string;
  /** The plan's or the service's name. */
  name: string;
  /** When the plan ends or the booking starts; null for a plan that is not cancelled yet. */
  at: string | null;
}

export async function deleteBlockers(db: Queryable, userId: string): Promise<DeleteBlocker[]> {
  const found = await db.query<DeleteBlocker>(
    `SELECT 'plan' AS kind, s.id, s.plan_name AS name, s.ends_at AS at, 1 AS rank, s.created_at AS since
     FROM subscriptions s
     WHERE s.customer_id = $1 AND s.status IN ('active', 'past_due') AND (s.ends_at IS NULL OR s.ends_at > now())
     UNION ALL
     SELECT CASE WHEN b.status IN ('on_the_way', 'working') THEN 'booking_in_progress' ELSE 'booking_soon' END,
       b.id, b.service_name, b.starts_at, 2, b.starts_at
     FROM bookings b
     WHERE b.customer_id = $1
       AND (b.status IN ('on_the_way', 'working')
         -- Only a booking with a pro: cancelling it now would no longer be free. Others are cancelled for free.
         OR (b.status = 'accepted' AND b.starts_at < now() + make_interval(hours => $2)))
     UNION ALL
     SELECT 'problem_open', b.id, b.service_name, b.starts_at, 3, b.starts_at
     FROM bookings b
     WHERE b.customer_id = $1
       AND ((b.problem_reported_at IS NOT NULL AND b.problem_resolved_at IS NULL)
         OR EXISTS (SELECT 1 FROM booking_issues i WHERE i.booking_id = b.id AND i.resolved_at IS NULL))
     UNION ALL
     -- Money held for a job that is done or cancelled: it is still to be charged or released.
     SELECT 'money_held', b.id, b.service_name, b.starts_at, 4, b.starts_at
     FROM bookings b
     WHERE b.customer_id = $1 AND b.status IN ('completed', 'cancelled')
       AND (b.payment_status = 'held'
         OR EXISTS (SELECT 1 FROM extra_requests e WHERE e.booking_id = b.id AND e.payment_status = 'held'))
     UNION ALL
     SELECT 'payment_due', b.id, b.service_name, b.starts_at, 5, b.starts_at
     FROM bookings b
     WHERE b.customer_id = $1 AND b.status = 'completed' AND b.payment_status = 'failed'
     ORDER BY rank, since`,
    [userId, FREE_CANCEL_HOURS],
  );
  return found.rows.map(({ kind, id, name, at }) => ({ kind, id, name, at: at ? new Date(at).toISOString() : null }));
}

/**
 * "Delete account" in the customer's Profile (D97). The account closes the same way as the team's "Delete"
 * (closeAccount), once nothing is open. Pros close theirs through support: they have payouts and documents.
 */
export async function accountDeletionRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, config, guards } = ctx;

  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  const deps = (): BookingDeps => ({ pool, gateway: ctx.gateway, config, log: app.log });

  function accountHolder(request: FastifyRequest): User {
    const user = currentUser(request);
    if (user.role === 'admin') throw forbidden();
    return user;
  }

  async function passwordHashOf(userId: string): Promise<string | null> {
    const found = await pool.query<{ hash: string | null }>('SELECT password_hash AS hash FROM users WHERE id = $1', [userId]);
    return found.rows[0]?.hash ?? null;
  }

  // What deleting would do, and what has to end first.
  app.get('/account/deletion', { preHandler: guards.signedIn }, async (request) => {
    const user = accountHolder(request);
    const pro = user.role === 'pro';
    const [blockers, upcoming, hash] = await Promise.all([
      pro ? Promise.resolve([]) : deleteBlockers(pool, user.id),
      pool.query<{ n: number }>('SELECT count(*)::int AS n FROM bookings WHERE customer_id = $1 AND status = ANY($2)', [user.id, NOT_STARTED]),
      passwordHashOf(user.id),
    ]);
    return {
      pro,
      allowed: !pro && blockers.length === 0,
      confirmWith: hash ? 'password' : 'typed',
      blockers,
      upcomingBookings: upcoming.rows[0]?.n ?? 0,
    };
  });

  app.post<{ Body: { password?: string; confirmText?: string } }>(
    '/account/delete',
    {
      preHandler: guards.signedIn,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            // The upper limit stops very long inputs from being used to overload password hashing.
            password: { type: 'string', minLength: 1, maxLength: 1024 },
            confirmText: { type: 'string', maxLength: 20 },
          },
        },
      },
    },
    async (request, reply) => {
      if (refuseWrongSite(request, reply, config, 'app')) {
        return reply;
      }
      const user = accountHolder(request);
      if (user.role === 'pro') {
        throw conflict('pro_account');
      }
      await deleteExpiredRows(pool);
      const byAccount = await recordAttempt(pool, `account-delete:${user.id}`, MAX_DELETE_TRIES_PER_ACCOUNT);
      const byIp = await recordAttempt(pool, `account-delete-ip:${request.ip}`, MAX_DELETE_TRIES_PER_IP);
      if (byAccount.overLimit || byIp.overLimit) {
        request.log.warn({ event: 'account_delete_limited', userId: user.id });
        return reply.code(429).send({ error: 'too_many_attempts' });
      }
      const hash = await passwordHashOf(user.id);
      if (hash) {
        if (!request.body.password) throw badRequest('password_required');
        if (!(await verifyPassword(hash, request.body.password))) {
          await slowDownFailedLogin();
          request.log.warn({ event: 'account_delete_rejected', userId: user.id, reason: 'wrong_password' });
          throw badRequest('wrong_password');
        }
      } else if (request.body.confirmText?.trim() !== DELETE_WORD) {
        throw badRequest('delete_not_confirmed');
      }
      const blockers = await deleteBlockers(pool, user.id);
      if (blockers.length) {
        request.log.info({ event: 'account_delete_rejected', userId: user.id, reason: 'open_items', kinds: blockers.map((b) => b.kind) });
        return reply.code(409).send({ error: 'account_has_open_items', blockers });
      }
      const { channels } = await closeAccount(deps(), {
        userId: user.id,
        adminId: null,
        reason: SELF_DELETE_REASON,
        notice: (account) => selfClosedNotice({ firstName: account.first_name, support: config.support }),
      });
      request.log.warn({ event: 'account_deleted_by_person', userId: user.id, channels });
      const cookie = sessionCookieFor(config, siteOf(request, config));
      return reply.clearCookie(cookie, cookieOptionsFor(config)).send({ deleted: true });
    },
  );
}
