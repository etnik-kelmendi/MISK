import { describe, expect, it } from 'vitest';
import { listAlerts } from './admin-list.js';

const NOW = new Date('2026-11-24T10:00:00.000Z');
const minutesFromNow = (minutes: number) => new Date(NOW.getTime() + minutes * 60000);

function input(overrides: Partial<Parameters<typeof listAlerts>[0]> = {}): Parameters<typeof listAlerts>[0] {
  return {
    kind: 'booking',
    status: 'accepted',
    paymentStatus: 'held',
    startsAt: minutesFromNow(600),
    pro: 'Daniel',
    problem: false,
    problemNote: null,
    issueReason: null,
    lateWarned: false,
    extraPending: false,
    payoutFailed: false,
    ...overrides,
  };
}

describe('listAlerts (board card lines, D96)', () => {
  it('has nothing to say about a calm booking', () => {
    expect(listAlerts(input(), NOW)).toEqual([]);
  });

  it('puts "Unsafe to work" first, then the other pro reason, the customer problem and failures, all as problems', () => {
    const alerts = listAlerts(input({ issueReason: 'unsafe', problem: true, problemNote: 'Back lawn not mowed', paymentStatus: 'failed', payoutFailed: true }), NOW);
    expect(alerts).toEqual([
      { level: 'problem', key: 'issue', params: { reason: 'unsafe' } },
      { level: 'problem', key: 'problemWithReason', params: { reason: 'Back lawn not mowed' } },
      { level: 'problem', key: 'paymentFailed' },
      { level: 'problem', key: 'payoutFailed' },
    ]);
  });

  it('says "Problem reported" when the customer gave no reason', () => {
    expect(listAlerts(input({ problem: true }), NOW)).toEqual([{ level: 'problem', key: 'problem' }]);
  });

  it('flags a booking nobody has as "No pro yet"', () => {
    expect(listAlerts(input({ status: 'unassigned', pro: null }), NOW)).toEqual([{ level: 'problem', key: 'noPro' }]);
  });

  it('warns about a search that starts within 2 hours, with the minutes left, and not before', () => {
    expect(listAlerts(input({ status: 'searching', pro: null, startsAt: minutesFromNow(90) }), NOW)).toEqual([
      { level: 'warning', key: 'searching', params: { minutes: 90 } },
    ]);
    expect(listAlerts(input({ status: 'searching', pro: null, startsAt: minutesFromNow(121) }), NOW)).toEqual([]);
  });

  it('warns about a late pro, extra work waiting for the customer and a job being charged', () => {
    expect(listAlerts(input({ lateWarned: true, extraPending: true }), NOW).map((a) => [a.level, a.key])).toEqual([
      ['warning', 'late'],
      ['warning', 'extraPending'],
    ]);
    expect(listAlerts(input({ status: 'completed', paymentStatus: 'held' }), NOW)).toEqual([{ level: 'warning', key: 'charging' }]);
    // A reported problem holds the charge, so it is a problem, not "being charged".
    expect(listAlerts(input({ status: 'completed', paymentStatus: 'held', problem: true }), NOW).map((a) => a.key)).toEqual(['problem']);
  });

  it('lists problems before warnings', () => {
    const levels = listAlerts(input({ lateWarned: true, issueReason: 'no_access' }), NOW).map((a) => a.level);
    expect(levels).toEqual(['problem', 'warning']);
  });

  it('keeps plan visits to the reasons they can have', () => {
    expect(listAlerts(input({ kind: 'visit', status: 'planned', paymentStatus: 'active', pro: 'Daniel' }), NOW)).toEqual([]);
  });
});
