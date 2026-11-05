import type { Pool } from 'pg';
import { slowDownFailedLogin, spendVerificationTime, verifyPassword } from './passwords.js';
import { createSession, deleteExpiredRows, type User } from './sessions.js';

export type AdminLoginResult =
  | { outcome: 'success'; user: User; token: string }
  | { outcome: 'invalid_credentials' }
  | { outcome: 'pending_approval' };

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export async function adminLogin(
  pool: Pool,
  input: { username: string; password: string; ip: string },
): Promise<AdminLoginResult> {
  await deleteExpiredRows(pool);
  const username = normalizeUsername(input.username);

  const found = await pool.query<User & { password_hash: string; pending: boolean }>(
    `SELECT id, role, phone, username, email, first_name AS "firstName", last_name AS "lastName", password_hash,
       (admin_requested_at IS NOT NULL AND admin_approved_at IS NULL) AS pending
     FROM users WHERE (username = $1 OR email = $1) AND role = 'admin' AND disabled_at IS NULL`,
    [username],
  );
  const row = found.rows[0];
  if (!row) {
    await spendVerificationTime(input.password);
    await slowDownFailedLogin();
    return { outcome: 'invalid_credentials' };
  }
  if (!(await verifyPassword(row.password_hash, input.password))) {
    await slowDownFailedLogin();
    return { outcome: 'invalid_credentials' };
  }
  if (row.pending) {
    return { outcome: 'pending_approval' };
  }
  const user: User = {
    id: row.id,
    role: row.role,
    phone: row.phone,
    username: row.username,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
  };
  return { outcome: 'success', user, token: await createSession(pool, user.id) };
}
