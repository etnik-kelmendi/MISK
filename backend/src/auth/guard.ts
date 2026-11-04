import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { findSessionUser, type Role, type User } from './sessions.js';

export const SESSION_COOKIE = 'misk_session';

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

export function createGuards(pool: Pool): Guards {
  async function signedIn(request: FastifyRequest, reply: FastifyReply) {
    const token = request.cookies[SESSION_COOKIE];
    const user = token ? await findSessionUser(pool, token) : null;
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
