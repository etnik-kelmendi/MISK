import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Icon } from '../components/Icon';

/**
 * Shown once a person has deleted their own account (D97). Opened from "Delete account", it signs the app out
 * (the API already ended every session); it is outside the signed-in pages, so signing out does not send the
 * person to Log in first.
 */
export function AccountDeletedPage() {
  const { t } = useTranslation();
  const { logout } = useAuth();
  const location = useLocation();
  const signOut = (location.state as { signOut?: boolean } | null)?.signOut === true;
  const done = useRef(false);

  useEffect(() => {
    if (!signOut || done.current) return;
    done.current = true;
    void logout();
  }, [logout, signOut]);

  return (
    <div className="app-frame signin-frame">
      <main className="app-body">
        <div className="signin stack">
          <div className="signin-hero small-hero">
            <span className="logo-mark big">
              <Icon name="leaf" />
            </span>
            <h1>{t('accountDeleted.title')}</h1>
          </div>
          <p className="center">{t('accountDeleted.text')}</p>
          <p className="small muted center">{t('accountDeleted.records')}</p>
          <Link to="/signin" className="cta center">
            {t('accountDeleted.start')}
          </Link>
        </div>
      </main>
    </div>
  );
}
