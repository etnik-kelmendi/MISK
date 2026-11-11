import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate } from 'react-router';
import { useApi } from '../../api/ApiContext';
import type { User } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { HOME_OF } from '../../auth/RequireRole';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { useAction } from '../../lib/useAction';
import { isValidEmail } from '../../lib/checks';

/** Emails a reset link to the admin's address. The answer never says whether the account exists. */
function ForgotPassword({ initial }: { initial: string }) {
  const { t } = useTranslation();
  const api = useApi();
  // A username typed into sign-in is not carried over: the reset needs the account's email.
  const [email, setEmail] = useState(isValidEmail(initial) ? initial.trim() : '');
  const [touched, setTouched] = useState(false);
  const [sent, setSent] = useState(false);
  const { run, busy, error } = useAction();
  const emailError = !touched
    ? null
    : !email.trim()
      ? t('validation.emailMissing')
      : !isValidEmail(email)
        ? t('signUp.errors.email')
        : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!isValidEmail(email)) {
      return;
    }
    const ok = await run(() => api.post('/auth/admin/forgot', { identifier: email.trim() }).then(() => true));
    setSent(Boolean(ok));
  }

  return (
    <section id="forgot-help" className="panel stack forgot" aria-labelledby="forgot-title">
      <h2 id="forgot-title">{t('admin.login.forgotTitle')}</h2>
      {sent ? (
        <p className="info" role="status">
          <Icon name="check" /> {t('admin.login.forgotSent')}
        </p>
      ) : (
        <form className="stack" onSubmit={submit} noValidate>
          <p className="small muted">{t('admin.login.forgotIntro')}</p>
          <div className="af">
            <label htmlFor="forgot-email">{t('admin.login.forgotEmail')}</label>
            <input
              id="forgot-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              maxLength={254}
              value={email}
              aria-invalid={Boolean(emailError) || undefined}
              aria-describedby={emailError ? 'forgot-email-error' : undefined}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => setTouched(email.trim() !== '')}
            />
            {emailError && (
              <span id="forgot-email-error" className="error-text">
                {emailError}
              </span>
            )}
          </div>
          <ErrorText error={error} />
          <button type="submit" className="abtn" disabled={busy}>
            {busy ? t('common.sending') : t('admin.login.forgotSend')}
          </button>
        </form>
      )}
    </section>
  );
}

export function AdminLoginPage() {
  const { t } = useTranslation();
  const api = useApi();
  const { state, setUser } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [forgotOpen, setForgotOpen] = useState(false);
  const { run, busy, error } = useAction();

  if (state.status === 'signedIn' && state.user.role) {
    return <Navigate to={HOME_OF[state.user.role]} replace />;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await run(() => api.post<{ user: User }>('/auth/admin/login', { username, password }));
    if (result) {
      setUser(result.user);
    }
  }

  return (
    <main className="admin-login">
      <form className="panel stack" onSubmit={submit}>
        <div className="logo">
          <span className="logo-mark">
            <Icon name="leaf" />
          </span>
          <h1>{t('admin.title')}</h1>
        </div>
        <div className="af">
          <label htmlFor="username">{t('admin.login.identifier')}</label>
          <input id="username" autoComplete="username" required value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="af">
          <label htmlFor="password">{t('admin.login.password')}</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <ErrorText error={error} />
        <button type="submit" className="abtn big" disabled={busy}>
          {busy ? t('common.checking') : t('admin.login.submit')}
        </button>
        <button
          type="button"
          className="link"
          aria-expanded={forgotOpen}
          aria-controls="forgot-help"
          onClick={() => setForgotOpen((open) => !open)}
        >
          {t('admin.login.forgot')}
        </button>
      </form>
      {forgotOpen && <ForgotPassword initial={username} />}
      <p className="panel request-note small">
        {t('admin.login.newToTeam')}{' '}
        <Link to="/admin/signup" className="b">
          {t('admin.login.requestAccount')}
        </Link>
      </p>
    </main>
  );
}
