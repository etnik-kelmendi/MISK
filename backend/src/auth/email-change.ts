import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { withTransaction, type Queryable } from '../db.js';
import { ApiError, badRequest, conflict, forbidden } from '../errors.js';
import { isUniqueViolation } from '../http.js';
import { emailChangedNotice, emailChangeStartedNotice, type Notice } from '../notifications/account-notices.js';
import { enqueue } from '../notifications/outbox.js';
import { logUserAction } from '../users/actions.js';
import { normalizeEmail } from './admin-accounts.js';
import { EMAIL_FORMAT, VERIFY_LINK_HOURS } from './email-accounts.js';
import { currentUser } from './guard.js';
import { slowDownFailedLogin, verifyPassword } from './passwords.js';
import { refuseWrongSite } from './routes.js';
import { deleteExpiredRows, hashToken, recordAttempt, type User } from './sessions.js';

/** Links sent to a new address per account in ATTEMPT_WINDOW_SECONDS, wrong passwords included. */
export const MAX_EMAIL_CHANGES_PER_ACCOUNT = 5;
export const MAX_EMAIL_CHANGES_PER_IP = 20;

const emailProperty = { type: 'string', minLength: 3, maxLength: 254 } as const;

export interface PendingEmailChange {
  email: string;
  expiresAt: string;
}

/** The email with the link that confirms a new address; it goes to the new address only. */
export function emailChangeLinkEmail(firstName: string | null, link: string) {
  return {
    subject: 'Confirm your new email for MISK',
    text: [
      `Hello ${firstName?.trim() || 'there'},`,
      '',
      `Please confirm this address to use it for your MISK account. Open this link within ${VERIFY_LINK_HOURS} hours. It works once:`,
      link,
      '',
      'Until you confirm, your account keeps its current email. If you did not ask for this, you can ignore this email.',
    ].join('\n'),
  };
}

/**
 * A notice about the account's email: to its current email, or by text when it has none yet. Queued before the
 * address changes, so it reaches the old address.
 */
function tellAccount(db: Queryable, user: { id: string; email: string | null }, notice: Notice) {
  return enqueue(db, user.id, 'account', notice.text, {
    channels: { push: false, sms: !user.email, email: true },
    email: notice.email,
  });
}

/**
 * Changing (or adding) the email of one's own account (D97). The new address applies only once the link sent
 * to it is opened; the old address hears about it at once. Whether another account uses the new address is
 * said only when the link is opened, so this never reveals which emails have accounts.
 */
export async function emailChangeRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, config, guards } = ctx;

  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });

  /** Customers and pros only: a team account's email is managed on Settings → Team & access. */
  function accountHolder(request: FastifyRequest): User {
    const user = currentUser(request);
    if (user.role === 'admin') throw forbidden();
    return user;
  }

  function deliverer() {
    const deliver = ctx.deliverEmail;
    if (!deliver) throw new ApiError(503, 'email_sending_unavailable');
    return deliver;
  }

  async function pendingOf(db: Queryable, userId: string): Promise<PendingEmailChange | null> {
    const found = await db.query<PendingEmailChange>(
      `SELECT new_email AS email, expires_at AS "expiresAt" FROM email_changes WHERE user_id = $1 AND expires_at > now()`,
      [userId],
    );
    return found.rows[0] ?? null;
  }

  /** Counts one link (or one try at one) for the account and the address it came from. */
  async function overLimit(request: FastifyRequest, userId: string): Promise<boolean> {
    await deleteExpiredRows(pool);
    const byAccount = await recordAttempt(pool, `email-change:${userId}`, MAX_EMAIL_CHANGES_PER_ACCOUNT);
    const byIp = await recordAttempt(pool, `email-change-ip:${request.ip}`, MAX_EMAIL_CHANGES_PER_IP);
    return byAccount.overLimit || byIp.overLimit;
  }

  /** A new link for the account's open change; older links stop working. The token goes after #. */
  async function newLink(db: Queryable, userId: string, email: string): Promise<{ link: string; pending: PendingEmailChange }> {
    const token = randomBytes(32).toString('base64url');
    await db.query('DELETE FROM email_changes WHERE user_id = $1 OR expires_at <= now()', [userId]);
    const inserted = await db.query<PendingEmailChange>(
      `INSERT INTO email_changes (user_id, new_email, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(hours => $4))
       RETURNING new_email AS email, expires_at AS "expiresAt"`,
      [userId, email, hashToken(token), VERIFY_LINK_HOURS],
    );
    const pending = inserted.rows[0];
    if (!pending) throw new Error('Email change returned no row');
    return { link: `${config.webOrigin}/confirm-email#token=${token}`, pending };
  }

  async function sendLink(request: FastifyRequest, user: User, to: string, link: string) {
    try {
      await deliverer()({ to, ...emailChangeLinkEmail(user.firstName, link) });
      request.log.info({ event: 'email_change_link_sent', userId: user.id });
    } catch (error) {
      // The change waits; the person can send the link again from Personal information.
      request.log.error({ event: 'email_change_link_failed', userId: user.id, err: error });
    }
  }

  app.get('/account/email', { preHandler: guards.signedIn }, async (request) => {
    const user = accountHolder(request);
    const found = await pool.query<{ hasPassword: boolean }>('SELECT password_hash IS NOT NULL AS "hasPassword" FROM users WHERE id = $1', [
      user.id,
    ]);
    return { email: user.email, hasPassword: found.rows[0]?.hasPassword ?? false, pending: await pendingOf(pool, user.id) };
  });

  // Sends a link to the new address. An account with a password confirms it is them by typing it again.
  app.post<{ Body: { email: string; password?: string } }>(
    '/account/email/start',
    {
      preHandler: guards.signedIn,
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          additionalProperties: false,
          // The upper limit stops very long inputs from being used to overload password hashing.
          properties: { email: emailProperty, password: { type: 'string', minLength: 1, maxLength: 1024 } },
        },
      },
    },
    async (request, reply) => {
      if (refuseWrongSite(request, reply, config, 'app')) {
        return reply;
      }
      const user = accountHolder(request);
      const email = normalizeEmail(request.body.email);
      if (!EMAIL_FORMAT.test(email)) {
        throw badRequest('invalid_email');
      }
      if (email === user.email) {
        throw conflict('email_unchanged');
      }
      deliverer();
      if (await overLimit(request, user.id)) {
        request.log.warn({ event: 'email_change_limited', userId: user.id });
        return reply.code(429).send({ error: 'too_many_attempts' });
      }
      const found = await pool.query<{ passwordHash: string | null }>('SELECT password_hash AS "passwordHash" FROM users WHERE id = $1', [user.id]);
      const passwordHash = found.rows[0]?.passwordHash ?? null;
      if (passwordHash) {
        if (!request.body.password) {
          throw badRequest('password_required');
        }
        if (!(await verifyPassword(passwordHash, request.body.password))) {
          await slowDownFailedLogin();
          request.log.warn({ event: 'email_change_rejected', userId: user.id, reason: 'wrong_password' });
          throw badRequest('wrong_password');
        }
      }
      const { link, pending } = await withTransaction(pool, async (client) => {
        const created = await newLink(client, user.id, email);
        await tellAccount(
          client,
          user,
          emailChangeStartedNotice({ newEmail: email, hadEmail: Boolean(user.email), firstName: user.firstName, support: config.support }),
        );
        return created;
      });
      await sendLink(request, user, email, link);
      request.log.info({ event: 'email_change_started', userId: user.id });
      return reply.code(202).send({ pending });
    },
  );

  // A new link for the change already asked for (the password was given then).
  app.post('/account/email/resend', { preHandler: guards.signedIn }, async (request, reply) => {
    if (refuseWrongSite(request, reply, config, 'app')) {
      return reply;
    }
    const user = accountHolder(request);
    deliverer();
    const open = await pendingOf(pool, user.id);
    if (!open) {
      throw conflict('no_email_change');
    }
    if (await overLimit(request, user.id)) {
      request.log.warn({ event: 'email_change_limited', userId: user.id });
      return reply.code(429).send({ error: 'too_many_attempts' });
    }
    const { link, pending } = await withTransaction(pool, (client) => newLink(client, user.id, open.email));
    await sendLink(request, user, pending.email, link);
    return reply.code(202).send({ pending });
  });

  app.delete('/account/email/pending', { preHandler: guards.signedIn }, async (request, reply) => {
    if (refuseWrongSite(request, reply, config, 'app')) {
      return reply;
    }
    const user = accountHolder(request);
    await pool.query('DELETE FROM email_changes WHERE user_id = $1', [user.id]);
    request.log.info({ event: 'email_change_cancelled', userId: user.id });
    return reply.code(204).send();
  });

  // The page the link opens. The token is the proof, so it works on any device, signed in or not. It works
  // once: the open change is used up even when the address turns out to be taken.
  app.post<{ Body: { token: string } }>(
    '/account/email/confirm',
    {
      schema: {
        body: {
          type: 'object',
          required: ['token'],
          additionalProperties: false,
          properties: { token: { type: 'string', minLength: 20, maxLength: 200 } },
        },
      },
    },
    async (request, reply) => {
      if (refuseWrongSite(request, reply, config, 'app')) {
        return reply;
      }
      type Outcome = { outcome: 'invalid' } | { outcome: 'taken'; userId: string } | { outcome: 'changed'; userId: string; email: string };
      let result: Outcome;
      try {
        result = await withTransaction(pool, async (client): Promise<Outcome> => {
          const used = await client.query<{ userId: string; email: string; oldEmail: string | null; firstName: string | null }>(
            `DELETE FROM email_changes c USING users u
             WHERE c.token_hash = $1 AND c.expires_at > now() AND u.id = c.user_id
               AND u.disabled_at IS NULL AND u.suspended_at IS NULL AND u.role IS DISTINCT FROM 'admin'
             RETURNING c.user_id AS "userId", c.new_email AS email, u.email AS "oldEmail", u.first_name AS "firstName"`,
            [hashToken(request.body.token)],
          );
          const change = used.rows[0];
          if (!change) return { outcome: 'invalid' };
          const taken = await client.query('SELECT 1 FROM users WHERE email = $1 AND id <> $2', [change.email, change.userId]);
          if (taken.rowCount) return { outcome: 'taken', userId: change.userId };
          // Told first, so the notice still goes to the old address.
          await tellAccount(
            client,
            { id: change.userId, email: change.oldEmail },
            emailChangedNotice({ newEmail: change.email, hadEmail: Boolean(change.oldEmail), firstName: change.firstName, support: config.support }),
          );
          await client.query('UPDATE users SET email = $2, email_verified_at = now() WHERE id = $1', [change.userId, change.email]);
          // Links sent to the old address stop working.
          await client.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [change.userId]);
          await client.query('UPDATE email_verifications SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [change.userId]);
          // Only what happened: addresses stay out of the log, which outlives a closed account.
          await logUserAction(client, change.userId, null, change.oldEmail ? 'email_changed' : 'email_added');
          return { outcome: 'changed', userId: change.userId, email: change.email };
        });
      } catch (error) {
        // Another account took the address between the check and the update.
        if (!isUniqueViolation(error)) throw error;
        result = { outcome: 'taken', userId: '' };
      }
      if (result.outcome === 'invalid') {
        return reply.code(400).send({ error: 'invalid_email_change_link' });
      }
      if (result.outcome === 'taken') {
        request.log.warn({ event: 'email_change_rejected', userId: result.userId || undefined, reason: 'email_taken' });
        return reply.code(409).send({ error: 'email_taken' });
      }
      request.log.info({ event: 'email_changed', userId: result.userId });
      return { email: result.email };
    },
  );
}
