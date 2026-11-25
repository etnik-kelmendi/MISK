import type { BookingDeps } from '../bookings/events.js';
import type { Config } from '../config.js';
import { withTransaction, type Queryable } from '../db.js';
import { enqueue } from '../notifications/outbox.js';
import { addDays, EXPIRY_WARNING_DAYS, marketToday, type DocumentKind } from './checks.js';
import { DOCUMENT_NAMES, logProAction } from './management.js';

/** The first automatic reminder goes this many days before a document runs out (D59). */
export const DOCUMENT_REMINDER_DAYS = EXPIRY_WARNING_DAYS;
/** The second, last reminder goes this many days before (D100). */
export const LAST_REMINDER_DAYS = 7;
/** Both reminders, each sent once per cover date. */
export const REMINDER_STAGES = [DOCUMENT_REMINDER_DAYS, LAST_REMINDER_DAYS] as const;
/** Reminders go out in the daytime only, in the market's time zone: from 9:00 to before 20:00. */
export const REMINDER_HOURS = { from: 9, until: 20 } as const;

/** "2026-12-05" as people read it: "5 Dec 2026". */
export function readableDay(day: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${day}T00:00:00Z`),
  );
}

/** The short text for the app, push and (as a last resort) SMS. */
export function expiringText(documentName: string, day: string): string {
  return (
    `MISK: your ${documentName} runs out on ${readableDay(day)}. Please upload the new one in the app before then. ` +
    'Once it has run out, you get no new jobs until the new one is accepted.'
  );
}

/** The email: which document, when it runs out, what to do, and what happens if nothing is done. */
export function expiringEmail(firstName: string | null, documentName: string, day: string, profileLink: string) {
  const date = readableDay(day);
  return {
    subject: `Your ${documentName} runs out on ${date}`,
    text: [
      `Hello ${firstName?.trim() || 'there'},`,
      '',
      `your ${documentName} runs out on ${date}.`,
      '',
      // Plain characters only: some databases (e.g. a Windows dev database in WIN1252) cannot store an arrow.
      `Please upload the new ${documentName} in the MISK app before then, in your Profile under Documents:`,
      profileLink,
      '',
      'Once it has run out, you get no new jobs until we have checked and accepted the new one. Jobs you already have are not affected.',
      '',
      'Thank you,',
      'The MISK team',
    ].join('\n'),
  };
}

/**
 * Tells a pro that a document runs out soon: in the app, by push on every device where they turned it on,
 * and by email. A pro with neither push nor an email address gets a text message instead, so the reminder
 * always reaches them.
 */
export async function sendExpiringReminder(
  db: Queryable,
  config: Pick<Config, 'webOrigin'>,
  proId: string,
  kind: DocumentKind,
  validUntil: string,
): Promise<boolean> {
  const person = await db.query<{ firstName: string | null; email: string | null; devices: number }>(
    `SELECT first_name AS "firstName", email, (SELECT count(*)::int FROM push_subscriptions s WHERE s.user_id = u.id) AS devices
     FROM users u WHERE u.id = $1`,
    [proId],
  );
  const pro = person.rows[0];
  if (!pro) {
    return false;
  }
  const name = DOCUMENT_NAMES[kind];
  return enqueue(db, proId, 'document_expiring', expiringText(name, validUntil), {
    channels: { push: true, email: true, sms: pro.devices === 0 && !pro.email },
    email: expiringEmail(pro.firstName, name, validUntil, `${config.webOrigin}/pro/profile/documents`),
  });
}

function marketHour(timezone: string, now: Date): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }).format(now)) % 24;
}

/**
 * Sends the reminders for every document of an active or pending pro: one when its cover runs out within
 * DOCUMENT_REMINDER_DAYS days, and a last one within LAST_REMINDER_DAYS days (D100), each once per cover date.
 * A document first seen inside the last 7 days gets only the last reminder, never two at once. A document whose
 * new copy is already waiting for the team's check is skipped: the pro has done their part. Safe to run often
 * and on several servers. Returns how many reminders were sent.
 */
export async function documentReminderTick(deps: Pick<BookingDeps, 'pool' | 'config' | 'log'>, now = new Date()): Promise<number> {
  const hour = marketHour(deps.config.timezone, now);
  if (hour < REMINDER_HOURS.from || hour >= REMINDER_HOURS.until) {
    return 0;
  }
  const today = marketToday(deps.config.timezone, now);
  const due = await deps.pool.query<{ proId: string; kind: DocumentKind; validUntil: string; stage: number }>(
    `SELECT d.pro_id AS "proId", d.kind, d.valid_until::text AS "validUntil",
       CASE WHEN d.valid_until <= $3::date THEN ${LAST_REMINDER_DAYS} ELSE ${DOCUMENT_REMINDER_DAYS} END AS stage
     FROM pro_documents d JOIN pro_profiles p ON p.user_id = d.pro_id
     WHERE p.status IN ('approved', 'pending_approval')
       AND d.review_status <> 'pending'
       AND d.valid_until >= $1::date AND d.valid_until <= $2::date AND d.valid_until <> 'infinity'
       AND NOT EXISTS (
         SELECT 1 FROM document_reminders r WHERE r.pro_id = d.pro_id AND r.kind = d.kind AND r.valid_until = d.valid_until
           AND r.days_before = CASE WHEN d.valid_until <= $3::date THEN ${LAST_REMINDER_DAYS} ELSE ${DOCUMENT_REMINDER_DAYS} END
       )
     ORDER BY d.valid_until`,
    [today, addDays(today, DOCUMENT_REMINDER_DAYS), addDays(today, LAST_REMINDER_DAYS)],
  );
  let sent = 0;
  for (const doc of due.rows) {
    const claimed = await withTransaction(deps.pool, async (client) => {
      // Claimed first, so two servers never send the same reminder twice.
      const inserted = await client.query(
        `INSERT INTO document_reminders (pro_id, kind, valid_until, days_before) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [doc.proId, doc.kind, doc.validUntil, doc.stage],
      );
      if (!inserted.rowCount) {
        return false;
      }
      await sendExpiringReminder(client, deps.config, doc.proId, doc.kind, doc.validUntil);
      await logProAction(client, doc.proId, null, 'reminder_sent', {
        document: doc.kind,
        state: 'expiring',
        automatic: true,
        daysBefore: doc.stage,
      });
      return true;
    });
    if (claimed) {
      sent += 1;
      deps.log.info({ event: 'document_reminder_sent', proId: doc.proId, document: doc.kind, validUntil: doc.validUntil, daysBefore: doc.stage });
    }
  }
  return sent;
}
