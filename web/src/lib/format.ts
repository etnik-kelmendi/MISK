/** Formatting for money and times. Times are always shown in the market's time zone. */

const LOCALE = 'en-GB';

export function euro(cents: number): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat(LOCALE, {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

/** "Tue 5 Nov, 10:00" */
export function dateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

/** "10:00" */
export function time(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
    new Date(iso),
  );
}

/** A calendar day key in the market time zone, e.g. "2026-11-05", for grouping. */
export function dayKey(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(iso),
  );
  return parts;
}

/** "Tue" and "5" for a day button. */
export function dayParts(iso: string, timeZone: string): { weekday: string; day: string; month: string } {
  const date = new Date(iso);
  const part = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(LOCALE, { timeZone, ...options }).format(date);
  return { weekday: part({ weekday: 'short' }), day: part({ day: 'numeric' }), month: part({ month: 'short' }) };
}

/** Parses "12.50" or "12,50" euros into cents; null when it is not a valid amount. */
export function parseEuroToCents(input: string): number | null {
  const normalized = input.trim().replace(',', '.');
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(normalized)) {
    return null;
  }
  return Math.round(Number(normalized) * 100);
}

export function sizePrice(service: { priceCents: number; sizeSmallPct: number; sizeMediumPct: number; sizeLargePct: number }, size: 'S' | 'M' | 'L') {
  const pct = { S: service.sizeSmallPct, M: service.sizeMediumPct, L: service.sizeLargePct }[size];
  return Math.round((service.priceCents * pct) / 100);
}

/** ISO weekday 1–7 of an instant in the market time zone. */
export function isoWeekday(iso: string, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(iso));
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(name) + 1;
}
