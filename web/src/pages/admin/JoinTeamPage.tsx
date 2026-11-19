import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { ApiError } from '../../api/client';
import type { AdminRole } from '../../api/types';
import { ErrorText } from '../../components/ErrorText';
import { FieldError } from '../../components/FieldError';
import { Icon } from '../../components/Icon';
import { isValidEmail } from '../../lib/checks';
import { useAction } from '../../lib/useAction';
import { useValidation } from '../../lib/useValidation';
import { PasswordInput, PasswordRules, passwordChecks } from '../SignUpPage';

/** Reads the token from the link's #fragment once, then removes it from the address bar and history. */
function takeToken(): string {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
  if (window.location.hash) {
    window.history.replaceState(window.history.state, '', window.location.pathname);
  }
  return token;
}

/** The same limits the API sets. */
const MAX_LENGTH = { firstName: 60, lastName: 60, email: 254, password: 1024, repeat: 1024 } as const;

type LinkState = { status: 'checking' } | { status: 'valid'; role: AdminRole } | { status: 'invalid' };

/** The page an invitation link opens: the person creates their account and joins the team (D51). */
export function JoinTeamPage() {
  const { t } = useTranslation();
  const api = useApi();
  const [token] = useState(takeToken);
  const [link, setLink] = useState<LinkState>(token ? { status: 'checking' } : { status: 'invalid' });
  const [values, setValues] = useState({ firstName: '', lastName: '', email: '', password: '', repeat: '' });
  const [joined, setJoined] = useState<string | null>(null);
  const [passwordLeft, setPasswordLeft] = useState(false);
  const { run, busy, error } = useAction();
  const checks = passwordChecks(values.password);
  const passwordOk = checks.length && checks.letter && checks.number;
  const form = useValidation(
    {
      firstName: !values.firstName.trim() && t('validation.firstNameMissing'),
      lastName: !values.lastName.trim() && t('validation.lastNameMissing'),
      email: !values.email.trim() ? t('validation.emailMissing') : !isValidEmail(values.email) && t('validation.emailInvalid'),
      password: !values.password ? t('validation.passwordMissing') : !passwordOk && t('validation.passwordWeak'),
      repeat: !values.repeat ? t('validation.confirmMissing') : values.repeat !== values.password && t('admin.team.mismatch'),
    },
    { firstName: 'join-first', lastName: 'join-last', email: 'join-email', password: 'join-password', repeat: 'join-repeat' },
  );

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api
      .post<{ invite: { role: AdminRole } }>('/auth/admin/invite/check', { token })
      .then((r) => !cancelled && setLink({ status: 'valid', role: r.invite.role }))
      .catch(() => !cancelled && setLink({ status: 'invalid' }));
    return () => {
      cancelled = true;
    };
  }, [api, token]);

  const linkDead = link.status === 'invalid' || (error instanceof ApiError && error.code === 'invalid_invite_link');
  const set = (key: keyof typeof values) => (e: ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [key]: e.target.value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.check()) return;
    const result = await run(() =>
      api.post<{ email: string }>('/auth/admin/invite/accept', {
        token,
        firstName: values.firstName.trim(),
        lastName: values.lastName.trim(),
        email: values.email.trim(),
        password: values.password,
      }),
    );
    if (result) setJoined(result.email);
  }

  const field = (key: 'firstName' | 'lastName' | 'email', id: string, label: string, type = 'text', autoComplete = 'off') => (
    <div className="af">
      <label htmlFor={id}>{label}</label>
      <input id={id} type={type} autoComplete={autoComplete} maxLength={MAX_LENGTH[key]} value={values[key]} {...form.describe(key)} onChange={set(key)} />
      <FieldError id={id} message={form.message(key)} />
    </div>
  );

  return (
    <main className="admin-login">
      <div className="panel stack">
        <div className="logo">
          <span className="logo-mark">
            <Icon name="leaf" />
          </span>
          <h1>{t('admin.join.title')}</h1>
        </div>
        {joined ? (
          <>
            <p role="status">{t('admin.join.done', { email: joined })}</p>
            <Link to="/admin/login" className="abtn big">
              {t('admin.join.signIn')}
            </Link>
          </>
        ) : linkDead ? (
          <p role="alert">{t('admin.join.invalid')}</p>
        ) : link.status === 'checking' ? (
          <p className="muted" role="status">
            {t('admin.join.checking')}
          </p>
        ) : (
          <form className="stack" onSubmit={submit} noValidate aria-label={t('admin.join.title')}>
            <p className="muted">{t('admin.join.intro', { role: t(`admin.settings.team.roles.${link.role}`) })}</p>
            <div className="fgrid">
              {field('firstName', 'join-first', t('admin.join.firstName'), 'text', 'given-name')}
              {field('lastName', 'join-last', t('admin.join.lastName'), 'text', 'family-name')}
            </div>
            {field('email', 'join-email', t('admin.join.email'), 'email', 'email')}
            <div className="af">
              <label htmlFor="join-password">{t('admin.join.password')}</label>
              <PasswordInput
                id="join-password"
                value={values.password}
                onChange={(password) => setValues((v) => ({ ...v, password }))}
                onBlur={() => setPasswordLeft(true)}
                describedBy={form.message('password') ? 'join-password-error join-password-rules' : 'join-password-rules'}
                invalid={Boolean(form.message('password'))}
              />
              <FieldError id="join-password" message={form.message('password')} />
              <PasswordRules id="join-password-rules" password={values.password} showProblems={form.tried || (passwordLeft && values.password !== '')} />
            </div>
            <div className="af">
              <label htmlFor="join-repeat">{t('admin.join.repeat')}</label>
              <PasswordInput
                id="join-repeat"
                value={values.repeat}
                onChange={(repeat) => setValues((v) => ({ ...v, repeat }))}
                describedBy={form.message('repeat') ? 'join-repeat-error' : undefined}
                invalid={Boolean(form.message('repeat'))}
              />
              <FieldError id="join-repeat" message={form.message('repeat')} />
            </div>
            <ErrorText error={error} />
            <button type="submit" className="abtn big" disabled={busy || !passwordOk} aria-describedby={passwordOk ? undefined : 'join-password-first'}>
              {t('admin.join.submit')}
            </button>
            {!passwordOk && (
              <p id="join-password-first" className="hint">
                {t('signUp.passwordFirst')}
              </p>
            )}
          </form>
        )}
      </div>
    </main>
  );
}
