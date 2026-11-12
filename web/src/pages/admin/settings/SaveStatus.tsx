import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorText } from '../../../components/ErrorText';
import { Icon } from '../../../components/Icon';
import { useAuth } from '../../../auth/AuthContext';
import { ApiError } from '../../../api/client';

type Status = 'saved' | 'saving' | 'failed';

interface SaveStatus {
  /** Runs one save and shows its progress in the page's "All changes saved" label. */
  track: <T>(save: () => Promise<T>) => Promise<T | undefined>;
}

const SaveContext = createContext<SaveStatus | null>(null);

/**
 * Every Settings change saves by itself; this keeps one label in sync with all of them. While any save
 * is running it says "Saving…", afterwards "All changes saved", and a failed save shows why.
 */
export function SaveStatusProvider({ children }: { children: (label: ReactNode) => ReactNode }) {
  const { t } = useTranslation();
  const { refresh } = useAuth();
  const [status, setStatus] = useState<Status>('saved');
  const [error, setError] = useState<unknown>(null);
  const running = useRef(0);

  const track = useCallback(
    async <T,>(save: () => Promise<T>): Promise<T | undefined> => {
      running.current += 1;
      setStatus('saving');
      setError(null);
      try {
        const result = await save();
        running.current -= 1;
        if (running.current === 0) setStatus('saved');
        return result;
      } catch (caught) {
        running.current -= 1;
        if (caught instanceof ApiError && caught.status === 401) refresh();
        else if (!(caught instanceof ApiError) || caught.status >= 500) console.error('Settings change not saved', caught);
        setError(caught);
        setStatus('failed');
        return undefined;
      }
    },
    [refresh],
  );

  const value = useMemo(() => ({ track }), [track]);
  const label = (
    <div className="save-status" aria-live="polite">
      {status === 'saving' && <span className="muted small">{t('admin.settings.saving')}</span>}
      {status === 'saved' && (
        <span className="badge g">
          <Icon name="check" /> {t('admin.settings.saved')}
        </span>
      )}
      {status === 'failed' && (
        <span className="small">
          <span className="error-text">{t('admin.settings.saveFailed')}</span>
          <ErrorText error={error} />
        </span>
      )}
    </div>
  );
  return <SaveContext.Provider value={value}>{children(label)}</SaveContext.Provider>;
}

export function useSave(): SaveStatus {
  const value = useContext(SaveContext);
  if (!value) {
    throw new Error('useSave must be used inside SaveStatusProvider');
  }
  return value;
}
