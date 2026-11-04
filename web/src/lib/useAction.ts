import { useCallback, useState } from 'react';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';

/**
 * Runs one user action at a time and keeps its error for display. A 401 rechecks the session, which
 * sends the person back to sign-in.
 */
export function useAction() {
  const { refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = useCallback(
    async <T>(work: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      setError(null);
      try {
        return await work();
      } catch (caught) {
        if (caught instanceof ApiError && caught.status === 401) {
          refresh();
        } else if (!(caught instanceof ApiError) || caught.status >= 500) {
          console.error('Action failed', caught);
        }
        setError(caught);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return { run, busy, error, clearError: () => setError(null) };
}
