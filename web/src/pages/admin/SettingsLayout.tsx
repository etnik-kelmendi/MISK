import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router';
import type { AdminArea } from '../../api/types';
import { useUser } from '../../auth/AuthContext';
import { Icon, type IconKey } from '../../components/Icon';
import { SaveStatusProvider } from './settings/SaveStatus';

const TABS: { to: string; key: 'fees' | 'area' | 'notifications' | 'team'; area: AdminArea; icon: IconKey; end?: boolean }[] = [
  { to: '/admin/settings', key: 'fees', area: 'fees', icon: 'euro', end: true },
  { to: '/admin/settings/area', key: 'area', area: 'zones', icon: 'pin' },
  { to: '/admin/settings/notifications', key: 'notifications', area: 'notifications', icon: 'bell' },
  { to: '/admin/settings/team', key: 'team', area: 'team', icon: 'users' },
];

/**
 * The platform's rules in four sections, as in the product demo: a menu on the left, the section on the
 * right. Every change saves by itself, shown by one label at the top.
 */
export function SettingsLayout() {
  const { t } = useTranslation();
  const user = useUser();
  const tabs = TABS.filter((tab) => user.areas?.includes(tab.area) ?? true);
  return (
    <SaveStatusProvider>
      {(label) => (
        <>
          <div className="settings-head">
            <div>
              <h1>{t('admin.settings.title')}</h1>
              <p className="small muted">{t('admin.settings.subtitle')}</p>
            </div>
            {label}
          </div>
          <div className="sgrid">
            <nav className="snav panel" aria-label={t('admin.settings.tabs.label')}>
              {tabs.map((tab) => (
                <NavLink key={tab.to} to={tab.to} end={tab.end} className={({ isActive }) => (isActive ? 'on' : '')}>
                  <Icon name={tab.icon} />
                  {t(`admin.settings.tabs.${tab.key}`)}
                </NavLink>
              ))}
            </nav>
            <div className="stack">
              <Outlet />
            </div>
          </div>
        </>
      )}
    </SaveStatusProvider>
  );
}
