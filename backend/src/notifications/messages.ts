/** Text message bodies. Kept short: one SMS segment holds 160 characters. */

export function formatSlot(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

export function formatEuro(cents: number): string {
  return `€${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

export const messages = {
  signInCode: (code: string) => `${code} is your MISK code. It works for 10 minutes. Never share it.`,
  jobOffer: (service: string, when: string, earnCents: number) =>
    `MISK: new job, ${service} on ${when}. You earn ${formatEuro(earnCents)}. Open the app within 15 minutes to accept.`,
  assignedByTeam: (service: string, when: string) =>
    `MISK: the team gave you a job, ${service} on ${when}. See the app for details.`,
  bookingConfirmed: (service: string, when: string) =>
    `MISK: your ${service} on ${when} is booked. We are finding your pro now.`,
  proAssigned: (service: string, when: string, proName: string) =>
    `MISK: ${proName} will do your ${service} on ${when}.`,
  proOnTheWay: (proName: string) => `MISK: ${proName} is on the way to you.`,
  jobCompleted: (service: string) => `MISK: your ${service} is done. Please rate your pro in the app.`,
  extraRequested: (description: string, priceCents: number) =>
    `MISK: your pro asks to add "${description}" for ${formatEuro(priceCents)}. Approve or decline in the app.`,
  bookingCancelled: (service: string, when: string) =>
    `MISK: your ${service} on ${when} was cancelled. Any money held on your card is released.`,
  bookingCancelledForPro: (service: string, when: string) => `MISK: the ${service} job on ${when} was cancelled.`,
  bookingUnassigned: (service: string, when: string) =>
    `MISK: we have not found a pro for your ${service} on ${when} yet. Our team is on it and will contact you.`,
  applicationApproved: () => 'MISK: you are approved! Set up payouts in the app to start getting jobs.',
  applicationRejected: () => 'MISK: we could not approve your application yet. See the app for what to change.',
  accountSuspended: () => 'MISK: your pro account is paused. Please contact the MISK team.',
};
