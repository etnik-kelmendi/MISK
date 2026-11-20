import type { AdminBookingListItem } from '../../api/types';

export const KANBAN_COLUMNS = ['todo', 'progress', 'review', 'done'] as const;
export type KanbanColumn = (typeof KANBAN_COLUMNS)[number];

/**
 * The board column of a booking or plan visit.
 * - In Review: anything with an open problem report (whatever its status), and finished jobs not yet paid
 *   for (pending or held: the 24-hour window before the money is taken) or whose payment failed.
 * - In Progress: the pro is on the way or working.
 * - Done: paid, released or refunded jobs, cancelled bookings, and visits that are completed, skipped or cancelled.
 * - To Do: everything else that is still waiting (awaiting payment, searching, unassigned, accepted, planned visits).
 */
export function kanbanColumn(item: Pick<AdminBookingListItem, 'kind' | 'status' | 'paymentStatus' | 'problem' | 'proIssue'>): KanbanColumn {
  // A problem the customer reported, or an issue the pro reported on site (D86), needs the team to look at it.
  if (item.problem || item.proIssue) {
    return 'review';
  }
  if (item.kind === 'visit') {
    return item.status === 'completed' || item.status === 'skipped' || item.status === 'cancelled' ? 'done' : 'todo';
  }
  switch (item.status) {
    case 'on_the_way':
    case 'working':
      return 'progress';
    case 'cancelled':
      return 'done';
    case 'completed':
      return item.paymentStatus === 'pending' || item.paymentStatus === 'held' || item.paymentStatus === 'failed' ? 'review' : 'done';
    default:
      return 'todo';
  }
}
