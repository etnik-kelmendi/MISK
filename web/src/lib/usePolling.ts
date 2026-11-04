import { useEffect } from 'react';

/** Calls `refresh` every `intervalMs` while `active` and the tab is visible. */
export function usePolling(refresh: () => void, intervalMs: number, active = true) {
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        refresh();
      }
    }, intervalMs);
    return () => clearInterval(timer);
  }, [refresh, intervalMs, active]);
}
