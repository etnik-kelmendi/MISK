import { useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { useApi } from '../../api/ApiContext';
import type { ProAvailability, ProProfile } from '../../api/types';
import { useResource } from '../../api/useResource';
import { useAuth, useUser } from '../../auth/AuthContext';
import { Icon, type IconKey } from '../../components/Icon';
import { Avatar } from '../../components/Photos';
import { ResourceState } from '../../components/ResourceState';
import { PRO_PROFILE_PATHS, type ProfileOverview } from './profile/types';

/** "Daniel K.": the first name and the initial of the last name, as customers see the pro. */
export function shortName(user: { firstName: string | null; lastName: string | null }): string {
  const initial = user.lastName?.trim().slice(0, 1);
  return [user.firstName?.trim(), initial ? `${initial.toUpperCase()}.` : null].filter(Boolean).join(' ');
}

/** One row of a Profile list: icon, label, an optional value and the arrow; it opens the section's page. */
export function ProfileRow({ to, icon, label, value }: { to: string; icon: IconKey; label: string; value?: ReactNode }) {
  return (
    <li>
      <Link to={to} className="lrow">
        <span className="li" aria-hidden="true">
          <Icon name={icon} />
        </span>
        <span className="grow">{label}</span>
        <span className="lv">
          {value}
          <Icon name="chevR" />
        </span>
      </Link>
    </li>
  );
}

/** "08:00–18:00", or "Holiday set" while a holiday is planned; days off (D99) are counted when there are any. */
function AvailabilityValue({ availability }: { availability: ProAvailability | undefined }) {
  const { t } = useTranslation();
  if (!availability) return null;
  if (availability.holidays.length > 0) {
    return <span className="badge">{t('proProfile.holidaySet')}</span>;
  }
  const daysOff = availability.daysOff?.length ?? 0;
  return (
    <span>
      {t('proProfile.hours', { from: availability.workStart, to: availability.workEnd })}
      {daysOff > 0 && ` · ${t('proProfile.daysOff', { count: daysOff })}`}
    </span>
  );
}

/** "1 expired" in red, "1 expiring" in orange, or "Checking" while a new copy waits for MISK. */
function DocumentsValue({ documents }: { documents: ProfileOverview['documents'] }) {
  const { t } = useTranslation();
  if (documents.expired > 0) return <span className="badge r">{t('proProfile.docsExpired', { count: documents.expired })}</span>;
  if (documents.expiring > 0) return <span className="badge">{t('proProfile.docsExpiring', { count: documents.expiring })}</span>;
  if (documents.checking > 0) return <span className="badge b">{t('proProfile.docsChecking')}</span>;
  return null;
}

/** The photo, name, trades, stars, finished jobs and, for an approved pro, "Verified pro". */
function ProfileHeader({ profile, overview }: { profile: ProProfile; overview: ProfileOverview | null }) {
  const { t } = useTranslation();
  const user = useUser();
  const name = shortName(user) || t('profile.noName');
  const facts = [
    (profile.tradeNames ?? []).join(', '),
    profile.ratingAverage !== null ? `★ ${profile.ratingAverage.toFixed(1)}` : null,
    overview ? t('proProfile.jobs', { count: overview.jobsDone }) : null,
  ].filter(Boolean);
  return (
    <header className="prohead pro-profile-head">
      <div className="row gap12">
        <Avatar name={name} photoId={profile.photoId} size="lg" />
        <div className="grow min0">
          <h1 className="pro-profile-name">{name}</h1>
          {facts.length > 0 && <p className="small muted pro-profile-facts">{facts.join(' · ')}</p>}
          {profile.status === 'approved' && (
            <span className="verified-badge">
              <Icon name="shield" /> {t('proProfile.verified')}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}

/**
 * The pro's Profile (D100): photo, name, trades, stars, finished jobs and "Verified pro" at the top, then the
 * Work, Performance and App groups, each row opening its page, and Log out. "Switch to customer app" opens Home
 * in the customer app with the same account (D64).
 */
export function ProProfilePage() {
  const { t } = useTranslation();
  const api = useApi();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const loadProfile = useCallback(() => api.get<{ profile: ProProfile }>('/pro/profile'), [api]);
  const loadOverview = useCallback(() => api.get<{ overview: ProfileOverview }>('/pro/profile/overview'), [api]);
  const profileState = useResource(loadProfile);
  const overviewState = useResource(loadOverview);
  const overview = overviewState.state.status === 'ready' ? overviewState.state.data.overview : null;

  return (
    <ResourceState state={profileState.state} reload={profileState.reload}>
      {({ profile }) => (
        <>
          <ProfileHeader profile={profile} overview={overview} />
          <div className="body">
            <h2 className="h-sm first">{t('proProfile.work')}</h2>
            <ul className="lgroup plist" aria-label={t('proProfile.work')}>
              <ProfileRow to={PRO_PROFILE_PATHS.personal} icon="user" label={t('proProfile.personal')} />
              <ProfileRow to={PRO_PROFILE_PATHS.work} icon="wrench" label={t('proProfile.workInfo')} />
              <ProfileRow
                to={PRO_PROFILE_PATHS.availability}
                icon="clock"
                label={t('proProfile.availability')}
                value={<AvailabilityValue availability={profile.availability} />}
              />
              <ProfileRow
                to={PRO_PROFILE_PATHS.documents}
                icon="file"
                label={t('proProfile.documents')}
                value={overview && <DocumentsValue documents={overview.documents} />}
              />
              <ProfileRow
                to={PRO_PROFILE_PATHS.bank}
                icon="card"
                label={t('proProfile.bank')}
                value={overview?.bankLast4 ? <span>{t('proProfile.last4', { last4: overview.bankLast4 })}</span> : null}
              />
            </ul>

            <h2 className="h-sm">{t('proProfile.performanceGroup')}</h2>
            <ul className="lgroup plist" aria-label={t('proProfile.performanceGroup')}>
              <ProfileRow
                to={PRO_PROFILE_PATHS.ratings}
                icon="sparkle"
                label={t('proProfile.ratings')}
                value={profile.ratingAverage !== null ? <span>{t('proProfile.ratingValue', { rating: profile.ratingAverage.toFixed(1) })}</span> : null}
              />
              <ProfileRow
                to={PRO_PROFILE_PATHS.performance}
                icon="chart"
                label={t('proProfile.performance')}
                value={overview?.topPercent ? <span className="badge g">{t('proProfile.top', { pct: overview.topPercent })}</span> : null}
              />
            </ul>

            <h2 className="h-sm">{t('proProfile.app')}</h2>
            <ul className="lgroup plist" aria-label={t('proProfile.app')}>
              <ProfileRow to={PRO_PROFILE_PATHS.notifications} icon="bell" label={t('proProfile.notifications')} />
              <ProfileRow to={PRO_PROFILE_PATHS.help} icon="help" label={t('proProfile.help')} />
              <ProfileRow to={PRO_PROFILE_PATHS.terms} icon="shield" label={t('proProfile.terms')} />
              {/* The customer app with the same account (D64): its last tab leads back here. */}
              <ProfileRow to="/" icon="repeat" label={t('proProfile.switchApp')} />
            </ul>

            <div className="lgroup">
              <button type="button" className="lrow" onClick={() => void logout().then(() => navigate('/signin'))}>
                <span className="li" aria-hidden="true">
                  <Icon name="logout" />
                </span>
                <span className="grow">{t('proProfile.logOut')}</span>
              </button>
            </div>
          </div>
        </>
      )}
    </ResourceState>
  );
}
