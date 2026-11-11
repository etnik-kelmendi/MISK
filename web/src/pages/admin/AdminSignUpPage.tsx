import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { ApiError } from '../../api/client';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { useAction } from '../../lib/useAction';
import { useValidation } from '../../lib/useValidation';
import { isValidEmail } from '../../lib/checks';
import { Field, PasswordInput } from '../SignUpPage';
import { MIN_PASSWORD_LENGTH } from './TeamPage';

/**
 * New team members ask for an admin account here. Nobody can sign in with it until an existing admin
 * approves the request under Settings → Team (D21).
 */
const EMPTY_FORM = { firstName: '', lastName: '', email: '', password: '', confirm: '' };

export function AdminSignUpPage() {
  const { t } = useTranslation();
  const api = useApi();
  const ids = { first: useId(), last: useId(), email: useId(), password: useId(), confirm: useId() };
  const [form, setForm] = useState(EMPTY_FORM);
  const [emailTouched, setEmailTouched] = useState(false);
  const [takenEmail, setTakenEmail] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const { run, busy, error } = useAction();

  const set = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const emailTaken = takenEmail !== null && takenEmail === form.email.trim().toLowerCase();
  const v = useValidation(
    {
      firstName: !form.firstName.trim() && t('validation.firstNameMissing'),
      lastName: !form.lastName.trim() && t('validation.lastNameMissing'),
      email: !form.email.trim()
        ? t('validation.emailMissing')
        : !isValidEmail(form.email)
          ? t('signUp.errors.email')
          : emailTaken && t('signUp.errors.emailTaken'),
      password: !form.password
        ? t('validation.passwordMissing')
        : form.password.length < MIN_PASSWORD_LENGTH && t('admin.signUp.passwordShort', { min: MIN_PASSWORD_LENGTH }),
      confirm: !form.confirm ? t('validation.confirmMissing') : form.password !== form.confirm && t('signUp.errors.mismatch'),
    },
    { firstName: ids.first, lastName: ids.last, email: ids.email, password: ids.password, confirm: ids.confirm },
  );
  // The email format is also checked as soon as the field is left.
  const emailError =
    v.message('email') ??
    (emailTouched && form.email.trim() !== '' && !isValidEmail(form.email)
      ? t('signUp.errors.email')
      : emailTaken
        ? t('signUp.errors.emailTaken')
        : null);

  /** Back to an empty form, to request an account for another email. */
  function startOver() {
    setForm(EMPTY_FORM);
    setEmailTouched(false);
    v.reset();
    setTakenEmail(null);
    setSent(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!v.check()) {
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
            <button type="button" className="abtn ghost" onClick={startOver}>
              {t('admin.signUp.another')}
            </button>
          </>
        ) : (
          <form className="stack" onSubmit={submit} noValidate>
            <p className="small muted">{t('admin.signUp.intro')}</p>
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
                  value={form.firstName}
                  {...v.describe('firstName')}
                  onChange={(e) => set('firstName', e.target.value)}
                />
              </Field>
              <Field id={ids.last} label={t('signUp.lastName')} error={v.message('lastName')}>
                <input
                  id={ids.last}
                  autoComplete="family-name"
                  required
                  maxLength={60}
                  value={form.lastName}
                  {...v.describe('lastName')}
                  onChange={(e) => set('lastName', e.target.value)}
                />
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
              error={v.message('password')}
              hint={<span className="hint">{t('admin.team.passwordHint', { min: MIN_PASSWORD_LENGTH })}</span>}
            >
              <PasswordInput
                id={ids.password}
                value={form.password}
                onChange={(value) => set('password', value)}
                invalid={Boolean(v.message('password'))}
                describedBy={v.message('password') ? `${ids.password}-error` : undefined}
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
            <ErrorText error={error} />
            <button type="submit" className="abtn big" disabled={busy}>
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
