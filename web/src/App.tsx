import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { createBrowserRouter, Link, Navigate, Route, RouterProvider, Routes } from 'react-router';
import { ApiProvider } from './api/ApiContext';
import { createApi } from './api/client';
import { MarketProvider } from './api/MarketContext';
import { AuthProvider } from './auth/AuthContext';
import { RequireRole } from './auth/RequireRole';
import type { AppConfig, Site } from './config';
import { AccountPage } from './pages/AccountPage';
import { AdminBookingRedirect } from './pages/admin/AdminBookingPage';
import { AdminBookingsPage } from './pages/admin/AdminBookingsPage';
import { AdminLoginPage } from './pages/admin/AdminLoginPage';
import { AdminSignUpPage } from './pages/admin/AdminSignUpPage';
import { ApproveRequestPage } from './pages/admin/ApproveRequestPage';
import { AdminProRedirect, AdminProsPage } from './pages/admin/AdminProsPage';
import { AreasPage } from './pages/admin/AreasPage';
import { CataloguePage } from './pages/admin/CataloguePage';
import { OverviewPage } from './pages/admin/OverviewPage';
import { JoinTeamPage } from './pages/admin/JoinTeamPage';
import { ResetPasswordPage } from './pages/admin/ResetPasswordPage';
import { PlanEditorPage, PlansPage } from './pages/admin/PlansPage';
import { SettingsLayout } from './pages/admin/SettingsLayout';
import { SettingsPage } from './pages/admin/SettingsPage';
import { NotificationsPage } from './pages/admin/NotificationsPage';
import { AreaGuard } from './auth/AreaGuard';
import { TeamPage } from './pages/admin/TeamPage';
import { BookingPage } from './pages/customer/BookingPage';
import { BookingsPage } from './pages/customer/BookingsPage';
import { BookPage } from './pages/customer/BookPage';
import { CategoryPage } from './pages/customer/CategoryPage';
import { CustomerPlansPage } from './pages/customer/CustomerPlansPage';
import { MyPlanPage } from './pages/customer/MyPlanPage';
import { SubscribePage } from './pages/customer/SubscribePage';
import { HomePage } from './pages/customer/HomePage';
import { ProHomePage } from './pages/pro/ProHomePage';
import { ProJobPage } from './pages/pro/ProJobPage';
import { ProProfilePage } from './pages/pro/ProProfilePage';
import { ProVisitPage } from './pages/pro/ProVisitPage';
import { ProWeekPage } from './pages/pro/ProWeekPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { ResetPasswordPage as AppResetPasswordPage } from './pages/ResetPasswordPage';
import { SignInPage } from './pages/SignInPage';
import { SignUpPage } from './pages/SignUpPage';
import { MessagesPage } from './pages/MessagesPage';
import { TermsPage } from './pages/TermsPage';
import { VerifyEmailPage } from './pages/VerifyEmailPage';
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

function CustomerAndProRoutes() {
  return (
    <Routes>
      <Route path="/signin" element={<SignInPage />} />
      <Route path="/signup" element={<SignUpPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<AppResetPasswordPage />} />
      <Route path="/terms" element={<TermsPage />} />
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
        <Route path="plans" element={<CustomerPlansPage />} />
        <Route path="plans/:id" element={<SubscribePage />} />
        <Route path="my-plans/:id" element={<MyPlanPage />} />
        <Route path="messages" element={<MessagesPage />} />
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
        <Route path="visits/:id" element={<ProVisitPage />} />
        <Route path="week" element={<ProWeekPage />} />
        <Route path="profile" element={<ProProfilePage />} />
        <Route path="messages" element={<MessagesPage />} />
        <Route path="account" element={<AccountPage />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

/** The control panel, served as its own website (D20). */
function AdminRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/admin" replace />} />
      <Route path="/admin/login" element={<AdminLoginPage />} />
      <Route path="/admin/signup" element={<AdminSignUpPage />} />
      <Route path="/admin/approve" element={<ApproveRequestPage />} />
      <Route path="/admin/reset-password" element={<ResetPasswordPage />} />
      <Route path="/admin/join" element={<JoinTeamPage />} />
      <Route
        path="admin"
        element={
          <RequireRole allow="admin">
            <AdminShell />
          </RequireRole>
        }
      >
        <Route index element={<OverviewPage />} />
        <Route
          path="bookings"
          element={
            <AreaGuard area="bookings">
              <AdminBookingsPage />
            </AreaGuard>
          }
        />
        <Route path="bookings/:id" element={<AdminBookingRedirect />} />
        <Route
          path="providers"
          element={
            <AreaGuard area="providers">
              <AdminProsPage />
            </AreaGuard>
          }
        />
        <Route path="providers/:id" element={<AdminProRedirect />} />
        <Route
          path="plans"
          element={
            <AreaGuard area="plans">
              <PlansPage />
            </AreaGuard>
          }
        />
        <Route
          path="plans/new"
          element={
            <AreaGuard area="plans">
              <PlanEditorPage />
            </AreaGuard>
          }
        />
        <Route
          path="plans/:id"
          element={
            <AreaGuard area="plans">
              <PlanEditorPage />
            </AreaGuard>
          }
        />
        <Route
          path="catalogue"
          element={
            <AreaGuard area="catalogue">
              <CataloguePage />
            </AreaGuard>
          }
        />
        <Route path="settings" element={<SettingsLayout />}>
          <Route
            index
            element={
              <AreaGuard area="fees">
                <SettingsPage />
              </AreaGuard>
            }
          />
          <Route
            path="area"
            element={
              <AreaGuard area="zones">
                <AreasPage />
              </AreaGuard>
            }
          />
          <Route
            path="notifications"
            element={
              <AreaGuard area="notifications">
                <NotificationsPage />
              </AreaGuard>
            }
          />
          <Route
            path="team"
            element={
              <AreaGuard area="team">
                <TeamPage />
              </AreaGuard>
            }
          />
          <Route path="areas" element={<Navigate to="/admin/settings/area" replace />} />
        </Route>
        {/* Earlier addresses keep working. */}
        <Route path="pros/*" element={<Navigate to="/admin/providers" replace />} />
        <Route path="areas" element={<Navigate to="/admin/settings/area" replace />} />
        <Route path="team" element={<Navigate to="/admin/settings/team" replace />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

/** The pages of one website: the customer and pro app, or the admin control panel. */
export function AppRoutes({ site }: { site: Site }) {
  return site === 'admin' ? <AdminRoutes /> : <CustomerAndProRoutes />;
}

export function App({ config }: { config: AppConfig }) {
  const api = useMemo(() => createApi(config.apiBaseUrl), [config.apiBaseUrl]);
  const router = useMemo(() => createBrowserRouter([{ path: '*', element: <AppRoutes site={config.site} /> }]), [config.site]);
  return (
    <ApiProvider api={api} config={config}>
      <AuthProvider>
        <MarketProvider>
          <RouterProvider router={router} />
        </MarketProvider>
      </AuthProvider>
    </ApiProvider>
  );
}
