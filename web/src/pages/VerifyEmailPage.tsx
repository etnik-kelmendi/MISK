import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { useApi } from '../api/ApiContext';
import type { User } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ErrorText } from '../components/ErrorText';
import { Icon } from '../components/Icon';
import { ResendVerification } from '../components/ResendVerification';
import { useAction } from '../lib/useAction';
import { isValidEmail } from './SignUpPage';

/** The token from the link's #fragment. */
function readToken(): string {
  return new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
}

/**
 * Opened from the link in the confirmation email: confirms the address once and signs the person in.
 * An old or used link offers a new one.
 */
export function VerifyEmailPage() {
  const { t } = useTranslation();
  const api = useApi();
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const { run, error } = useAction();
  const [token] = useState(readToken);
  const [failed, setFailed] = useState(token === '');
  const [email, setEmail] = useState('');
  const started = useRef(false);

  useEffect(() => {
    // The link works once, so it is sent once, even when React runs effects twice in development.
    if (!token || started.current) {
      return;
    }
    started.current = true;
    // The token leaves the address bar and history, so it is not shared by copying the address.
    window.history.replaceState(window.history.state, '', window.location.pathname);
    void run(() => api.post<{ user: User }>('/auth/verify-email', { token })).then((result) => {
      if (result) {
        setUser(result.user);
        // A new account chooses next whether it needs help or offers it, as after phone sign-up.
        void navigate('/signin', { replace: true });
      } else {
        setFailed(true);
      }
    });
  }, [api, navigate, run, setUser, token]);

  return (
    <div className="app-frame signin-frame">
      <main className="app-body">
        <div className="signin stack">
          <div className="signin-hero small-hero">
            <span className="logo-mark big">
              <Icon name="leaf" />
            </span>
            <h1>{t('verifyEmail.title')}</h1>
          </div>
          {failed ? (
            <>
              {token ? <ErrorText error={error} /> : <p role="alert">{t('errors.invalid_verification_link')}</p>}
              <p className="small muted">{t('verifyEmail.askNew')}</p>
              <div className="field">
                <label htmlFor="verify-email">{t('signUp.email')}</label>
                <input
                  id="verify-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
              <ResendVerification email={isValidEmail(email) ? email : ''} className="cta" />
              <Link to="/signin" className="small center">
                {t('verifyEmail.toLogin')}
              </Link>
            </>
          ) : (
            <p className="muted center" role="status">
              {t('verifyEmail.checking')}
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
