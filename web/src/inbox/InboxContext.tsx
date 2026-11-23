import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApi } from '../api/ApiContext';
import type { Inbox, InboxMessage, InboxUnread } from '../api/types';
import { usePolling } from '../lib/usePolling';

/** How often the app checks for new messages while it is open. */
export const INBOX_REFRESH_MS = 15_000;
/** Messages already announced in this browser tab, so a reload does not announce them again. */
const ANNOUNCED_KEY = 'misk-announced-messages';
const MAX_REMEMBERED = 200;

interface InboxValue {
  inbox: Inbox | null;
  /** True when the messages could not be loaded the last time. */
  failed: boolean;
  /** Unread messages that arrived and have not been announced or dismissed yet, newest first. */
  fresh: InboxMessage[];
  dismissFresh: () => void;
  reload: () => void;
  markRead: () => Promise<void>;
}

const InboxContext = createContext<InboxValue | null>(null);

/** The text without the "MISK:" that starts every text message, beginning with a capital letter. */
export function readable(body: string): string {
  const text = body.replace(/^MISK:\s*/, '');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A message the MISK team wrote to this person on the control panel (D87). */
export const isTeamMessage = (message: Pick<InboxMessage, 'kind'>) => message.kind === 'team_message';

/** What a message says, without the "MISK:" or "MISK team:" it starts with; team messages are labelled instead. */
export function messageText(message: Pick<InboxMessage, 'kind' | 'body'>): string {
  return isTeamMessage(message) ? message.body.replace(/^MISK team:\s*/, '') : readable(message.body);
}

function rememberedIds(): Set<string> {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(ANNOUNCED_KEY) ?? '[]');
    return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    // Storage can be blocked (private window); announcing again after a reload is harmless.
    return new Set();
  }
}

function remember(ids: Set<string>) {
  try {
    sessionStorage.setItem(ANNOUNCED_KEY, JSON.stringify([...ids].slice(-MAX_REMEMBERED)));
  } catch {
    // See rememberedIds.
  }
}

/** A system notification when the app is in the background and the person allowed notifications. */
function notifySystem(message: InboxMessage) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || document.visibilityState === 'visible') {
      return;
    }
    new Notification('MISK', { body: readable(message.body), tag: message.id });
  } catch (error) {
    // Some browsers only allow notifications from a service worker; the banner still shows.
    console.warn('Could not show a system notification', error);
  }
}

/**
 * Keeps a customer's or pro's messages and the unread count fresh for the tab bar and the Messages page,
 * and notices new ones: a job the team gave a pro, a cancelled job, and so on, so the app can announce
 * them straight away instead of only raising the number on the Messages tab.
 */
export function InboxProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [failed, setFailed] = useState(false);
  const [fresh, setFresh] = useState<InboxMessage[]>([]);
  const announced = useRef<Set<string> | null>(null);
  // What the loaded list had, so the frequent cheap check knows when the list must be loaded again.
  const loaded = useRef<InboxUnread | null>(null);

  const reload = useCallback(() => {
    api.get<Inbox>('/inbox').then(
      (data) => {
        setInbox(data);
        setFailed(false);
        loaded.current = { unread: data.unread, newestId: data.messages[0]?.id ?? null };
        announced.current ??= rememberedIds();
        const seen = announced.current;
        const arrived = data.messages.filter((m) => !m.read && !seen.has(m.id));
        if (arrived.length > 0) {
          for (const m of arrived) seen.add(m.id);
          remember(seen);
          setFresh((current) => [...arrived, ...current.filter((m) => !arrived.some((a) => a.id === m.id))]);
          if (arrived[0]) notifySystem(arrived[0]);
        }
      },
      (error: unknown) => {
        // The badge is a convenience: a failed check is retried on the next poll and shown on the page.
        console.warn('Could not load messages', error);
        setFailed(true);
      },
    );
  }, [api]);

  // While the app is open: only the unread count and newest message, and the whole list only when they changed.
  const check = useCallback(() => {
    api.get<InboxUnread>('/inbox/unread').then(
      (latest) => {
        const known = loaded.current;
        if (!known || known.unread !== latest.unread || known.newestId !== latest.newestId) reload();
      },
      // Retried on the next check; a suspended account is handled by the app as a whole.
      (error: unknown) => console.warn('Could not check for new messages', error),
    );
  }, [api, reload]);

  useEffect(reload, [reload]);
  usePolling(check, INBOX_REFRESH_MS);
  // Coming back to the app checks at once, so a job given while it was in the background shows up.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [reload]);

  const dismissFresh = useCallback(() => setFresh([]), []);

  const markRead = useCallback(async () => {
    await api.post('/inbox/read');
    setFresh([]);
    setInbox((current) => (current ? { messages: current.messages.map((m) => ({ ...m, read: true })), unread: 0 } : current));
    if (loaded.current) loaded.current = { ...loaded.current, unread: 0 };
  }, [api]);

  const value = useMemo(() => ({ inbox, failed, fresh, dismissFresh, reload, markRead }), [inbox, failed, fresh, dismissFresh, reload, markRead]);
  return <InboxContext.Provider value={value}>{children}</InboxContext.Provider>;
}

export function useInbox(): InboxValue {
  const value = useContext(InboxContext);
  if (!value) {
    throw new Error('useInbox must be used inside InboxProvider');
  }
  return value;
}
