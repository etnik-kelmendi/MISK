import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { JobListItem } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ResourceState } from '../../components/ResourceState';
import { StatusBadge } from '../../components/StatusBadge';
import { dayKey, dayParts, euro, time } from '../../lib/format';

const DAY_MS = 24 * 3600 * 1000;

interface Earnings {
  sentCents: number;
  pendingCents: number;
  last30Cents: number;
}

export function ProWeekPage() {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const [start] = useState(() => new Date());
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => new Date(start.getTime() + i * DAY_MS).toISOString()), [start]);
  const [selected, setSelected] = useState(() => dayKey(start.toISOString(), timezone));

  const loadJobs = useCallback(() => {
    const from = new Date(start.getTime() - DAY_MS).toISOString();
    const to = new Date(start.getTime() + 8 * DAY_MS).toISOString();
    return api.get<{ jobs: JobListItem[] }>(`/pro/jobs?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  }, [api, start]);
  const jobs = useResource(loadJobs);
  const loadEarnings = useCallback(() => api.get<{ earnings: Earnings }>('/pro/earnings'), [api]);
  const earnings = useResource(loadEarnings);

  return (
    <>
      <header className="prohead">
        <h1>{t('week.title')}</h1>
        <ResourceState state={earnings.state} reload={earnings.reload}>
          {({ earnings: e }) => (
            <div className="row gap8 kpi-row">
              <div className="kpi-dark">
                <p className="tiny subtle">{t('week.last30')}</p>
                <p className="b big">{euro(e.last30Cents)}</p>
              </div>
              <div className="kpi-dark">
                <p className="tiny subtle">{t('week.pending')}</p>
                <p className="b big accent">{euro(e.pendingCents)}</p>
              </div>
            </div>
          )}
        </ResourceState>
      </header>
      <div className="body">
        <ResourceState state={jobs.state} reload={jobs.reload}>
          {({ jobs: list }) => {
            const byDay = new Map<string, JobListItem[]>();
            for (const job of list) {
              const key = dayKey(job.startsAt, timezone);
              byDay.set(key, [...(byDay.get(key) ?? []), job]);
            }
            const totals = days.map((d) =>
              (byDay.get(dayKey(d, timezone)) ?? []).filter((j) => j.status !== 'cancelled').reduce((sum, j) => sum + j.earningsCents, 0),
            );
            const max = Math.max(1, ...totals);
            const shown = byDay.get(selected) ?? [];
            return (
              <>
                <section className="card" aria-labelledby="by-day">
                  <h2 id="by-day" className="b small">
                    {t('week.byDay')}
                  </h2>
                  <div className="bars">
                    {days.map((d, i) => {
                      const key = dayKey(d, timezone);
                      const parts = dayParts(d, timezone);
                      const total = totals[i] ?? 0;
                      return (
                        <button
                          key={key}
                          type="button"
                          className="bcol"
                          aria-pressed={key === selected}
                          aria-label={t('week.dayTotal', { day: `${parts.weekday} ${parts.day}`, amount: euro(total) })}
                          onClick={() => setSelected(key)}
                        >
                          <span className="tiny b">{total ? euro(total) : ''}</span>
                          <span className={`bar ${key === selected ? 'hl' : ''}`} style={{ height: `${Math.max(4, (total / max) * 70)}px` }} />
                          <span className="bl">{i === 0 ? t('week.today') : parts.weekday}</span>
                        </button>
                      );
                    })}
                  </div>
                </section>
                <h2 className="h-sm">{t('week.jobsOn', { count: shown.length })}</h2>
                {shown.length === 0 ? (
                  <p className="card small muted center">{t('week.dayOff')}</p>
                ) : (
                  <ul className="stack">
                    {shown.map((job) => (
                      <li key={job.id}>
                        <Link to={`/pro/jobs/${job.id}`} className="job link-card">
                          <span className="jt">{time(job.startsAt, timezone)}</span>
                          <span className="grow">
                            <span className="b small block">{job.serviceName}</span>
                            <span className="tiny muted">{job.address}</span>
                          </span>
                          <span className="right">
                            <span className="b small block">{euro(job.earningsCents)}</span>
                            <StatusBadge status={job.status} />
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="tiny muted">{t('week.payoutNote')}</p>
              </>
            );
          }}
        </ResourceState>
      </div>
    </>
  );
}
