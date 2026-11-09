import { useCallback, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../api/ApiContext';
import type { Channel, MessageKind, NotificationSettings } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
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

function TestButton({ kind, label }: { kind: MessageKind; label: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const action = useAction();
  const [result, setResult] = useState<string | null>(null);

  async function send() {
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
    <span className="stack tight">
      <button
        type="button"
        className="abtn ghost"
        disabled={action.busy}
        aria-label={t('admin.settings.notifications.testLabel', { message: label })}
        onClick={() => void send()}
      >
        {t('admin.settings.notifications.test')}
      </button>
      {result && (
        <span className="small" role="status">
          {result}
        </span>
      )}
      <ErrorText error={action.error} />
    </span>
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
      {(data) => (
        <div className="stack">
          <section className="panel stack" aria-labelledby="messages-heading">
            <h2 id="messages-heading">{t('admin.settings.tabs.notifications')}</h2>
            <p className="small muted">{t('admin.settings.notifications.intro')}</p>
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
                      <th key={c} scope="col">
                        {t(`admin.settings.notifications.${c}`)}
                      </th>
                    ))}
                    <th scope="col">
                      <span className="visually-hidden">{t('admin.settings.notifications.test')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.messages.map((message) => {
                    const label = t(`admin.settings.notifications.kind.${message.kind}`);
                    return (
                      <tr key={message.kind}>
                        <td className="b">{label}</td>
                        <td>
                          <span className={`badge ${message.audience === 'pro' ? 'a' : 'b'}`}>
                            {t(`admin.settings.notifications.audience.${message.audience}`)}
                          </span>
                        </td>
                        {CHANNELS.map((channel) => (
                          <td key={channel}>
                            <input
                              type="checkbox"
                              className="check"
                              checked={message[channel]}
                              aria-label={t('admin.settings.notifications.channelLabel', {
                                channel: t(`admin.settings.notifications.${channel}`),
                                message: label,
                              })}
                              onChange={(e) => void toggle(message.kind, channel, e.target.checked)}
                            />
                          </td>
                        ))}
                        <td>
                          <TestButton kind={message.kind} label={label} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
          <section className="panel stack">
            <MyPhone phone={data.me.phone} onSaved={reload} />
            <PushToggle buttonClass="abtn ghost" onChange={reload} />
          </section>
        </div>
      )}
    </ResourceState>
  );
}
