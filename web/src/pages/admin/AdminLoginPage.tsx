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

/** Server command for when no admin can sign in; a command, so never translated. */
const RESET_COMMAND = 'npm run user:reset-password';

/** Emails a reset link to the admin's address. The answer never says whether the account exists. */
function ForgotPassword({ initial }: { initial: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const [identifier, setIdentifier] = useState(initial);
  const [sent, setSent] = useState(false);
  const { run, busy, error } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const ok = await run(() => api.post('/auth/admin/forgot', { identifier }).then(() => true));
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
        <form className="stack" onSubmit={submit}>
          <p className="small muted">{t('admin.login.forgotIntro')}</p>
          <div className="af">
            <label htmlFor="forgot-identifier">{t('admin.login.forgotIdentifier')}</label>
            <input
              id="forgot-identifier"
              autoComplete="email"
              required
              minLength={3}
              maxLength={254}
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
            />
          </div>
          <ErrorText error={error} />
          <button type="submit" className="abtn" disabled={busy || identifier.trim().length < 3}>
            {busy ? t('common.sending') : t('admin.login.forgotSend')}
          </button>
        </form>
      )}
      <p className="small muted">
        {t('admin.login.forgotNoEmail')} <code>{RESET_COMMAND}</code>
      </p>
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
