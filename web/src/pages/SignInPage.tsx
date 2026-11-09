import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { useApi, useAppConfig } from '../api/ApiContext';
import type { User } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { HOME_OF } from '../auth/RequireRole';
import { ErrorText } from '../components/ErrorText';
import { Icon } from '../components/Icon';
import { useAction } from '../lib/useAction';
import { invitedAsPro, rememberInvite } from '../lib/invite';

export type Method = 'email' | 'phone';

function LegalLinks() {
  const { t } = useTranslation();
  const config = useAppConfig();
  if (!config.termsUrl && !config.privacyUrl) {
    return null;
  }
  return (
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
  );
}

function EmailLogin() {
  const { t } = useTranslation();
  const api = useApi();
  const { setUser } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const { run, busy, error } = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await run(() => api.post<{ user: User }>('/auth/login', { email, password }));
    if (result) {
      setUser(result.user);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <div className="field">
        <label htmlFor="login-email">{t('signUp.email')}</label>
        <input
          id="login-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="login-password">{t('signUp.password')}</label>
        <div className="password-input">
          <input
            id="login-password"
            type={visible ? 'text' : 'password'}
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button
            type="button"
            className="reveal"
            aria-controls="login-password"
            aria-pressed={visible}
            aria-label={visible ? t('signUp.hidePassword') : t('signUp.showPassword')}
            onClick={() => setVisible((v) => !v)}
          >
            {visible ? t('signUp.hide') : t('signUp.show')}
          </button>
        </div>
      </div>
      <ErrorText error={error} />
      <button className="cta" type="submit" disabled={busy || !email.trim() || !password}>
        {busy ? t('common.checking') : t('signIn.logIn')}
      </button>
    </form>
  );
}

function PhoneLogin({ onSent }: { onSent: (phone: string) => void }) {
  const { t } = useTranslation();
  const api = useApi();
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
    <form className="stack" onSubmit={submit}>
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
    </form>
  );
}

function LoginStep({ method, onMethod, onSent }: { method: Method; onMethod: (m: Method) => void; onSent: (phone: string) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const methods: Method[] = ['email', 'phone'];
  return (
    <div className="signin">
      <div className="signin-hero">
        <span className="logo-mark big">
          <Icon name="leaf" />
        </span>
        <p className="brand">{t('app.name')}</p>
        <p className="muted">{t('signIn.tagline')}</p>
      </div>
      <h1 className="signin-title">{t('signIn.title')}</h1>
      <div className="seg wide-seg" role="group" aria-label={t('signIn.methodLabel')}>
        {methods.map((m) => (
          <button key={m} type="button" className={m === method ? 'on' : ''} aria-pressed={m === method} onClick={() => onMethod(m)}>
            {t(`signIn.method.${m}`)}
          </button>
        ))}
      </div>
      {method === 'email' ? <EmailLogin /> : <PhoneLogin onSent={onSent} />}
      <div className="switch-account">
        <span className="small">{t('signIn.noAccount')}</span>
        <button type="button" className="btn btn-ghost" onClick={() => navigate('/signup')}>
          {t('signIn.signUp')}
        </button>
      </div>
      <LegalLinks />
    </div>
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
  const { state, setUser } = useAuth();
  const [role, setRole] = useState<'customer' | 'pro'>(() => (invitedAsPro() ? 'pro' : 'customer'));
  // People who signed up with email already gave their name.
  const [firstName, setFirstName] = useState(state.status === 'signedIn' ? (state.user.firstName ?? '') : '');
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
  const [params, setParams] = useSearchParams();
  // Remembered before the sign-in steps change the address (see lib/invite).
  useEffect(() => rememberInvite(params), [params]);
  const method: Method = params.get('method') === 'phone' ? 'phone' : 'email';
  const setMethod = (next: Method) => setParams(next === 'phone' ? { method: 'phone' } : {}, { replace: true });

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
        {phone ? (
          <CodeStep phone={phone} onBack={() => setPhone(null)} />
        ) : (
          <LoginStep method={method} onMethod={setMethod} onSent={setPhone} />
        )}
      </main>
    </div>
  );
}
