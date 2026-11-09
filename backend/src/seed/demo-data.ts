import type { Pool, PoolClient } from 'pg';
import { hashPassword } from '../auth/passwords.js';
import { jobPriceCents, proShareCents, type JobSize } from '../catalogue/pricing.js';
import { withTransaction } from '../db.js';
import type { FileStorage } from '../uploads/storage.js';
import { makeDocument, makePhoto } from './images.js';
import { planVisits } from '../subscriptions/service.js';

/**
 * Demo data for development and the preview: a served city, the demo's catalogue and plans, pros in
 * every application state, customers who sign in by phone or email, and eight weeks of bookings in
 * every status with ratings, extra work and payouts. Times are relative to today, so the data never
 * goes stale. Deterministic: the same people and bookings every run.
 *
 * Never for production: every password below is public.
 */
export const DEMO_ADMIN = { username: 'admin', password: 'demo admin password' };
export const DEMO_CUSTOMER_PASSWORD = 'garden42';

export interface SeededIntent {
  id: string;
  amountCents: number;
  status: 'held' | 'captured' | 'released' | 'refunded';
}

export interface SeedSummary {
  postcodes: number;
  categories: number;
  services: number;
  plans: number;
  pros: number;
  customers: number;
  bookings: number;
  ratings: number;
  /** Payment ids the data refers to, so a fake payment provider can be told about them. */
  intents: SeededIntent[];
}

const POSTCODES: [string, string, number, number][] = [
  ['10115', 'Mitte', 52.5323, 13.3846],
  ['10117', 'Mitte South', 52.517, 13.3889],
  ['10405', 'Prenzlauer Berg', 52.5373, 13.4245],
  ['10557', 'Moabit', 52.5246, 13.361],
  ['10785', 'Tiergarten South', 52.505, 13.364],
  ['10961', 'Kreuzberg', 52.493, 13.399],
  ['12043', 'Neukölln', 52.481, 13.435],
  ['14167', 'Zehlendorf', 52.418, 13.26],
];

type Icon = 'leaf' | 'hammer' | 'drop' | 'bolt' | 'sparkle' | 'brush';
/** The demo's catalogue: [slug, name, icon, [name, price €, minutes, description][]]. */
const CATALOGUE: [string, string, Icon, [string, number, number, string][]][] = [
  ['gardening', 'Gardening', 'leaf', [
    ['Lawn mowing', 35, 60, 'Mow, edge and clear the clippings'],
    ['Hedge trimming', 45, 90, 'Shape hedges and bushes, waste taken away'],
    ['Garden clean-up', 79, 180, 'Weeding, leaves and flower beds tidied'],
    ['Planting', 55, 120, 'Flowers, shrubs or small trees planted'],
  ]],
  ['handyman', 'Handyman', 'hammer', [
    ['Furniture assembly', 40, 90, 'Wardrobes, beds, shelves and more'],
    ['TV & shelf mounting', 49, 60, 'Wall mounting with cables hidden'],
    ['Small repairs', 32, 60, 'Doors, handles, hinges, silicone'],
    ['Handyman by the hour', 38, 120, 'A list of small jobs, paid per hour'],
  ]],
  ['plumbing', 'Plumbing', 'drop', [
    ['Leak repair', 59, 60, 'Find and fix leaking pipes and joints'],
    ['Tap replacement', 49, 45, 'Kitchen or bathroom tap swapped'],
    ['Drain unblocking', 69, 60, 'Sinks, showers and toilets cleared'],
  ]],
  ['electrical', 'Electrical', 'bolt', [
    ['Light fitting', 45, 60, 'Install or replace ceiling lights'],
    ['Socket install', 39, 45, 'New or replacement sockets and switches'],
    ['Fault finding', 55, 60, 'Tripping fuses and dead circuits'],
  ]],
  ['cleaning', 'Cleaning', 'sparkle', [
    ['Home cleaning', 49, 150, 'Kitchen, bathrooms, floors and dusting'],
    ['Deep cleaning', 119, 300, 'Top-to-bottom, inside cupboards and appliances'],
    ['Window cleaning', 39, 90, 'Inside and out, frames included'],
  ]],
  ['painting', 'Painting', 'brush', [
    ['Room painting', 189, 480, 'Walls and ceiling of one room, paint included'],
    ['Wall touch-up', 69, 120, 'Patch holes and repaint marks'],
  ]],
];

/** Services paid per hour instead of by size (D31). */
const HOURLY = new Set(['Handyman by the hour']);

interface ProSeed {
  key: string;
  firstName: string;
  phone: string;
  status: 'approved' | 'submitted' | 'info_requested' | 'pending_approval' | 'suspended' | 'rejected' | 'draft';
  trades: string[];
  home: string;
  radius: number;
  days: number[];
  /** Stars this pro's customers usually give, cycled through. */
  stars: number[];
  note?: string;
  /** How the team's checks stand, for the Providers page; by default every document is accepted. */
  docs?: Partial<Record<'id' | 'certificate' | 'insurance' | 'background', 'pending' | 'rejected' | 'missing' | 'expiring' | 'renewal'>>;
  watchList?: boolean;
}

const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
const PROS: ProSeed[] = [
  { key: 'daniel', firstName: 'Daniel', phone: '+4915200000001', status: 'approved', trades: ['gardening'], home: '10115', radius: 15, days: EVERY_DAY, stars: [5, 5, 5, 4, 5] },
  { key: 'arben', firstName: 'Arben', phone: '+4915200000002', status: 'approved', trades: ['plumbing'], home: '10961', radius: 15, days: EVERY_DAY, stars: [5, 4, 5, 5] },
  { key: 'marta', firstName: 'Marta', phone: '+4915200000003', status: 'approved', trades: ['handyman', 'painting'], home: '10405', radius: 12, days: [1, 2, 3, 4, 5, 6], stars: [5, 4, 4, 5] },
  { key: 'ina', firstName: 'Ina', phone: '+4915200000004', status: 'approved', trades: ['cleaning'], home: '10557', radius: 12, days: EVERY_DAY, stars: [5, 5, 4], docs: { insurance: 'expiring' } },
  { key: 'faton', firstName: 'Faton', phone: '+4915200000005', status: 'approved', trades: ['electrical', 'handyman'], home: '12043', radius: 15, days: [1, 2, 3, 4, 5], stars: [4, 5, 4, 3, 5], watchList: true },
  { key: 'jonas', firstName: 'Jonas', phone: '+4915200000006', status: 'approved', trades: ['gardening', 'cleaning'], home: '10785', radius: 10, days: [2, 4, 6, 7], stars: [4, 4, 5] },
  { key: 'luan', firstName: 'Luan', phone: '+4915200000007', status: 'submitted', trades: ['painting'], home: '10117', radius: 12, days: [1, 2, 3, 4, 5], stars: [], docs: { insurance: 'pending', background: 'pending' } },
  { key: 'erion', firstName: 'Erion', phone: '+4915200000010', status: 'submitted', trades: ['gardening'], home: '10961', radius: 12, days: [1, 2, 3, 4, 5, 6], stars: [] },
  { key: 'kujtim', firstName: 'Kujtim', phone: '+4915200000011', status: 'info_requested', trades: ['cleaning'], home: '10557', radius: 10, days: [1, 2, 3, 4, 5], stars: [], note: 'Your ID photo is cut off. Please upload a photo of the whole card.', docs: { id: 'rejected', insurance: 'pending', background: 'pending' } },
  { key: 'valon', firstName: 'Valon', phone: '+4915200000012', status: 'pending_approval', trades: ['plumbing'], home: '10405', radius: 12, days: [1, 2, 3, 4, 5], stars: [5, 4], docs: { insurance: 'renewal' } },
  { key: 'gent', firstName: 'Gent', phone: '+4915200000013', status: 'suspended', trades: ['handyman'], home: '12043', radius: 10, days: [1, 2, 3, 4, 5], stars: [3, 2], note: 'Two customers reported damage to their furniture; under investigation.' },
  { key: 'besa', firstName: 'Besa', phone: '+4915200000008', status: 'rejected', trades: ['electrical'], home: '12043', radius: 8, days: [1, 3, 5], stars: [], note: 'The trade certificate is not readable. Please upload a clearer scan.', docs: { id: 'pending', certificate: 'rejected', insurance: 'pending', background: 'missing' } },
  { key: 'dren', firstName: 'Dren', phone: '+4915200000009', status: 'draft', trades: ['handyman'], home: '10405', radius: 10, days: [6, 7], stars: [] },
];

interface CustomerSeed {
  key: string;
  firstName: string;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  postcode: string;
  address: string;
}

const CUSTOMERS: CustomerSeed[] = [
  { key: 'sara', firstName: 'Sara', lastName: null, phone: '+4915100000001', email: null, postcode: '10115', address: '12 Linden Street' },
  { key: 'tom', firstName: 'Tom', lastName: null, phone: '+4915100000002', email: null, postcode: '10405', address: '4 Elm Court' },
  { key: 'lea', firstName: 'Lea', lastName: null, phone: '+4915100000003', email: null, postcode: '10961', address: '21 Birch Road' },
  { key: 'noah', firstName: 'Noah', lastName: null, phone: '+4915100000004', email: null, postcode: '10557', address: '9 Cedar Close' },
  { key: 'mila', firstName: 'Mila', lastName: null, phone: '+4915100000005', email: null, postcode: '12043', address: '2 Pine Street' },
  { key: 'anna', firstName: 'Anna', lastName: 'Schmidt', phone: null, email: 'anna@example.com', postcode: '10117', address: '17 Maple Lane' },
  { key: 'ben', firstName: 'Ben', lastName: 'Keller', phone: null, email: 'ben@example.com', postcode: '10785', address: '8 Oak Avenue' },
  { key: 'clara', firstName: 'Clara', lastName: 'Wolf', phone: null, email: 'clara@example.com', postcode: '10115', address: '30 Willow Way' },
  { key: 'emil', firstName: 'Emil', lastName: 'Braun', phone: null, email: 'emil@example.com', postcode: '14167', address: '5 Ash Road' },
];

const PLANS = [
  { name: 'Lawn care', category: 'gardening', price: 4900, frequency: 'weekly', minutes: 60, tasks: ['Mow', 'Edge', 'Blow paths'], addon: ['Hedge trimming', 1500], season: [4, 10], status: 'published' },
  { name: 'Full garden care', category: 'gardening', price: 8900, frequency: 'weekly', minutes: 120, tasks: ['Lawn', 'Beds & weeding', 'Hedges', 'Watering check'], addon: ['Seasonal pruning', 1900], season: null, status: 'published' },
  { name: 'Home cleaning', category: 'cleaning', price: 6900, frequency: 'every_2_weeks', minutes: 150, tasks: ['Kitchen', 'Bathrooms', 'Floors', 'Dusting'], addon: ['Oven cleaning', 1200], season: null, status: 'published' },
  { name: 'Handyman on call', category: 'handyman', price: 3900, frequency: 'every_2_weeks', minutes: 60, tasks: ['1 h per visit', 'Small repairs', 'Assembly', 'Odd jobs'], addon: ['Same-day priority', 2000], season: null, status: 'draft' },
] as const;

const EXTRAS: [string, number][] = [
  ['Trim the front hedge', 2000],
  ['Clear the gutter', 2500],
  ['Replace a second tap washer', 1200],
  ['Hang two extra shelves', 1800],
];

const TAGS = [['on_time', 'tidy'], ['friendly'], ['great_value', 'on_time'], ['extra_mile', 'friendly', 'tidy'], []];
const SIZES: JobSize[] = ['M', 'S', 'L', 'M'];
const HOURS = [8, 10, 12, 14, 16];

interface ServiceRow {
  id: string;
  categoryId: string;
  slug: string;
  name: string;
  priceCents: number;
  durationMinutes: number;
  sizeSmallPct: number;
  sizeMediumPct: number;
  sizeLargePct: number;
  pricing: 'fixed' | 'hourly';
}

/** A local slot in the market time zone, `day` days from today, as SQL. */
const SLOT = `((now() AT TIME ZONE $tz)::date + $day::int + make_interval(hours => $hour::int)) AT TIME ZONE $tz`;

export async function seedDemoData(pool: Pool, storage: FileStorage, options: { timezone: string }): Promise<SeedSummary> {
  const existing = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
  if ((existing.rows[0]?.n ?? 0) > 0) {
    throw new Error('The database already has users. Seed only an empty database (npm run db:seed -- --reset empties it).');
  }

  // Hashing is slow, so each password is hashed once, before the transaction.
  const [adminHash, customerHash] = await Promise.all([hashPassword(DEMO_ADMIN.password), hashPassword(DEMO_CUSTOMER_PASSWORD)]);
  const savedFiles: string[] = [];
  const save = async (content: Buffer) => {
    const key = await storage.save(content);
    savedFiles.push(key);
    return key;
  };

  try {
    return await withTransaction(pool, (client) => fill(client, save, options.timezone, adminHash, customerHash));
  } catch (error) {
    await Promise.all(savedFiles.map((key) => storage.remove(key)));
    throw error;
  }
}

async function fill(
  db: PoolClient,
  save: (content: Buffer) => Promise<string>,
  tz: string,
  adminHash: string,
  customerHash: string,
): Promise<SeedSummary> {
  const intents: SeededIntent[] = [];
  let ratings = 0;
  let bookings = 0;

  async function upload(ownerId: string, kind: 'document' | 'photo', content: Buffer, mime: string) {
    const key = await save(content);
    const row = await db.query<{ id: string }>(
      'INSERT INTO uploads (owner_id, kind, mime, size_bytes, storage_key) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [ownerId, kind, mime, content.length, key],
    );
    return row.rows[0]?.id ?? '';
  }

  await db.query("INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'admin')", [DEMO_ADMIN.username, adminHash]);

  for (const [code, name, lat, lng] of POSTCODES) {
    await db.query('INSERT INTO postcodes (code, name, lat, lng) VALUES ($1, $2, $3, $4)', [code, name, lat, lng]);
  }

  const categoryIds = new Map<string, string>();
  const services: ServiceRow[] = [];
  for (const [order, [slug, name, icon, items]] of CATALOGUE.entries()) {
    const category = await db.query<{ id: string }>(
      'INSERT INTO categories (slug, name, icon, sort_order, active) VALUES ($1, $2, $3, $4, true) RETURNING id',
      [slug, name, icon, order],
    );
    const categoryId = category.rows[0]?.id ?? '';
    categoryIds.set(slug, categoryId);
    for (const [index, [serviceName, euros, minutes, description]] of items.entries()) {
      const row = await db.query<{ id: string }>(
        `INSERT INTO services (category_id, name, description, price_cents, duration_minutes, sort_order, pricing, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() - interval '120 days') RETURNING id`,
        [categoryId, serviceName, description, euros * 100, minutes, index, HOURLY.has(serviceName) ? 'hourly' : 'fixed'],
      );
      services.push({
        id: row.rows[0]?.id ?? '',
        categoryId,
        slug,
        name: serviceName,
        priceCents: euros * 100,
        durationMinutes: minutes,
        sizeSmallPct: 100,
        sizeMediumPct: 130,
        sizeLargePct: 170,
        pricing: HOURLY.has(serviceName) ? 'hourly' : 'fixed',
      });
    }
  }
  // A trade the team is still setting up: a draft, so customers do not see it yet.
  const draft = await db.query<{ id: string }>(
    "INSERT INTO categories (slug, name, icon, sort_order, active) VALUES ('pool-care', 'Pool care', 'sun', 99, false) RETURNING id",
  );
  await db.query(
    `INSERT INTO services (category_id, name, description, price_cents, duration_minutes)
     VALUES ($1, 'Pool cleaning', 'Skim, vacuum and check the water', 6900, 90)`,
    [draft.rows[0]?.id],
  );

  for (const plan of PLANS) {
    await db.query(
      `INSERT INTO plans (name, category_id, price_cents, frequency, visit_minutes, tasks, addon_name, addon_price_cents,
         seasonal, season_from, season_to, status, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $12 = 'published' THEN now() - interval '20 days' END)`,
      [
        plan.name,
        categoryIds.get(plan.category),
        plan.price,
        plan.frequency,
        plan.minutes,
        [...plan.tasks],
        plan.addon[0],
        plan.addon[1],
        plan.season !== null,
        plan.season?.[0] ?? null,
        plan.season?.[1] ?? null,
        plan.status,
      ],
    );
  }

  const proIds = new Map<string, string>();
  for (const [index, pro] of PROS.entries()) {
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (phone, role, first_name, created_at) VALUES ($1, 'pro', $2, now() - make_interval(days => $3)) RETURNING id`,
      [pro.phone, pro.firstName, 90 - index * 5],
    );
    const id = user.rows[0]?.id ?? '';
    proIds.set(pro.key, id);
    // Pros who have worked for MISK have a payout account, whatever their state now.
    const worked = ['approved', 'pending_approval', 'suspended'].includes(pro.status);
    const applying = pro.status === 'submitted' || pro.status === 'info_requested';
    await db.query(
      `INSERT INTO pro_profiles (user_id, status, home_postcode, radius_km, working_days, submitted_at, reviewed_at,
         review_note, stripe_account_id, payouts_enabled, watch_list_at, suspended_at, suspended_reason)
       VALUES ($1, $2, $3, $4, $5,
         CASE WHEN $2 = 'draft' THEN NULL WHEN $9 THEN now() - make_interval(days => 1 + $10::int) ELSE now() - interval '60 days' END,
         CASE WHEN $2 IN ('approved', 'rejected', 'pending_approval', 'suspended', 'info_requested') THEN now() - interval '58 days' END,
         CASE WHEN $2 = 'suspended' THEN NULL ELSE $6 END, $7, $8,
         CASE WHEN $11 THEN now() - interval '6 days' END,
         CASE WHEN $2 = 'suspended' THEN now() - interval '5 days' END,
         CASE WHEN $2 = 'suspended' THEN $6 END)`,
      [id, pro.status, pro.home, pro.radius, pro.days, pro.note ?? null, worked ? `acct_seed_${pro.key}` : null, worked, applying, index % 3, pro.watchList ?? false],
    );
    for (const trade of pro.trades) {
      await db.query('INSERT INTO pro_trades (pro_id, category_id) VALUES ($1, $2)', [id, categoryIds.get(trade)]);
    }
    if (pro.status !== 'draft') {
      for (const [kind, title, file, years] of [
        ['id', 'Identity card', 'id-card.pdf', 4],
        ['certificate', 'Trade certificate', 'trade-certificate.pdf', null],
        ['insurance', 'Liability insurance', 'liability-insurance-2026.pdf', 1],
        ['background', 'Certificate of good conduct', 'certificate-of-good-conduct.pdf', null],
      ] as const) {
        const state = pro.docs?.[kind] ?? 'accepted';
        if (state === 'missing') {
          continue;
        }
        const uploadId = await upload(id, 'document', makeDocument(`${title}: ${pro.firstName} (demo)`), 'application/pdf');
        // Expiry: as printed on the document; cover: until when an accepted copy lets the pro work.
        const expiresDays = state === 'expiring' ? 12 : years === null ? null : years * 365 - index * 20;
        const coverDays = state === 'renewal' ? -2 : state === 'accepted' || state === 'expiring' ? (expiresDays ?? null) : undefined;
        await db.query(
          `INSERT INTO pro_documents (pro_id, kind, upload_id, file_name, uploaded_at, expires_on, review_status, review_note,
             reviewed_at, valid_until)
           VALUES ($1, $2, $3, $4, now() - make_interval(days => $5::int),
             CASE WHEN $6::int IS NULL THEN NULL ELSE (now() + make_interval(days => $6::int))::date END,
             $7, $8, CASE WHEN $7 <> 'pending' THEN now() - interval '1 day' END,
             CASE WHEN $9::text = 'none' THEN NULL WHEN $9::text = 'infinity' THEN 'infinity'::date
                  ELSE (now() + make_interval(days => $9::int))::date END)`,
          [
            id,
            kind,
            uploadId,
            state === 'renewal' ? 'liability-insurance-2027.pdf' : file,
            state === 'renewal' ? 1 : 30 + index,
            state === 'renewal' ? 365 : expiresDays,
            state === 'accepted' || state === 'expiring' ? 'accepted' : state === 'rejected' ? 'rejected' : 'pending',
            state === 'rejected' ? 'Please upload a clear photo of the whole document.' : null,
            coverDays === undefined ? 'none' : coverDays === null ? 'infinity' : String(coverDays),
          ],
        );
      }
    }
  }

  const customerIds = new Map<string, string>();
  for (const customer of CUSTOMERS) {
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (phone, email, password_hash, role, first_name, last_name, terms_accepted_at, stripe_customer_id)
       VALUES ($1, $2, $3, 'customer', $4, $5, CASE WHEN $2::text IS NOT NULL THEN now() END, $6) RETURNING id`,
      [customer.phone, customer.email, customer.email ? customerHash : null, customer.firstName, customer.lastName, `cus_seed_${customer.key}`],
    );
    customerIds.set(customer.key, user.rows[0]?.id ?? '');
  }

  const approvedFor = (slug: string) => PROS.filter((p) => p.status === 'approved' && p.trades.includes(slug));

  async function addBooking(input: {
    tag: string;
    customer: CustomerSeed;
    service: ServiceRow;
    size: JobSize;
    status: string;
    startsAt: { day: number; hour: number } | { minutesFromNow: number };
    pro: ProSeed | null;
    paymentStatus: 'pending' | 'held' | 'captured' | 'released' | 'refunded';
    events: string[];
    cancelledBy?: 'customer' | 'admin' | 'system';
    notes?: string;
  }) {
    const price = jobPriceCents(input.service, input.size);
    const intentId = `pi_seed_${input.tag}`;
    const startSql =
      'day' in input.startsAt
        ? SLOT.replaceAll('$tz', '$14').replaceAll('$day', '$15').replaceAll('$hour', '$16')
        : // Every parameter must appear in the SQL, so the unused time zone and hour cancel out here.
          `date_trunc('minute', now()) + make_interval(mins => $15::int, hours => COALESCE($16::int, 0)) + ($14::text IS NULL)::int * interval '0'`;
    const startValues = 'day' in input.startsAt ? [input.startsAt.day, input.startsAt.hour] : [input.startsAt.minutesFromNow, null];
    const row = await db.query<{ id: string; starts_at: Date; ends_at: Date }>(
      `WITH s AS (SELECT ${startSql} AS starts_at)
       INSERT INTO bookings (customer_id, service_id, category_id, service_name, size, address, postcode, notes,
         starts_at, ends_at, status, price_cents, fee_cents, pro_share_pct, pro_id, payment_intent_id, payment_status,
         cancelled_by, created_at, completed_at)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, s.starts_at, s.starts_at + make_interval(mins => $9::int), $10, $11, 290, 82,
         $12, $13, $17, $18,
         CASE WHEN s.starts_at < now() THEN s.starts_at - interval '2 days' ELSE LEAST(now(), s.starts_at - interval '3 hours') END,
         CASE WHEN $10 = 'completed' THEN s.starts_at + make_interval(mins => $9::int) END
       FROM s
       RETURNING id, starts_at, ends_at`,
      [
        customerIds.get(input.customer.key),
        input.service.id,
        input.service.categoryId,
        input.service.name,
        input.size,
        input.customer.address,
        input.customer.postcode,
        input.notes ?? '',
        input.service.durationMinutes,
        input.status,
        price,
        input.pro ? proIds.get(input.pro.key) : null,
        intentId,
        tz,
        ...startValues,
        input.paymentStatus,
        input.cancelledBy ?? null,
      ],
    );
    const booking = row.rows[0];
    if (!booking) {
      throw new Error('Booking insert returned nothing');
    }
    bookings += 1;
    if (input.paymentStatus !== 'pending') {
      intents.push({ id: intentId, amountCents: price + 290, status: input.paymentStatus });
    }
    // Each step of the timeline at a plausible moment between booking and finishing, never in the future.
    for (const status of input.events) {
      await db.query(
        `INSERT INTO booking_events (booking_id, status, created_at)
         SELECT id, $2, LEAST(now(), CASE $2
           WHEN 'awaiting_payment' THEN created_at
           WHEN 'searching' THEN created_at + interval '1 minute'
           WHEN 'accepted' THEN created_at + interval '9 minutes'
           WHEN 'unassigned' THEN created_at + interval '50 minutes'
           WHEN 'cancelled' THEN created_at + interval '3 hours'
           WHEN 'on_the_way' THEN starts_at - interval '30 minutes'
           WHEN 'working' THEN starts_at
           ELSE ends_at END)
         FROM bookings WHERE id = $1`,
        [booking.id, status],
      );
    }
    return { id: booking.id, price, startsAt: booking.starts_at, endsAt: booking.ends_at };
  }

  async function addPayout(bookingId: string, pro: ProSeed, tag: string, amountCents: number, reversed = false) {
    await db.query(
      `INSERT INTO payouts (booking_id, pro_id, payment_intent_id, charge_id, amount_cents, transfer_id, status, created_at)
       SELECT $1, $2, $3, $4, $5, $6, $7, completed_at FROM bookings WHERE id = $1`,
      [bookingId, proIds.get(pro.key), `pi_seed_${tag}`, `ch_seed_${tag}`, amountCents, `tr_seed_${tag}`, reversed ? 'reversed' : 'sent'],
    );
  }

  const COMPLETED_EVENTS = ['awaiting_payment', 'searching', 'accepted', 'on_the_way', 'working', 'completed'];
  const bookable = services.filter((s) => approvedFor(s.slug).length > 0);

  // Eight weeks of history: mostly finished jobs, some cancelled, a few refunded.
  for (let i = 0; i < 64; i += 1) {
    const service = bookable[(i * 7) % bookable.length] as ServiceRow;
    const pros = approvedFor(service.slug);
    const pro = pros[i % pros.length] as ProSeed;
    const customer = CUSTOMERS[i % CUSTOMERS.length] as CustomerSeed;
    const day = -1 - Math.floor((i * 55) / 64);
    const hour = HOURS[(i * 3) % HOURS.length] as number;
    const size = SIZES[i % SIZES.length] as JobSize;
    const tag = `past${i}`;

    if (i % 13 === 5) {
      await addBooking({
        tag, customer, service, size, pro: null, status: 'cancelled', paymentStatus: 'released', cancelledBy: 'customer',
        startsAt: { day, hour }, events: ['awaiting_payment', 'searching', 'cancelled'],
      });
      continue;
    }
    const refunded = i % 17 === 9;
    const booking = await addBooking({
      tag, customer, service, size, pro, status: 'completed', paymentStatus: refunded ? 'refunded' : 'captured',
      startsAt: { day, hour }, events: COMPLETED_EVENTS,
    });
    await addPayout(booking.id, pro, tag, proShareCents(booking.price, 82), refunded);

    if (i % 7 === 3) {
      const [description, extraPrice] = EXTRAS[i % EXTRAS.length] as [string, number];
      const extraTag = `${tag}x`;
      await db.query(
        `INSERT INTO extra_requests (booking_id, description, price_cents, status, payment_intent_id, payment_status, created_at, decided_at)
         VALUES ($1, $2, $3, 'approved', $4, $5, $6, $6)`,
        [booking.id, description, extraPrice, `pi_seed_${extraTag}`, refunded ? 'refunded' : 'captured', booking.startsAt],
      );
      intents.push({ id: `pi_seed_${extraTag}`, amountCents: extraPrice, status: refunded ? 'refunded' : 'captured' });
      await addPayout(booking.id, pro, extraTag, proShareCents(extraPrice, 82), refunded);
    }
    if (i < 8) {
      const proId = proIds.get(pro.key) ?? '';
      for (let p = 0; p < 2; p += 1) {
        const photoId = await upload(proId, 'photo', makePhoto([62 + p * 20, 155 - i * 4, 107]), 'image/png');
        await db.query("INSERT INTO booking_photos (upload_id, booking_id, kind, created_at) VALUES ($1, $2, 'completion', $3)", [
          photoId,
          booking.id,
          booking.endsAt,
        ]);
      }
    }
    if (i % 6 !== 4) {
      const stars = pro.stars[i % pro.stars.length] ?? 5;
      await db.query(
        `INSERT INTO ratings (booking_id, pro_id, customer_id, stars, tags, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [booking.id, proIds.get(pro.key), customerIds.get(customer.key), stars, TAGS[i % TAGS.length], booking.endsAt],
      );
      ratings += 1;
    }
  }

  // What is happening now and next: one job of each live status.
  const find = (name: string) => services.find((s) => s.name === name) as ServiceRow;
  const byKey = (list: { key: string }[], key: string) => list.find((x) => x.key === key);
  const customer = (key: string) => byKey(CUSTOMERS, key) as CustomerSeed;
  const pro = (key: string) => byKey(PROS, key) as ProSeed;
  const LIVE = ['awaiting_payment', 'searching', 'accepted'];

  await addBooking({
    tag: 'working', customer: customer('sara'), service: find('Lawn mowing'), size: 'M', pro: pro('daniel'), status: 'working',
    paymentStatus: 'held', startsAt: { minutesFromNow: -30 }, events: [...LIVE, 'on_the_way', 'working'],
    notes: 'Gate code 4411. The lawn at the back is the larger part.',
  });
  const extraBooking = await addBooking({
    tag: 'ontheway', customer: customer('lea'), service: find('Leak repair'), size: 'M', pro: pro('arben'), status: 'on_the_way',
    paymentStatus: 'held', startsAt: { minutesFromNow: 40 }, events: [...LIVE, 'on_the_way'],
    notes: 'The leak is under the kitchen sink.',
  });
  await db.query(`INSERT INTO extra_requests (booking_id, description, price_cents) VALUES ($1, 'Replace the old siphon too', 1800)`, [
    extraBooking.id,
  ]);

  const upcoming: [string, string, string, JobSize, number, number][] = [
    ['tom', 'Furniture assembly', 'marta', 'L', 1, 10],
    ['anna', 'Home cleaning', 'ina', 'M', 1, 8],
    ['clara', 'Hedge trimming', 'daniel', 'M', 2, 12],
    ['noah', 'Light fitting', 'faton', 'S', 3, 14],
  ];
  for (const [index, [who, serviceName, proKey, size, day, hour]] of upcoming.entries()) {
    const booking = await addBooking({
      tag: `next${index}`, customer: customer(who), service: find(serviceName), size, pro: pro(proKey), status: 'accepted',
      paymentStatus: 'held', startsAt: { day, hour }, events: LIVE,
    });
    if (index === 0) {
      const photoId = await upload(customerIds.get(who) ?? '', 'photo', makePhoto([180, 150, 110]), 'image/png');
      await db.query("INSERT INTO booking_photos (upload_id, booking_id, kind) VALUES ($1, $2, 'customer')", [photoId, booking.id]);
    }
  }

  // Waiting for a pro to accept, with a live 15-minute offer.
  for (const [index, [who, serviceName, proKey, day, hour]] of (
    [
      ['mila', 'Drain unblocking', 'arben', 2, 10],
      ['ben', 'Window cleaning', 'jonas', 4, 14],
    ] as const
  ).entries()) {
    const booking = await addBooking({
      tag: `offer${index}`, customer: customer(who), service: find(serviceName), size: 'M', pro: null, status: 'searching',
      paymentStatus: 'held', startsAt: { day, hour }, events: ['awaiting_payment', 'searching'],
    });
    await db.query(
      `INSERT INTO booking_offers (booking_id, pro_id, expires_at) VALUES ($1, $2, now() + interval '12 minutes')`,
      [booking.id, proIds.get(proKey)],
    );
  }

  // Nobody could take it: the admins see it under "Needs attention".
  const lonely = await addBooking({
    tag: 'unassigned', customer: customer('emil'), service: find('Room painting'), size: 'M', pro: null, status: 'unassigned',
    paymentStatus: 'held', startsAt: { day: 1, hour: 8 }, events: ['awaiting_payment', 'searching', 'unassigned'],
  });
  await db.query(
    `INSERT INTO booking_offers (booking_id, pro_id, status, expires_at, responded_at)
     VALUES ($1, $2, 'declined', now() - interval '1 hour', now() - interval '70 minutes')`,
    [lonely.id, proIds.get('marta')],
  );

  // Monthly plans in use: customers with a regular pro and visits planned four weeks ahead.
  const planIds = await db.query<{ id: string; name: string }>("SELECT id, name FROM plans WHERE status = 'published'");
  const planId = (name: string) => planIds.rows.find((row) => row.name === name)?.id;
  for (const [index, sub] of (
    [
      { who: 'sara', plan: 'Lawn care', pro: 'daniel', category: 'gardening', days: [2, 5], window: 'morning', tasks: ['Mow', 'Edge', 'Blow paths'], minutes: 60, price: 6400, addon: 'Hedge trimming', seasonal: true, frequency: 'twice_weekly' },
      { who: 'anna', plan: 'Home cleaning', pro: 'ina', category: 'cleaning', days: [3], window: 'afternoon', tasks: ['Kitchen', 'Bathrooms', 'Floors', 'Dusting'], minutes: 150, price: 6900, addon: null, seasonal: false, frequency: 'every_2_weeks' },
    ] as const
  ).entries()) {
    const created = await db.query<{ id: string }>(
      `INSERT INTO subscriptions (customer_id, plan_id, category_id, plan_name, tasks, size, frequency, days, time_window,
         visit_minutes, address, postcode, with_addon, addon_name, price_cents, pro_share_pct, seasonal, season_from, season_to,
         skips_per_month, min_term_months, pro_id, status, stripe_subscription_id, started_at, current_period_end, created_at)
       VALUES ($1, $2, $3, $4, $5, 'M', $6, $7, $8, $9, $10, $11, $12, $13, $14, 70, $15, $16, $17, 2, 3, $18, 'active', $19,
         now() - interval '40 days', now() + interval '20 days', now() - interval '40 days')
       RETURNING id`,
      [
        customerIds.get(sub.who),
        planId(sub.plan),
        categoryIds.get(sub.category),
        sub.plan,
        [...sub.tasks],
        sub.frequency,
        [...sub.days],
        sub.window,
        sub.minutes,
        customer(sub.who).address,
        customer(sub.who).postcode,
        sub.addon !== null,
        sub.addon,
        sub.price,
        sub.seasonal,
        sub.seasonal ? 4 : null,
        sub.seasonal ? 10 : null,
        proIds.get(sub.pro),
        `sub_seed_${index}`,
      ],
    );
    const subscriptionId = created.rows[0]?.id ?? '';
    await db.query(
      `INSERT INTO subscription_payouts (subscription_id, pro_id, invoice_id, amount_cents, transfer_id, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'sent', now() - interval '10 days')`,
      [subscriptionId, proIds.get(sub.pro), `in_seed_${index}`, Math.floor((sub.price * 70) / 100), `tr_seed_sub_${index}`],
    );
    const row = await db.query(
      `SELECT id, pro_id, days, frequency, time_window, visit_minutes, seasonal, season_from, season_to, started_at, created_at, ends_at
       FROM subscriptions WHERE id = $1`,
      [subscriptionId],
    );
    await planVisits(db, row.rows[0], tz, 'planned');
  }

  // Every job a pro took was offered to them first; Faton turned down several, so his acceptance is low.
  await db.query(
    `INSERT INTO booking_offers (booking_id, pro_id, status, offered_at, expires_at, responded_at)
     SELECT b.id, b.pro_id, 'accepted', b.created_at, b.created_at + interval '15 minutes', b.created_at + interval '4 minutes'
     FROM bookings b WHERE b.pro_id IS NOT NULL
     ON CONFLICT (booking_id, pro_id) DO NOTHING`,
  );
  await db.query(
    `INSERT INTO booking_offers (booking_id, pro_id, status, offered_at, expires_at, responded_at)
     SELECT b.id, $1, 'declined', b.created_at - interval '20 minutes', b.created_at - interval '5 minutes', b.created_at - interval '15 minutes'
     FROM bookings b
     WHERE b.pro_id IS NOT NULL AND b.pro_id <> $1 AND b.created_at > now() - interval '30 days'
       AND b.category_id IN (SELECT category_id FROM pro_trades WHERE pro_id = $1)
     ORDER BY b.created_at DESC LIMIT 8
     ON CONFLICT (booking_id, pro_id) DO NOTHING`,
    [proIds.get('faton')],
  );
  await db.query(
    `INSERT INTO pro_admin_actions (pro_id, action, details, created_at) VALUES
       ($1, 'watch_list_on', '{}', now() - interval '6 days'),
       ($2, 'moved_to_pending', '{"documents": ["insurance"]}', now() - interval '2 days'),
       ($3, 'suspended', $4, now() - interval '5 days'),
       ($5, 'info_requested', $6, now() - interval '1 day')`,
    [
      proIds.get('faton'),
      proIds.get('valon'),
      proIds.get('gent'),
      JSON.stringify({ reason: (byKey(PROS, 'gent') as ProSeed).note }),
      proIds.get('kujtim'),
      JSON.stringify({ message: (byKey(PROS, 'kujtim') as ProSeed).note }),
    ],
  );

  // ---------- Something to see in every section of the control panel ----------

  // Done a few hours ago: the card is charged tomorrow, and the customer can still report a problem or tip.
  const justDone = await addBooking({
    tag: 'justdone', customer: customer('anna'), service: find('Home cleaning'), size: 'M', pro: pro('ina'), status: 'completed',
    paymentStatus: 'held', startsAt: { minutesFromNow: -330 }, events: COMPLETED_EVENTS,
  });
  await db.query("INSERT INTO booking_photos (upload_id, booking_id, kind) VALUES ($1, $2, 'completion')", [
    await upload(proIds.get('ina') ?? '', 'photo', makePhoto([120, 170, 200]), 'image/png'),
    justDone.id,
  ]);

  // A problem the customer reported before the charge: the charge waits under Bookings → Needs action.
  const problem = await addBooking({
    tag: 'problem', customer: customer('clara'), service: find('Hedge trimming'), size: 'L', pro: pro('jonas'), status: 'completed',
    paymentStatus: 'held', startsAt: { minutesFromNow: -720 }, events: COMPLETED_EVENTS,
  });
  await db.query(
    `UPDATE bookings SET problem_reported_at = now() - interval '2 hours',
       problem_note = 'The hedge at the back of the garden was not trimmed at all.' WHERE id = $1`,
    [problem.id],
  );

  // Cancelled by the customer six hours before the start: the full price was charged and the pro paid.
  const lateCancel = await addBooking({
    tag: 'latecancel', customer: customer('tom'), service: find('Window cleaning'), size: 'M', pro: pro('jonas'), status: 'cancelled',
    paymentStatus: 'captured', cancelledBy: 'customer', startsAt: { day: -2, hour: 14 }, events: [...LIVE, 'cancelled'],
  });
  await db.query('UPDATE bookings SET late_cancel = true WHERE id = $1', [lateCancel.id]);
  await db.query(
    `INSERT INTO payouts (booking_id, pro_id, payment_intent_id, charge_id, amount_cents, transfer_id, status, created_at)
     SELECT id, pro_id, payment_intent_id, 'ch_seed_latecancel', $2, 'tr_seed_latecancel', 'sent', starts_at - interval '6 hours'
     FROM bookings WHERE id = $1`,
    [lateCancel.id, proShareCents(lateCancel.price, 82)],
  );

  // Tips on three finished jobs, split 82 / 18 like the jobs.
  const tipped = await db.query<{ id: string; pro_key: string; amount: number }>(
    `SELECT b.id, b.pro_id AS pro_key, (ARRAY[300, 500, 1000])[row_number() OVER (ORDER BY b.completed_at DESC)] AS amount
     FROM bookings b WHERE b.status = 'completed' AND b.payment_status = 'captured' AND b.pro_id IS NOT NULL
     ORDER BY b.completed_at DESC LIMIT 3`,
  );
  for (const [index, tip] of tipped.rows.entries()) {
    const intent = `pi_seed_tip${index}`;
    await db.query(
      `INSERT INTO tips (booking_id, amount_cents, pro_share_pct, pro_cents, payment_intent_id, status, created_at)
       SELECT $1, $2, 82, $3, $4, 'captured', completed_at + interval '1 hour' FROM bookings WHERE id = $1`,
      [tip.id, tip.amount, proShareCents(tip.amount, 82), intent],
    );
    await db.query(
      `INSERT INTO payouts (booking_id, pro_id, payment_intent_id, charge_id, amount_cents, transfer_id, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'sent', now() - interval '1 day')`,
      [tip.id, tip.pro_key, intent, `ch_seed_tip${index}`, proShareCents(tip.amount, 82), `tr_seed_tip${index}`],
    );
    intents.push({ id: intent, amountCents: tip.amount, status: 'captured' });
  }

  // ---------- The team, with one member per role ----------
  const teamHash = adminHash;
  const adminId = (await db.query<{ id: string }>("SELECT id FROM users WHERE username = 'admin'")).rows[0]?.id ?? '';
  await db.query("UPDATE users SET first_name = 'Demo', last_name = 'Admin', contact_phone = '+4915199900000' WHERE id = $1", [adminId]);
  const team: [string, string, string | null, 'operations' | 'support' | 'finance', number | null][] = [
    ['olivia.ops@example.com', 'Olivia', 'Brandt', 'operations', 2],
    ['sam.support@example.com', 'Sam', 'Okafor', 'support', 26],
    ['fiona.finance@example.com', 'Fiona', 'Weiss', 'finance', 75],
    ['new.hire@example.com', 'Nora', null, 'operations', null],
  ];
  const teamIds = new Map<string, string>();
  for (const [email, first, last, role, hoursAgo] of team) {
    const member = await db.query<{ id: string }>(
      `INSERT INTO users (username, email, first_name, last_name, password_hash, role, admin_role, invited_at, created_at)
       VALUES ($1, $1, $2, $3, $4, 'admin', $5, CASE WHEN $6::int IS NULL THEN now() - interval '1 day' END, now() - interval '40 days')
       RETURNING id`,
      [email, first, last, teamHash, role, hoursAgo],
    );
    const id = member.rows[0]?.id ?? '';
    teamIds.set(role === 'operations' && hoursAgo === null ? 'invited' : role, id);
    if (hoursAgo !== null) {
      // An ended session, so the team list can show when they were last active.
      await db.query(
        `INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at)
         VALUES (decode(md5(random()::text), 'hex'), $1, now() - make_interval(hours => $2 + 1), now() - make_interval(hours => $2), now() - interval '1 minute')`,
        [id, hoursAgo],
      );
    }
  }

  // ---------- Service area: two zones on the waitlist and people waiting ----------
  await db.query(
    `INSERT INTO postcodes (code, name, lat, lng, active) VALUES
       ('12047', 'Neukölln North', 52.4895, 13.4255, false),
       ('13347', 'Wedding', 52.5491, 13.3586, false)`,
  );
  const waiting: [string, string, string][] = [
    ['+4915100000101', 'Jana', '12047'],
    ['+4915100000102', 'Malik', '12047'],
    ['+4915100000103', 'Petra', '12047'],
    ['+4915100000104', 'Yusuf', '13347'],
    ['+4915100000105', 'Greta', '14193'],
  ];
  for (const [phone, name, postcode] of waiting) {
    const person = await db.query<{ id: string }>(
      "INSERT INTO users (phone, role, first_name) VALUES ($1, 'customer', $2) RETURNING id",
      [phone, name],
    );
    await db.query("INSERT INTO waitlist (postcode, user_id, created_at) VALUES ($1, $2, now() - interval '9 days')", [
      postcode,
      person.rows[0]?.id,
    ]);
  }
  await db.query("INSERT INTO waitlist (postcode, user_id) VALUES ('12047', $1)", [customerIds.get('mila')]);

  // ---------- The activity log: changes the team made in the last weeks ----------
  const at = (days: number) => `now() - interval '${days} days'`;
  const ops = teamIds.get('operations') ?? adminId;
  const finance = teamIds.get('finance') ?? adminId;
  const support = teamIds.get('support') ?? adminId;
  const activity: [string, string, string, string, Record<string, unknown>][] = [
    [adminId, at(30), 'fees', 'service_fee', { from: 250, to: 290 }],
    [finance, at(21), 'fees', 'payout_interval', { from: 'monthly', to: 'weekly' }],
    [ops, at(14), 'zones', 'zone_added', { code: '12047', name: 'Neukölln North' }],
    [ops, at(12), 'zones', 'zone_added', { code: '13347', name: 'Wedding' }],
    [ops, at(6), 'notifications', 'channel_on', { message: 'booking_confirmed', channel: 'email' }],
    [adminId, at(3), 'team', 'invited', { email: 'new.hire@example.com', role: 'operations' }],
    [adminId, at(2), 'team', 'role_changed', { memberId: support, from: 'operations', to: 'support' }],
  ];
  for (const [who, when, area, action, details] of activity) {
    await db.query(`INSERT INTO admin_activity (admin_id, area, action, details, created_at) VALUES ($1, $2, $3, $4, ${when})`, [
      who,
      area,
      action,
      JSON.stringify(details),
    ]);
  }
  // The team's actions on pros; moving a pro to Pending approval was MISK's own doing.
  await db.query("UPDATE pro_admin_actions SET admin_id = $1 WHERE action <> 'moved_to_pending' AND admin_id IS NULL", [ops]);
  const mowing = find('Lawn mowing');
  await db.query(
    `INSERT INTO catalogue_changes (admin_id, category_id, service_id, action, details, created_at) VALUES
       ($1, $2, $3, 'price_changed', '{"from": 3200, "to": 3500}', now() - interval '20 days'),
       ($1, $4, $5, 'service_added', '{"name": "Handyman by the hour", "priceCents": 3800, "pricing": "hourly"}', now() - interval '10 days'),
       ($1, (SELECT id FROM categories WHERE slug = 'pool-care'), NULL, 'trade_added', '{"name": "Pool care"}', now() - interval '4 days')`,
    [ops, mowing.categoryId, mowing.id, find('Handyman by the hour').categoryId, find('Handyman by the hour').id],
  );
  const upcomingJob = await db.query<{ id: string }>("SELECT id FROM bookings WHERE payment_intent_id = 'pi_seed_next2'");
  await db.query(
    `INSERT INTO booking_admin_actions (booking_id, admin_id, action, details, created_at)
     SELECT id, $2, 'rescheduled', json_build_object('from', starts_at - interval '1 day', 'to', starts_at), now() - interval '1 day'
     FROM bookings WHERE id = $1`,
    [upcomingJob.rows[0]?.id, support],
  );
  await db.query(
    `INSERT INTO booking_admin_actions (booking_id, admin_id, action, details, created_at)
     SELECT id, $1, 'refunded', json_build_object('amountCents', price_cents + fee_cents, 'wasCharged', true), completed_at + interval '1 day'
     FROM bookings WHERE payment_status = 'refunded'`,
    [finance],
  );

  // Booked a moment ago, card not confirmed yet.
  await addBooking({
    tag: 'unpaid', customer: customer('tom'), service: find('Socket install'), size: 'S', pro: null, status: 'awaiting_payment',
    paymentStatus: 'pending', startsAt: { day: 3, hour: 16 }, events: ['awaiting_payment'],
  });

  return {
    postcodes: POSTCODES.length,
    categories: CATALOGUE.length,
    services: services.length,
    plans: PLANS.length,
    pros: PROS.length,
    customers: CUSTOMERS.length,
    bookings,
    ratings,
    intents,
  };
}
