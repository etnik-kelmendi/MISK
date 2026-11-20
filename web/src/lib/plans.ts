import type { TFunction } from 'i18next';
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

/** The plan rules every customer sees (D77): the minimum term with 30 days' notice after it, and the pause rules (0 weeks: no pauses; 0 days: no notice needed, D85). */
export function planRuleTexts(
  t: TFunction,
  rules: { minTermMonths: number; pauseNoticeDays: number; maxPauseWeeks: number },
): { term: string; pause: string } {
  return {
    term: t('planRules.term', { count: rules.minTermMonths }),
    pause:
      rules.maxPauseWeeks === 0
        ? t('planRules.pauseNotAllowed')
        : t('planRules.pause', {
            count: rules.maxPauseWeeks,
            notice: rules.pauseNoticeDays === 0 ? t('planRules.noticeNone') : t('planRules.notice', { count: rules.pauseNoticeDays }),
          }),
  };
}

const DAY_MS = 24 * 3600 * 1000;

/** A calendar day ('YYYY-MM-DD') plus `days` days. */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from one calendar day to another. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** Whether text is a real calendar day 'YYYY-MM-DD'. */
export function isCalendarDay(value: string): boolean {
  const at = Date.parse(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(at) && new Date(at).toISOString().startsWith(value);
}
