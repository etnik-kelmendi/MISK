import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../config.js';
import { findSessionUser, type Role, type User } from './sessions.js';

export const SESSION_COOKIE = 'misk_session';
/** The control panel's own session, so signing in on one site never signs you in on the other. */
export const ADMIN_SESSION_COOKIE = 'misk_admin_session';

export type Site = 'app' | 'admin';

/** Whether the app and the control panel are separate websites. */
export const sitesAreSeparate = (config: Config) => config.adminOrigin !== config.webOrigin;

/** Which website sent the request, judged by its Origin header; null when there is none. */
export function siteOf(request: FastifyRequest, config: Config): Site | null {
  const origin = request.headers.origin;
  if (sitesAreSeparate(config) && origin === config.adminOrigin) {
    return 'admin';
  }
  return origin === config.webOrigin ? 'app' : null;
}

/** The session cookie for a site. One shared cookie when both are one site. */
export function sessionCookieFor(config: Config, site: Site | null): string {
  return sitesAreSeparate(config) && site === 'admin' ? ADMIN_SESSION_COOKIE : SESSION_COOKIE;
}

/**
 * The session tokens to try for a request. A request with an Origin uses only its site's cookie;
 * one without (an image or a document opened in a tab) may use either, and the file route's own
 * access check still decides what it may see.
 */
function sessionTokens(request: FastifyRequest, config: Config): string[] {
  const site = siteOf(request, config);
  const names = request.headers.origin ? [sessionCookieFor(config, site)] : [SESSION_COOKIE, ADMIN_SESSION_COOKIE];
  return names.map((name) => request.cookies[name]).filter((token): token is string => Boolean(token));
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}

export type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

export interface Guards {
  /** Any signed-in person, including one who has not chosen a role yet. */
  signedIn: Guard;
  customer: Guard;
  pro: Guard;
  admin: Guard;
}

/** The signed-in user. Only call inside a route protected by a guard. */
export function currentUser(request: FastifyRequest): User {
  if (!request.user) {
    throw new Error('currentUser() called on a route without a guard');
  }
  return request.user;
}

export function createGuards(pool: Pool, config: Config): Guards {
  async function signedIn(request: FastifyRequest, reply: FastifyReply) {
    let user: User | null = null;
    for (const token of sessionTokens(request, config)) {
      user = await findSessionUser(pool, token);
      if (user) {
        break;
      }
    }
    if (!user) {
      return reply.code(401).send({ error: 'unauthenticated' });
    }
    request.user = user;
  }

  const withRole = (role: Role): Guard =>
    async function (request, reply) {
      await signedIn(request, reply);
      if (!reply.sent && request.user?.role !== role) {
        return reply.code(403).send({ error: 'forbidden' });
      }
    };

  return { signedIn, customer: withRole('customer'), pro: withRole('pro'), admin: withRole('admin') };
}
