import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth/passwords.js';
import { loadConfig } from '../src/config.js';
import { runMigrations } from '../src/migrate.js';
import { createSmtpSender, type EmailMessage } from '../src/notifications/email.js';
import { startWorkers } from '../src/workers.js';
import { startTemporaryDatabase } from './embedded-db.js';
import { createFakeGateway } from './fake-gateway.js';
import { DEMO_ADMIN, seedDemoData } from '../src/seed/demo-data.js';
import { createDiskStorage } from '../src/uploads/storage.js';

/**
 * The real API on a throwaway database, for the web app's browser tests. Payments use the in-memory
 * fake (holds succeed at once), and text messages are kept in memory so tests can read sign-in codes
 * from GET /test/last-code. Nothing is ever charged or texted. Never run this in production.
 */
const database = await startTemporaryDatabase();
const uploadDir = mkdtempSync(join(tmpdir(), 'misk-e2e-uploads-'));
await runMigrations(database.url);

const config = loadConfig({
  DATABASE_URL: database.url,
  WEB_ORIGIN: 'http://localhost:4173',
  // The control panel is its own website (D20).
  ADMIN_ORIGIN: 'http://localhost:4174',
  MARKET_TIMEZONE: 'Europe/Berlin',
  PORT: '3100',
  UPLOAD_DIR: uploadDir,
  // Only the mail settings are taken from the environment, so a preview can send real reset emails.
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT,
  SMTP_USER: process.env.SMTP_USER ?? process.env.SMTP_USERNAME,
  SMTP_PASSWORD: process.env.SMTP_PASSWORD,
  MAIL_FROM: process.env.MAIL_FROM,
});
const smtp = config.smtp ? createSmtpSender(config.smtp) : null;
const pool = new pg.Pool({ connectionString: config.databaseUrl });

// --demo fills the database with the full demo data (the preview); without it, the small fixed data the
// browser tests rely on.
const demo = process.argv.includes('--demo');
const fake = createFakeGateway({ instantHolds: true });
if (demo) {
  const summary = await seedDemoData(pool, createDiskStorage(uploadDir), { timezone: config.timezone });
  fake.addIntents(summary.intents);
  console.log(`Demo data: ${summary.bookings} bookings, ${summary.pros} pros, ${summary.customers} customers. Admin: ${DEMO_ADMIN.username} / ${DEMO_ADMIN.password}`);
} else {
  await pool.query(
    `INSERT INTO postcodes (code, name, lat, lng) VALUES ('10115', 'Mitte', 52.5323, 13.3846), ('10117', 'Mitte South', 52.517, 13.3889)`,
  );
  const category = await pool.query<{ id: string }>(
    `INSERT INTO categories (slug, name, icon) VALUES ('gardening', 'Gardening', 'leaf') RETURNING id`,
  );
  const categoryId = category.rows[0]?.id;
  await pool.query(
    `INSERT INTO services (category_id, name, description, price_cents, duration_minutes)
     VALUES ($1, 'Lawn mowing', 'Mow, edge and clear the clippings', 3500, 60)`,
    [categoryId],
  );
  await pool.query(`INSERT INTO users (username, password_hash, role) VALUES ('admin', $1, 'admin')`, [
    await hashPassword('e2e admin password'),
  ]);
  // One approved pro who works every day near 10115, ready for offers.
  const pro = await pool.query<{ id: string }>(
    `INSERT INTO users (phone, role, first_name) VALUES ('+4915100000002', 'pro', 'Daniel') RETURNING id`,
  );
  const proId = pro.rows[0]?.id;
  await pool.query(
    `INSERT INTO pro_profiles (user_id, status, home_postcode, radius_km, working_days, stripe_account_id, payouts_enabled)
     VALUES ($1, 'approved', '10115', 15, '{1,2,3,4,5,6,7}', 'acct_e2e', true)`,
    [proId],
  );
  await pool.query('INSERT INTO pro_trades (pro_id, category_id) VALUES ($1, $2)', [proId, categoryId]);
}

// An extra admin for trying the preview, from backend/.env (never from the repository).
const previewEmail = process.env.PREVIEW_ADMIN_EMAIL?.trim().toLowerCase();
const previewPassword = process.env.PREVIEW_ADMIN_PASSWORD;
if (previewEmail && previewPassword) {
  await pool.query(`INSERT INTO users (username, email, password_hash, role) VALUES ($1, $1, $2, 'admin')`, [
    previewEmail,
    await hashPassword(previewPassword),
  ]);
  console.log(`Preview admin: ${previewEmail}`);
}

const texts: { to: string; body: string }[] = [];
// Emails stay in memory and are printed here, so the preview can show a reset link without a mail server.
const emails: EmailMessage[] = [];
const app = await buildApp({
  config,
  pool,
  gateway: fake.gateway,
  sms: async (to, body) => {
    texts.push({ to, body });
    return { providerId: `e2e-${texts.length}` };
  },
  email: async (message) => {
    emails.push(message);
    console.log(`
[email to ${message.to}] ${message.subject}${smtp ? ' (sending by SMTP)' : ''}
${message.text}
`);
    if (smtp) {
      await smtp(message);
      console.log(`[email to ${message.to}] sent`);
    }
  },
});

app.get<{ Querystring: { phone: string } }>('/test/last-code', async (request, reply) => {
  const text = [...texts].reverse().find((t) => t.to === request.query.phone);
  const code = text?.body.match(/^(\d{6})/)?.[1];
  return code ? { code } : reply.code(404).send({ error: 'not_found' });
});

app.get<{ Querystring: { to: string } }>('/test/last-email', async (request, reply) => {
  const email = [...emails].reverse().find((e) => e.to === request.query.to?.toLowerCase());
  return email ?? reply.code(404).send({ error: 'not_found' });
});

const stopWorkers = startWorkers({ pool, gateway: fake.gateway, config, log: app.log }, null, app.log);

async function shutdown() {
  stopWorkers();
  await app.close();
  await pool.end();
  await database.stop();
  rmSync(uploadDir, { recursive: true, force: true });
  process.exit(0);
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

await app.listen({ port: config.port, host: 'localhost' });
