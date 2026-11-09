import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router';
import type { AdminArea } from '../../api/types';
import { useUser } from '../../auth/AuthContext';
import { SaveStatusProvider } from './settings/SaveStatus';

const TABS: { to: string; key: 'fees' | 'area' | 'notifications' | 'team'; area: AdminArea; end?: boolean }[] = [
  { to: '/admin/settings', key: 'fees', area: 'fees', end: true },
  { to: '/admin/settings/area', key: 'area', area: 'zones' },
  { to: '/admin/settings/notifications', key: 'notifications', area: 'notifications' },
  { to: '/admin/settings/team', key: 'team', area: 'team' },
];

/** The platform's rules in four tabs. Every change saves by itself, shown by one label at the top. */
export function SettingsLayout() {
  const { t } = useTranslation();
  const user = useUser();
  const tabs = TABS.filter((tab) => user.areas?.includes(tab.area) ?? true);
  return (
    <SaveStatusProvider>
      {(label) => (
        <>
          <div className="row between wrap gap8">
            <h1>{t('admin.settings.title')}</h1>
            {label}
          </div>
          <nav className="seg tabs" aria-label={t('admin.settings.tabs.label')}>
            {tabs.map((tab) => (
              <NavLink key={tab.to} to={tab.to} end={tab.end} className={({ isActive }) => (isActive ? 'on' : '')}>
                {t(`admin.settings.tabs.${tab.key}`)}
              </NavLink>
            ))}
          </nav>
          <Outlet />
        </>
      )}
    </SaveStatusProvider>
  );
}
