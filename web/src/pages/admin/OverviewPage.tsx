import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import {
  OVERVIEW_PERIODS,
  type LiveBooking,
  type Overview,
  type OverviewApplication,
  type OverviewLive,
  type OverviewPeriod,
} from '../../api/types';
import { useResource } from '../../api/useResource';
import { canOpen } from '../../auth/AreaGuard';
import { useUser } from '../../auth/AuthContext';
import { ErrorText } from '../../components/ErrorText';
import { ResourceState } from '../../components/ResourceState';
import { dateTime, euro } from '../../lib/format';
import { useAction } from '../../lib/useAction';
import { usePolling } from '../../lib/usePolling';
import { REFRESH_MS } from './AdminBookingDrawer';
import { ItemStatus } from './AdminBookingsPage';

export const DEFAULT_PERIOD: OverviewPeriod = '7';

function isPeriod(value: string | null): value is OverviewPeriod {
  return OVERVIEW_PERIODS.some((p) => p === value);
}

/** "+12%", "−5%" or "±0%" against the previous period, green when up and red when down. */
function Change({ pct, none }: { pct: number | null; none: string }) {
  const { t } = useTranslation();
  if (pct === null) {
    return <p className="kd muted">{none}</p>;
  }
  const tone = pct > 0 ? 'up' : pct < 0 ? 'down' : 'muted';
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '±';
  return <p className={`kd ${tone}`}>{t('admin.overview.change', { change: `${sign}${Math.abs(pct)}%` })}</p>;
}

/** Bookings per week, one-off jobs and plan visits together; the last bar is this week. */
function WeeklyChart({ weekly }: { weekly: Overview['weekly'] }) {
  const { t } = useTranslation();
  const max = Math.max(1, ...weekly.map((w) => w.bookings));
  const label = t('admin.overview.weeklyLabel', {
    count: weekly.length,
    weeks: weekly.map((w) => w.bookings).join(', '),
    current: weekly.at(-1)?.bookings ?? 0,
  });
  return (
    <div className="bars tall" role="img" aria-label={label}>
      {weekly.map((w, i) => {
        const current = i === weekly.length - 1;
        return (
          <div
            key={w.week}
            className={`bcol ${current ? 'now' : ''}`}
            data-testid={current ? 'current-week' : undefined}
            title={t('admin.overview.weekSplit', { oneOff: w.oneOff, visits: w.visits })}
          >
            <span className="tiny b muted">{w.bookings}</span>
            <span className={`bar ${current ? 'hl' : ''}`} style={{ height: `${(w.bookings / max) * 110 + 4}px` }} />
            <span className="bl">{current ? t('admin.overview.thisWeek') : `${w.week.slice(8)}/${w.week.slice(5, 7)}`}</span>
          </div>
        );
      })}
    </div>
  );
}

function ApplicationRow({ pro, approved, onApproved }: { pro: OverviewApplication; approved: boolean; onApproved: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { run, busy, error } = useAction();
  const name = [pro.firstName, pro.lastName].filter(Boolean).join(' ') || t('admin.overview.noName');

  async function approve() {
    const done = await run(() => api.post(`/admin/pros/${pro.id}/approve`));
    if (done !== undefined) {
      onApproved();
    }
  }

  return (
    <li className="app-row">
      <div className="app-who">
        <p className="b">{name}</p>
        <p className="small muted">
          {pro.trades.join(', ') || t('admin.overview.noTrade')} ·{' '}
          {t('admin.overview.documents', { uploaded: pro.documentsUploaded, total: pro.documentsTotal })}
        </p>
        <ErrorText error={error} />
      </div>
      {approved ? (
        <span className="badge g" role="status">
          {t('admin.overview.approved')}
        </span>
      ) : pro.ready ? (
        <button
          type="button"
          className="abtn"
          disabled={busy}
          onClick={() => void approve()}
          aria-label={t('admin.overview.approveName', { name })}
        >
          {t('admin.overview.approve')}
        </button>
      ) : (
        <Link
          className="abtn ghost"
          to={`/admin/providers?tab=applications&open=${pro.id}`}
          aria-label={t('admin.overview.reviewName', { name })}
        >
          {t('admin.overview.review')}
        </Link>
      )}
    </li>
  );
}

function Applications({ applications, reload }: { applications: NonNullable<OverviewLive['applications']>; reload: () => void }) {
  const { t } = useTranslation();
  // Approved pros stay in the list with "Approved" until the page is left, so the admin sees it worked.
  const [approved, setApproved] = useState<OverviewApplication[]>([]);
  const listed = [...applications.pros.filter((p) => !approved.some((a) => a.id === p.id)), ...approved];
  return (
    <section className="panel" aria-labelledby="applications-heading">
      <div className="row between">
        <h2 id="applications-heading">{t('admin.overview.applicationsTitle')}</h2>
        <span className={`badge ${applications.waiting ? 'a' : 'grey'}`}>
          {t('admin.overview.waiting', { count: applications.waiting })}
        </span>
      </div>
      {listed.length === 0 ? (
        <p className="small muted">{t('admin.overview.noApplications')}</p>
      ) : (
        <ul className="app-list">
          {listed.map((pro) => (
            <ApplicationRow
              key={pro.id}
              pro={pro}
              approved={approved.some((a) => a.id === pro.id)}
              onApproved={() => {
                setApproved((current) => [...current, pro]);
                reload();
              }}
            />
          ))}
        </ul>
      )}
      {applications.waiting > applications.pros.length && (
        <Link className="small b" to="/admin/providers?tab=applications">
          {t('admin.overview.allApplications', { count: applications.waiting })}
        </Link>
      )}
    </section>
  );
}

function LiveBookings({ bookings, timezone }: { bookings: LiveBooking[]; timezone: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const open = (item: LiveBooking) => void navigate(`/admin/bookings?open=${item.kind === 'booking' ? 'b' : 'v'}:${item.id}`);
  return (
    <section className="panel scroll-x" aria-labelledby="live-heading">
      <div className="row between">
        <h2 id="live-heading">{t('admin.overview.liveTitle')}</h2>
        <Link className="small b" to="/admin/bookings">
          {t('admin.overview.allBookings')}
        </Link>
      </div>
      {bookings.length === 0 ? (
        <p className="small muted">{t('admin.overview.noBookings')}</p>
      ) : (
        <table className="t clickable">
          <thead>
            <tr>
              <th scope="col">{t('admin.overview.when')}</th>
              <th scope="col">{t('admin.bookings.service')}</th>
              <th scope="col">{t('admin.overview.customerOrAddress')}</th>
              <th scope="col">{t('admin.bookings.pro')}</th>
              <th scope="col">{t('admin.bookings.status')}</th>
              <th scope="col">{t('admin.overview.value')}</th>
            </tr>
          </thead>
          <tbody>
            {bookings.map((item) => (
              <tr key={`${item.kind}-${item.id}`} className={item.tab === 'needs_action' ? 'hl' : ''} onClick={() => open(item)}>
                <td>
                  <button
                    type="button"
                    className="link b"
                    aria-label={t('admin.bookings.open', { number: item.number })}
                    onClick={(event) => {
                      event.stopPropagation();
                      open(item);
                    }}
                  >
                    {dateTime(item.startsAt, timezone)}
                  </button>
                </td>
                <td>{item.service}</td>
                <td>
                  {item.customer ?? item.address}
                  {item.customer && <div className="small muted">{item.address}</div>}
                </td>
                <td>{item.pro ?? <span className="unassigned">{t('admin.bookings.unassigned')}</span>}</td>
                <td>
                  <ItemStatus item={item} />
                  {item.problem && <div className="small unassigned">{t('admin.bookings.problem')}</div>}
                </td>
                <td>{item.kind === 'visit' ? <span className="badge b">{t('admin.overview.plan')}</span> : euro(item.valueCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="small muted">{t('admin.bookings.updated')}</p>
    </section>
  );
}

/** The first page of the control panel: how the marketplace is doing, for a chosen period. */
export function OverviewPage() {
  const { t } = useTranslation();
  const api = useApi();
  const user = useUser();
  const [params, setParams] = useSearchParams();
  const daysParam = params.get('days');
  const days: OverviewPeriod = isPeriod(daysParam) ? daysParam : DEFAULT_PERIOD;
  const load = useCallback(() => api.get<Overview>(`/admin/overview?days=${days}`), [api, days]);
  const { state, reload } = useResource(load);
  const loadLive = useCallback(() => api.get<OverviewLive>('/admin/overview/live'), [api]);
  const { state: liveState, reload: reloadLive } = useResource(loadLive);
  const refresh = useCallback(() => {
    reload();
    reloadLive();
  }, [reload, reloadLive]);
  usePolling(refresh, REFRESH_MS);

  function choose(period: OverviewPeriod) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (period === DEFAULT_PERIOD) next.delete('days');
        else next.set('days', period);
        return next;
      },
      { replace: true },
    );
  }

  return (
    <>
      <div className="row between wrap">
        <div>
          <h1>{t('admin.overview.title')}</h1>
          {state.status === 'ready' && (
            <p className="muted small b">
              {t('admin.overview.scope', { city: state.data.city, period: t(`admin.overview.periodName.${days}`) })}
            </p>
          )}
        </div>
        <div className="seg" role="group" aria-label={t('admin.overview.period')}>
          {OVERVIEW_PERIODS.map((p) => (
            <button key={p} type="button" className={p === days ? 'on' : ''} aria-pressed={p === days} onClick={() => choose(p)}>
              {t(`admin.overview.days.${p}`)}
            </button>
          ))}
        </div>
      </div>
      <ResourceState state={state} reload={reload}>
        {(data) => {
          const k = data.kpis;
          const a = data.attention;
          return (
            <>
              <div className="kpis">
                <div className="kpi">
                  <p className="kl">{t('admin.overview.bookings')}</p>
                  <p className="kv2">{k.bookings}</p>
                  <Change pct={k.bookingsChangePct} none={t('admin.overview.noPrevious')} />
                </div>
                <div className="kpi">
                  <p className="kl">{t('admin.overview.subscriptions')}</p>
                  <p className="kv2">{k.activeSubscriptions}</p>
                  <p className={`kd ${k.newSubscriptions ? '' : 'muted'}`}>
                    {t('admin.overview.newSubscriptions', { count: k.newSubscriptions })}
                  </p>
                </div>
                <div className="kpi">
                  <p className="kl">{t('admin.overview.gross')}</p>
                  <p className="kv2">{euro(k.grossCents)}</p>
                  <p className="kd">{t('admin.overview.share', { amount: euro(k.miskShareCents) })}</p>
                </div>
                <div className="kpi">
                  <p className="kl">{t('admin.overview.rating')}</p>
                  <p className="kv2">{k.ratingAverage === null ? '–' : k.ratingAverage.toFixed(1)}</p>
                  <p className={`kd ${k.onTimePct === null ? 'muted' : ''}`}>
                    {k.onTimePct === null ? t('admin.overview.noJobs') : t('admin.overview.onTime', { pct: k.onTimePct })}
                  </p>
                </div>
              </div>
              {canOpen(user, 'bookings') && a.unassigned + a.unreleasedHolds + a.failedPayouts > 0 && (
                <p className="attention-strip">
                  {a.unassigned > 0 && (
                    <Link to="/admin/bookings?tab=needs_action">{t('admin.overview.unassigned', { count: a.unassigned })}</Link>
                  )}
                  {a.unreleasedHolds > 0 && <span>{t('admin.overview.holds', { count: a.unreleasedHolds })}</span>}
                  {a.failedPayouts > 0 && <span>{t('admin.overview.failedPayouts', { count: a.failedPayouts })}</span>}
                </p>
              )}
              <div className={liveState.status === 'ready' && liveState.data.applications === null ? '' : 'agrid'}>
                <section className="panel" aria-labelledby="weekly-heading">
                  <div className="row between wrap">
                    <h2 id="weekly-heading">{t('admin.overview.weekly')}</h2>
                    <span className="small muted">{t('admin.overview.weeklyNote')}</span>
                  </div>
                  <WeeklyChart weekly={data.weekly} />
                </section>
                <ResourceState state={liveState} reload={reloadLive}>
                  {(live) => (live.applications ? <Applications applications={live.applications} reload={reloadLive} /> : null)}
                </ResourceState>
              </div>
              {liveState.status === 'ready' && <LiveBookings bookings={liveState.data.bookings} timezone={data.timezone} />}
            </>
          );
        }}
      </ResourceState>
    </>
  );
}
