import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation } from 'react-router';
import type { Role } from '../api/types';
import { useAuth } from './AuthContext';

export const HOME_OF: Record<Role, string> = { customer: '/', pro: '/pro', admin: '/admin' };

/** Only renders its children for the given role; everyone else is sent where they belong. */
export function RequireRole({ allow: role, children }: { allow: Role; children: ReactNode }) {
  const { t } = useTranslation();
  const { state, refresh } = useAuth();
  const location = useLocation();

  if (state.status === 'loading') {
    return (
      <p className="muted center pad" role="status">
        {t('common.loading')}
      </p>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="card center pad" role="alert">
        <p>{t('common.loadFailed')}</p>
        <button type="button" className="btn btn-ghost" onClick={refresh}>
          {t('common.retry')}
        </button>
      </div>
    );
  }
  if (state.status === 'signedOut') {
    const target = role === 'admin' ? '/admin/login' : '/signin';
    return <Navigate to={target} replace state={{ from: location.pathname }} />;
  }
  const userRole = state.user.role;
  if (!userRole) {
    return <Navigate to="/signin" replace />;
  }
  if (userRole !== role) {
    return <Navigate to={HOME_OF[userRole]} replace />;
  }
  return <>{children}</>;
}
