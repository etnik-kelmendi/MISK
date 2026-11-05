import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { ApiError } from '../../api/client';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { useAction } from '../../lib/useAction';
import { Field, isValidEmail, PasswordInput } from '../SignUpPage';
import { MIN_PASSWORD_LENGTH } from './TeamPage';

/**
 * New team members ask for an admin account here. Nobody can sign in with it until an existing admin
 * approves the request under Settings → Team (D21).
 */
export function AdminSignUpPage() {
  const { t } = useTranslation();
  const api = useApi();
  const ids = { first: useId(), last: useId(), email: useId(), password: useId(), confirm: useId() };
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', password: '', confirm: '' });
  const [emailTouched, setEmailTouched] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [takenEmail, setTakenEmail] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const { run, busy, error } = useAction();

  const set = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const anyEmpty = Object.values(form).some((value) => !value.trim());
  const emailInvalid = (emailTouched || submitted) && form.email.trim() !== '' && !isValidEmail(form.email);
  const emailTaken = takenEmail !== null && takenEmail === form.email.trim().toLowerCase();
  const passwordShort = form.password.length < MIN_PASSWORD_LENGTH;
  const mismatch = submitted && form.confirm !== '' && form.password !== form.confirm;
  const emailError = emailInvalid ? t('signUp.errors.email') : emailTaken ? t('signUp.errors.emailTaken') : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (anyEmpty || !isValidEmail(form.email) || passwordShort || form.password !== form.confirm) {
      return;
    }
    const result = await run(async () => {
      try {
        return await api.post<{ status: string }>('/auth/admin/register', {
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          email: form.email.trim(),
          password: form.password,
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
      setSent(true);
    }
  }

  return (
    <main className="admin-login">
      <div className="panel stack admin-signup">
        <div className="logo">
          <span className="logo-mark">
            <Icon name="leaf" />
          </span>
          <h1>{t('admin.signUp.title')}</h1>
        </div>
        {sent ? (
          <>
            <p className="info" role="status">
              <Icon name="clock" /> {t('admin.signUp.sent')}
            </p>
            <Link to="/admin/login" className="abtn big">
              {t('admin.signUp.toLogin')}
            </Link>
          </>
        ) : (
          <form className="stack" onSubmit={submit} noValidate>
            <p className="small muted">{t('admin.signUp.intro')}</p>
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
            <Field id={ids.email} label={t('admin.signUp.email')} error={emailError}>
              <input
                id={ids.email}
                type="email"
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
              error={submitted && passwordShort ? t('admin.signUp.passwordShort', { min: MIN_PASSWORD_LENGTH }) : null}
              hint={<span className="hint">{t('admin.team.passwordHint', { min: MIN_PASSWORD_LENGTH })}</span>}
            >
              <PasswordInput id={ids.password} value={form.password} onChange={(v) => set('password', v)} invalid={submitted && passwordShort} />
            </Field>
            <Field id={ids.confirm} label={t('signUp.confirm')} error={mismatch ? t('signUp.errors.mismatch') : null}>
              <PasswordInput id={ids.confirm} value={form.confirm} onChange={(v) => set('confirm', v)} invalid={mismatch} />
            </Field>
            <ErrorText error={error} />
            <button type="submit" className="abtn big" disabled={busy || anyEmpty}>
              {busy ? t('common.sending') : t('admin.signUp.submit')}
            </button>
            <p className="small center">
              {t('signUp.haveAccount')} <Link to="/admin/login">{t('signUp.logIn')}</Link>
            </p>
          </form>
        )}
      </div>
    </main>
  );
}
