import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../api/ApiContext';
import type { Channel, MessageKind, NotificationSettings } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { FieldError } from '../../components/FieldError';
import { isValidEmail, MAX_EMAIL_LENGTH } from '../../lib/checks';
import { PushToggle } from '../../components/PushToggle';
import { ResourceState } from '../../components/ResourceState';
import { useAction } from '../../lib/useAction';
import { useSave } from './settings/SaveStatus';

const CHANNELS: Channel[] = ['push', 'sms', 'email'];

function MyPhone({ phone, onSaved }: { phone: string | null; onSaved: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { track } = useSave();
  const [text, setText] = useState(phone ?? '');

  async function commit(event?: FormEvent) {
    event?.preventDefault();
    if (text.trim() === (phone ?? '')) return;
    const result = await track(() => api.patch<{ phone: string | null }>('/admin/me/phone', { phone: text.trim() || null }));
    if (result) {
      setText(result.phone ?? '');
      onSaved();
    }
  }

  return (
    <form className="af" onSubmit={(e) => void commit(e)}>
      <label htmlFor="my-phone">{t('admin.settings.notifications.myPhone')}</label>
      <input
        id="my-phone"
        type="tel"
        autoComplete="tel"
        maxLength={30}
        placeholder={t('admin.settings.notifications.phonePlaceholder')}
        value={text}
        aria-describedby="my-phone-hint"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void commit()}
      />
      <span id="my-phone-hint" className="hint">
        {t('admin.settings.notifications.myPhoneHint')}
      </span>
    </form>
  );
}

/** "Send me a test": sends the chosen message to the admin's own phone, email and this device. */
function TestMessage({ messages }: { messages: { kind: MessageKind; label: string }[] }) {
  const { t } = useTranslation();
  const api = useApi();
  const action = useAction();
  const [kind, setKind] = useState<MessageKind>(messages[0]?.kind ?? 'booking_confirmed');
  const [result, setResult] = useState<string | null>(null);
  const label = messages.find((m) => m.kind === kind)?.label ?? '';

  async function send() {
    setResult(null);
    const response = await action.run(() =>
      api.post<{ sent: { sms: boolean; email: boolean; push: number }; missing: ('phone' | 'email' | 'push')[] }>(
        `/admin/notifications/${kind}/test`,
      ),
    );
    if (!response) return;
    const sent = (['push', 'sms', 'email'] as const).filter((c) => (c === 'push' ? response.sent.push > 0 : response.sent[c]));
    const parts = [
      sent.length
        ? t('admin.settings.notifications.testSent', { channels: sent.map((c) => t(`admin.settings.notifications.channelsSent.${c}`)).join(', ') })
        : t('admin.settings.notifications.testNone'),
      ...response.missing.map((m) => t(`admin.settings.notifications.testMissing.${m}`)),
    ];
    setResult(parts.join(' '));
  }

  return (
    <div className="stack">
      <div className="stack tight">
        <div className="test-row">
          <select aria-label={t('admin.settings.notifications.testWhich')} value={kind} onChange={(e) => setKind(e.target.value as MessageKind)}>
            {messages.map((m) => (
              <option key={m.kind} value={m.kind}>
                {m.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="abtn ghost"
            disabled={action.busy}
            aria-label={t('admin.settings.notifications.testLabel', { message: label })}
            onClick={() => void send()}
          >
            {t('admin.settings.notifications.test')}
          </button>
          <span className="small muted">{t('admin.settings.notifications.smsCost')}</span>
        </div>
        {result && (
          <p className="small" role="status">
            {result}
          </p>
        )}
        <ErrorText error={action.error} />
      </div>
      <TestEmail kind={kind} label={label} />
    </div>
  );
}

/** Where a test email stands in the outbox, as the API reports it. */
export interface TestEmailStatus {
  id: string;
  to: string;
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'not_configured';
  /** Sent, or failed for good: nothing changes any more. */
  done: boolean;
  error: string | null;
}

/** How often and how long the page asks about a test email on its own, before offering "Check status". */
const STATUS_POLL_MS = 2_000;
const STATUS_POLL_TRIES = 15;

/**
 * "Send a test email" (D84): the chosen message goes to any address the admin types, through the normal
 * outbox and email sender. The page then follows the email until it is sent or has failed, so the admin
 * can see that email delivery really works.
 */
function TestEmail({ kind, label }: { kind: MessageKind; label: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const action = useAction();
  const check = useAction();
  const [email, setEmail] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<TestEmailStatus | null>(null);
  const [polling, setPolling] = useState(false);
  const tries = useRef(0);

  // Asks again every few seconds while the email waits in the outbox, for half a minute at most.
  const pollingId = polling && sent && !sent.done ? sent.id : null;
  useEffect(() => {
    if (!pollingId) return;
    let live = true;
    const timer = window.setInterval(() => {
      tries.current += 1;
      if (tries.current > STATUS_POLL_TRIES) {
        setPolling(false);
        return;
      }
      api.get<{ email: TestEmailStatus }>(`/admin/notifications/test-email/${pollingId}`).then(
        (r) => {
          if (!live) return;
          setSent(r.email);
          if (r.email.done) setPolling(false);
        },
        // A failed check is not a failed email; the admin can still press "Check status".
        (error: unknown) => {
          console.warn('Could not check the test email', error);
          if (live) setPolling(false);
        },
      );
    }, STATUS_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [api, pollingId]);

  function validate(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return t('admin.settings.notifications.testEmail.missing');
    if (trimmed.length > MAX_EMAIL_LENGTH || !isValidEmail(trimmed)) return t('admin.settings.notifications.testEmail.invalid');
    return null;
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const found = validate(email);
    setProblem(found);
    if (found) {
      document.getElementById('test-email')?.focus();
      return;
    }
    setSent(null);
    const response = await action.run(() =>
      api.post<{ email: TestEmailStatus }>(`/admin/notifications/${kind}/test-email`, { email: email.trim() }),
    );
    if (!response) return;
    tries.current = 0;
    setSent(response.email);
    setPolling(!response.email.done);
  }

  async function checkNow() {
    if (!sent) return;
    const response = await check.run(() => api.get<{ email: TestEmailStatus }>(`/admin/notifications/test-email/${sent.id}`));
    if (response) setSent(response.email);
  }

  const reason = (status: TestEmailStatus) => status.error || t('admin.settings.notifications.testEmail.unknownError');
  const outcome = (status: TestEmailStatus): { text: string; tone: 'ok' | 'bad' | 'wait' } => {
    const to = status.to;
    switch (status.status) {
      case 'sent':
        return { text: t('admin.settings.notifications.testEmail.sent', { email: to }), tone: 'ok' };
      case 'not_configured':
        return { text: t('admin.settings.notifications.testEmail.notConfigured', { email: to }), tone: 'bad' };
      case 'failed':
        return status.done
          ? { text: t('admin.settings.notifications.testEmail.failed', { email: to, error: reason(status) }), tone: 'bad' }
          : { text: t('admin.settings.notifications.testEmail.retrying', { email: to, error: reason(status) }), tone: 'wait' };
      default:
        return polling
          ? { text: t('admin.settings.notifications.testEmail.queued', { email: to }), tone: 'wait' }
          : { text: t('admin.settings.notifications.testEmail.stillWaiting', { email: to }), tone: 'wait' };
    }
  };
  const shown = sent ? outcome(sent) : null;

  return (
    <form className="stack tight test-email" onSubmit={(e) => void send(e)} noValidate aria-labelledby="test-email-heading">
      <h3 id="test-email-heading" className="b small">
        {t('admin.settings.notifications.testEmail.title')}
      </h3>
      <p id="test-email-intro" className="small muted">
        {t('admin.settings.notifications.testEmail.intro')}
      </p>
      <div className="test-email-row">
        <div className="af">
          <label htmlFor="test-email">{t('admin.settings.notifications.testEmail.label')}</label>
          <input
            id="test-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            spellCheck={false}
            maxLength={MAX_EMAIL_LENGTH}
            placeholder={t('admin.settings.notifications.testEmail.placeholder')}
            value={email}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? 'test-email-error test-email-intro' : 'test-email-intro'}
            onChange={(e) => {
              setEmail(e.target.value);
              if (problem) setProblem(validate(e.target.value));
            }}
          />
        </div>
        <button type="submit" className="abtn ghost" disabled={action.busy} aria-label={t('admin.settings.notifications.testEmail.sendLabel', { message: label })}>
          {action.busy ? t('admin.settings.notifications.testEmail.sending') : t('admin.settings.notifications.testEmail.send')}
        </button>
      </div>
      <FieldError id="test-email" message={problem} />
      <ErrorText error={action.error} />
      {shown && sent && (
        <div className="row gap8 wrap">
          <p className={`small ${shown.tone === 'bad' ? 'error-text' : shown.tone === 'ok' ? 'brand-text' : ''}`} role="status">
            {shown.text}
          </p>
          {!sent.done && !polling && (
            <button
              type="button"
              className="abtn ghost sm"
              disabled={check.busy}
              aria-label={t('admin.settings.notifications.testEmail.checkLabel', { email: sent.to })}
              onClick={() => void checkNow()}
            >
              {t('admin.settings.notifications.testEmail.check')}
            </button>
          )}
        </div>
      )}
      <ErrorText error={check.error} />
    </form>
  );
}

/** Settings → Notifications: who gets each message and on which channels. */
export function NotificationsPage() {
  const { t } = useTranslation();
  const api = useApi();
  const { track } = useSave();
  const load = useCallback(() => api.get<NotificationSettings>('/admin/notifications'), [api]);
  const { state, reload, update } = useResource(load);

  async function toggle(kind: MessageKind, channel: Channel, on: boolean) {
    const result = await track(() => api.patch<NotificationSettings>(`/admin/notifications/${kind}`, { [channel]: on }));
    if (result) update(() => result);
  }

  return (
    <ResourceState state={state} reload={reload}>
      {(data) => {
        const labelled = data.messages.map((m) => ({ ...m, label: t(`admin.settings.notifications.kind.${m.kind}`) }));
        return (
          <>
            <section className="panel stack" aria-labelledby="messages-heading">
              <div className="panel-title">
                <h2 id="messages-heading">{t('admin.settings.notifications.title')}</h2>
                <span className="small muted">{t('admin.settings.notifications.intro')}</span>
              </div>
              {CHANNELS.filter((c) => !data.ready[c]).map((c) => (
                <p key={c} className="note">
                  {t('admin.settings.notifications.notReady', { channel: t(`admin.settings.notifications.${c}`) })}
                </p>
              ))}
              <div className="scroll-x">
                <table className="t">
                  <thead>
                    <tr>
                      <th scope="col">{t('admin.settings.notifications.message')}</th>
                      <th scope="col">{t('admin.settings.notifications.who')}</th>
                      {CHANNELS.map((c) => (
                        <th key={c} scope="col" className="cb">
                          {t(`admin.settings.notifications.${c}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {labelled.map((message) => (
                      <tr key={message.kind}>
                        <td className="b">{message.label}</td>
                        <td>
                          <span className={`badge ${message.audience === 'pro' ? 'grey' : 'g'}`}>
                            {t(`admin.settings.notifications.audience.${message.audience}`)}
                          </span>
                        </td>
                        {CHANNELS.map((channel) => (
                          <td key={channel} className="cb">
                            <input
                              type="checkbox"
                              className="cbox"
                              checked={message[channel]}
                              aria-label={t('admin.settings.notifications.channelLabel', {
                                channel: t(`admin.settings.notifications.${channel}`),
                                message: message.label,
                              })}
                              onChange={(e) => void toggle(message.kind, channel, e.target.checked)}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <TestMessage messages={labelled} />
            </section>
            <section className="panel stack">
              <MyPhone phone={data.me.phone} onSaved={reload} />
              <PushToggle buttonClass="abtn ghost" onChange={reload} />
            </section>
          </>
        );
      }}
    </ResourceState>
  );
}
