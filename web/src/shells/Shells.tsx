import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { useAuth, useUser } from '../auth/AuthContext';
import { Icon, type IconKey } from '../components/Icon';

interface Tab {
  to: string;
  icon: IconKey;
  label: string;
  end?: boolean;
}

function TabBar({ tabs, label }: { tabs: Tab[]; label: string }) {
  return (
    <nav className="tabbar" aria-label={label}>
      {tabs.map((tab) => (
        <NavLink key={tab.to} to={tab.to} end={tab.end} className={({ isActive }) => (isActive ? 'on' : '')}>
          <Icon name={tab.icon} />
          <span>{tab.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

/** The phone-first frame of the customer app. */
export function CustomerShell() {
  const { t } = useTranslation();
  return (
    <div className="app-frame">
      <main className="app-body">
        <Outlet />
      </main>
      <TabBar
        label={t('nav.customer')}
        tabs={[
          { to: '/', icon: 'home', label: t('nav.home'), end: true },
          { to: '/bookings', icon: 'list', label: t('nav.bookings') },
          { to: '/plans', icon: 'repeat', label: t('nav.plans') },
          { to: '/account', icon: 'user', label: t('nav.account') },
        ]}
      />
    </div>
  );
}

/** The phone-first frame of the pro app, with its dark header colour. */
export function ProShell() {
  const { t } = useTranslation();
  return (
    <div className="app-frame pro">
      <main className="app-body">
        <Outlet />
      </main>
      <TabBar
        label={t('nav.pro')}
        tabs={[
          { to: '/pro', icon: 'list', label: t('nav.jobs'), end: true },
          { to: '/pro/week', icon: 'calendar', label: t('nav.week') },
          { to: '/pro/profile', icon: 'user', label: t('nav.profile') },
        ]}
      />
    </div>
  );
}

export function AppHeader({ title, back, right }: { title: string; back?: string; right?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <header className="appbar">
      {back && (
        <Link to={back} className="iconbtn" aria-label={t('common.back')}>
          <Icon name="chevL" />
        </Link>
      )}
      <h1>{title}</h1>
      {right}
    </header>
  );
}

/** The desktop control panel for the MISK team. */
export function AdminShell() {
  const { t } = useTranslation();
  const { logout } = useAuth();
  const user = useUser();
  const navigate = useNavigate();
  const links: Tab[] = [
    { to: '/admin', icon: 'chart', label: t('admin.nav.overview'), end: true },
    { to: '/admin/bookings', icon: 'calendar', label: t('admin.nav.bookings') },
    { to: '/admin/providers', icon: 'users', label: t('admin.nav.providers') },
    { to: '/admin/plans', icon: 'repeat', label: t('admin.nav.plans') },
    { to: '/admin/catalogue', icon: 'grid', label: t('admin.nav.catalogue') },
    { to: '/admin/settings', icon: 'sliders', label: t('admin.nav.settings') },
  ];
  return (
    <div className="admin">
      <nav className="aside" aria-label={t('admin.nav.label')}>
        <div className="logo">
          <span className="logo-mark">
            <Icon name="leaf" />
          </span>
          <span>{t('admin.title')}</span>
        </div>
        {links.map((link) => (
          <NavLink key={link.to} to={link.to} end={link.end} className={({ isActive }) => (isActive ? 'on' : '')}>
            <Icon name={link.icon} />
            <span>{link.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="admin-content">
        <header className="admin-top">
          <span className="badge b">
            <Icon name="user" /> {t('admin.signedIn', { name: user.email ?? user.username ?? '' })}
          </span>
          <button type="button" className="abtn ghost" onClick={() => void logout().then(() => navigate('/admin/login'))}>
            <Icon name="logout" /> {t('common.signOut')}
          </button>
        </header>
        <main className="amain">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
