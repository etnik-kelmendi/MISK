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
  jobCompleted: (service: string) =>
    `MISK: your ${service} is done. We charge your card in 24 hours. Something wrong? Report it in the app before then.`,
  extraRequested: (description: string, priceCents: number) =>
    `MISK: your pro asks to add "${description}" for ${formatEuro(priceCents)}. Approve or decline in the app.`,
  bookingCancelled: (service: string, when: string) =>
    `MISK: your ${service} on ${when} was cancelled. Any money held on your card is released.`,
  bookingCancelledForPro: (service: string, when: string) => `MISK: the ${service} job on ${when} was cancelled.`,
  bookingRescheduled: (service: string, when: string) => `MISK: your ${service} has moved to ${when}.`,
  jobRescheduled: (service: string, when: string) => `MISK: the ${service} job has moved to ${when}. See the app.`,
  bookingUnassigned: (service: string, when: string) =>
    `MISK: we have not found a pro for your ${service} on ${when} yet. Our team is on it and will contact you.`,
  applicationApproved: () => 'MISK: you are approved! Set up payouts in the app to start getting jobs.',
  applicationRejected: () => 'MISK: we could not approve your application yet. See the app for what to change.',
  accountSuspended: () => 'MISK: your pro account is suspended, so you get no new jobs. Please contact the MISK team.',
  accountReinstated: () => 'MISK: your pro account is active again. New jobs will reach you as before.',
  reinstatedNeedsDocuments: () =>
    'MISK: your pro account is no longer suspended. A document ran out meanwhile: upload the new one in the app to get jobs again.',
  infoRequested: (message: string) => `MISK: we need more for your application: ${message} Please update it in the app.`,
  documentRejected: (document: string, note: string) => `MISK: please upload a new copy of your ${document}. ${note}`,
  documentReminder: (document: string) => `MISK: please upload your ${document} in the app, so you keep getting jobs.`,
  documentExpiringReminder: (document: string, date: string) =>
    `MISK: your ${document} runs out on ${date}. Please upload the new one in the app before then.`,
  documentsExpired: (documents: string) =>
    `MISK: your ${documents} ran out, so you get no new jobs for now. Upload the new one in the app and we check it quickly.`,
  backToActive: () => 'MISK: your documents are checked. You get new jobs again.',
  jobsPaused: () => 'MISK: the team has paused new jobs for you for now. Your booked jobs stay. We will contact you.',
  jobsResumed: () => 'MISK: new jobs are switched on again for you.',
  coachingCall: (when: string) => `MISK: we booked a short call with you on ${when} to help with your jobs. We will phone you then.`,
  proReplaced: (service: string, when: string) =>
    `MISK: your pro can no longer do your ${service} on ${when}. We are finding you another pro now.`,
  planProReplaced: (plan: string, proName: string) => `MISK: ${proName} is your new regular pro for ${plan}.`,
  planProMissing: (plan: string) => `MISK: your regular pro for ${plan} has changed. We are finding a new one and will contact you.`,
  newRegularCustomer: (plan: string) => `MISK: you are the new regular pro for a ${plan} customer. See My week.`,
};
