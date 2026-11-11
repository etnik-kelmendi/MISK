import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { useAction } from '../../lib/useAction';
import { useValidation } from '../../lib/useValidation';
import { FieldError } from '../../components/FieldError';
import { MIN_PASSWORD_LENGTH } from './TeamPage';

/** Reads the token from the link's #fragment once, then removes it from the address bar and history. */
function takeToken(): string {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
  if (window.location.hash) {
    window.history.replaceState(window.history.state, '', window.location.pathname);
  }
  return token;
}

export function ResetPasswordPage() {
  const { t } = useTranslation();
  const api = useApi();
  const [token] = useState(takeToken);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [done, setDone] = useState(false);
  const { run, busy, error } = useAction();
  const mismatch = repeat.length > 0 && password !== repeat;
  const form = useValidation(
    {
      password: !password
        ? t('validation.passwordMissing')
        : password.length < MIN_PASSWORD_LENGTH && t('admin.signUp.passwordShort', { min: MIN_PASSWORD_LENGTH }),
      repeat: !repeat ? t('validation.confirmMissing') : mismatch && t('admin.team.mismatch'),
    },
    { password: 'new-password', repeat: 'repeat-password' },
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.check()) {
      return;
    }
    const result = await run(() => api.post('/auth/admin/reset', { token, password }).then(() => true));
    if (result) {
      setDone(true);
    }
  }

  return (
    <main className="admin-login">
      <div className="panel stack">
        <div className="logo">
          <span className="logo-mark">
            <Icon name="leaf" />
          </span>
          <h1>{t('admin.reset.title')}</h1>
        </div>
        {done ? (
          <>
            <p role="status">{t('admin.reset.done')}</p>
            <Link to="/admin/login" className="abtn big">
              {t('admin.login.submit')}
            </Link>
          </>
        ) : !token ? (
          <>
            <p role="alert">{t('errors.invalid_reset_link')}</p>
            <Link to="/admin/login">{t('admin.reset.back')}</Link>
          </>
        ) : (
          <form className="stack" onSubmit={submit} noValidate>
            <div className="af">
              <label htmlFor="new-password">{t('admin.team.password')}</label>
              <input
                id="new-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                value={password}
                {...form.describe('password')}
                onChange={(e) => setPassword(e.target.value)}
              />
              <FieldError id="new-password" message={form.message('password')} />
              <span className="hint">{t('admin.team.passwordHint', { min: MIN_PASSWORD_LENGTH })}</span>
            </div>
            <div className="af">
              <label htmlFor="repeat-password">{t('admin.team.repeat')}</label>
              <input
                id="repeat-password"
                type="password"
                autoComplete="new-password"
                required
                value={repeat}
                {...form.describe('repeat')}
                onChange={(e) => setRepeat(e.target.value)}
              />
              {form.message('repeat') ? (
                <FieldError id="repeat-password" message={form.message('repeat')} />
              ) : (
                mismatch && <span className="error-text">{t('admin.team.mismatch')}</span>
              )}
            </div>
            <ErrorText error={error} />
            <button type="submit" className="abtn big" disabled={busy}>
              {t('admin.reset.submit')}
            </button>
            <Link to="/admin/login">{t('admin.reset.back')}</Link>
          </form>
        )}
      </div>
    </main>
  );
}
