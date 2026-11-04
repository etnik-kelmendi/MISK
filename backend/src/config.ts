import { resolve } from 'node:path';
import { normalizePhone } from './notifications/phone.js';
import type { SmtpConfig } from './notifications/email.js';
import type { TwilioConfig } from './notifications/sms.js';

export interface StripeConfig {
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
}

export interface Config {
  databaseUrl: string;
  port: number;
  webOrigin: string;
  trustProxy: boolean;
  production: boolean;
  secureCookies: boolean;
  logLevel: string;
  /** IANA time zone of the city MISK serves. Slots and working days are counted in it. */
  timezone: string;
  uploadDir: string;
  /** SMS sending; null until all three Twilio settings are given. Required in production. */
  twilio: TwilioConfig | null;
  /** Card payments; null until all three Stripe settings are given. The server refuses to start without it. */
  stripe: StripeConfig | null;
  /** Outgoing email for admin password recovery; null until the SMTP settings are given. */
  smtp: SmtpConfig | null;
}

type RawEnv = Record<string, string | undefined>;

function required(env: RawEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? '3000');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be a port number');
  }
  return port;
}

function parseOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('WEB_ORIGIN must be an absolute URL');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== value) {
    throw new Error('WEB_ORIGIN must be an exact http or https origin with no path');
  }
  return value;
}

function parseTimezone(value: string): string {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
  } catch {
    throw new Error('MARKET_TIMEZONE must be an IANA time zone such as Europe/Berlin');
  }
  return value;
}

// All three or none: a half-filled setup would look ready and then fail on every message.
function parseTwilio(env: RawEnv): TwilioConfig | null {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  const fromInput = env.TWILIO_FROM_NUMBER?.trim();
  if (!accountSid && !authToken && !fromInput) {
    return null;
  }
  if (!accountSid || !authToken || !fromInput) {
    throw new Error('TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER must be set together');
  }
  const from = normalizePhone(fromInput);
  if (!from) {
    throw new Error('TWILIO_FROM_NUMBER must be an international number such as +4915112345678');
  }
  return { accountSid, authToken, from };
}

function parseStripe(env: RawEnv, production: boolean): StripeConfig | null {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  const publishableKey = env.STRIPE_PUBLISHABLE_KEY?.trim();
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secretKey && !publishableKey && !webhookSecret) {
    return null;
  }
  if (!secretKey || !publishableKey || !webhookSecret) {
    throw new Error('STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, and STRIPE_WEBHOOK_SECRET must be set together');
  }
  if (!/^(sk|rk)_(test|live)_/.test(secretKey) || !/^pk_(test|live)_/.test(publishableKey)) {
    throw new Error('STRIPE_SECRET_KEY must start with sk_ or rk_, and STRIPE_PUBLISHABLE_KEY with pk_');
  }
  if (!webhookSecret.startsWith('whsec_')) {
    throw new Error('STRIPE_WEBHOOK_SECRET must start with whsec_');
  }
  const live = secretKey.includes('_live_');
  if (live !== publishableKey.startsWith('pk_live_')) {
    throw new Error('The Stripe secret and publishable keys must both be live keys or both be test keys');
  }
  if (live && !production) {
    throw new Error('Live Stripe keys may only be used with NODE_ENV=production');
  }
  return { secretKey, publishableKey, webhookSecret };
}

// Host, user, password and sender together or none; the port defaults to 587 (STARTTLS).
function parseSmtp(env: RawEnv): SmtpConfig | null {
  const host = env.SMTP_HOST?.trim();
  const user = env.SMTP_USER?.trim();
  const password = env.SMTP_PASSWORD?.trim();
  const from = env.MAIL_FROM?.trim();
  if (!host && !user && !password && !from) {
    return null;
  }
  if (!host || !user || !password || !from) {
    throw new Error('SMTP_HOST, SMTP_USER, SMTP_PASSWORD, and MAIL_FROM must be set together');
  }
  const port = Number(env.SMTP_PORT?.trim() || '587');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP_PORT must be a port number');
  }
  if (!/^[^\s<>]+@[^\s<>]+$|^[^<>]*<[^\s<>]+@[^\s<>]+>$/.test(from)) {
    throw new Error('MAIL_FROM must be an email address, optionally with a name: MISK <no-reply@misk.app>');
  }
  return { host, port, secure: port === 465, user, password, from };
}

export function loadConfig(env: RawEnv): Config {
  const production = env.NODE_ENV === 'production';
  const twilio = parseTwilio(env);
  if (production && !twilio) {
    throw new Error('Twilio settings are required in production, or nobody can receive a sign-in code');
  }
  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    port: parsePort(env.PORT),
    webOrigin: parseOrigin(required(env, 'WEB_ORIGIN')),
    trustProxy: env.TRUST_PROXY === 'true',
    production,
    secureCookies: production,
    logLevel: env.LOG_LEVEL ?? 'info',
    timezone: parseTimezone(required(env, 'MARKET_TIMEZONE')),
    uploadDir: resolve(env.UPLOAD_DIR?.trim() || '.uploads'),
    twilio,
    stripe: parseStripe(env, production),
    smtp: parseSmtp(env),
  };
}
