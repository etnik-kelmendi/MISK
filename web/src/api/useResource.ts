import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from './client';

/** Logs a failed call, and rechecks the session when the API says it has ended. */
export function useApiErrorHandler() {
  const { refresh } = useAuth();

  return useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && error.status === 401) {
        refresh();
        return;
      }
      console.error('API request failed', error);
    },
    [refresh],
  );
}

type ResourceState<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error' };

/** Loads data for a page. Pass a stable `load`, and it reloads whenever `load` changes. */
export function useResource<T>(load: () => Promise<T>) {
  const handleError = useApiErrorHandler();
  const [state, setState] = useState<ResourceState<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    load().then(
      (data) => {
        if (current) {
          setState({ status: 'ready', data });
        }
      },
      (error: unknown) => {
        if (current) {
          handleError(error);
          setState({ status: 'error' });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [load, attempt, handleError]);

  const reload = useCallback(() => {
    setState((previous) => (previous.status === 'error' ? { status: 'loading' } : previous));
    setAttempt((value) => value + 1);
  }, []);

  const update = useCallback((change: (data: T) => T) => {
    setState((previous) =>
      previous.status === 'ready' ? { status: 'ready', data: change(previous.data) } : previous,
    );
  }, []);

  return { state, reload, update };
}
