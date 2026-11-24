import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useNavigate } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { BookingStatus, Offer, ProJob, ProProfile } from '../../api/types';
import { useResource } from '../../api/useResource';
import { useUser } from '../../auth/AuthContext';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { PhotoGrid } from '../../components/Photos';
import { ResourceState } from '../../components/ResourceState';
import { Stars, StatusBadge } from '../../components/StatusBadge';
import { dateTime, dayKey, dayName, euro, time } from '../../lib/format';
import { loadSchedule, type ScheduleItem } from '../../lib/proSchedule';
import { useAction } from '../../lib/useAction';
import { usePolling } from '../../lib/usePolling';
import { VisitMoveRequests } from './VisitMoveRequests';

function useCountdown(until: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return Math.max(0, Math.floor((new Date(until).getTime() - now) / 1000));
}

function OfferCard({ offer, onGone }: { offer: Offer; onGone: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const navigate = useNavigate();
  const { timezone } = useMarket();
  const seconds = useCountdown(offer.expiresAt);
  const { run, busy, error } = useAction();
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, '0');
  const flexible = Boolean(offer.flexibleWindow);
  const options = offer.startOptions ?? [];
  const [start, setStart] = useState<string | null>(options.length === 1 ? (options[0] ?? null) : null);

  async function accept() {
    const result = await run(() =>
      api.post<{ job: ProJob }>(`/pro/offers/${offer.id}/accept`, flexible && start ? { startsAt: start } : undefined),
    );
    if (result) {
      navigate(`/pro/jobs/${result.job.id}`);
    } else {
      onGone();
    }
  }

  async function decline() {
    await run(() => api.post(`/pro/offers/${offer.id}/decline`));
    onGone();
  }

  return (
    <article className="req" aria-labelledby={`offer-${offer.id}`}>
      <div className="req-top">
        <span className="ring" role="timer" aria-label={t('offer.timeLeft', { minutes, seconds: rest })}>
          {minutes}:{rest}
        </span>
        <div>
          <h2 id={`offer-${offer.id}`} className="b">
            {t('offer.new')}
          </h2>
          <p className="small">{t('offer.acceptBefore')}</p>
        </div>
      </div>
      <div className="req-body">
        <div className="row between">
          <div>
            <p className="b big">{offer.serviceName}</p>
            <p className="small muted">{t(`book.size.${offer.size}`)}</p>
          </div>
          <div className="right">
            <p className="tiny muted">{t('offer.youEarn')}</p>
            <p className="earn">{euro(offer.earningsCents)}</p>
          </div>
        </div>
        <dl className="kv">
          <dt>
            <Icon name="calendar" label={t('offer.when')} />
          </dt>
          <dd>
            {flexible && offer.flexibleWindow
              ? t('offer.flexibleWhen', { day: dayName(offer.startsAt, timezone), window: t(`time.window.${offer.flexibleWindow}`).toLowerCase() })
              : dateTime(offer.startsAt, timezone)}
          </dd>
          <dt>
            <Icon name="pin" label={t('offer.where')} />
          </dt>
          <dd>
            {offer.address}, {offer.postcode}
            {offer.distanceKm !== null && ` · ${t('offer.km', { km: offer.distanceKm })}`}
          </dd>
          <dt>
            <Icon name="user" label={t('offer.customer')} />
          </dt>
          <dd>
            {offer.customerRating != null
              ? t('offer.customerRated', { name: offer.customerName ?? t('chat.yourCustomer'), rating: offer.customerRating.toFixed(1) })
              : t('offer.customerNew', { name: offer.customerName ?? t('chat.yourCustomer') })}
          </dd>
          {offer.notes && (
            <>
              <dt>
                <Icon name="chat" label={t('offer.notes')} />
              </dt>
              <dd className="small">“{offer.notes}”</dd>
            </>
          )}
        </dl>
        {flexible && (
          <fieldset>
            <legend className="h-sm">{t('offer.pickStart')}</legend>
            {options.length === 0 ? (
              <p className="small muted">{t('offer.noStart')}</p>
            ) : (
              <div className="chips">
                {options.map((option) => (
                  <label key={option} className={`chip ${start === option ? 'on' : ''}`}>
                    <input type="radio" name={`start-${offer.id}`} className="visually-hidden" checked={start === option} onChange={() => setStart(option)} />
                    {time(option, timezone)}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        )}
        <PhotoGrid ids={offer.photoIds} label={t('offer.photos')} />
        <p className="info">
          <Icon name="shield" /> {t('offer.paymentSecured')}
        </p>
        <ErrorText error={error} />
        <div className="row gap8">
          <button type="button" className="btn2 no" disabled={busy || seconds === 0} onClick={() => void decline()}>
            {t('offer.decline')}
          </button>
          <button
            type="button"
            className="btn2 yes"
            disabled={busy || seconds === 0 || (flexible && !start)}
            onClick={() => void accept()}
          >
            {flexible && start ? t('offer.acceptAt', { time: time(start, timezone) }) : t('offer.accept')}
          </button>
        </div>
      </div>
    </article>
  );
}

/** Jobs and plan visits still to do today, and any job under way, in time order (D86). */
function laterToday(items: ScheduleItem[], timezone: string): ScheduleItem[] {
  const today = dayKey(new Date().toISOString(), timezone);
  return items.filter(
    (item) => !item.closed && (dayKey(item.startsAt, timezone) === today || item.status === 'on_the_way' || item.status === 'working'),
  );
}

/** The approved pro's Jobs page (D86): new offers while online, then the rest of today. */
function ApprovedHome({ profile, onOnline }: { profile: ProProfile; onOnline: (online: boolean) => Promise<void> }) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const online = profile.online !== false;
  const loadOffers = useCallback(() => api.get<{ offers: Offer[] }>('/pro/offers'), [api]);
  const offers = useResource(loadOffers);
  const loadJobs = useCallback(() => loadSchedule(api), [api]);
  const jobs = useResource(loadJobs);
  const switching = useAction();
  usePolling(offers.reload, 10_000, online);
  usePolling(jobs.reload, 30_000);

  return (
    <div className="body">
      {!profile.payoutsEnabled && (
        <Link to="/pro/profile" className="info amber link-card">
          <Icon name="card" /> {t('pro.payoutsNeeded')}
        </Link>
      )}
      {profile.offersPausedUntil && (
        <p className="info amber" role="status">
          <Icon name="clock" /> <span>{t('pro.offersPaused', { date: dateTime(profile.offersPausedUntil, timezone) })}</span>
        </p>
      )}
      {online ? (
        <ResourceState state={offers.state} reload={offers.reload}>
          {({ offers: list }) =>
            list.length === 0 ? (
              <p className="card muted center">{profile.payoutsEnabled ? t('pro.noOffers') : t('pro.noOffersUntilPayouts')}</p>
            ) : (
              <div className="stack">
                {list.map((offer) => (
                  <OfferCard key={offer.id} offer={offer} onGone={offers.reload} />
                ))}
              </div>
            )
          }
        </ResourceState>
      ) : (
        <div className="stack">
          <section className="card center" aria-labelledby="offline-heading">
            <span className="offline-icon" aria-hidden="true">
              <Icon name="pause" />
            </span>
            <h2 id="offline-heading" className="b">
              {t('pro.offlineTitle')}
            </h2>
            <p className="small muted">{t('pro.offlineText')}</p>
            <button type="button" className="cta dark" disabled={switching.busy} onClick={() => void switching.run(() => onOnline(true))}>
              {t('pro.goOnline')}
            </button>
            <ErrorText error={switching.error} />
          </section>
          <p className="info">
            <Icon name="clock" /> <span>{t('pro.offlineAuto')}</span>
          </p>
        </div>
      )}
      <VisitMoveRequests onAnswered={jobs.reload} />
      <h2 className="h-sm">{t('pro.laterToday')}</h2>
      <ResourceState state={jobs.state} reload={jobs.reload}>
        {(list) => {
          const today = laterToday(list, timezone);
          return today.length === 0 ? (
            <p className="muted small">{t('pro.nothingToday')}</p>
          ) : (
            <ul className="stack" aria-label={t('pro.laterToday')}>
              {today.map((item) => (
                <li key={item.key}>
                  <Link to={item.href} className={`job link-card ${item.kind === 'visit' ? 'rec' : ''}`}>
                    <span className="jt">{time(item.startsAt, timezone)}</span>
                    <span className="grow">
                      <span className="b small block">{item.title}</span>
                      <span className="tiny muted">{item.address}</span>
                    </span>
                    {item.kind === 'visit' ? (
                      <span className="badge a">
                        <Icon name="repeat" /> {t('visit.plan')}
                      </span>
                    ) : (
                      <StatusBadge status={item.status as BookingStatus} />
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          );
        }}
      </ResourceState>
      <p className="small">
        <Link to="/pro/week">{t('pro.seeWeek')}</Link>
      </p>
    </div>
  );
}

/** The online switch in the header (D86): a real switch, saved on the server. */
function OnlineSwitch({ online, onChange }: { online: boolean; onChange: (online: boolean) => Promise<void> }) {
  const { t } = useTranslation();
  const { run, busy, error } = useAction();
  return (
    <span className="right">
      <button
        type="button"
        role="switch"
        aria-checked={online}
        aria-label={t('pro.onlineSwitch')}
        className={`online ${online ? '' : 'off'}`}
        disabled={busy}
        onClick={() => void run(() => onChange(!online))}
      >
        {online && <span className="lamp" aria-hidden="true" />}
        {online ? t('pro.online') : t('pro.offline')}
        <span className={`toggle sm ${online ? 'on' : ''}`} aria-hidden="true" />
      </button>
      <ErrorText error={error} />
    </span>
  );
}

/**
 * A pro who is not working yet: a new one fills in the Application page, everyone else sees where their
 * application stands (D93).
 */
function ApplicationStatus({ profile }: { profile: ProProfile }) {
  const { t } = useTranslation();
  if (profile.status === 'suspended') {
    return (
      <div className="body">
        <p className="card" role="alert">
          {t('apply.suspended')}
        </p>
      </div>
    );
  }
  return <Navigate to={profile.status === 'draft' ? '/pro/apply' : '/pro/application'} replace />;
}

export function ProHomePage() {
  const { t } = useTranslation();
  const api = useApi();
  const user = useUser();
  const load = useCallback(() => api.get<{ profile: ProProfile }>('/pro/profile'), [api]);
  const { state, reload, update } = useResource(load);
  const [announce, setAnnounce] = useState('');

  async function setOnline(online: boolean) {
    const result = await api.put<{ online: boolean }>('/pro/online', { online });
    update((current) => ({ profile: { ...current.profile, online: result.online } }));
    setAnnounce(result.online ? t('pro.nowOnline') : t('pro.nowOffline'));
  }

  const profile = state.status === 'ready' ? state.data.profile : null;
  const working = profile !== null && ['approved', 'pending_approval'].includes(profile.status);
  return (
    <>
      <header className="prohead">
        <div className="row between">
          <h1>{working ? t('pro.jobsTitle') : t('apply.title')}</h1>
          {profile?.status === 'approved' && <OnlineSwitch online={profile.online !== false} onChange={setOnline} />}
        </div>
        {profile && (
          <p className="small subtle">
            {[user.firstName, ...(profile.tradeNames ?? [])].filter(Boolean).join(' · ')} ·{' '}
            <Stars average={profile.ratingAverage} count={profile.ratingCount} />
          </p>
        )}
        <span className="visually-hidden" role="status">
          {announce}
        </span>
      </header>
      <ResourceState state={state} reload={reload}>
        {({ profile: current }) =>
          current.status === 'approved' || current.status === 'pending_approval' ? (
            <>
              {current.status === 'pending_approval' && (
                <div className="body">
                  <div className="info amber" role="alert">
                    <Icon name="file" />
                    <p>
                      <b>{t('apply.pendingApproval')}</b> {t('apply.pendingApprovalHint')}{' '}
                      <Link to="/pro/profile">{t('apply.uploadNow')}</Link>
                    </p>
                  </div>
                </div>
              )}
              {current.jobsPaused && (
                <div className="body">
                  <p className="info amber" role="status">
                    {t('apply.jobsPaused')}
                  </p>
                </div>
              )}
              <ApprovedHome profile={current} onOnline={setOnline} />
            </>
          ) : (
            <ApplicationStatus profile={current} />
          )
        }
      </ResourceState>
    </>
  );
}
