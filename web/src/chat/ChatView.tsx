import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi } from '../api/ApiContext';
import { useMarket } from '../api/MarketContext';
import type { ChatMessage } from '../api/types';
import { useResource } from '../api/useResource';
import { ErrorText } from '../components/ErrorText';
import { Icon } from '../components/Icon';
import { Avatar, IMAGE_TYPES, MAX_FILE_BYTES, useLightbox } from '../components/Photos';
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
 * (accepted, on the way, extra work requests) in between, quick replies, a message field and a photo button
 * (D83). Photos open full screen. Inside a pop-up (`inSheet`, D86) the pop-up's own title replaces the header.
 */
export function ChatView({
  side,
  path,
  otherName,
  otherPhotoId,
  otherDetail,
  statusLine,
  subtitle,
  back,
  events,
  quickReplies,
  closedFooter,
  closedText,
  inSheet = false,
}: {
  side: 'customer' | 'pro';
  /** The API path of the messages, e.g. /bookings/b1/messages. */
  path: string;
  otherName: string;
  /** The other side's photo, shown in the header (D83). */
  otherPhotoId?: string | null;
  /** A short line about the other side next to the status, e.g. "212 jobs" (D83). */
  otherDetail?: string;
  statusLine: string;
  subtitle: string;
  /** Where the header's back arrow goes; not needed inside a pop-up. */
  back?: string;
  events: ChatEvent[];
  quickReplies: string[];
  /** Shown instead of the message field when the chat is closed, e.g. "Rate Daniel". */
  closedFooter?: ReactNode;
  /** Why the chat is closed, e.g. "This job is done, so the chat is read-only." */
  closedText?: string;
  /** Shown in a pop-up (D86): no page header, and the conversation scrolls inside the pop-up. */
  inSheet?: boolean;
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
  const photoInput = useId();
  const [photoTooBig, setPhotoTooBig] = useState(false);
  const photoIds = state.status === 'ready' ? state.data.messages.flatMap((m) => (m.photoId ? [m.photoId] : [])) : [];
  const lightbox = useLightbox(photoIds, t('chat.photos'));

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

  async function sendPhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || send.busy) return;
    // Over 8 MB is refused here already, as the API would (D83).
    setPhotoTooBig(file.size > MAX_FILE_BYTES);
    if (file.size > MAX_FILE_BYTES) return;
    const result = await send.run(() => api.upload<{ message: ChatMessage }>(`${path}/photo`, file));
    if (result) update((current) => ({ ...current, messages: [...current.messages, result.message] }));
  }

  return (
    <div className={`chat ${inSheet ? 'in-sheet' : ''}`}>
      {!inSheet && (
        <header className="appbar chat-head">
          {back && (
            <Link to={back} className="iconbtn" aria-label={t('common.back')}>
              <Icon name="chevL" />
            </Link>
          )}
          <Avatar name={otherName} photoId={otherPhotoId} size="sm" />
          <div className="grow">
            <h1 className="b chat-name">{otherName}</h1>
            <p className="tiny brand-text b">
              {statusLine}
              {otherDetail && <span className="muted"> · {otherDetail}</span>}
            </p>
          </div>
        </header>
      )}
      <ResourceState state={state} reload={reload}>
        {({ messages, canWrite: open }) => {
          const items = [
            ...messages.map((m) => ({ key: `m-${m.id}`, at: m.createdAt, message: m })),
            ...events.map((e) => ({ key: e.key, at: e.at, event: e })),
          ].sort((a, b) => a.at.localeCompare(b.at));
          return (
            <>
              <div className="chat-body" role="log" aria-label={t('chat.conversation', { name: otherName })} aria-live="polite">
                <p className="tiny muted center">{inSheet ? `${statusLine} · ${subtitle}` : subtitle}</p>
                {items.length === 0 && <p className="small muted center">{t('chat.empty', { name: otherName })}</p>}
                {items.map((item) =>
                  'message' in item && item.message ? (
                    <div key={item.key} className={`bubble ${item.message.from === side ? 'me' : ''} ${item.message.photoId ? 'has-photo' : ''}`}>
                      <span className="visually-hidden">{item.message.from === side ? t('chat.you') : otherName}: </span>
                      {item.message.photoId && (
                        <PhotoBubble
                          photoId={item.message.photoId}
                          alt={item.message.from === side ? t('chat.yourPhoto') : t('chat.photoFrom', { name: otherName })}
                          index={photoIds.indexOf(item.message.photoId)}
                          lightbox={lightbox}
                        />
                      )}
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
                    <span className="file-button">
                      <input
                        id={photoInput}
                        type="file"
                        accept={IMAGE_TYPES}
                        className="visually-hidden"
                        disabled={send.busy}
                        onChange={(event) => void sendPhoto(event)}
                      />
                      <label htmlFor={photoInput} className={`iconbtn chat-photo ${send.busy ? 'disabled' : ''}`}>
                        <Icon name="camera" />
                        <span className="visually-hidden">{t('chat.sendPhoto')}</span>
                      </label>
                    </span>
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
                  {photoTooBig && (
                    <span className="error-text" role="alert">
                      {t('errors.file_too_large')}
                    </span>
                  )}
                  <ErrorText error={send.error} />
                </div>
              ) : (
                <div className="chat-foot stack">
                  <p className="small muted center">{closedText ?? t('chat.closed')}</p>
                  {closedFooter}
                </div>
              )}
            </>
          );
        }}
      </ResourceState>
      {lightbox.viewer}
    </div>
  );
}

/** A photo in a chat bubble; tapping it opens the chat's photos full screen at this one (D83). */
function PhotoBubble({
  photoId,
  alt,
  index,
  lightbox,
}: {
  photoId: string;
  alt: string;
  index: number;
  lightbox: ReturnType<typeof useLightbox>;
}) {
  const { t } = useTranslation();
  const api = useApi();
  return (
    <button ref={lightbox.register(index)} type="button" className="bubble-photo" aria-label={t('chat.openPhoto')} onClick={() => lightbox.openAt(index)}>
      <img src={api.fileUrl(photoId)} alt={alt} loading="lazy" />
    </button>
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
