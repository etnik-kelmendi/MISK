import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { Queryable } from '../db.js';

export type Role = 'customer' | 'pro' | 'admin';

export interface User {
  id: string;
  /** Null until a phone user chooses whether they need help or offer it. */
  role: Role | null;
  phone: string | null;
  username: string | null;
  firstName: string | null;
}

export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
// Admin sessions end sooner: the control panel can refund money and approve pros.
const ADMIN_IDLE_SECONDS = 8 * 60 * 60;
const APP_IDLE_SECONDS = 30 * 24 * 60 * 60;
export const ATTEMPT_WINDOW_SECONDS = 15 * 60;

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/**
 * Records one attempt for a rate-limit key and says whether the key is over its limit.
 * Counting after inserting means parallel requests cannot all slip under the limit.
 */
export async function recordAttempt(pool: Queryable, key: string, limit: number) {
  const inserted = await pool.query<{ id: string }>('INSERT INTO login_attempts (key) VALUES ($1) RETURNING id', [
    key,
  ]);
  const counted = await pool.query<{ count: string }>(
    `SELECT count(*) FROM login_attempts
     WHERE key = $1 AND attempted_at > now() - make_interval(secs => $2)`,
    [key, ATTEMPT_WINDOW_SECONDS],
  );
  return { id: inserted.rows[0]?.id, overLimit: Number(counted.rows[0]?.count) > limit };
}

export async function clearAttempts(pool: Queryable, keys: string[]) {
  await pool.query('DELETE FROM login_attempts WHERE key = ANY($1)', [keys]);
}

export async function deleteExpiredRows(pool: Pool) {
  await pool.query('DELETE FROM login_attempts WHERE attempted_at <= now() - make_interval(secs => $1)', [
    ATTEMPT_WINDOW_SECONDS,
  ]);
  await pool.query("DELETE FROM sign_in_codes WHERE created_at <= now() - interval '1 day'");
  await pool.query(
    `DELETE FROM sessions USING users
     WHERE sessions.user_id = users.id
       AND (sessions.expires_at <= now()
         OR sessions.last_seen_at <= now() - make_interval(secs => CASE WHEN users.role = 'admin' THEN $1::int ELSE $2::int END))`,
    [ADMIN_IDLE_SECONDS, APP_IDLE_SECONDS],
  );
}

export async function createSession(pool: Queryable, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  // Only a hash is stored, so a leaked database does not hand out working sessions.
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3))`,
    [hashToken(token), userId, SESSION_MAX_AGE_SECONDS],
  );
  return token;
}

const USER_COLUMNS = `users.id, users.role, users.phone, users.username, users.first_name AS "firstName"`;

export async function findSessionUser(pool: Queryable, token: string): Promise<User | null> {
  const result = await pool.query<User>(
    `UPDATE sessions SET last_seen_at = now()
     FROM users
     WHERE sessions.token_hash = $1
       AND sessions.user_id = users.id
       AND users.disabled_at IS NULL
       AND sessions.expires_at > now()
       AND sessions.last_seen_at > now() - make_interval(secs => CASE WHEN users.role = 'admin' THEN $2::int ELSE $3::int END)
     RETURNING ${USER_COLUMNS}`,
    [hashToken(token), ADMIN_IDLE_SECONDS, APP_IDLE_SECONDS],
  );
  return result.rows[0] ?? null;
}

export async function findUser(pool: Queryable, userId: string): Promise<User | null> {
  const result = await pool.query<User>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [userId]);
  return result.rows[0] ?? null;
}

export async function deleteSession(pool: Queryable, token: string): Promise<void> {
  await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}
