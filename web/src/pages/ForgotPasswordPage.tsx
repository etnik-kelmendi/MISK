import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi } from '../api/ApiContext';
import { ErrorText } from '../components/ErrorText';
import { Icon } from '../components/Icon';
import { isValidEmail } from '../lib/checks';
import { useAction } from '../lib/useAction';
import { useValidation } from '../lib/useValidation';
import { Field } from './SignUpPage';

/**
 * "Forgot password?": asks for the account's email and sends a reset link. It says the same whether or not
 * an account exists, so the page cannot be used to find out who has one.
 */
export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const api = useApi();
  const id = useId();
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const { run, busy, error } = useAction();
  const form = useValidation(
    { email: !email.trim() ? t('validation.emailMissing') : !isValidEmail(email) && t('validation.emailInvalid') },
    { email: id },
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.check()) {
      return;
    }
    const result = await run(() => api.post('/auth/forgot-password', { email: email.trim() }).then(() => true));
    if (result) {
      setSentTo(email.trim());
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
          <h1 className="signin-title">{t('forgot.title')}</h1>
          {sentTo ? (
            <div className="stack">
              <p className="info" role="status">
                <Icon name="check" />
                <span>{t('forgot.sent', { email: sentTo })}</span>
              </p>
              <p className="small muted">{t('forgot.sentHint')}</p>
              <button type="button" className="btn btn-ghost" onClick={() => setSentTo(null)}>
                {t('forgot.again')}
              </button>
              <Link to="/signin" className="cta">
                {t('forgot.back')}
              </Link>
            </div>
          ) : (
            <form className="stack" onSubmit={submit} noValidate aria-label={t('forgot.title')}>
              <p className="muted">{t('forgot.intro')}</p>
              <Field id={id} label={t('signUp.email')} error={form.message('email')}>
                <input
                  id={id}
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  value={email}
                  {...form.describe('email')}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </Field>
              <ErrorText error={error} />
              <button className="cta" type="submit" disabled={busy}>
                {busy ? t('common.sending') : t('forgot.submit')}
              </button>
              <Link to="/signin" className="center small">
                {t('forgot.back')}
              </Link>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
