import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi } from '../api/ApiContext';
import { useAuth } from '../auth/AuthContext';
import { ErrorText } from '../components/ErrorText';
import { Icon } from '../components/Icon';
import { useAction } from '../lib/useAction';

/** The token from the link's #fragment. */
function readToken(): string {
  return new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
}

/**
 * Opened from the link sent to a new email address (D97): confirms it once, and the account's email changes.
 * Works on any device; the link itself is the proof. A signed-in app picks up the new address.
 */
export function ConfirmEmailPage() {
  const { t } = useTranslation();
  const api = useApi();
  const { state, refresh } = useAuth();
  const { run, error } = useAction();
  const [token] = useState(readToken);
  const [result, setResult] = useState<{ status: 'checking' } | { status: 'done'; email: string } | { status: 'failed' }>(
    token ? { status: 'checking' } : { status: 'failed' },
  );
  const started = useRef(false);
  const signedIn = state.status === 'signedIn';
  // Where the email is shown: Personal information, or the pro's Account page.
  const back = state.status !== 'signedIn' ? '/signin' : state.user.role === 'pro' ? '/pro/account' : '/profile/personal';

  useEffect(() => {
    // The link works once, so it is sent once, even when React runs effects twice in development.
    if (!token || started.current) return;
    started.current = true;
    // The token leaves the address bar and history, so it is not shared by copying the address.
    window.history.replaceState(window.history.state, '', window.location.pathname);
    void run(() => api.post<{ email: string }>('/account/email/confirm', { token })).then((answer) => {
      if (answer) {
        setResult({ status: 'done', email: answer.email });
        // A signed-in app shows the new address everywhere.
        refresh();
      } else {
        setResult({ status: 'failed' });
      }
    });
  }, [api, refresh, run, token]);

  return (
    <div className="app-frame signin-frame">
      <main className="app-body">
        <div className="signin stack">
          <div className="signin-hero small-hero">
            <span className="logo-mark big">
              <Icon name="leaf" />
            </span>
            <h1>{t('confirmEmail.title')}</h1>
          </div>
          {result.status === 'checking' && (
            <p className="muted center" role="status">
              {t('confirmEmail.checking')}
            </p>
          )}
          {result.status === 'done' && (
            <>
              <p className="info" role="status">
                <Icon name="check" />
                <span>{t('confirmEmail.done', { email: result.email })}</span>
              </p>
              <Link to={back} className="cta center">
                {signedIn ? t('confirmEmail.toPersonal') : t('confirmEmail.toLogin')}
              </Link>
            </>
          )}
          {result.status === 'failed' && (
            <>
              {token ? <ErrorText error={error} /> : <p role="alert">{t('errors.invalid_email_change_link')}</p>}
              <p className="small muted">{t('confirmEmail.startAgain')}</p>
              <Link to={back} className="cta center">
                {signedIn ? t('confirmEmail.toPersonal') : t('confirmEmail.toLogin')}
              </Link>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
