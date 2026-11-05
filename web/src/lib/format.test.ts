import { loadConfig } from '../config';
import { dateTime, dayKey, euro, isoWeekday, parseEuroToCents, sizePrice, time } from './format';

describe('format', () => {
  it('shows euros without needless cents', () => {
    expect(euro(4550)).toBe('€45.50');
    expect(euro(4500)).toBe('€45');
  });

  it('shows times in the market time zone, not the browser one', () => {
    const iso = '2026-11-05T09:00:00.000Z';
    expect(time(iso, 'Europe/Berlin')).toBe('10:00');
    expect(time(iso, 'Europe/London')).toBe('09:00');
    expect(dateTime(iso, 'Europe/Berlin')).toBe('Thu 5 Nov, 10:00');
    expect(dayKey('2026-11-05T23:30:00.000Z', 'Europe/Berlin')).toBe('2026-11-06');
    expect(isoWeekday('2026-11-05T23:30:00.000Z', 'Europe/Berlin')).toBe(5);
  });

  it('parses euro amounts typed with a dot or a comma', () => {
    expect(parseEuroToCents('20')).toBe(2000);
    expect(parseEuroToCents('19,50')).toBe(1950);
    expect(parseEuroToCents(' 0.05 ')).toBe(5);
    expect(parseEuroToCents('12.345')).toBeNull();
    expect(parseEuroToCents('-3')).toBeNull();
    expect(parseEuroToCents('ten')).toBeNull();
  });

  it('prices sizes like the API', () => {
    const service = { priceCents: 3500, sizeSmallPct: 100, sizeMediumPct: 130, sizeLargePct: 170 };
    expect([sizePrice(service, 'S'), sizePrice(service, 'M'), sizePrice(service, 'L')]).toEqual([3500, 4550, 5950]);
  });
});

describe('loadConfig', () => {
  it('needs an absolute API address', () => {
    expect(loadConfig({ VITE_API_BASE_URL: 'https://api.misk.app/' })).toEqual({
      site: 'app',
      apiBaseUrl: 'https://api.misk.app',
      termsUrl: null,
      privacyUrl: null,
    });
    expect(() => loadConfig({})).toThrow('VITE_API_BASE_URL is required');
    expect(() => loadConfig({ VITE_API_BASE_URL: '/api' })).toThrow('absolute URL');
    expect(() => loadConfig({ VITE_API_BASE_URL: 'ftp://x' })).toThrow('http or https');
  });

  it('builds the control panel in admin mode', () => {
    expect(loadConfig({ VITE_API_BASE_URL: 'https://a.b', MODE: 'admin' }).site).toBe('admin');
    expect(loadConfig({ VITE_API_BASE_URL: 'https://a.b', MODE: 'production' }).site).toBe('app');
  });

  it('checks the optional legal links', () => {
    expect(loadConfig({ VITE_API_BASE_URL: 'https://a.b', VITE_TERMS_URL: 'https://misk.app/terms' }).termsUrl).toBe(
      'https://misk.app/terms',
    );
    expect(() => loadConfig({ VITE_API_BASE_URL: 'https://a.b', VITE_PRIVACY_URL: 'javascript:alert(1)' })).toThrow();
  });
});
