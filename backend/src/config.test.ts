import { loadConfig } from './config.js';

const base = {
  DATABASE_URL: 'postgres://localhost/misk',
  WEB_ORIGIN: 'http://localhost:5173',
  MARKET_TIMEZONE: 'Europe/Berlin',
};
const twilio = { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'token', TWILIO_FROM_NUMBER: '+4915112345678' };
const stripe = { STRIPE_SECRET_KEY: 'sk_test_1', STRIPE_PUBLISHABLE_KEY: 'pk_test_1', STRIPE_WEBHOOK_SECRET: 'whsec_1' };

describe('loadConfig', () => {
  it('reads a minimal development setup', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({ port: 3000, production: false, secureCookies: false, twilio: null, stripe: null });
    expect(config.timezone).toBe('Europe/Berlin');
  });

  it('requires the database, origin and time zone', () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: '' })).toThrow('DATABASE_URL is required');
    expect(() => loadConfig({ ...base, WEB_ORIGIN: undefined })).toThrow('WEB_ORIGIN is required');
    expect(() => loadConfig({ ...base, MARKET_TIMEZONE: undefined })).toThrow('MARKET_TIMEZONE is required');
  });

  it('refuses a malformed origin, port or time zone', () => {
    expect(() => loadConfig({ ...base, WEB_ORIGIN: 'http://localhost:5173/app' })).toThrow('exact http or https origin');
    expect(() => loadConfig({ ...base, PORT: '70000' })).toThrow('PORT must be a port number');
    expect(() => loadConfig({ ...base, MARKET_TIMEZONE: 'Mars/Olympus' })).toThrow('IANA time zone');
  });

  it('accepts Stripe test keys and refuses partial or mismatched ones', () => {
    expect(loadConfig({ ...base, ...stripe }).stripe).toEqual({
      secretKey: 'sk_test_1',
      publishableKey: 'pk_test_1',
      webhookSecret: 'whsec_1',
    });
    expect(() => loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_1' })).toThrow('must be set together');
    expect(() => loadConfig({ ...base, ...stripe, STRIPE_PUBLISHABLE_KEY: 'nope' })).toThrow('must start with');
    expect(() => loadConfig({ ...base, ...stripe, STRIPE_WEBHOOK_SECRET: 'nope' })).toThrow('whsec_');
    expect(() => loadConfig({ ...base, ...stripe, STRIPE_PUBLISHABLE_KEY: 'pk_live_1' })).toThrow('both be live keys');
  });

  it('only allows live Stripe keys in production', () => {
    const live = { STRIPE_SECRET_KEY: 'sk_live_1', STRIPE_PUBLISHABLE_KEY: 'pk_live_1', STRIPE_WEBHOOK_SECRET: 'whsec_1' };
    expect(() => loadConfig({ ...base, ...live })).toThrow('only be used with NODE_ENV=production');
    expect(loadConfig({ ...base, ...live, ...twilio, NODE_ENV: 'production' }).stripe?.secretKey).toBe('sk_live_1');
  });

  it('requires Twilio in production so sign-in codes can be delivered', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow('Twilio settings are required');
    const config = loadConfig({ ...base, ...twilio, NODE_ENV: 'production' });
    expect(config.secureCookies).toBe(true);
    expect(() => loadConfig({ ...base, TWILIO_ACCOUNT_SID: 'AC1' })).toThrow('must be set together');
    expect(() => loadConfig({ ...base, ...twilio, TWILIO_FROM_NUMBER: '0151' })).toThrow('international number');
  });
});
