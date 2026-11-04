import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { inject } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth/passwords.js';
import type { BookingDeps } from '../src/bookings/events.js';
import { loadConfig, type Config } from '../src/config.js';
import { createDiskStorage } from '../src/uploads/storage.js';
import { createFakeGateway, type FakeGateway } from './fake-gateway.js';

export const ORIGIN = 'http://localhost:5173';
export const TIMEZONE = 'Europe/Berlin';
export const ADMIN_PASSWORD = 'correct horse battery staple';

/** Smallest valid files of each kind, for upload tests. */
export const FILES = {
  png: Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cf00000301010018dd8db40000000049454e44ae426082', 'hex'),
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]),
  pdf: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1'),
  text: Buffer.from('just text, not a picture'),
};

export interface TestContext {
  app: FastifyInstance;
  pool: pg.Pool;
  config: Config;
  fake: FakeGateway;
  /** Every text message the app tried to send directly (sign-in codes). */
  texts: { to: string; body: string }[];
  deps: BookingDeps;
  close: () => Promise<void>;
}

export async function createTestContext(): Promise<TestContext> {
  const config = loadConfig({
    DATABASE_URL: inject('databaseUrl'),
    WEB_ORIGIN: ORIGIN,
    MARKET_TIMEZONE: TIMEZONE,
  });
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const fake = createFakeGateway();
  const texts: { to: string; body: string }[] = [];
  const uploadDir = mkdtempSync(join(tmpdir(), 'misk-test-uploads-'));
  const app = await buildApp({
    config,
    pool,
    gateway: fake.gateway,
    sms: async (to, body) => {
      texts.push({ to, body });
      return { providerId: `SM${texts.length}` };
    },
    storage: createDiskStorage(uploadDir),
    // TEST_LOG=1 npm test shows the API's error log while debugging a failing test.
    logger: process.env.TEST_LOG ? { level: 'error' } : false,
  });
  return {
    app,
    pool,
    config,
    fake,
    texts,
    deps: { pool, gateway: fake.gateway, config, log: app.log },
    close: async () => {
      await app.close();
      await pool.end();
      rmSync(uploadDir, { recursive: true, force: true });
    },
  };
}

export async function resetDatabase(pool: pg.Pool) {
  await pool.query(
    `TRUNCATE users, categories, postcodes, stripe_events, login_attempts, sign_in_codes RESTART IDENTITY CASCADE`,
  );
  await pool.query('UPDATE settings SET service_fee_cents = 290, pro_share_pct = 82');
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';

/** Calls the API as the web app would: with its Origin and, when given, a session cookie. */
export function call(
  t: TestContext,
  method: Method,
  url: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<LightMyRequestResponse> {
  return t.app.inject({
    method,
    url,
    headers: { origin: ORIGIN, ...(options.cookie ? { cookie: options.cookie } : {}) },
    ...(options.body === undefined ? {} : { payload: options.body as object }),
  });
}

/** Sends one file as multipart/form-data. */
export function upload(t: TestContext, url: string, cookie: string, content: Buffer, filename = 'file.png') {
  const boundary = '----misktestboundary';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return t.app.inject({
    method: 'POST',
    url,
    headers: { origin: ORIGIN, cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
}

export function sessionCookie(response: LightMyRequestResponse): string {
  const cookie = response.cookies.find((c) => c.name === 'misk_session');
  if (!cookie) {
    throw new Error(`No session cookie in response ${response.statusCode}: ${response.body}`);
  }
  return `misk_session=${cookie.value}`;
}

/** The code inside the last sign-in text sent to `phone`. */
export function lastCode(t: TestContext, phone: string): string {
  const text = [...t.texts].reverse().find((m) => m.to === phone);
  const code = text?.body.match(/^(\d{6})/)?.[1];
  if (!code) {
    throw new Error(`No sign-in code was sent to ${phone}`);
  }
  return code;
}

/** Signs in by phone code and, when a role is given, chooses it. Returns the session cookie. */
export async function signIn(t: TestContext, phone: string, role?: 'customer' | 'pro', firstName = 'Sara') {
  const start = await call(t, 'POST', '/auth/phone/start', { body: { phone } });
  if (start.statusCode !== 202) {
    throw new Error(`start failed: ${start.body}`);
  }
  const verify = await call(t, 'POST', '/auth/phone/verify', { body: { phone, code: lastCode(t, phone) } });
  const cookie = sessionCookie(verify);
  if (role) {
    const chosen = await call(t, 'POST', '/account/role', { cookie, body: { role, firstName } });
    if (chosen.statusCode !== 200) {
      throw new Error(`role failed: ${chosen.body}`);
    }
  }
  return cookie;
}

export async function signInAdmin(t: TestContext, username = 'admin') {
  await t.pool.query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'admin') ON CONFLICT (username) DO NOTHING`,
    [username, await hashPassword(ADMIN_PASSWORD)],
  );
  const response = await call(t, 'POST', '/auth/admin/login', { body: { username, password: ADMIN_PASSWORD } });
  return sessionCookie(response);
}

export interface Market {
  gardening: string;
  plumbing: string;
  mowing: string;
  hedge: string;
  leak: string;
}

/** A small served area: two gardening services, one plumbing service, three postcodes. */
export async function seedMarket(pool: pg.Pool): Promise<Market> {
  await pool.query(
    `INSERT INTO postcodes (code, name, lat, lng) VALUES
       ('10115', 'Mitte', 52.5323, 13.3846),
       ('10117', 'Mitte South', 52.5170, 13.3889),
       ('14167', 'Zehlendorf', 52.4180, 13.2600)`,
  );
  const categories = await pool.query<{ id: string; slug: string }>(
    `INSERT INTO categories (slug, name, icon, sort_order) VALUES
       ('gardening', 'Gardening', 'leaf', 1), ('plumbing', 'Plumbing', 'drop', 2)
     RETURNING id, slug`,
  );
  const id = (slug: string) => categories.rows.find((c) => c.slug === slug)?.id ?? '';
  const services = await pool.query<{ id: string; name: string }>(
    `INSERT INTO services (category_id, name, description, price_cents, duration_minutes) VALUES
       ($1, 'Lawn mowing', 'Mow, edge and clear', 3500, 60),
       ($1, 'Hedge trimming', 'Shape hedges', 4500, 90),
       ($2, 'Leak repair', 'Fix leaking pipes', 5900, 60)
     RETURNING id, name`,
    [id('gardening'), id('plumbing')],
  );
  const service = (name: string) => services.rows.find((s) => s.name === name)?.id ?? '';
  return {
    gardening: id('gardening'),
    plumbing: id('plumbing'),
    mowing: service('Lawn mowing'),
    hedge: service('Hedge trimming'),
    leak: service('Leak repair'),
  };
}

/**
 * An approved pro ready for jobs. Their application is written straight to the database; the
 * application flow itself is covered by the pro tests.
 */
export async function approvedPro(
  t: TestContext,
  phone: string,
  options: { trades: string[]; postcode?: string; radiusKm?: number; firstName?: string; days?: number[] },
) {
  const cookie = await signIn(t, phone, 'pro', options.firstName ?? 'Daniel');
  const user = await t.pool.query<{ id: string }>('SELECT id FROM users WHERE phone = $1', [phone]);
  const proId = user.rows[0]?.id ?? '';
  await t.pool.query(
    `UPDATE pro_profiles SET status = 'approved', home_postcode = $2, radius_km = $3, working_days = $4,
       payouts_enabled = true, stripe_account_id = $5
     WHERE user_id = $1`,
    [proId, options.postcode ?? '10115', options.radiusKm ?? 12, options.days ?? [1, 2, 3, 4, 5, 6, 7], `acct_${proId.slice(0, 8)}`],
  );
  await t.pool.query('INSERT INTO pro_trades (pro_id, category_id) SELECT $1, unnest($2::uuid[])', [proId, options.trades]);
  return { cookie, proId };
}

let raters = 0;

/** Adds a past, completed job for the pro with the given stars. */
export async function giveRating(pool: pg.Pool, proId: string, stars: number) {
  raters += 1;
  const customer = await pool.query<{ id: string }>(
    `INSERT INTO users (phone, role, first_name) VALUES ($1, 'customer', 'Rater') RETURNING id`,
    [`+4915000${String(raters).padStart(5, '0')}`],
  );
  const customerId = customer.rows[0]?.id;
  const booking = await pool.query<{ id: string }>(
    `INSERT INTO bookings (customer_id, service_id, category_id, service_name, size, address, postcode,
       starts_at, ends_at, status, price_cents, fee_cents, pro_share_pct, pro_id, completed_at)
     SELECT $1, s.id, s.category_id, s.name, 'M', 'Old Street 1', '10115',
       now() - interval '10 days', now() - interval '10 days' + interval '1 hour', 'completed', 1000, 0, 82, $2, now() - interval '10 days'
     FROM services s LIMIT 1 RETURNING id`,
    [customerId, proId],
  );
  await pool.query('INSERT INTO ratings (booking_id, pro_id, customer_id, stars) VALUES ($1, $2, $3, $4)', [
    booking.rows[0]?.id,
    proId,
    customerId,
    stars,
  ]);
}
