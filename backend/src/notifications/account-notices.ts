import type { SupportContact } from '../config.js';

/**
 * What MISK tells a person about their own account (D87): suspended, active again, closed, and changes to
 * their phone number. Each notice has a short text (SMS, push, the inbox in the app) and a longer email.
 * A suspended person cannot open the app, so these go out by text AND email wherever possible.
 */
export interface Notice {
  text: string;
  email: { subject: string; text: string };
}

/** What a suspension or closing ended: counted after the bookings and plans were cancelled. */
export interface EndedWork {
  /** Upcoming bookings the person made as a customer, now cancelled. */
  bookings: number;
  /** Monthly plans the person had as a customer, now ended. */
  plans: number;
  /** For a pro: whether their upcoming jobs and regular customers were handed to other pros. */
  proWorkHandedOver: boolean;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "help@misk.app or +4930123456", or null when the team set no contact. */
export function supportLine(support: SupportContact): string | null {
  const ways = [support.email, support.phone].filter((way): way is string => Boolean(way));
  return ways.length ? ways.join(' or ') : null;
}

function contactSentence(support: SupportContact): string {
  const line = supportLine(support);
  return line ? `Questions? Contact the MISK team at ${line}.` : 'Questions? Please contact the MISK team.';
}

function endedWorkSentence(work: EndedWork | null): string | null {
  if (!work) return null;
  const parts: string[] = [];
  if (work.bookings > 0) parts.push(`${plural(work.bookings, 'upcoming booking was', 'upcoming bookings were')} cancelled`);
  if (work.plans > 0) parts.push(`${plural(work.plans, 'plan has', 'plans have')} ended`);
  const sentences: string[] = [];
  if (parts.length) sentences.push(`${capitalize(parts.join(' and '))}; any money held on your card is released.`);
  if (work.proWorkHandedOver) sentences.push('Your upcoming jobs go to other pros.');
  return sentences.length ? sentences.join(' ') : null;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function greeting(firstName: string | null): string {
  return `Hello ${firstName?.trim() || 'there'},`;
}

function email(subject: string, firstName: string | null, paragraphs: (string | null)[]): Notice['email'] {
  return {
    subject,
    text: [greeting(firstName), ...paragraphs.filter((p): p is string => Boolean(p)), 'The MISK team'].join('\n\n'),
  };
}

export function suspendedNotice(input: { firstName: string | null; work: EndedWork | null; note: string | null; support: SupportContact }): Notice {
  const work = endedWorkSentence(input.work);
  const note = input.note ? `Message from the MISK team: ${input.note}` : null;
  const contact = contactSentence(input.support);
  return {
    text: ['MISK: your account is suspended, so you cannot sign in for now.', work, note, contact].filter(Boolean).join(' '),
    email: email('Your MISK account is suspended', input.firstName, [
      'The MISK team has suspended your account. While it is suspended you cannot sign in to the MISK app.',
      work,
      note,
      `${contact} We will tell you as soon as your account is active again.`,
    ]),
  };
}

export function reinstatedNotice(input: { firstName: string | null; support: SupportContact }): Notice {
  return {
    text: 'MISK: your account is active again. You can sign in as before.',
    email: email('Your MISK account is active again', input.firstName, [
      'Good news: your MISK account is active again. You can sign in to the MISK app as before.',
      'Bookings and plans that were cancelled while it was suspended stay cancelled; you can book again at any time.',
      contactSentence(input.support),
    ]),
  };
}

export function closedNotice(input: { firstName: string | null; support: SupportContact }): Notice {
  return {
    text: `MISK: your account has been closed by the MISK team. Upcoming bookings and plans are cancelled and any held money released. ${contactSentence(input.support)}`,
    email: email('Your MISK account has been closed', input.firstName, [
      'The MISK team has closed your MISK account. You can no longer sign in with it, and your name, phone number and email address are removed from it.',
      'Upcoming bookings and plans are cancelled, and any money held on your card is released. Past bookings and payments are kept for our records, as the law requires.',
      contactSentence(input.support),
    ]),
  };
}

/** The last digits only, so a notice never spells out a whole number. */
export function maskPhone(phone: string): string {
  return `…${phone.slice(-4)}`;
}

export type PhoneChange = 'phone_added' | 'phone_changed' | 'phone_removed';

/** Sent by email (and to the inbox) when the phone number of an account changes, so a stranger's change is noticed. */
export function phoneChangedNotice(input: { change: PhoneChange; phone: string | null; firstName: string | null; support: SupportContact }): Notice {
  const notMe = `If this was not you, contact the MISK team${supportLine(input.support) ? ` at ${supportLine(input.support)}` : ''} at once.`;
  const masked = input.phone ? maskPhone(input.phone) : '';
  const what =
    input.change === 'phone_removed'
      ? 'The phone number was removed from your MISK account. You sign in with your email and password, and we no longer text you.'
      : input.change === 'phone_added'
        ? `The phone number ending ${masked} was added to your MISK account. You can now also sign in with it, and we text you about your bookings.`
        : `The phone number of your MISK account was changed to the one ending ${masked}. You now sign in with it, and we text you there.`;
  return {
    text: `MISK: ${what.charAt(0).toLowerCase()}${what.slice(1)} ${notMe}`,
    email: email('The phone number of your MISK account', input.firstName, [what, notMe]),
  };
}

/** "j***@example.com": the first character and the domain, so a notice never spells out a whole address. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email.charAt(0)}***${email.slice(at)}`;
}

function notMeSentence(support: SupportContact): string {
  const line = supportLine(support);
  return `If this wasn't you, contact support${line ? ` at ${line}` : ''} at once.`;
}

/**
 * Sent to the account's current email (or by text when it has none) as soon as someone asks to change the
 * email, before it applies (D97), so a stranger with a borrowed session is noticed in time.
 */
export function emailChangeStartedNotice(input: { newEmail: string; hadEmail: boolean; firstName: string | null; support: SupportContact }): Notice {
  const masked = maskEmail(input.newEmail);
  const what = input.hadEmail
    ? `Your MISK email is being changed to ${masked}. The change applies once the new address is confirmed.`
    : `The email ${masked} is being added to your MISK account. It is added once the address is confirmed.`;
  const notMe = notMeSentence(input.support);
  return {
    text: `MISK: ${what} ${notMe}`,
    email: email('Your MISK email is being changed', input.firstName, [what, notMe]),
  };
}

/** Sent to the old address (or by text) once the new email is confirmed and applies (D97). */
export function emailChangedNotice(input: { newEmail: string; hadEmail: boolean; firstName: string | null; support: SupportContact }): Notice {
  const masked = maskEmail(input.newEmail);
  const what = input.hadEmail
    ? `The email of your MISK account is now ${masked}. From now on you log in and get our emails there, not at this address.`
    : `The email ${masked} is now on your MISK account. You can log in with it, and we send our emails there.`;
  const notMe = notMeSentence(input.support);
  return {
    text: `MISK: ${what} ${notMe}`,
    email: email('The email of your MISK account changed', input.firstName, [what, notMe]),
  };
}

/** The goodbye when a person deletes their own account (D97), sent while the phone and email are still there. */
export function selfClosedNotice(input: { firstName: string | null; support: SupportContact }): Notice {
  return {
    text: `MISK: your account is deleted, as you asked. Thank you for using MISK. ${contactSentence(input.support)}`,
    email: email('Your MISK account is deleted', input.firstName, [
      'Your MISK account is deleted, as you asked. You can no longer log in with it. Your profile, saved addresses and payment methods are removed.',
      'Upcoming bookings are cancelled, and any money held on your card is released. Receipts are kept for 7 years because the law requires it, without your name or contact details.',
      'You are welcome to sign up again at any time with the same phone number or email.',
      contactSentence(input.support),
    ]),
  };
}
