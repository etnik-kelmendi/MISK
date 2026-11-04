import type { Pool } from 'pg';
import { hashPassword, MIN_PASSWORD_LENGTH } from './passwords.js';
import { normalizeUsername } from './admin-sign-in.js';

const USERNAME_FORMAT = /^\S{3,254}$/;
// Serializes parallel runs, so two commands cannot both create a "first" Admin.
const FIRST_ADMIN_LOCK = 7_360_001;

export async function createFirstAdmin(pool: Pool, usernameInput: string, password: string) {
  const username = normalizeUsername(usernameInput);
  if (!USERNAME_FORMAT.test(username)) {
    throw new Error('Enter a username of 3 to 254 characters with no spaces.');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`The password must have at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const passwordHash = await hashPassword(password);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [FIRST_ADMIN_LOCK]);
    const existing = await client.query("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1");
    if (existing.rowCount) {
      throw new Error('An Admin already exists. This command only creates the first one.');
    }
    await client.query(
      "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'admin')",
      [username, passwordHash],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
