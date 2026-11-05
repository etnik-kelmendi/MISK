import type { FastifyBaseLogger } from 'fastify';
import { deleteExpiredRows } from './auth/sessions.js';
import { dispatchTick } from './bookings/dispatch.js';
import type { BookingDeps } from './bookings/events.js';
import { expireUnpaid, settleTick } from './bookings/lifecycle.js';
import { dispatchOnce } from './notifications/outbox.js';
import { subscriptionTick } from './subscriptions/service.js';
import type { SmsSender } from './notifications/sms.js';

interface Job {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
}

/**
 * Starts the background jobs. Each job runs one pass at a time, so a slow pass is never overlapped by
 * the next. Every job is safe to run on several servers at once. Returns a function that stops them.
 */
export function startWorkers(deps: BookingDeps, sender: SmsSender | null, log: FastifyBaseLogger): () => void {
  const jobs: Job[] = [
    { name: 'Sending text messages', everyMs: 3_000, run: () => dispatchOnce(deps.pool, sender, log) },
    { name: 'Offering jobs to pros', everyMs: 10_000, run: () => dispatchTick(deps) },
    { name: 'Dropping unpaid bookings', everyMs: 60_000, run: () => expireUnpaid(deps) },
    { name: 'Settling completed jobs', everyMs: 60_000, run: () => settleTick(deps) },
    { name: 'Planning monthly plan visits and billing', everyMs: 5 * 60_000, run: () => subscriptionTick(deps) },
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
