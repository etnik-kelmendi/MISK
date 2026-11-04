import type { Pool } from 'pg';
import { spendVerificationTime, verifyPassword } from './passwords.js';
import { clearAttempts, createSession, deleteExpiredRows, recordAttempt, type User } from './sessions.js';

export const MAX_ATTEMPTS_PER_ACCOUNT = 5;
export const MAX_ATTEMPTS_PER_IP = 20;

export type AdminLoginResult =
  | { outcome: 'success'; user: User; token: string }
  | { outcome: 'invalid_credentials' }
  | { outcome: 'too_many_attempts' };

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export async function adminLogin(
  pool: Pool,
  input: { username: string; password: string; ip: string },
): Promise<AdminLoginResult> {
  await deleteExpiredRows(pool);
  const username = normalizeUsername(input.username);
  const accountKey = `admin:${username}`;
  const account = await recordAttempt(pool, accountKey, MAX_ATTEMPTS_PER_ACCOUNT);
  const address = await recordAttempt(pool, `admin-ip:${input.ip}`, MAX_ATTEMPTS_PER_IP);
  if (account.overLimit || address.overLimit) {
    return { outcome: 'too_many_attempts' };
  }

  const found = await pool.query<User & { password_hash: string }>(
    `SELECT id, role, phone, username, first_name AS "firstName", password_hash
     FROM users WHERE username = $1 AND role = 'admin' AND disabled_at IS NULL`,
    [username],
  );
  const row = found.rows[0];
  if (!row) {
    await spendVerificationTime(input.password);
    return { outcome: 'invalid_credentials' };
  }
  if (!(await verifyPassword(row.password_hash, input.password))) {
    return { outcome: 'invalid_credentials' };
  }
  await clearAttempts(pool, [accountKey]);
  const user: User = { id: row.id, role: row.role, phone: row.phone, username: row.username, firstName: row.firstName };
  return { outcome: 'success', user, token: await createSession(pool, user.id) };
}
