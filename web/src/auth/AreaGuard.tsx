import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router';
import type { AdminArea, User } from '../api/types';
import { useUser } from './AuthContext';

/** Whether this admin's team role opens an area. Older sessions without areas open everything. */
export function canOpen(user: User, area: AdminArea): boolean {
  return user.areas?.includes(area) ?? true;
}

/** The Settings tabs in order, with the area each needs. */
export const SETTINGS_TABS: { path: string; area: AdminArea }[] = [
  { path: '/admin/settings', area: 'fees' },
  { path: '/admin/settings/area', area: 'zones' },
  { path: '/admin/settings/notifications', area: 'notifications' },
  { path: '/admin/settings/team', area: 'team' },
];

/** The first Settings tab this admin may open, or null. */
export function firstSettingsTab(user: User): string | null {
  return SETTINGS_TABS.find((tab) => canOpen(user, tab.area))?.path ?? null;
}

/**
 * Shows a page only to team roles that may open it; the API refuses the others too. Settings sends an
 * admin without Fees to the first tab they may open.
 */
export function AreaGuard({ area, children }: { area: AdminArea; children: ReactNode }) {
  const { t } = useTranslation();
  const user = useUser();
  if (canOpen(user, area)) {
    return children;
  }
  const settingsTab = area === 'fees' ? firstSettingsTab(user) : null;
  if (settingsTab && settingsTab !== '/admin/settings') {
    return <Navigate to={settingsTab} replace />;
  }
  return (
    <p className="panel muted" role="alert">
      {t('errors.no_access')}
    </p>
  );
}
