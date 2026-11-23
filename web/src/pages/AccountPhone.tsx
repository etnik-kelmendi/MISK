import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../api/ApiContext';
import type { User } from '../api/types';
import { useAuth, useUser } from '../auth/AuthContext';
import { ErrorText } from '../components/ErrorText';
import { FieldError } from '../components/FieldError';
import { Icon } from '../components/Icon';
import { isValidPhone } from '../lib/checks';
import { useAction } from '../lib/useAction';
import { useValidation } from '../lib/useValidation';

type Step = { name: 'idle' } | { name: 'number' } | { name: 'code'; phone: string } | { name: 'remove' };

/**
 * The phone number of one's own account (D87): add or change it with a texted code, or remove it when the
 * account can still sign in with email and password. With a phone the account can also sign in by code,
 * gets texts about bookings, and the team can find it by phone.
 */
export function AccountPhone() {
  const { t } = useTranslation();
  const user = useUser();
  const [step, setStep] = useState<Step>({ name: 'idle' });
  const [done, setDone] = useState<string | null>(null);
  const actions = useRef<HTMLButtonElement>(null);
  const moved = useRef(false);

  // Back from a form: focus returns to where the person started, not the top of the page.
  useEffect(() => {
    if (step.name === 'idle' && moved.current) actions.current?.focus();
    moved.current = step.name !== 'idle';
  }, [step.name]);

  function finish(message: string | null) {
    setDone(message);
    setStep({ name: 'idle' });
  }

  return (
    <section className="card stack" aria-labelledby="account-phone-title">
      <h2 id="account-phone-title" className="h-sm">
        {t('account.phoneTitle')}
      </h2>
      {step.name === 'idle' && (
        <>
          {user.phone ? (
            <>
              <p className="phone-current">{user.phone}</p>
              <p className="small muted">{t('account.phoneUses')}</p>
            </>
          ) : (
            <p className="small">{t('account.phoneNone')}</p>
          )}
          {done && (
            <p className="small brand-text" role="status">
              {done}
            </p>
          )}
          <div className="row gap8 wrap">
            <button ref={actions} type="button" className="btn btn-ghost" onClick={() => setStep({ name: 'number' })}>
              <Icon name="phone" /> {user.phone ? t('account.phoneChange') : t('account.phoneAdd')}
            </button>
            {user.phone && user.email && (
              <button type="button" className="btn btn-ghost" onClick={() => setStep({ name: 'remove' })}>
                {t('account.phoneRemove')}
              </button>
            )}
          </div>
        </>
      )}
      {step.name === 'number' && (
        <NumberForm current={user.phone} onCancel={() => finish(null)} onSent={(phone) => setStep({ name: 'code', phone })} />
      )}
      {step.name === 'code' && (
        <CodeForm phone={step.phone} onOtherNumber={() => setStep({ name: 'number' })} onDone={() => finish(t('account.phoneSaved'))} />
      )}
      {step.name === 'remove' && <RemoveConfirm onCancel={() => finish(null)} onDone={() => finish(t('account.phoneRemoved'))} />}
    </section>
  );
}

function NumberForm({ current, onCancel, onSent }: { current: string | null; onCancel: () => void; onSent: (phone: string) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const [phone, setPhone] = useState('');
  const { run, busy, error } = useAction();
  const form = useValidation(
    { phone: !phone.trim() ? t('validation.phoneMissing') : !isValidPhone(phone) && t('errors.invalid_phone') },
    { phone: 'account-phone' },
  );

  useEffect(() => document.getElementById('account-phone')?.focus(), []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.check()) return;
    const result = await run(() => api.post<{ phone: string }>('/account/phone/start', { phone: phone.trim() }));
    if (result) onSent(result.phone);
  }

  return (
    <form className="stack" onSubmit={submit} noValidate aria-label={current ? t('account.phoneChange') : t('account.phoneAdd')}>
      <div className="field">
        <label htmlFor="account-phone">{t('account.phoneLabel')}</label>
        <input
          id="account-phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          maxLength={32}
          placeholder={t('signIn.phonePlaceholder')}
          required
          value={phone}
          {...form.describe('phone')}
          aria-describedby={form.message('phone') ? 'account-phone-error' : 'account-phone-hint'}
          onChange={(event) => setPhone(event.target.value)}
        />
        {form.message('phone') ? (
          <FieldError id="account-phone" message={form.message('phone')} />
        ) : (
          <span id="account-phone-hint" className="hint">
            {t('account.phoneHint')}
          </span>
        )}
      </div>
      <ErrorText error={error} />
      <div className="row gap8 wrap">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {t('account.phoneSendCode')}
        </button>
      </div>
    </form>
  );
}

function CodeForm({ phone, onOtherNumber, onDone }: { phone: string; onOtherNumber: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { setUser } = useAuth();
  const [code, setCode] = useState('');
  const verify = useAction();
  const resend = useAction();
  const [resent, setResent] = useState(false);
  const form = useValidation(
    { code: code.length === 0 ? t('validation.codeMissing') : code.length !== 6 && t('validation.codeLength') },
    { code: 'account-phone-code' },
  );

  useEffect(() => document.getElementById('account-phone-code')?.focus(), []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.check()) return;
    const result = await verify.run(() => api.post<{ user: User }>('/account/phone/verify', { phone, code }));
    if (result) {
      setUser(result.user);
      onDone();
    }
  }

  async function sendAgain() {
    setResent(false);
    verify.clearError();
    if (await resend.run(() => api.post('/account/phone/start', { phone }))) setResent(true);
  }

  return (
    <form className="stack" onSubmit={submit} noValidate aria-label={t('account.phoneCodeTitle')}>
      <p className="small">{t('account.phoneCodeSent', { phone })}</p>
      <div className="field">
        <label htmlFor="account-phone-code">{t('signIn.code')}</label>
        <input
          id="account-phone-code"
          className="code-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          value={code}
          {...form.describe('code')}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
        />
        <FieldError id="account-phone-code" message={form.message('code')} />
      </div>
      <ErrorText error={verify.error ?? resend.error} />
      {resent && (
        <p className="small brand-text" role="status">
          {t('signIn.resent')}
        </p>
      )}
      <button type="submit" className="btn btn-primary" disabled={verify.busy}>
        {t('account.phoneConfirm')}
      </button>
      <div className="row gap8 wrap">
        <button type="button" className="btn btn-ghost" disabled={resend.busy} onClick={() => void sendAgain()}>
          {t('signIn.resend')}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onOtherNumber}>
          {t('account.phoneOther')}
        </button>
      </div>
    </form>
  );
}

function RemoveConfirm({ onCancel, onDone }: { onCancel: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { setUser } = useAuth();
  const { run, busy, error } = useAction();
  const keep = useRef<HTMLButtonElement>(null);

  useEffect(() => keep.current?.focus(), []);

  async function remove() {
    const result = await run(() => api.delete<{ user: User }>('/account/phone'));
    if (result) {
      setUser(result.user);
      onDone();
    }
  }

  return (
    <div className="stack" role="alertdialog" aria-labelledby="remove-phone-title" aria-describedby="remove-phone-text">
      <p id="remove-phone-title" className="b">
        {t('account.phoneRemoveTitle')}
      </p>
      <p id="remove-phone-text" className="small">
        {t('account.phoneRemoveText')}
      </p>
      <ErrorText error={error} />
      <div className="row gap8 wrap">
        <button ref={keep} type="button" className="btn btn-ghost" onClick={onCancel}>
          {t('account.phoneKeep')}
        </button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove()}>
          {t('account.phoneRemoveConfirm')}
        </button>
      </div>
    </div>
  );
}
