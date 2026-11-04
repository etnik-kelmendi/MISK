import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router';
import { useApi } from '../../api/ApiContext';
import type { User } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { HOME_OF } from '../../auth/RequireRole';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { useAction } from '../../lib/useAction';

export function AdminLoginPage() {
  const { t } = useTranslation();
  const api = useApi();
  const { state, setUser } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
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
          <label htmlFor="username">{t('admin.login.username')}</label>
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
      </form>
    </main>
  );
}
