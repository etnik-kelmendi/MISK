import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate } from 'react-router';
import { useApi, useAppConfig } from '../api/ApiContext';
import { ApiError } from '../api/client';
import type { User } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { HOME_OF } from '../auth/RequireRole';
import { ErrorText } from '../components/ErrorText';
import { Icon } from '../components/Icon';
import { useAction } from '../lib/useAction';

export const MIN_PASSWORD_LENGTH = 8;
const EMAIL_FORMAT = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const isValidEmail = (email: string) => EMAIL_FORMAT.test(email.trim());

export function passwordChecks(password: string) {
  return {
    length: password.length >= MIN_PASSWORD_LENGTH,
    letter: /\p{L}/u.test(password),
    number: /\p{N}/u.test(password),
  };
}

function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string | null;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}{' '}
        <span className="required" aria-hidden="true">
          *
        </span>
        <span className="visually-hidden">{t('signUp.requiredSuffix')}</span>
      </label>
      {children}
      {hint}
      {error && (
        <span id={`${id}-error`} className="error-text" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** A password input with a show/hide button. */
function PasswordInput({
  id,
  value,
  onChange,
  describedBy,
  invalid,
  onFocus,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  describedBy?: string;
  invalid?: boolean;
  onFocus?: () => void;
}) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  return (
    <div className="password-input">
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        autoComplete="new-password"
        required
        maxLength={1024}
        value={value}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onFocus={onFocus}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="reveal"
        aria-controls={id}
        aria-pressed={visible}
        aria-label={visible ? t('signUp.hidePassword') : t('signUp.showPassword')}
        onClick={() => setVisible((v) => !v)}
      >
        {visible ? t('signUp.hide') : t('signUp.show')}
      </button>
    </div>
  );
}

export function SignUpPage() {
  const { t } = useTranslation();
  const api = useApi();
  const config = useAppConfig();
  const navigate = useNavigate();
  const { state, setUser } = useAuth();
  const ids = { first: useId(), last: useId(), email: useId(), password: useId(), confirm: useId(), terms: useId(), rules: useId() };
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', password: '', confirm: '', acceptTerms: false });
  const [emailTouched, setEmailTouched] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  // The email the API said is already registered; the message goes away once the email changes.
  const [takenEmail, setTakenEmail] = useState<string | null>(null);
  const { run, busy, error } = useAction();

  if (state.status === 'signedIn') {
    return <Navigate to={state.user.role ? HOME_OF[state.user.role] : '/signin'} replace />;
  }

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };
  const emailTaken = takenEmail !== null && takenEmail === form.email.trim().toLowerCase();
  const checks = passwordChecks(form.password);
  const passwordOk = checks.length && checks.letter && checks.number;
  const emailInvalid = (emailTouched || submitted) && form.email.trim() !== '' && !isValidEmail(form.email);
  const mismatch = submitted && form.confirm !== '' && form.password !== form.confirm;
  const anyEmpty = [form.firstName, form.lastName, form.email, form.password, form.confirm].some((v) => !v.trim());
  const emailError = emailInvalid ? t('signUp.errors.email') : emailTaken ? t('signUp.errors.emailTaken') : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    setShowRules(true);
    if (anyEmpty || !form.acceptTerms || !isValidEmail(form.email) || !passwordOk || form.password !== form.confirm) {
      return;
    }
    const result = await run(async () => {
      try {
        return await api.post<{ user: User }>('/auth/register', {
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          email: form.email.trim(),
          password: form.password,
          acceptTerms: true,
        });
      } catch (caught) {
        if (caught instanceof ApiError && caught.code === 'email_taken') {
          setTakenEmail(form.email.trim().toLowerCase());
          return undefined;
        }
        throw caught;
      }
    });
    if (result) {
      setUser(result.user);
      // A new account chooses next whether it needs help or offers it.
      navigate('/signin', { replace: true });
    }
  }

  return (
    <div className="app-frame signin-frame">
      <main className="app-body">
        <form className="signin" onSubmit={submit} noValidate>
          <div className="signin-hero small-hero">
            <span className="logo-mark big">
              <Icon name="leaf" />
            </span>
            <p className="brand">{t('app.name')}</p>
          </div>
          <h1 className="signin-title">{t('signUp.title')}</h1>
          <p className="small muted">
            <span aria-hidden="true">* </span>
            {t('signUp.requiredNote')}
          </p>

          <div className="two-col">
            <Field id={ids.first} label={t('signUp.firstName')}>
              <input id={ids.first} autoComplete="given-name" required maxLength={60} value={form.firstName} onChange={(e) => set('firstName', e.target.value)} />
            </Field>
            <Field id={ids.last} label={t('signUp.lastName')}>
              <input id={ids.last} autoComplete="family-name" required maxLength={60} value={form.lastName} onChange={(e) => set('lastName', e.target.value)} />
            </Field>
          </div>

          <Field id={ids.email} label={t('signUp.email')} error={emailError}>
            <input
              id={ids.email}
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              maxLength={254}
              value={form.email}
              aria-invalid={Boolean(emailError) || undefined}
              aria-describedby={emailError ? `${ids.email}-error` : undefined}
              onBlur={() => setEmailTouched(true)}
              onChange={(e) => set('email', e.target.value)}
            />
          </Field>

          <Field
            id={ids.password}
            label={t('signUp.password')}
            hint={
              (showRules || form.password !== '') && (
                <ul id={ids.rules} className="rules" aria-label={t('signUp.rules.title')}>
                  {(['length', 'letter', 'number'] as const).map((rule) => (
                    <li key={rule} className={checks[rule] ? 'ok' : submitted ? 'bad' : ''}>
                      <Icon name={checks[rule] ? 'check' : 'x'} />
                      <span>{t(`signUp.rules.${rule}`, { min: MIN_PASSWORD_LENGTH })}</span>
                      <span className="visually-hidden">{checks[rule] ? t('signUp.rules.met') : t('signUp.rules.notMet')}</span>
                    </li>
                  ))}
                </ul>
              )
            }
          >
            <PasswordInput
              id={ids.password}
              value={form.password}
              onChange={(v) => set('password', v)}
              onFocus={() => setShowRules(true)}
              describedBy={ids.rules}
              invalid={submitted && !passwordOk}
            />
          </Field>

          <Field id={ids.confirm} label={t('signUp.confirm')} error={mismatch ? t('signUp.errors.mismatch') : null}>
            <PasswordInput
              id={ids.confirm}
              value={form.confirm}
              onChange={(v) => set('confirm', v)}
              invalid={mismatch}
              describedBy={mismatch ? `${ids.confirm}-error` : undefined}
            />
          </Field>

          <div className="terms">
            <input
              id={ids.terms}
              type="checkbox"
              required
              checked={form.acceptTerms}
              onChange={(e) => set('acceptTerms', e.target.checked)}
            />
            <label htmlFor={ids.terms}>
              {t('signUp.terms')}{' '}
              {config.termsUrl && (
                <a href={config.termsUrl} target="_blank" rel="noreferrer">
                  {t('signUp.readTerms')}
                </a>
              )}{' '}
              <span className="required" aria-hidden="true">
                *
              </span>
              <span className="visually-hidden">{t('signUp.requiredSuffix')}</span>
            </label>
          </div>

          <ErrorText error={error} />
          <button className="cta" type="submit" disabled={busy || anyEmpty || !form.acceptTerms}>
            {busy ? t('signUp.creating') : t('signUp.submit')}
          </button>
          {(anyEmpty || !form.acceptTerms) && <p className="tiny muted center">{t('signUp.fillAll')}</p>}

          <div className="switch-account">
            <span className="small">{t('signUp.haveAccount')}</span>
            <button type="button" className="btn btn-ghost" onClick={() => navigate('/signin')}>
              {t('signUp.logIn')}
            </button>
          </div>
          <p className="small center">
            <button type="button" className="link" onClick={() => navigate('/signin?method=phone')}>
              {t('signUp.usePhone')}
            </button>
          </p>
        </form>
      </main>
    </div>
  );
}
