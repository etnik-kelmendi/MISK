import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useApi } from '../api/ApiContext';
import type { Inbox } from '../api/types';
import { usePolling } from '../lib/usePolling';

/** How often the app checks for new messages while it is open. */
export const INBOX_REFRESH_MS = 30_000;

interface InboxValue {
  inbox: Inbox | null;
  /** True when the messages could not be loaded the last time. */
  failed: boolean;
  reload: () => void;
  markRead: () => Promise<void>;
}

const InboxContext = createContext<InboxValue | null>(null);

/** Keeps a customer's or pro's messages and the unread count fresh for the tab bar and the Messages page. */
export function InboxProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(() => {
    api.get<Inbox>('/inbox').then(
      (data) => {
        setInbox(data);
        setFailed(false);
      },
      (error: unknown) => {
        // The badge is a convenience: a failed check is retried on the next poll and shown on the page.
        console.warn('Could not load messages', error);
        setFailed(true);
      },
    );
  }, [api]);

  useEffect(reload, [reload]);
  usePolling(reload, INBOX_REFRESH_MS);

  const markRead = useCallback(async () => {
    await api.post('/inbox/read');
    setInbox((current) => (current ? { messages: current.messages.map((m) => ({ ...m, read: true })), unread: 0 } : current));
  }, [api]);

  const value = useMemo(() => ({ inbox, failed, reload, markRead }), [inbox, failed, reload, markRead]);
  return <InboxContext.Provider value={value}>{children}</InboxContext.Provider>;
}

export function useInbox(): InboxValue {
  const value = useContext(InboxContext);
  if (!value) {
    throw new Error('useInbox must be used inside InboxProvider');
  }
  return value;
}
