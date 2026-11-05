import type { Api } from '../api/client';
import type { BookingStatus, JobListItem, ProVisit, VisitStatus } from '../api/types';

/** One line in a pro's schedule: a one-off job or a visit of a monthly plan. */
export interface ScheduleItem {
  key: string;
  href: string;
  kind: 'job' | 'visit';
  title: string;
  startsAt: string;
  address: string;
  earningsCents: number;
  status: BookingStatus | VisitStatus;
  /** Finished or skipped: shown in history, left out of "upcoming". */
  closed: boolean;
}

/** One-off jobs and plan visits together, in time order. Without a range: yesterday to a week ahead. */
export async function loadSchedule(api: Api, range?: { from: Date; to: Date }): Promise<ScheduleItem[]> {
  const query = range ? `?from=${encodeURIComponent(range.from.toISOString())}&to=${encodeURIComponent(range.to.toISOString())}` : '';
  const [{ jobs }, { visits }] = await Promise.all([
    api.get<{ jobs: JobListItem[] }>(`/pro/jobs${query}`),
    api.get<{ visits: ProVisit[] }>(`/pro/visits${query}`),
  ]);
  const items: ScheduleItem[] = [
    ...jobs.map((job) => ({
      key: `job-${job.id}`,
      href: `/pro/jobs/${job.id}`,
      kind: 'job' as const,
      title: job.serviceName,
      startsAt: job.startsAt,
      address: job.address,
      earningsCents: job.earningsCents,
      status: job.status,
      closed: job.status === 'completed' || job.status === 'cancelled',
    })),
    ...visits.map((visit) => ({
      key: `visit-${visit.id}`,
      href: `/pro/visits/${visit.id}`,
      kind: 'visit' as const,
      title: visit.planName,
      startsAt: visit.startsAt,
      address: visit.address,
      earningsCents: visit.earningsCents,
      status: visit.status,
      closed: visit.status !== 'planned',
    })),
  ];
  return items.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}
