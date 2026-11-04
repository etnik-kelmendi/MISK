import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router';

/** Settings holds the marketplace fees, the served areas and the admin team, one tab each. */
export function SettingsLayout() {
  const { t } = useTranslation();
  const tabs = [
    { to: '/admin/settings', label: t('admin.settings.tabs.fees'), end: true },
    { to: '/admin/settings/areas', label: t('admin.settings.tabs.areas') },
    { to: '/admin/settings/team', label: t('admin.settings.tabs.team') },
  ];
  return (
    <>
      <h1>{t('admin.settings.title')}</h1>
      <nav className="seg tabs" aria-label={t('admin.settings.tabs.label')}>
        {tabs.map((tab) => (
          <NavLink key={tab.to} to={tab.to} end={tab.end} className={({ isActive }) => (isActive ? 'on' : '')}>
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  );
}
