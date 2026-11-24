import { useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { useApi } from '../../../api/ApiContext';
import type { FavouritePro } from '../../../api/types';
import { useResource } from '../../../api/useResource';
import { useAuth, useUser } from '../../../auth/AuthContext';
import { Icon, type IconKey } from '../../../components/Icon';
import { Avatar } from '../../../components/Photos';
import { useInbox } from '../../../inbox/InboxContext';
import { AppHeader } from '../../../shells/Shells';
import { useAddresses } from '../Addresses';

/** Where Profile's sections live (D92). Receipts are the "Past & receipts" tab of Bookings (D67). */
export const PROFILE_PATHS = {
  personal: '/profile/personal',
  addresses: '/profile/addresses',
  payments: '/profile/payments',
  receipts: '/bookings?tab=past',
  notifications: '/profile/notifications',
  favourites: '/favourites',
  becomePro: '/profile/become-a-pro',
  help: '/profile/help',
  legal: '/profile/terms',
} as const;

/** "Sara Meier", or just the first name. */
export function fullName(user: { firstName: string | null; lastName: string | null }): string {
  return [user.firstName, user.lastName].filter(Boolean).join(' ');
}

/** One row of a Profile list: icon, label, an optional value and the arrow. */
function ProfileRow({ to, icon, label, value, state }: { to: string; icon: IconKey; label: string; value?: ReactNode; state?: unknown }) {
  return (
    <li>
      <Link to={to} state={state} className="lrow">
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

/** The way to Messages from Profile (D89), with the number of unread ones (D87). */
function MessagesRow() {
  const { t } = useTranslation();
  const { inbox } = useInbox();
  const unread = inbox?.unread ?? 0;
  return (
    <Link to="/messages" className="card row link-card">
      <Icon name="chat" />
      <span className="grow b">{t('nav.messages')}</span>
      {unread > 0 && <span className="badge r">{t('account.unread', { count: unread })}</span>}
      <Icon name="chevR" />
    </Link>
  );
}

/**
 * The customer's Profile (D92): photo, name and phone number with Edit, the Account and MISK lists, and Log out.
 * A pro booking for themselves (D64) finds "Pro app" where customers find "Become a pro".
 */
export function ProfilePage() {
  const { t } = useTranslation();
  const api = useApi();
  const user = useUser();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const addresses = useAddresses();
  const loadFavourites = useCallback(() => api.get<{ pros: FavouritePro[] }>('/favourites/pros'), [api]);
  const favourites = useResource(loadFavourites);
  const name = fullName(user) || t('profile.noName');
  const isPro = user.role === 'pro';
  const addressCount = addresses.state.status === 'ready' ? addresses.state.data.addresses.length : null;
  const favouriteCount = favourites.state.status === 'ready' ? favourites.state.data.pros.length : null;
  // Sub-pages go back to Profile; Favourites is also opened from Home.
  const fromProfile = { back: '/profile' };

  return (
    <>
      <AppHeader title={t('nav.profile')} />
      <div className="body">
        <section className="card row profile-head" aria-label={t('profile.you')}>
          <Avatar name={name} />
          <span className="grow">
            <span className="b block profile-name">{name}</span>
            <span className="small muted block">{user.phone ?? user.email ?? t('profile.noPhone')}</span>
          </span>
          <Link to={PROFILE_PATHS.personal} className="mini-btn" aria-label={t('profile.editLabel')}>
            {t('profile.edit')}
          </Link>
        </section>
        <MessagesRow />

        <h2 className="h-sm">{t('profile.account')}</h2>
        <ul className="lgroup plist" aria-label={t('profile.account')}>
          <ProfileRow to={PROFILE_PATHS.personal} icon="user" label={t('profile.personal')} />
          <ProfileRow
            to={PROFILE_PATHS.addresses}
            icon="pin"
            label={t('profile.addresses')}
            value={addressCount ? <span>{addressCount}</span> : null}
          />
          <ProfileRow to={PROFILE_PATHS.payments} icon="card" label={t('profile.payments')} />
          <ProfileRow to={PROFILE_PATHS.receipts} icon="file" label={t('profile.receipts')} />
          {!isPro && <ProfileRow to={PROFILE_PATHS.notifications} icon="bell" label={t('profile.notifications')} />}
        </ul>

        <h2 className="h-sm">{t('profile.misk')}</h2>
        <ul className="lgroup plist" aria-label={t('profile.misk')}>
          <ProfileRow
            to={PROFILE_PATHS.favourites}
            state={fromProfile}
            icon="heart"
            label={t('profile.favourites')}
            value={favouriteCount ? <span>{favouriteCount}</span> : null}
          />
          {isPro ? (
            <ProfileRow to="/pro" icon="wrench" label={t('nav.proApp')} />
          ) : (
            <ProfileRow
              to={PROFILE_PATHS.becomePro}
              icon="wrench"
              label={t('profile.becomePro')}
              value={<span className="badge g">{t('profile.sameAccount')}</span>}
            />
          )}
          <ProfileRow to={PROFILE_PATHS.help} icon="help" label={t('profile.help')} />
          <ProfileRow to={PROFILE_PATHS.legal} icon="shield" label={t('profile.legal')} />
        </ul>

        <div className="lgroup">
          <button type="button" className="lrow" onClick={() => void logout().then(() => navigate('/signin'))}>
            <span className="li" aria-hidden="true">
              <Icon name="logout" />
            </span>
            <span className="grow">{t('profile.logOut')}</span>
          </button>
        </div>
      </div>
    </>
  );
}
