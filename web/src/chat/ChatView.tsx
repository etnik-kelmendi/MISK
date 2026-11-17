import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi } from '../api/ApiContext';
import { useMarket } from '../api/MarketContext';
import type { ChatMessage } from '../api/types';
import { useResource } from '../api/useResource';
import { ErrorText } from '../components/ErrorText';
import { Icon } from '../components/Icon';
import { ResourceState } from '../components/ResourceState';
import { time } from '../lib/format';
import { useAction } from '../lib/useAction';
import { usePolling } from '../lib/usePolling';

/** How often an open chat checks for new messages. */
export const CHAT_REFRESH_MS = 5_000;
/** The longest message the API takes. */
export const MESSAGE_MAX = 1000;

/** Something shown in the conversation that is not a message: a status change or an extra work request. */
export interface ChatEvent {
  key: string;
  at: string;
  node: ReactNode;
}

/**
 * The chat between the customer and the pro of one booking (D67): messages, with the booking's own events
 * (accepted, on the way, extra work requests) in between, quick replies and a message field.
 */
export function ChatView({
  side,
  path,
  otherName,
  statusLine,
  subtitle,
  back,
  events,
  quickReplies,
  closedFooter,
}: {
  side: 'customer' | 'pro';
  /** The API path of the messages, e.g. /bookings/b1/messages. */
  path: string;
  otherName: string;
  statusLine: string;
  subtitle: string;
  back: string;
  events: ChatEvent[];
  quickReplies: string[];
  /** Shown instead of the message field when the chat is closed, e.g. "Rate Daniel". */
  closedFooter?: ReactNode;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const load = useCallback(() => api.get<{ messages: ChatMessage[]; canWrite: boolean }>(path), [api, path]);
  const { state, reload, update } = useResource(load);
  const [text, setText] = useState('');
  const send = useAction();
  const end = useRef<HTMLDivElement>(null);
  const canWrite = state.status === 'ready' && state.data.canWrite;
  const count = state.status === 'ready' ? state.data.messages.length : 0;
  usePolling(reload, CHAT_REFRESH_MS, canWrite);

  // New messages scroll into view.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [count, events.length]);

  async function submit(body: string, event?: FormEvent) {
    event?.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || send.busy) return;
    const result = await send.run(() => api.post<{ message: ChatMessage }>(path, { body: trimmed }));
    if (result) {
      update((current) => ({ ...current, messages: [...current.messages, result.message] }));
      if (body === text) setText('');
    }
  }

  return (
    <div className="chat">
      <header className="appbar chat-head">
        <Link to={back} className="iconbtn" aria-label={t('common.back')}>
          <Icon name="chevL" />
        </Link>
        <span className="av av-sm" aria-hidden="true">
          {otherName.slice(0, 1).toUpperCase()}
        </span>
        <div className="grow">
          <h1 className="b chat-name">{otherName}</h1>
          <p className="tiny brand-text b">{statusLine}</p>
        </div>
      </header>
      <ResourceState state={state} reload={reload}>
        {({ messages, canWrite: open }) => {
          const items = [
            ...messages.map((m) => ({ key: `m-${m.id}`, at: m.createdAt, message: m })),
            ...events.map((e) => ({ key: e.key, at: e.at, event: e })),
          ].sort((a, b) => a.at.localeCompare(b.at));
          return (
            <>
              <div className="chat-body" role="log" aria-label={t('chat.conversation', { name: otherName })} aria-live="polite">
                <p className="tiny muted center">{subtitle}</p>
                {items.length === 0 && <p className="small muted center">{t('chat.empty', { name: otherName })}</p>}
                {items.map((item) =>
                  'message' in item && item.message ? (
                    <div key={item.key} className={`bubble ${item.message.from === side ? 'me' : ''}`}>
                      <span className="visually-hidden">{item.message.from === side ? t('chat.you') : otherName}: </span>
                      {item.message.body}
                      <span className="bt">{time(item.message.createdAt, timezone)}</span>
                    </div>
                  ) : (
                    <div key={item.key}>{'event' in item ? item.event?.node : null}</div>
                  ),
                )}
                <div ref={end} />
              </div>
              {open ? (
                <div className="chat-foot">
                  <div className="chat-quick" role="group" aria-label={t('chat.quickReplies')}>
                    {quickReplies.map((reply) => (
                      <button key={reply} type="button" className="chip" disabled={send.busy} onClick={() => void submit(reply)}>
                        {reply}
                      </button>
                    ))}
                  </div>
                  <form className="row gap8" onSubmit={(event) => void submit(text, event)}>
                    <label htmlFor="chat-input" className="visually-hidden">
                      {t('chat.message', { name: otherName })}
                    </label>
                    <input
                      id="chat-input"
                      className="chat-input"
                      maxLength={MESSAGE_MAX}
                      autoComplete="off"
                      placeholder={t('chat.placeholder', { name: otherName })}
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                    />
                    <button type="submit" className="iconbtn send" aria-label={t('chat.send')} disabled={send.busy || !text.trim()}>
                      <Icon name="arrowR" />
                    </button>
                  </form>
                  <ErrorText error={send.error} />
                </div>
              ) : (
                <div className="chat-foot stack">
                  <p className="small muted center">{t('chat.closed')}</p>
                  {closedFooter}
                </div>
              )}
            </>
          );
        }}
      </ResourceState>
    </div>
  );
}

/** A status change in the conversation, e.g. "Daniel is on the way". */
export function ChatNote({ children }: { children: ReactNode }) {
  return (
    <p className="chat-sys">
      <Icon name="check" /> {children}
    </p>
  );
}
