import type { TFunction } from 'i18next';
import type { Frequency, JobSize, PlanStart, PublicPlan } from '../api/types';

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

/** At most this many skipped visits per calendar month of a plan (D90); the server enforces the same. */
export const SKIPS_PER_MONTH = 2;

/** Skips and moves are possible until this long before a visit (D77, D90); the server checks the same. */
export const CHANGE_NOTICE_HOURS = 24;

/** Whether a visit can still be skipped, moved or have its skip undone: more than 24 hours ahead. */
export function changeable(startsAt: string, now: number = Date.now()): boolean {
  return new Date(startsAt).getTime() - now >= CHANGE_NOTICE_HOURS * 3600 * 1000;
}

/** The Plan builder's Start choices (D90): the first visit is on a chosen day from tomorrow plus this many days. */
export const START_OFFSET_DAYS: Record<PlanStart, number> = { asap: 0, next_week: 7, in_2_weeks: 14 };
/** Visits are planned this far ahead, so the first visit falls within it (as on the server). */
export const PLANNING_DAYS = 28;

/** Today in the market time zone, 'YYYY-MM-DD'. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The ISO weekday of a calendar day: 1 is Monday, 7 is Sunday. */
export function isoWeekday(day: string): number {
  return ((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

/**
 * The first visit's day for the builder's choices, by the server's rule (D90): the first chosen weekday from
 * tomorrow plus the Start option's days, in season, within the planning window. Null when there is none.
 */
export function firstVisitDay(
  today: string,
  start: PlanStart,
  days: number[],
  season: { seasonal: boolean; seasonFrom: number | null; seasonTo: number | null },
): string | null {
  if (days.length === 0) return null;
  for (let offset = 1 + START_OFFSET_DAYS[start]; offset <= PLANNING_DAYS; offset += 1) {
    const day = addDays(today, offset);
    const month = Number(day.slice(5, 7));
    const inSeason = !season.seasonal || (month >= (season.seasonFrom ?? 1) && month <= (season.seasonTo ?? 12));
    if (days.includes(isoWeekday(day)) && inSeason) return day;
  }
  return null;
}

/** The months a plan runs: "April – October" for a seasonal plan, else "All year". */
export function seasonText(t: TFunction, plan: { seasonal: boolean; seasonFrom: number | null; seasonTo: number | null }): string {
  if (!plan.seasonal) return t('plans.allYear');
  const month = (m: number) => new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' }).format(Date.UTC(2026, m - 1, 15));
  return t('plans.season', { from: month(plan.seasonFrom ?? 1), to: month(plan.seasonTo ?? 12) });
}

/** What the customer pays a month: the server's price for the frequency and size (from /plans), plus the extra. */
export function builderPrice(plan: PublicPlan, choice: { frequency: Frequency; size: JobSize; withAddon: boolean }): number {
  return plan.prices[choice.frequency][choice.size] + (choice.withAddon ? (plan.addonPriceCents ?? 0) : 0);
}
