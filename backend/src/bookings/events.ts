import type { FastifyBaseLogger } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../config.js';
import type { Queryable } from '../db.js';
import type { PaymentGateway } from '../payments/gateway.js';

/** What booking operations need; a subset of the app context so workers can call them too. */
export interface BookingDeps {
  pool: Pool;
  gateway: PaymentGateway;
  config: Config;
  log: FastifyBaseLogger;
}

export type BookingStatus =
  | 'awaiting_payment'
  | 'searching'
  | 'unassigned'
  | 'accepted'
  | 'on_the_way'
  | 'working'
  | 'completed'
  | 'cancelled';

/** Sets a booking's status and records it on the timeline in one step. */
export async function setStatus(db: Queryable, bookingId: string, status: BookingStatus, extraSql = '', extraValues: unknown[] = []) {
  await db.query(`UPDATE bookings SET status = $2, updated_at = now()${extraSql} WHERE id = $1`, [
    bookingId,
    status,
    ...extraValues,
  ]);
  await db.query('INSERT INTO booking_events (booking_id, status) VALUES ($1, $2)', [bookingId, status]);
}
