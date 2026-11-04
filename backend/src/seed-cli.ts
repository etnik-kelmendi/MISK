import pg from 'pg';
import { loadConfig } from './config.js';
import { DEMO_ADMIN, DEMO_CUSTOMER_PASSWORD, seedDemoData } from './seed/demo-data.js';
import { emptyDatabase, migrateIfNeeded } from './seed/reset.js';
import { createDiskStorage } from './uploads/storage.js';

// Fills a development database with demo data: `npm run db:seed`, or `npm run db:seed -- --reset`
// to empty it first. Refuses to run in production, where every demo password would be a hole.
const config = loadConfig(process.env);
if (config.production) {
  console.error('db:seed never runs with NODE_ENV=production: the demo accounts have public passwords.');
  process.exit(1);
}

const reset = process.argv.includes('--reset');
const pool = new pg.Pool({ connectionString: config.databaseUrl });
try {
  await migrateIfNeeded(config.databaseUrl);
  if (reset) {
    await emptyDatabase(pool);
    console.log('Emptied the database.');
  }
  const summary = await seedDemoData(pool, createDiskStorage(config.uploadDir), { timezone: config.timezone });
  console.log(
    [
      'Demo data added:',
      `  ${summary.postcodes} postcodes, ${summary.categories} categories, ${summary.services} services, ${summary.plans} plans`,
      `  ${summary.pros} pros, ${summary.customers} customers, ${summary.bookings} bookings, ${summary.ratings} ratings`,
      '',
      'Sign in with:',
      `  Admin (/admin/login): ${DEMO_ADMIN.username} / ${DEMO_ADMIN.password}`,
      `  Customer by email (/signin): anna@example.com / ${DEMO_CUSTOMER_PASSWORD}`,
      '  Customer by phone: +4915100000001 (Sara); pro by phone: +4915200000001 (Daniel). Codes appear in the API log without Twilio.',
      '',
      'Bookings use made-up payment ids (pi_seed_...). With real Stripe keys, do not complete or refund seeded bookings;',
      'the preview server (npm run preview:server) uses fake payments where they work end to end.',
    ].join('\n'),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
