import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserRouter, Link, Route, Routes } from 'react-router';
import { ApiProvider } from './api/ApiContext';
import { createApi } from './api/client';
import { MarketProvider } from './api/MarketContext';
import { AuthProvider } from './auth/AuthContext';
import { RequireRole } from './auth/RequireRole';
import type { AppConfig } from './config';
import { AccountPage } from './pages/AccountPage';
import { AdminBookingPage } from './pages/admin/AdminBookingPage';
import { AdminBookingsPage } from './pages/admin/AdminBookingsPage';
import { AdminLoginPage } from './pages/admin/AdminLoginPage';
import { AdminProPage, AdminProsPage } from './pages/admin/AdminProsPage';
import { AreasPage } from './pages/admin/AreasPage';
import { CataloguePage } from './pages/admin/CataloguePage';
import { OverviewPage } from './pages/admin/OverviewPage';
import { SettingsPage } from './pages/admin/SettingsPage';
import { TeamPage } from './pages/admin/TeamPage';
import { BookingPage } from './pages/customer/BookingPage';
import { BookingsPage } from './pages/customer/BookingsPage';
import { BookPage } from './pages/customer/BookPage';
import { CategoryPage } from './pages/customer/CategoryPage';
import { HomePage } from './pages/customer/HomePage';
import { ProHomePage } from './pages/pro/ProHomePage';
import { ProJobPage } from './pages/pro/ProJobPage';
import { ProProfilePage } from './pages/pro/ProProfilePage';
import { ProWeekPage } from './pages/pro/ProWeekPage';
import { SignInPage } from './pages/SignInPage';
import { AdminShell, CustomerShell, ProShell } from './shells/Shells';

function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <main className="app-frame center pad">
      <h1>{t('notFound.title')}</h1>
      <p>
        <Link to="/">{t('notFound.home')}</Link>
      </p>
    </main>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/signin" element={<SignInPage />} />
      <Route path="/admin/login" element={<AdminLoginPage />} />
      <Route
        element={
          <RequireRole allow="customer">
            <CustomerShell />
          </RequireRole>
        }
      >
        <Route index element={<HomePage />} />
        <Route path="category/:slug" element={<CategoryPage />} />
        <Route path="book/:serviceId" element={<BookPage />} />
        <Route path="bookings" element={<BookingsPage />} />
        <Route path="bookings/:id" element={<BookingPage />} />
        <Route path="account" element={<AccountPage />} />
      </Route>
      <Route
        path="pro"
        element={
          <RequireRole allow="pro">
            <ProShell />
          </RequireRole>
        }
      >
        <Route index element={<ProHomePage />} />
        <Route path="jobs/:id" element={<ProJobPage />} />
        <Route path="week" element={<ProWeekPage />} />
        <Route path="profile" element={<ProProfilePage />} />
        <Route path="account" element={<AccountPage />} />
      </Route>
      <Route
        path="admin"
        element={
          <RequireRole allow="admin">
            <AdminShell />
          </RequireRole>
        }
      >
        <Route index element={<OverviewPage />} />
        <Route path="bookings" element={<AdminBookingsPage />} />
        <Route path="bookings/:id" element={<AdminBookingPage />} />
        <Route path="pros" element={<AdminProsPage />} />
        <Route path="pros/:id" element={<AdminProPage />} />
        <Route path="catalogue" element={<CataloguePage />} />
        <Route path="areas" element={<AreasPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="team" element={<TeamPage />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

export function App({ config }: { config: AppConfig }) {
  const api = useMemo(() => createApi(config.apiBaseUrl), [config.apiBaseUrl]);
  return (
    <ApiProvider api={api} config={config}>
      <AuthProvider>
        <MarketProvider>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </MarketProvider>
      </AuthProvider>
    </ApiProvider>
  );
}
