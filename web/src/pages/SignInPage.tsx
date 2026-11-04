import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router';
import { useApi, useAppConfig } from '../api/ApiContext';
import type { User } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { HOME_OF } from '../auth/RequireRole';
import { ErrorText } from '../components/ErrorText';
import { Icon } from '../components/Icon';
import { useAction } from '../lib/useAction';

function PhoneStep({ onSent }: { onSent: (phone: string) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const config = useAppConfig();
  const [phone, setPhone] = useState('');
  const { run, busy, error } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await run(() => api.post<{ phone: string }>('/auth/phone/start', { phone }));
    if (result) {
      onSent(result.phone);
    }
  }

  return (
    <form className="signin" onSubmit={submit}>
      <div className="signin-hero">
        <span className="logo-mark big">
          <Icon name="leaf" />
        </span>
        <h1 className="brand">{t('app.name')}</h1>
        <p className="muted">{t('signIn.tagline')}</p>
      </div>
      <div className="field">
        <label htmlFor="phone">{t('signIn.phone')}</label>
        <input
          id="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          required
          placeholder={t('signIn.phonePlaceholder')}
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
        />
        <span className="hint">{t('signIn.phoneHint')}</span>
      </div>
      <ErrorText error={error} />
      <button className="cta" type="submit" disabled={busy || !phone.trim()}>
        <Icon name="phone" /> {busy ? t('common.sending') : t('signIn.sendCode')}
      </button>
      {(config.termsUrl || config.privacyUrl) && (
        <p className="tiny muted center">
          {t('signIn.agree')}{' '}
          {config.termsUrl && (
            <a href={config.termsUrl} target="_blank" rel="noreferrer">
              {t('signIn.terms')}
            </a>
          )}
          {config.termsUrl && config.privacyUrl && ` ${t('common.and')} `}
          {config.privacyUrl && (
            <a href={config.privacyUrl} target="_blank" rel="noreferrer">
              {t('signIn.privacy')}
            </a>
          )}
        </p>
      )}
    </form>
  );
}

function CodeStep({ phone, onBack }: { phone: string; onBack: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { setUser } = useAuth();
  const [code, setCode] = useState('');
  const { run, busy, error } = useAction();
  const resend = useAction();
  const [resent, setResent] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await run(() => api.post<{ user: User }>('/auth/phone/verify', { phone, code }));
    if (result) {
      setUser(result.user);
    }
  }

  return (
    <form className="signin" onSubmit={submit}>
      <h1>{t('signIn.codeTitle')}</h1>
      <p className="muted">{t('signIn.codeSent', { phone })}</p>
      <div className="field">
        <label htmlFor="code">{t('signIn.code')}</label>
        <input
          id="code"
          className="code-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
        />
      </div>
      <ErrorText error={error ?? resend.error} />
      <button className="cta" type="submit" disabled={busy || code.length !== 6}>
        {busy ? t('common.checking') : t('signIn.verify')}
      </button>
      <div className="row between">
        <button type="button" className="link" onClick={onBack}>
          {t('signIn.changeNumber')}
        </button>
        <button
          type="button"
          className="link"
          disabled={resend.busy}
          onClick={() => void resend.run(() => api.post('/auth/phone/start', { phone })).then((r) => setResent(r !== undefined))}
        >
          {resent ? t('signIn.resent') : t('signIn.resend')}
        </button>
      </div>
    </form>
  );
}

function RoleStep() {
  const { t } = useTranslation();
  const api = useApi();
  const { setUser } = useAuth();
  const [role, setRole] = useState<'customer' | 'pro'>('customer');
  const [firstName, setFirstName] = useState('');
  const { run, busy, error } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await run(() => api.post<{ user: User }>('/account/role', { role, firstName }));
    if (result) {
      setUser(result.user);
    }
  }

  const options = [
    { value: 'customer' as const, icon: 'home' as const, title: t('signIn.roleCustomer'), text: t('signIn.roleCustomerText') },
    { value: 'pro' as const, icon: 'wrench' as const, title: t('signIn.rolePro'), text: t('signIn.roleProText') },
  ];

  return (
    <form className="signin" onSubmit={submit}>
      <h1>{t('signIn.welcome')}</h1>
      <fieldset className="choices">
        <legend className="muted">{t('signIn.roleQuestion')}</legend>
        {options.map((option) => (
          <label key={option.value} className={`svc ${role === option.value ? 'on' : ''}`}>
            <input
              type="radio"
              name="role"
              className="visually-hidden"
              value={option.value}
              checked={role === option.value}
              onChange={() => setRole(option.value)}
            />
            <span className="ci">
              <Icon name={option.icon} />
            </span>
            <span className="grow">
              <span className="b block">{option.title}</span>
              <span className="small muted">{option.text}</span>
            </span>
            <span className="radio" aria-hidden="true" />
          </label>
        ))}
      </fieldset>
      <p className="tiny muted">{t('signIn.roleFinal')}</p>
      <div className="field">
        <label htmlFor="firstName">{t('signIn.firstName')}</label>
        <input
          id="firstName"
          autoComplete="given-name"
          required
          maxLength={60}
          value={firstName}
          onChange={(event) => setFirstName(event.target.value)}
        />
      </div>
      <ErrorText error={error} />
      <button className={`cta ${role === 'pro' ? 'dark' : ''}`} type="submit" disabled={busy || !firstName.trim()}>
        {role === 'pro' ? t('signIn.openPro') : t('signIn.openCustomer')} <Icon name="arrowR" />
      </button>
    </form>
  );
}

export function SignInPage() {
  const { state } = useAuth();
  const [phone, setPhone] = useState<string | null>(null);

  if (state.status === 'signedIn') {
    return state.user.role ? (
      <Navigate to={HOME_OF[state.user.role]} replace />
    ) : (
      <div className="app-frame">
        <main className="app-body">
          <RoleStep />
        </main>
      </div>
    );
  }
  return (
    <div className="app-frame signin-frame">
      <main className="app-body">
        {phone ? <CodeStep phone={phone} onBack={() => setPhone(null)} /> : <PhoneStep onSent={setPhone} />}
      </main>
    </div>
  );
}
