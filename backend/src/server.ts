import pg from 'pg';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createSmtpSender } from './notifications/email.js';
import { createTwilioSender } from './notifications/sms.js';
import { createStripeGateway } from './payments/stripe-gateway.js';
import { startWorkers } from './workers.js';

const config = loadConfig(process.env);
if (!config.stripe) {
  // No booking may ever be taken without a real payment (D11). Stripe test keys are free.
  console.error('Stripe settings are required. Add STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY and STRIPE_WEBHOOK_SECRET to .env.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: config.databaseUrl });
const sms = config.twilio ? createTwilioSender(config.twilio) : null;
const gateway = createStripeGateway(config.stripe);
const email = config.smtp ? createSmtpSender(config.smtp) : null;
const app = await buildApp({ config, pool, gateway, sms, email, logger: { level: config.logLevel } });

if (!sms) {
  app.log.warn('SMS is not set up: sign-in codes are written to this log and other texts are kept as not sent');
}
if (!email) {
  app.log.warn('Email is not set up: admin password recovery emails cannot be sent');
}

const stopWorkers = startWorkers({ pool, gateway, config, log: app.log }, sms, app.log);

async function shutdown() {
  stopWorkers();
  await app.close();
  await pool.end();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

await app.listen({ port: config.port, host: '0.0.0.0' });
