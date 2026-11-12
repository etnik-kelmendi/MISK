import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi } from '../api/ApiContext';
import { ApiError } from '../api/client';
import { ErrorText } from '../components/ErrorText';
import { Icon } from '../components/Icon';
import { useAction } from '../lib/useAction';
import { useValidation } from '../lib/useValidation';
import { Field, MIN_PASSWORD_LENGTH, PasswordInput, passwordChecks } from './SignUpPage';

/** Reads the token from the link's #fragment once, then removes it from the address bar and history. */
function takeToken(): string {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
  if (window.location.hash) {
    window.history.replaceState(window.history.state, '', window.location.pathname);
  }
  return token;
}

/** The page the emailed reset link opens: choose and confirm a new password, then sign in with it. */
export function ResetPasswordPage() {
  const { t } = useTranslation();
  const api = useApi();
  const ids = { password: useId(), confirm: useId(), rules: useId() };
  const [token] = useState(takeToken);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const { run, busy, error } = useAction();
  const checks = passwordChecks(password);
  const passwordOk = checks.length && checks.letter && checks.number;
  const form = useValidation(
    {
      password: !password ? t('validation.passwordMissing') : !passwordOk && t('validation.passwordWeak'),
      confirm: !confirm ? t('validation.confirmMissing') : password !== confirm && t('signUp.errors.mismatch'),
    },
    { password: ids.password, confirm: ids.confirm },
  );
  const linkDead = !token || (error instanceof ApiError && error.code === 'invalid_reset_link');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.check()) {
      return;
    }
    const result = await run(() => api.post('/auth/reset-password', { token, password }).then(() => true));
    if (result) {
      setDone(true);
    }
  }

  return (
    <div className="app-frame signin-frame">
      <main className="app-body">
        <div className="signin">
          <div className="signin-hero">
            <span className="logo-mark big">
              <Icon name="leaf" />
            </span>
            <p className="brand">{t('app.name')}</p>
          </div>
          <h1 className="signin-title">{t('reset.title')}</h1>
          {done ? (
            <div className="stack">
              <p className="info" role="status">
                <Icon name="check" />
                <span>{t('reset.done')}</span>
              </p>
              <Link to="/signin" className="cta">
                {t('signIn.logIn')}
              </Link>
            </div>
          ) : linkDead ? (
            <div className="stack">
              <p className="error-text" role="alert">
                {t('errors.invalid_reset_link')}
              </p>
              <Link to="/forgot-password" className="cta">
                {t('reset.newLink')}
              </Link>
            </div>
          ) : (
            <form className="stack" onSubmit={submit} noValidate aria-label={t('reset.title')}>
              <p className="muted">{t('reset.intro')}</p>
              <Field
                id={ids.password}
                label={t('reset.password')}
                error={form.message('password')}
                hint={
                  <ul id={ids.rules} className="rules" aria-label={t('signUp.rules.title')}>
                    {(['length', 'letter', 'number'] as const).map((rule) => (
                      <li key={rule} className={checks[rule] ? 'ok' : form.tried ? 'bad' : ''}>
                        <Icon name={checks[rule] ? 'check' : 'x'} />
                        <span>{t(`signUp.rules.${rule}`, { min: MIN_PASSWORD_LENGTH })}</span>
                        <span className="visually-hidden">{checks[rule] ? t('signUp.rules.met') : t('signUp.rules.notMet')}</span>
                      </li>
                    ))}
                  </ul>
                }
              >
                <PasswordInput
                  id={ids.password}
                  value={password}
                  onChange={setPassword}
                  describedBy={form.message('password') ? `${ids.password}-error ${ids.rules}` : ids.rules}
                  invalid={Boolean(form.message('password'))}
                />
              </Field>
              <Field id={ids.confirm} label={t('reset.confirm')} error={form.message('confirm')}>
                <PasswordInput
                  id={ids.confirm}
                  value={confirm}
                  onChange={setConfirm}
                  describedBy={form.message('confirm') ? `${ids.confirm}-error` : undefined}
                  invalid={Boolean(form.message('confirm'))}
                />
              </Field>
              <ErrorText error={error} />
              <button className="cta" type="submit" disabled={busy}>
                {busy ? t('common.checking') : t('reset.submit')}
              </button>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
