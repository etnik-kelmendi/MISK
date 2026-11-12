import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { onlyRow, withTransaction } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { isUniqueViolation, uuidParams } from '../http.js';
import { logActivity } from '../settings/activity.js';
import { ADMIN_ROLES, type AdminRole } from './access.js';
import { normalizeEmail } from './admin-accounts.js';
import { currentUser } from './guard.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from './passwords.js';
import { refuseWrongSite } from './routes.js';
import { hashToken, recordAttempt } from './sessions.js';

/** An invitation link works for this many days, once. */
export const INVITE_LINK_DAYS = 7;
/** Sign-ups and link checks per network address in 15 minutes, so tokens cannot be guessed. */
export const MAX_INVITE_TRIES_PER_IP = 20;

const EMAIL_FORMAT = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const nameProperty = { type: 'string', minLength: 1, maxLength: 60, pattern: '\\S' } as const;
const tokenProperty = { type: 'string', minLength: 20, maxLength: 100 } as const;

/** An invite that can still be used: not used, not withdrawn, not run out. */
const OPEN = 'used_at IS NULL AND revoked_at IS NULL AND expires_at > now()';

/**
 * Invitation links for the team (D51). An admin makes a link for a role and shares it by any channel; the
 * person who opens it signs up and joins the team with that role, without waiting for approval, because
 * an admin chose to invite them. Every link works once and for INVITE_LINK_DAYS days, and can be withdrawn.
 */
export async function teamInviteRoutes(app: FastifyInstance, ctx: AppContext) {
  const { pool, guards, config } = ctx;

  app.post<{ Body: { role: AdminRole } }>(
    '/admin/team/invites',
    {
      preHandler: guards.admin,
      schema: {
        body: { type: 'object', required: ['role'], additionalProperties: false, properties: { role: { type: 'string', enum: ADMIN_ROLES } } },
      },
    },
    async (request, reply) => {
      const adminId = currentUser(request).id;
      const token = randomBytes(32).toString('base64url');
      const invite = await withTransaction(pool, async (client) => {
        const created = await client.query<{ id: string; role: AdminRole; createdAt: Date; expiresAt: Date }>(
          `INSERT INTO team_invites (token_hash, role, created_by, expires_at) VALUES ($1, $2, $3, now() + make_interval(days => $4))
           RETURNING id, role, created_at AS "createdAt", expires_at AS "expiresAt"`,
          [hashToken(token), request.body.role, adminId, INVITE_LINK_DAYS],
        );
        await logActivity(client, { adminId, area: 'team', action: 'invite_link_created', details: { role: request.body.role } });
        return onlyRow(created);
      });
      request.log.info({ event: 'team_invite_created', inviteId: invite.id, by: adminId });
      // The token goes after #, so it never reaches server logs or other sites in a Referer header. It is
      // shown this once; only its hash is kept.
      return reply.code(201).send({ invite, link: `${config.adminOrigin}/admin/join#token=${token}` });
    },
  );

  app.get('/admin/team/invites', { preHandler: guards.admin }, async () => {
    const open = await pool.query(
      `SELECT i.id, i.role, i.created_at AS "createdAt", i.expires_at AS "expiresAt",
         COALESCE(NULLIF(concat_ws(' ', u.first_name, u.last_name), ''), u.email, u.username) AS "createdBy"
       FROM team_invites i LEFT JOIN users u ON u.id = i.created_by
       WHERE i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
       ORDER BY i.created_at DESC`,
    );
    return { invites: open.rows };
  });

  app.delete<{ Params: { id: string } }>(
    '/admin/team/invites/:id',
    { preHandler: guards.admin, schema: { params: uuidParams } },
    async (request, reply) => {
      const adminId = currentUser(request).id;
      await withTransaction(pool, async (client) => {
        const revoked = await client.query<{ role: AdminRole }>(
          `UPDATE team_invites SET revoked_at = now() WHERE id = $1 AND ${OPEN} RETURNING role`,
          [request.params.id],
        );
        const invite = revoked.rows[0];
        if (!invite) {
          throw notFound('invite_not_found');
        }
        await logActivity(client, { adminId, area: 'team', action: 'invite_link_revoked', details: { role: invite.role } });
      });
      return reply.code(204).send();
    },
  );

  // The join page asks first, so it can say which role the link is for, or that it no longer works.
  app.post<{ Body: { token: string } }>(
    '/auth/admin/invite/check',
    { schema: { body: { type: 'object', required: ['token'], additionalProperties: false, properties: { token: tokenProperty } } } },
    async (request, reply) => {
      if (refuseWrongSite(request, reply, config, 'admin')) {
        return reply;
      }
      if ((await recordAttempt(pool, `invite-ip:${request.ip}`, MAX_INVITE_TRIES_PER_IP)).overLimit) {
        return reply.code(429).send({ error: 'too_many_attempts' });
      }
      const found = await pool.query<{ role: AdminRole; expiresAt: Date }>(
        `SELECT role, expires_at AS "expiresAt" FROM team_invites WHERE token_hash = $1 AND ${OPEN}`,
        [hashToken(request.body.token)],
      );
      const invite = found.rows[0];
      if (!invite) {
        return reply.code(400).send({ error: 'invalid_invite_link' });
      }
      return { invite };
    },
  );

  app.post<{ Body: { token: string; firstName: string; lastName: string; email: string; password: string } }>(
    '/auth/admin/invite/accept',
    {
      schema: {
        body: {
          type: 'object',
          required: ['token', 'firstName', 'lastName', 'email', 'password'],
          additionalProperties: false,
          properties: {
            token: tokenProperty,
            firstName: nameProperty,
            lastName: nameProperty,
            email: { type: 'string', minLength: 3, maxLength: 254 },
            password: { type: 'string', minLength: 1, maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      if (refuseWrongSite(request, reply, config, 'admin')) {
        return reply;
      }
      const email = normalizeEmail(request.body.email);
      if (!EMAIL_FORMAT.test(email)) {
        throw badRequest('invalid_email');
      }
      if (request.body.password.length < MIN_PASSWORD_LENGTH) {
        throw badRequest('password_too_short');
      }
      if ((await recordAttempt(pool, `invite-ip:${request.ip}`, MAX_INVITE_TRIES_PER_IP)).overLimit) {
        return reply.code(429).send({ error: 'too_many_attempts' });
      }
      const firstName = request.body.firstName.trim();
      const lastName = request.body.lastName.trim();
      const passwordHash = await hashPassword(request.body.password);
      try {
        const joined = await withTransaction(pool, async (client) => {
          // Claimed first, so two people opening the same link cannot both join.
          const claimed = await client.query<{ id: string; role: AdminRole }>(
            `UPDATE team_invites SET used_at = now() WHERE token_hash = $1 AND ${OPEN} RETURNING id, role`,
            [hashToken(request.body.token)],
          );
          const invite = claimed.rows[0];
          if (!invite) {
            return null;
          }
          const created = await client.query<{ id: string }>(
            `INSERT INTO users (username, email, password_hash, role, admin_role, first_name, last_name, invited_at)
             VALUES ($1, $1, $2, 'admin', $3, $4, $5, now()) RETURNING id`,
            [email, passwordHash, invite.role, firstName, lastName],
          );
          const userId = onlyRow(created).id;
          await client.query('UPDATE team_invites SET used_by = $2 WHERE id = $1', [invite.id, userId]);
          await logActivity(client, {
            adminId: userId,
            area: 'team',
            action: 'joined_by_invite',
            details: { name: `${firstName} ${lastName}`, role: invite.role },
          });
          return { userId, role: invite.role };
        });
        if (!joined) {
          return reply.code(400).send({ error: 'invalid_invite_link' });
        }
        request.log.info({ event: 'team_invite_accepted', userId: joined.userId, role: joined.role });
        return reply.code(201).send({ email, role: joined.role });
      } catch (error) {
        if (isUniqueViolation(error)) {
          // The transaction was undone, so the link still works with another email.
          return reply.code(409).send({ error: 'email_taken' });
        }
        throw error;
      }
    },
  );
}
