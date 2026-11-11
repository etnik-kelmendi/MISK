import { resolve } from 'node:path';
import { normalizePhone } from './notifications/phone.js';
import type { SmtpConfig } from './notifications/email.js';
import type { PushConfig } from './notifications/push.js';
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
  /** Exact origin of the admin control panel; the same as `webOrigin` when both are one site. */
  adminOrigin: string;
  trustProxy: boolean;
  production: boolean;
  secureCookies: boolean;
  logLevel: string;
  /** IANA time zone of the city MISK serves. Slots and working days are counted in it. */
  timezone: string;
  /** Name of the city MISK serves, shown on the control panel's overview. */
  city: string;
  uploadDir: string;
  /** SMS sending; null until all three Twilio settings are given. Required in production. */
  twilio: TwilioConfig | null;
  /** Card payments; null until all three Stripe settings are given. The server refuses to start without it. */
  stripe: StripeConfig | null;
  /** Outgoing email for admin password recovery; null until the SMTP settings are given. */
  smtp: SmtpConfig | null;
  /** Web Push to the app on people's phones; null until the VAPID keys are given. */
  push: PushConfig | null;
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

function parseOrigin(value: string, name = 'WEB_ORIGIN'): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== value) {
    throw new Error(`${name} must be an exact http or https origin with no path`);
  }
  return value;
}

/** MARKET_CITY, or the city in the time zone's name ("Europe/Berlin" → "Berlin"). */
export function parseCity(value: string | undefined, timezone: string): string {
  const city = value?.trim() || (timezone.split('/').pop() ?? '').replaceAll('_', ' ');
  if (!city || city.length > 60) {
    throw new Error('MARKET_CITY must be the name of the city MISK serves, at most 60 characters');
  }
  return city;
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
  // SMTP_USERNAME is accepted too, because providers such as SMTP2GO name it that way.
  const user = (env.SMTP_USER ?? env.SMTP_USERNAME)?.trim();
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

// Both keys and the contact together or none.
function parsePush(env: RawEnv): PushConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim();
  if (!publicKey && !privateKey && !subject) {
    return null;
  }
  if (!publicKey || !privateKey || !subject) {
    throw new Error('VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT must be set together');
  }
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(publicKey) || !/^[A-Za-z0-9_-]{40,50}$/.test(privateKey)) {
    throw new Error('VAPID keys must be the URL-safe base64 keys printed by `npx web-push generate-vapid-keys`');
  }
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(subject)) {
    throw new Error('VAPID_SUBJECT must be a mailto: address or an https URL');
  }
  return { publicKey, privateKey, subject };
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
    adminOrigin: parseOrigin(env.ADMIN_ORIGIN?.trim() || required(env, 'WEB_ORIGIN'), 'ADMIN_ORIGIN'),
    trustProxy: env.TRUST_PROXY === 'true',
    production,
    secureCookies: production,
    logLevel: env.LOG_LEVEL ?? 'info',
    timezone: parseTimezone(required(env, 'MARKET_TIMEZONE')),
    city: parseCity(env.MARKET_CITY, required(env, 'MARKET_TIMEZONE')),
    uploadDir: resolve(env.UPLOAD_DIR?.trim() || '.uploads'),
    twilio,
    stripe: parseStripe(env, production),
    smtp: parseSmtp(env),
    push: parsePush(env),
  };
}
