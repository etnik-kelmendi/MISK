import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi } from '../../api/ApiContext';
import type { Overview } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ResourceState } from '../../components/ResourceState';
import { euro } from '../../lib/format';

const PERIODS = ['1', '7', '30'] as const;

export function OverviewPage() {
  const { t } = useTranslation();
  const api = useApi();
  const [days, setDays] = useState<(typeof PERIODS)[number]>('7');
  const load = useCallback(() => api.get<Overview>(`/admin/overview?days=${days}`), [api, days]);
  const { state, reload } = useResource(load);

  return (
    <>
      <div className="row between wrap">
        <h1>{t('admin.overview.title')}</h1>
        <div className="seg" role="group" aria-label={t('admin.overview.period')}>
          {PERIODS.map((p) => (
            <button key={p} type="button" className={p === days ? 'on' : ''} aria-pressed={p === days} onClick={() => setDays(p)}>
              {t(`admin.overview.days.${p}`)}
            </button>
          ))}
        </div>
      </div>
      <ResourceState state={state} reload={reload}>
        {(data) => {
          const max = Math.max(1, ...data.weekly.map((w) => w.bookings));
          const a = data.attention;
          return (
            <>
              <div className="kpis">
                <div className="kpi">
                  <p className="kl">{t('admin.overview.bookings')}</p>
                  <p className="kv2">{data.kpis.bookings}</p>
                  <p className="kd">{t('admin.overview.completed', { count: data.kpis.completed })}</p>
                </div>
                <div className="kpi">
                  <p className="kl">{t('admin.overview.gross')}</p>
                  <p className="kv2">{euro(data.kpis.grossCents)}</p>
                  <p className="kd">{t('admin.overview.share', { amount: euro(data.kpis.miskShareCents) })}</p>
                </div>
                <div className="kpi">
                  <p className="kl">{t('admin.overview.paidToPros')}</p>
                  <p className="kv2">{euro(data.kpis.payoutCents)}</p>
                </div>
                <div className="kpi">
                  <p className="kl">{t('admin.overview.rating')}</p>
                  <p className="kv2">{data.kpis.ratingAverage === null ? '–' : data.kpis.ratingAverage.toFixed(1)}</p>
                  <p className="kd">{t('admin.overview.ratings', { count: data.kpis.ratingCount })}</p>
                </div>
              </div>
              <div className="agrid">
                <section className="panel" aria-labelledby="weekly-heading">
                  <h2 id="weekly-heading">{t('admin.overview.weekly')}</h2>
                  <div className="bars tall" role="img" aria-label={t('admin.overview.weeklyLabel', { weeks: data.weekly.map((w) => w.bookings).join(', ') })}>
                    {data.weekly.map((w, i) => (
                      <div key={w.week} className="bcol">
                        <span className="tiny b muted">{w.bookings}</span>
                        <span className={`bar ${i === data.weekly.length - 1 ? 'hl' : ''}`} style={{ height: `${(w.bookings / max) * 110 + 4}px` }} />
                        <span className="bl">{w.week.slice(5)}</span>
                      </div>
                    ))}
                  </div>
                </section>
                <section className="panel" aria-labelledby="attention-heading">
                  <h2 id="attention-heading">{t('admin.overview.attention')}</h2>
                  <ul className="attention">
                    <li>
                      <Link to="/admin/providers?status=submitted">{t('admin.overview.applications', { count: a.pendingApplications })}</Link>
                    </li>
                    <li>
                      <Link to="/admin/bookings?status=unassigned" className={a.unassigned ? 'warn' : ''}>
                        {t('admin.overview.unassigned', { count: a.unassigned })}
                      </Link>
                    </li>
                    <li className={a.unreleasedHolds ? 'warn' : ''}>{t('admin.overview.holds', { count: a.unreleasedHolds })}</li>
                    <li className={a.failedPayouts ? 'warn' : ''}>{t('admin.overview.failedPayouts', { count: a.failedPayouts })}</li>
                  </ul>
                </section>
              </div>
            </>
          );
        }}
      </ResourceState>
    </>
  );
}
