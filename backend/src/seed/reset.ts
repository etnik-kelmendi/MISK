import type { Pool } from 'pg';
import { runMigrations } from '../migrate.js';

/** Removes all marketplace data, keeping the schema and the settings row. Development only. */
export async function emptyDatabase(pool: Pool): Promise<void> {
  await pool.query(
    'TRUNCATE users, categories, postcodes, plans, stripe_events, login_attempts, sign_in_codes RESTART IDENTITY CASCADE',
  );
  await pool.query('UPDATE settings SET service_fee_cents = 290, pro_share_pct = 82, updated_at = now()');
}

/** Brings the schema up to date first, so seeding a fresh database just works. */
export async function migrateIfNeeded(databaseUrl: string): Promise<void> {
  await runMigrations(databaseUrl);
}
