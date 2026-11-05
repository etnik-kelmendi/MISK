import type { Frequency, JobSize } from '../api/types';

/** Average visits a month, as the API counts them. */
export const VISITS_PER_MONTH: Record<Frequency, number> = {
  every_2_weeks: 2.2,
  weekly: 4.3,
  twice_weekly: 8.7,
  three_times_weekly: 13,
};

/** How many weekdays the customer picks for each frequency. */
export const DAYS_PER_WEEK: Record<Frequency, number> = {
  every_2_weeks: 1,
  weekly: 1,
  twice_weekly: 2,
  three_times_weekly: 3,
};

/** Plan prices are for a medium home or garden: small 15% less, large 35% more (same rule as the API). */
export function planSizePrice(priceCents: number, size: JobSize): number {
  return Math.round((priceCents * { S: 85, M: 100, L: 135 }[size]) / 100);
}

/** The month (1–12) it is now in the market time zone. */
export function currentMonth(timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone, month: 'numeric' }).format(new Date()));
}
