import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
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
import { dateTime, euro, time } from '../../lib/format';
import { loadSchedule } from '../../lib/proSchedule';
import { useAction } from '../../lib/useAction';
import { usePolling } from '../../lib/usePolling';
import { ApplicationForm } from './ApplicationForm';
import { ProPlansSection } from './ProVisitPage';

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

  async function accept() {
    const result = await run(() => api.post<{ job: ProJob }>(`/pro/offers/${offer.id}/accept`));
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
          <dd>{dateTime(offer.startsAt, timezone)}</dd>
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
          <dd>{offer.customerName}</dd>
          {offer.notes && (
            <>
              <dt>
                <Icon name="chat" label={t('offer.notes')} />
              </dt>
              <dd className="small">“{offer.notes}”</dd>
            </>
          )}
        </dl>
        <PhotoGrid ids={offer.photoIds} label={t('offer.photos')} />
        <p className="info">
          <Icon name="shield" /> {t('offer.paymentSecured')}
        </p>
        <ErrorText error={error} />
        <div className="row gap8">
          <button type="button" className="btn2 no" disabled={busy || seconds === 0} onClick={() => void decline()}>
            {t('offer.decline')}
          </button>
          <button type="button" className="btn2 yes" disabled={busy || seconds === 0} onClick={() => void accept()}>
            {t('offer.accept')}
          </button>
        </div>
      </div>
    </article>
  );
}

function ApprovedHome({ profile }: { profile: ProProfile }) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const loadOffers = useCallback(() => api.get<{ offers: Offer[] }>('/pro/offers'), [api]);
  const offers = useResource(loadOffers);
  const loadJobs = useCallback(() => loadSchedule(api), [api]);
  const jobs = useResource(loadJobs);
  usePolling(offers.reload, 10_000);
  usePolling(jobs.reload, 30_000);

  return (
    <div className="body">
      {!profile.payoutsEnabled && (
        <Link to="/pro/profile" className="info amber link-card">
          <Icon name="card" /> {t('pro.payoutsNeeded')}
        </Link>
      )}
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
      <h2 className="h-sm">{t('pro.upcoming')}</h2>
      <ResourceState state={jobs.state} reload={jobs.reload}>
        {(list) => {
          const open = list.filter((item) => !item.closed);
          return open.length === 0 ? (
            <p className="muted small">{t('pro.noJobs')}</p>
          ) : (
            <ul className="stack">
              {open.map((item) => (
                <li key={item.key}>
                  <Link to={item.href} className={`job link-card ${item.kind === 'visit' ? 'rec' : ''}`}>
                    <span className="jt">{time(item.startsAt, timezone)}</span>
                    <span className="grow">
                      <span className="b small block">{item.title}</span>
                      <span className="tiny muted">
                        {dateTime(item.startsAt, timezone)} · {item.address}
                      </span>
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
      <ProPlansSection />
    </div>
  );
}

function ApplicationStatus({ profile, onChange }: { profile: ProProfile; onChange: (p: ProProfile) => void }) {
  const { t } = useTranslation();
  if (profile.status === 'submitted') {
    return (
      <div className="body">
        <div className="card center">
          <Icon name="clock" className="big-icon" />
          <h2 className="b">{t('apply.underReview')}</h2>
          <p className="muted small">{t('apply.underReviewText')}</p>
        </div>
      </div>
    );
  }
  if (profile.status === 'suspended') {
    return (
      <div className="body">
        <p className="card" role="alert">
          {t('apply.suspended')}
        </p>
      </div>
    );
  }
  return (
    <div className="body">
      {profile.status === 'info_requested' && (
        <div className="info amber" role="alert">
          <Icon name="chat" />
          <p>
            {t('apply.infoRequested')} <b>{profile.reviewNote}</b> {t('apply.infoRequestedHint')}
          </p>
        </div>
      )}
      {profile.status === 'rejected' && (
        <div className="info amber" role="alert">
          <Icon name="file" />
          <p>
            {t('apply.rejected')} <b>{profile.reviewNote}</b>
          </p>
        </div>
      )}
      <p className="muted">{t('apply.intro')}</p>
      <ApplicationForm profile={profile} onChange={onChange} />
    </div>
  );
}

export function ProHomePage() {
  const { t } = useTranslation();
  const api = useApi();
  const user = useUser();
  const load = useCallback(() => api.get<{ profile: ProProfile }>('/pro/profile'), [api]);
  const { state, reload, update } = useResource(load);

  return (
    <>
      <header className="prohead">
        <div className="row between">
          <h1>{state.status === 'ready' && ['approved', 'pending_approval'].includes(state.data.profile.status) ? t('pro.jobsTitle') : t('apply.title')}</h1>
          {state.status === 'ready' && state.data.profile.status === 'approved' && (
            <span className="online">
              <span className="lamp" aria-hidden="true" /> {t('pro.online')}
            </span>
          )}
        </div>
        {state.status === 'ready' && (
          <p className="small subtle">
            {user.firstName} · <Stars average={state.data.profile.ratingAverage} count={state.data.profile.ratingCount} />
          </p>
        )}
      </header>
      <ResourceState state={state} reload={reload}>
        {({ profile }) =>
          profile.status === 'approved' || profile.status === 'pending_approval' ? (
            <>
              {profile.status === 'pending_approval' && (
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
              {profile.jobsPaused && (
                <div className="body">
                  <p className="info amber" role="status">
                    {t('apply.jobsPaused')}
                  </p>
                </div>
              )}
              <ApprovedHome profile={profile} />
            </>
          ) : (
            <ApplicationStatus profile={profile} onChange={(next) => update(() => ({ profile: next }))} />
          )
        }
      </ResourceState>
    </>
  );
}
