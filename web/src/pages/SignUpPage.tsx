import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate } from 'react-router';
import { useApi } from '../api/ApiContext';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { HOME_OF } from '../auth/RequireRole';
import { Drawer } from '../components/Drawer';
import { ErrorText } from '../components/ErrorText';
import { Icon } from '../components/Icon';
import { ResendVerification } from '../components/ResendVerification';
import { isValidEmail } from '../lib/checks';
import { useAction } from '../lib/useAction';
import { useValidation } from '../lib/useValidation';
import { TermsContent } from './TermsPage';

export const MIN_PASSWORD_LENGTH = 8;

export function passwordChecks(password: string) {
  return {
    length: password.length >= MIN_PASSWORD_LENGTH,
    letter: /\p{L}/u.test(password),
    number: /\p{N}/u.test(password),
  };
}

export function Field({
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
export function PasswordInput({
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
  const navigate = useNavigate();
  const { state } = useAuth();
  const ids = { first: useId(), last: useId(), email: useId(), password: useId(), confirm: useId(), terms: useId(), rules: useId() };
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', password: '', confirm: '', acceptTerms: false });
  const [emailTouched, setEmailTouched] = useState(false);
  const [showRules, setShowRules] = useState(false);
  // The email the API said is already registered; the message goes away once the email changes.
  const [takenEmail, setTakenEmail] = useState<string | null>(null);
  const { run, busy, error } = useAction();
  const [termsOpen, setTermsOpen] = useState(false);
  // The address the confirmation link went to; the account signs in once it is confirmed.
  const [sentTo, setSentTo] = useState<string | null>(null);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };
  const emailTaken = takenEmail !== null && takenEmail === form.email.trim().toLowerCase();
  const checks = passwordChecks(form.password);
  const passwordOk = checks.length && checks.letter && checks.number;
  // What is missing or wrong in each field, in the order of the form.
  const v = useValidation(
    {
      firstName: !form.firstName.trim() && t('validation.firstNameMissing'),
      lastName: !form.lastName.trim() && t('validation.lastNameMissing'),
      email: !form.email.trim()
        ? t('validation.emailMissing')
        : !isValidEmail(form.email)
          ? t('signUp.errors.email')
          : emailTaken && t('signUp.errors.emailTaken'),
      password: !form.password ? t('validation.passwordMissing') : !passwordOk && t('validation.passwordWeak'),
      confirm: !form.confirm ? t('validation.confirmMissing') : form.password !== form.confirm && t('signUp.errors.mismatch'),
      terms: !form.acceptTerms && t('validation.termsMissing'),
    },
    { firstName: ids.first, lastName: ids.last, email: ids.email, password: ids.password, confirm: ids.confirm, terms: ids.terms },
  );
  // The email format is also checked as soon as the field is left, before Sign up.
  const emailError =
    v.message('email') ??
    (emailTouched && form.email.trim() !== '' && !isValidEmail(form.email)
      ? t('signUp.errors.email')
      : emailTaken
        ? t('signUp.errors.emailTaken')
        : null);

  if (state.status === 'signedIn') {
    return <Navigate to={state.user.role ? HOME_OF[state.user.role] : '/signin'} replace />;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setShowRules(true);
    if (!v.check()) {
      return;
    }
    const result = await run(async () => {
      try {
        return await api.post<{ status: 'verification_sent'; email: string }>('/auth/register', {
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
      setSentTo(result.email);
    }
  }

  if (sentTo) {
    return (
      <div className="app-frame signin-frame">
        <main className="app-body">
          <div className="signin stack">
            <div className="signin-hero small-hero">
              <span className="logo-mark big">
                <Icon name="leaf" />
              </span>
              <h1>{t('verifyEmail.checkTitle')}</h1>
            </div>
            <p className="info" role="status">
              <Icon name="check" /> {t('verifyEmail.checkText', { email: sentTo })}
            </p>
            <p className="small muted">{t('verifyEmail.checkSpam')}</p>
            <ResendVerification email={sentTo} />
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setSentTo(null);
                setForm((current) => ({ ...current, email: '' }));
                setEmailTouched(false);
              }}
            >
              {t('verifyEmail.otherEmail')}
            </button>
            <button type="button" className="link small center" onClick={() => navigate('/signin')}>
              {t('verifyEmail.toLogin')}
            </button>
          </div>
        </main>
      </div>
    );
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
            <Field id={ids.first} label={t('signUp.firstName')} error={v.message('firstName')}>
              <input
                id={ids.first}
                autoComplete="given-name"
                required
                maxLength={60}
                {...v.describe('firstName')}
                value={form.firstName}
                onChange={(e) => set('firstName', e.target.value)}
              />
            </Field>
            <Field id={ids.last} label={t('signUp.lastName')} error={v.message('lastName')}>
              <input
                id={ids.last}
                autoComplete="family-name"
                required
                maxLength={60}
                {...v.describe('lastName')}
                value={form.lastName}
                onChange={(e) => set('lastName', e.target.value)}
              />
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
            error={v.message('password')}
            hint={
              (showRules || form.password !== '') && (
                <ul id={ids.rules} className="rules" aria-label={t('signUp.rules.title')}>
                  {(['length', 'letter', 'number'] as const).map((rule) => (
                    <li key={rule} className={checks[rule] ? 'ok' : v.tried ? 'bad' : ''}>
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
              onChange={(value) => set('password', value)}
              onFocus={() => setShowRules(true)}
              describedBy={v.message('password') ? `${ids.password}-error ${ids.rules}` : ids.rules}
              invalid={Boolean(v.message('password'))}
            />
          </Field>

          <Field id={ids.confirm} label={t('signUp.confirm')} error={v.message('confirm')}>
            <PasswordInput
              id={ids.confirm}
              value={form.confirm}
              onChange={(value) => set('confirm', value)}
              invalid={Boolean(v.message('confirm'))}
              describedBy={v.message('confirm') ? `${ids.confirm}-error` : undefined}
            />
          </Field>

          <div className="terms">
            <input
              id={ids.terms}
              type="checkbox"
              required
              checked={form.acceptTerms}
              {...v.describe('terms')}
              onChange={(e) => set('acceptTerms', e.target.checked)}
            />
            <label htmlFor={ids.terms}>
              {t('signUp.terms')}{' '}
              <span className="required" aria-hidden="true">
                *
              </span>
              <span className="visually-hidden">{t('signUp.requiredSuffix')}</span>
            </label>
            <button type="button" className="link b" aria-haspopup="dialog" onClick={() => setTermsOpen(true)}>
              {t('signUp.readTerms')}
            </button>
            {v.message('terms') && (
              <span id={`${ids.terms}-error`} className="error-text terms-error">
                {v.message('terms')}
              </span>
            )}
          </div>
          {termsOpen && (
            <Drawer title={t('terms.title')} closeLabel={t('common.close')} onClose={() => setTermsOpen(false)}>
              <TermsContent headingLevel={3} />
              <button
                type="button"
                className="cta"
                onClick={() => {
                  set('acceptTerms', true);
                  setTermsOpen(false);
                }}
              >
                {t('terms.accept')}
              </button>
            </Drawer>
          )}

          <ErrorText error={error} />
          <button className="cta" type="submit" disabled={busy}>
            {busy ? t('signUp.creating') : t('signUp.submit')}
          </button>

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
