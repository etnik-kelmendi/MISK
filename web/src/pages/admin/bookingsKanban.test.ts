import type { AdminBookingListItem } from '../../api/types';
import { kanbanColumn } from './bookingsKanban';

type Input = Pick<AdminBookingListItem, 'kind' | 'status' | 'paymentStatus' | 'problem' | 'proIssue'>;
const booking = (status: string, paymentStatus = 'held', problem = false): Input =>
  ({ kind: 'booking', status, paymentStatus, problem }) as Input;
const visit = (status: string, problem = false): Input => ({ kind: 'visit', status, paymentStatus: 'active', problem }) as Input;

describe('kanbanColumn', () => {
  it.each(['awaiting_payment', 'searching', 'unassigned', 'accepted'])('puts a %s booking in To Do', (status) => {
    expect(kanbanColumn(booking(status))).toBe('todo');
  });

  it.each(['on_the_way', 'working'])('puts a %s booking in In Progress', (status) => {
    expect(kanbanColumn(booking(status))).toBe('progress');
  });

  it.each(['pending', 'held', 'failed'])('puts a completed booking with payment %s in In Review', (payment) => {
    expect(kanbanColumn(booking('completed', payment))).toBe('review');
  });

  it.each(['captured', 'released', 'refunded'])('puts a completed booking with payment %s in Done', (payment) => {
    expect(kanbanColumn(booking('completed', payment))).toBe('done');
  });

  it('puts cancelled bookings in Done, whatever the payment', () => {
    expect(kanbanColumn(booking('cancelled', 'held'))).toBe('done');
    expect(kanbanColumn(booking('cancelled', 'refunded'))).toBe('done');
  });

  it.each(['accepted', 'on_the_way', 'working'])('puts a %s booking with an issue the pro reported in In Review', (status) => {
    expect(kanbanColumn({ ...booking(status), proIssue: true })).toBe('review');
  });

  it('puts every booking with a problem in In Review, whatever its status', () => {
    for (const status of ['awaiting_payment', 'unassigned', 'accepted', 'on_the_way', 'working', 'completed', 'cancelled']) {
      expect(kanbanColumn(booking(status, 'captured', true))).toBe('review');
    }
    expect(kanbanColumn(visit('planned', true))).toBe('review');
  });

  it('puts pending and planned visits in To Do and finished ones in Done', () => {
    expect(kanbanColumn(visit('pending'))).toBe('todo');
    expect(kanbanColumn(visit('planned'))).toBe('todo');
    expect(kanbanColumn(visit('completed'))).toBe('done');
    expect(kanbanColumn(visit('skipped'))).toBe('done');
    expect(kanbanColumn(visit('cancelled'))).toBe('done');
  });

  it('ignores the subscription status of a visit', () => {
    expect(kanbanColumn({ kind: 'visit', status: 'completed', paymentStatus: 'past_due', problem: false })).toBe('done');
  });
});
