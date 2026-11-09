import type { BookingDeps } from '../bookings/events.js';
import { addDays, marketToday } from '../pros/checks.js';

export const PAYOUT_INTERVALS = ['weekly', 'biweekly', 'monthly'] as const;
export type PayoutInterval = (typeof PAYOUT_INTERVALS)[number];

/** Every-two-weeks payouts fall on the Fridays an even number of weeks after this one. */
const BIWEEKLY_ANCHOR = '2026-01-02';
const FRIDAY = 5;

function weekday(day: string): number {
  const iso = new Date(`${day}T12:00:00Z`).getUTCDay();
  return iso === 0 ? 7 : iso;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

/**
 * The next day the pro's money goes to their bank, on or after `today` ("YYYY-MM-DD"): the next Friday,
 * every other Friday, or the 1st of the month. Stripe usually needs a working day to show it in the bank.
 */
export function nextPayoutDate(interval: PayoutInterval, today: string): string {
  if (interval === 'monthly') {
    return today.endsWith('-01') ? today : `${addMonth(today)}-01`;
  }
  const toFriday = (FRIDAY - weekday(today) + 7) % 7;
  const friday = addDays(today, toFriday);
  if (interval === 'weekly') {
    return friday;
  }
  const weeksFromAnchor = Math.round(daysBetween(BIWEEKLY_ANCHOR, friday) / 7);
  return weeksFromAnchor % 2 === 0 ? friday : addDays(friday, 7);
}

function addMonth(day: string): string {
  const [year, month] = day.split('-').map(Number) as [number, number];
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
}

/** Stripe's schedule for an interval: Stripe has no "every two weeks", so MISK starts those payouts. */
export const stripeScheduleOf = (interval: PayoutInterval) => (interval === 'biweekly' ? 'manual' : interval);

/**
 * Brings every pro's Stripe payout schedule in line with Settings, a few accounts at a time, and on
 * every-two-weeks Fridays pays their balance out. Safe to run on several servers: setting a schedule twice
 * changes nothing, and each day's manual payout is claimed in the database before it is started (and
 * Stripe's idempotency key stops a repeat). Returns how many accounts it touched.
 */
export async function payoutScheduleTick(deps: BookingDeps): Promise<number> {
  const setting = await deps.pool.query<{ interval: PayoutInterval }>('SELECT payout_interval AS interval FROM settings');
  const interval = setting.rows[0]?.interval ?? 'weekly';
  const due = await deps.pool.query<{ user_id: string; stripe_account_id: string }>(
    `SELECT user_id, stripe_account_id FROM pro_profiles
     WHERE stripe_account_id IS NOT NULL AND payout_schedule IS DISTINCT FROM $1
     ORDER BY user_id LIMIT 25`,
    [interval],
  );
  let touched = 0;
  for (const pro of due.rows) {
    try {
      await deps.gateway.setPayoutSchedule(pro.stripe_account_id, stripeScheduleOf(interval));
      await deps.pool.query('UPDATE pro_profiles SET payout_schedule = $2 WHERE user_id = $1', [pro.user_id, interval]);
      touched += 1;
    } catch (error) {
      deps.log.error({ event: 'payout_schedule_failed', proId: pro.user_id, err: error });
    }
  }

  const today = marketToday(deps.config.timezone);
  if (interval === 'biweekly' && nextPayoutDate('biweekly', today) === today) {
    const pros = await deps.pool.query<{ user_id: string; stripe_account_id: string }>(
      `UPDATE pro_profiles SET last_manual_payout_on = $1::date
       WHERE user_id IN (
         SELECT user_id FROM pro_profiles
         WHERE stripe_account_id IS NOT NULL AND payouts_enabled AND payout_schedule = 'biweekly'
           AND last_manual_payout_on IS DISTINCT FROM $1::date
         LIMIT 25 FOR UPDATE SKIP LOCKED)
       RETURNING user_id, stripe_account_id`,
      [today],
    );
    for (const pro of pros.rows) {
      try {
        const amount = await deps.gateway.payOutBalance(pro.stripe_account_id, `payout-${pro.user_id}-${today}`);
        deps.log.info({ event: 'manual_payout_started', proId: pro.user_id, amountCents: amount });
        touched += 1;
      } catch (error) {
        // Try again on the next pass of the same day.
        await deps.pool.query('UPDATE pro_profiles SET last_manual_payout_on = NULL WHERE user_id = $1', [pro.user_id]);
        deps.log.error({ event: 'manual_payout_failed', proId: pro.user_id, err: error });
      }
    }
  }
  return touched;
}
