/**
 * Calendar days as "YYYY-MM-DD" text (D101). The days are counted on the calendar at noon UTC, so a clock
 * change never moves a date, and text comparison orders them like dates.
 */

import { displayLocale } from './locale';

const DAY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

/** True for text shaped like "2026-11-25". */
export function isDay(value: string): boolean {
  return DAY_FORMAT.test(value);
}

function noon(day: string): Date {
  return new Date(`${day}T12:00:00Z`);
}

/** The day `count` days after `day` (before it when negative). */
export function addDays(day: string, count: number): string {
  const date = noon(day);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

/** How many days `later` is after `earlier`. */
export function daysBetween(earlier: string, later: string): number {
  return Math.round((noon(later).getTime() - noon(earlier).getTime()) / 86_400_000);
}

/** The month of a day, "YYYY-MM". */
export function monthOf(day: string): string {
  return day.slice(0, 7);
}

/** The month `count` months after "YYYY-MM". */
export function addMonths(month: string, count: number): string {
  const [year = 0, number = 1] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, number - 1 + count, 1, 12));
  return date.toISOString().slice(0, 7);
}

/** 1 for Monday to 7 for Sunday. */
export function isoWeekday(day: string): number {
  return ((noon(day).getUTCDay() + 6) % 7) + 1;
}

/**
 * The weeks of a month, Monday first, as rows of seven: a day of the month, or null for the cells before the
 * first and after the last day.
 */
export function monthWeeks(month: string): (string | null)[][] {
  const first = `${month}-01`;
  const cells: (string | null)[] = Array.from({ length: isoWeekday(first) - 1 }, () => null);
  for (let day = first; monthOf(day) === month; day = addDays(day, 1)) {
    cells.push(day);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let index = 0; index < cells.length; index += 7) {
    weeks.push(cells.slice(index, index + 7));
  }
  return weeks;
}

/** Formats a calendar day in the app's language (D110), e.g. { weekday: 'long', day: 'numeric', month: 'long' }. */
export function formatDay(day: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(displayLocale(), { timeZone: 'UTC', ...options }).format(noon(day));
}

/** "Wednesday 14 January". */
export function longDayName(day: string): string {
  return formatDay(day, { weekday: 'long', day: 'numeric', month: 'long' });
}

/** "November 2026" for "2026-11". */
export function monthName(month: string): string {
  return formatDay(`${month}-01`, { month: 'long', year: 'numeric' });
}

/** The seven weekdays, Monday first: short ("Mon") and long ("Monday") names. */
export const WEEKDAYS: { short: string; long: string }[] = Array.from({ length: 7 }, (_, index) => {
  // 2024-01-01 was a Monday.
  const day = addDays('2024-01-01', index);
  return { short: formatDay(day, { weekday: 'short' }), long: formatDay(day, { weekday: 'long' }) };
});

/** The Monday of the week `day` is in: the week row of Choose time shows Monday to Sunday, like the calendar. */
export function weekStart(day: string): string {
  return addDays(day, 1 - isoWeekday(day));
}

/**
 * The month label of the week starting on Monday `monday`: "November 2026", or both months when the week
 * spans two, "Nov – Dec 2026", with both years when it spans two years, "Dec 2026 – Jan 2027".
 */
export function weekMonths(monday: string): string {
  const sunday = addDays(monday, 6);
  if (monthOf(monday) === monthOf(sunday)) return monthName(monthOf(monday));
  const end = formatDay(sunday, { month: 'short', year: 'numeric' });
  const sameYear = monday.slice(0, 4) === sunday.slice(0, 4);
  return `${formatDay(monday, sameYear ? { month: 'short' } : { month: 'short', year: 'numeric' })} – ${end}`;
}
