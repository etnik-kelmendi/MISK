import type { FastifyBaseLogger } from 'fastify';
import { deleteExpiredRows } from './auth/sessions.js';
import { dispatchTick } from './bookings/dispatch.js';
import type { BookingDeps } from './bookings/events.js';
import { expireUnpaid, renewHoldsTick, settleTick } from './bookings/lifecycle.js';
import { dispatchOnce } from './notifications/outbox.js';
import { subscriptionTick } from './subscriptions/service.js';
import { visitMoveTick } from './subscriptions/moves.js';
import { settlePausesAfterPlanEnd } from './subscriptions/pause.js';
import { documentExpiryTick } from './pros/management.js';
import { documentReminderTick } from './pros/document-reminders.js';
import { ratingRequestTick, reminderTick } from './bookings/reminders.js';
import { payoutScheduleTick } from './payments/payouts.js';
import { timeWaitlistTick } from './bookings/time-waitlist.js';
import type { Senders } from './notifications/outbox.js';

interface Job {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
}

/**
 * Starts the background jobs. Each job runs one pass at a time, so a slow pass is never overlapped by
 * the next. Every job is safe to run on several servers at once. Returns a function that stops them.
 */
export function startWorkers(deps: BookingDeps, senders: Senders, log: FastifyBaseLogger): () => void {
  const jobs: Job[] = [
    { name: 'Sending messages (push, SMS, email)', everyMs: 3_000, run: () => dispatchOnce(deps.pool, senders, log) },
    { name: 'Offering jobs to pros', everyMs: 10_000, run: () => dispatchTick(deps) },
    { name: 'Dropping unpaid bookings', everyMs: 60_000, run: () => expireUnpaid(deps) },
    { name: 'Settling completed jobs', everyMs: 60_000, run: () => settleTick(deps) },
    { name: 'Renewing card reservations before they run out', everyMs: 60 * 60_000, run: () => renewHoldsTick(deps) },
    { name: 'Planning monthly plan visits and billing', everyMs: 5 * 60_000, run: () => subscriptionTick(deps) },
    { name: 'Declining plan visit moves the pro did not answer in time', everyMs: 5 * 60_000, run: () => visitMoveTick(deps) },
    { name: 'Taking back pause credit for visits after a plan ends', everyMs: 15 * 60_000, run: () => settlePausesAfterPlanEnd(deps) },
    { name: 'Moving pros with expired documents to Pending approval', everyMs: 15 * 60_000, run: () => documentExpiryTick(deps) },
    { name: 'Reminding pros 30 days before a document runs out', everyMs: 15 * 60_000, run: () => documentReminderTick(deps) },
    { name: 'Reminding customers of their jobs tomorrow', everyMs: 5 * 60_000, run: () => reminderTick(deps) },
    { name: 'Asking customers to rate finished jobs', everyMs: 5 * 60_000, run: () => ratingRequestTick(deps) },
    { name: 'Telling customers a time they waited for is free', everyMs: 2 * 60_000, run: () => timeWaitlistTick(deps) },
    { name: 'Keeping pro payout schedules in line with Settings', everyMs: 10 * 60_000, run: () => payoutScheduleTick(deps) },
    { name: 'Removing expired sign-in data', everyMs: 15 * 60_000, run: () => deleteExpiredRows(deps.pool) },
  ];
  const timers = jobs.map((job) => {
    let running = false;
    return setInterval(() => {
      if (running) {
        return;
      }
      running = true;
      job
        .run()
        .catch((error: unknown) => log.error({ err: error }, `${job.name} failed`))
        .finally(() => {
          running = false;
        });
    }, job.everyMs);
  });
  return () => timers.forEach(clearInterval);
}
