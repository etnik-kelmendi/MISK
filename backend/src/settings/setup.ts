import type { Config } from '../config.js';
import type { Queryable } from '../db.js';

/**
 * Optional production settings and what goes missing without them (D98). The API logs one warning listing the
 * missing ones when it starts, and the control panel's Setup checklist shows which are set: yes or no only,
 * never a value.
 */
export const SETUP_KEYS = ['support_email', 'support_phone', 'email_sender', 'sms_sender', 'push', 'stripe_webhook'] as const;
export type SetupKey = (typeof SETUP_KEYS)[number];

/** The environment variables behind each item and what is affected while they are missing, for the log. */
const SETUP_ITEMS: Record<SetupKey, { variables: string; effect: string }> = {
  support_email: { variables: 'SUPPORT_EMAIL', effect: 'the "Email us" contact buttons are hidden and pro issue alerts have no fallback address' },
  support_phone: { variables: 'SUPPORT_PHONE', effect: 'the "Call us" contact buttons are hidden' },
  email_sender: {
    variables: 'SMTP_HOST, SMTP_USER, SMTP_PASSWORD, MAIL_FROM',
    effect: 'no email is sent (sign-up confirmations, password recovery, alerts): notifications reach people in the app only',
  },
  sms_sender: {
    variables: 'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER',
    effect: 'no text is sent: sign-in codes are written to this log and notifications reach people in the app only',
  },
  push: { variables: 'VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT', effect: 'push messages are kept as not sent' },
  stripe_webhook: { variables: 'STRIPE_WEBHOOK_SECRET', effect: 'payments and plan sign-ups are never confirmed' },
};

export interface SetupItem {
  key: SetupKey;
  set: boolean;
}

type SetupConfig = Pick<Config, 'support' | 'smtp' | 'twilio' | 'push' | 'stripe'>;

/** Which optional settings are set; never their values. */
export function setupChecklist(config: SetupConfig): SetupItem[] {
  const set: Record<SetupKey, boolean> = {
    support_email: Boolean(config.support.email),
    support_phone: Boolean(config.support.phone),
    email_sender: config.smtp !== null,
    sms_sender: config.twilio !== null,
    push: config.push !== null,
    stripe_webhook: Boolean(config.stripe?.webhookSecret),
  };
  return SETUP_KEYS.map((key) => ({ key, set: set[key] }));
}

/** One warning naming every missing setting and what it affects, or null when everything is set. */
export function missingSettingsWarning(config: SetupConfig): string | null {
  const missing = setupChecklist(config).filter((item) => !item.set);
  if (missing.length === 0) {
    return null;
  }
  const lines = missing.map(({ key }) => `- ${SETUP_ITEMS[key].variables}: ${SETUP_ITEMS[key].effect}`);
  return `Optional settings are missing; set them before going live:\n${lines.join('\n')}`;
}

/** Whether a pro's issue report can reach anyone by email: a team member's own address, or SUPPORT_EMAIL (D94, D98). */
export async function issueAlertsEmailable(db: Queryable, supportEmail: string | null): Promise<boolean> {
  if (supportEmail) {
    return true;
  }
  const found = await db.query("SELECT 1 FROM users WHERE role = 'admin' AND disabled_at IS NULL AND email IS NOT NULL LIMIT 1");
  return Boolean(found.rowCount);
}
