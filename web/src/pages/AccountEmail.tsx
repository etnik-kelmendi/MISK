import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../api/ApiContext';
import { useMarket } from '../api/MarketContext';
import { useResource } from '../api/useResource';
import { useUser } from '../auth/AuthContext';
import { ErrorText } from '../components/ErrorText';
import { FieldError } from '../components/FieldError';
import { Icon } from '../components/Icon';
import { isValidEmail } from '../lib/checks';
import { dateTime } from '../lib/format';
import { useAction } from '../lib/useAction';
import { useValidation } from '../lib/useValidation';

/** The API's limit for an email address. */
export const MAX_EMAIL_LENGTH = 254;

/** A change of email waiting for the link sent to the new address (D97). */
export interface PendingEmail {
  email: string;
  expiresAt: string;
}

/** What `GET /account/email` answers. */
export interface AccountEmailState {
  email: string | null;
  hasPassword: boolean;
  pending: PendingEmail | null;
}

/**
 * The email of one's own account (D97): change it, or add one to a phone account. The new address applies only
 * once the link sent to it is opened; until then this shows the change as waiting, with "Send the link again"
 * and "Cancel change". An account with a password types it to confirm it is them.
 */
export function AccountEmail() {
  const { t } = useTranslation();
  const api = useApi();
  const user = useUser();
  const { timezone } = useMarket();
  const load = useCallback(() => api.get<AccountEmailState>('/account/email'), [api]);
  const { state, update, reload } = useResource(load);
  const [editing, setEditing] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const resend = useAction();
  const cancel = useAction();
  const opener = useRef<HTMLButtonElement>(null);
  const moved = useRef(false);

  // Back from the form: focus returns to the button that opened it.
  useEffect(() => {
    if (!editing && moved.current) opener.current?.focus();
    moved.current = editing;
  }, [editing]);

  const data = state.status === 'ready' ? state.data : null;
  const pending = data?.pending ?? null;
  const email = user.email;

  async function sendAgain() {
    setDone(null);
    cancel.clearError();
    const result = await resend.run(() => api.post<{ pending: PendingEmail }>('/account/email/resend'));
    if (result) {
      update((current) => ({ ...current, pending: result.pending }));
      setDone(t('accountEmail.resent', { email: result.pending.email }));
    }
  }

  async function cancelChange() {
    setDone(null);
    resend.clearError();
    const result = await cancel.run(async () => {
      await api.delete('/account/email/pending');
      return true;
    });
    if (result) {
      update((current) => ({ ...current, pending: null }));
      setDone(email ? t('accountEmail.cancelled', { email }) : t('accountEmail.cancelledAdd'));
    }
  }

  return (
    <section className="card stack" aria-labelledby="account-email-title">
      <h2 id="account-email-title" className="h-sm">
        {t('personal.email')}
      </h2>
      {editing && data ? (
        <EmailForm
          current={email}
          needsPassword={data.hasPassword}
          onCancel={() => setEditing(false)}
          onSent={(next) => {
            update((current) => ({ ...current, pending: next }));
            setDone(null);
            setEditing(false);
          }}
        />
      ) : (
        <>
          {email ? <p className="phone-current">{email}</p> : <p className="small">{t('accountEmail.none')}</p>}
          {email && <p className="small muted">{data?.hasPassword ? t('accountEmail.usesLogin') : t('accountEmail.uses')}</p>}
          {state.status === 'error' && (
            <p className="small" role="alert">
              {t('accountEmail.loadError')}{' '}
              <button type="button" className="link" onClick={reload}>
                {t('common.retry')}
              </button>
            </p>
          )}
          {pending && (
            <div className="info amber" role="status">
              <Icon name="bell" />
              <div className="stack gap4">
                <p>{t('accountEmail.pending', { email: pending.email })}</p>
                <p className="small">{t('accountEmail.expires', { date: dateTime(pending.expiresAt, timezone) })}</p>
              </div>
            </div>
          )}
          {done && (
            <p className="small brand-text" role="status">
              {done}
            </p>
          )}
          <ErrorText error={resend.error ?? cancel.error} />
          <div className="row gap8 wrap">
            <button
              ref={opener}
              type="button"
              className="btn btn-ghost"
              disabled={!data}
              onClick={() => {
                setDone(null);
                setEditing(true);
              }}
            >
              {email ? t('accountEmail.change') : t('accountEmail.add')}
            </button>
            {pending && (
              <>
                <button type="button" className="btn btn-ghost" disabled={resend.busy} onClick={() => void sendAgain()}>
                  {t('accountEmail.resend')}
                </button>
                <button type="button" className="btn btn-ghost" disabled={cancel.busy} onClick={() => void cancelChange()}>
                  {t('accountEmail.cancel')}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function EmailForm({
  current,
  needsPassword,
  onCancel,
  onSent,
}: {
  current: string | null;
  needsPassword: boolean;
  onCancel: () => void;
  onSent: (pending: PendingEmail) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { run, busy, error } = useAction();
  const typed = email.trim().toLowerCase();
  const form = useValidation(
    {
      email: !typed
        ? t('validation.emailMissing')
        : !isValidEmail(typed)
          ? t('validation.emailInvalid')
          : typed === current && t('errors.email_unchanged'),
      password: needsPassword && !password && t('errors.password_required'),
    },
    { email: 'account-email', password: 'account-email-password' },
  );

  useEffect(() => document.getElementById('account-email')?.focus(), []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.check()) return;
    const result = await run(() =>
      api.post<{ pending: PendingEmail }>('/account/email/start', { email: email.trim(), ...(needsPassword ? { password } : {}) }),
    );
    if (result) onSent(result.pending);
  }

  return (
    <form className="stack" onSubmit={submit} noValidate aria-label={current ? t('accountEmail.change') : t('accountEmail.add')}>
      <div className="field">
        <label htmlFor="account-email">{t('accountEmail.newLabel')}</label>
        <input
          id="account-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          maxLength={MAX_EMAIL_LENGTH}
          required
          value={email}
          {...form.describe('email')}
          aria-describedby={form.message('email') ? 'account-email-error' : 'account-email-hint'}
          onChange={(event) => setEmail(event.target.value)}
        />
        {form.message('email') ? (
          <FieldError id="account-email" message={form.message('email')} />
        ) : (
          <span id="account-email-hint" className="hint">
            {t('accountEmail.hint')}
          </span>
        )}
      </div>
      {needsPassword && (
        <div className="field">
          <label htmlFor="account-email-password">{t('accountEmail.passwordLabel')}</label>
          <input
            id="account-email-password"
            type="password"
            autoComplete="current-password"
            maxLength={1024}
            required
            value={password}
            {...form.describe('password')}
            aria-describedby={form.message('password') ? 'account-email-password-error' : 'account-email-password-hint'}
            onChange={(event) => setPassword(event.target.value)}
          />
          {form.message('password') ? (
            <FieldError id="account-email-password" message={form.message('password')} />
          ) : (
            <span id="account-email-password-hint" className="hint">
              {t('accountEmail.passwordHint')}
            </span>
          )}
        </div>
      )}
      <ErrorText error={error} />
      <div className="row gap8 wrap">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {t('accountEmail.send')}
        </button>
      </div>
    </form>
  );
}
