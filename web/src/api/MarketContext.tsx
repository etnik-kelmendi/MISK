import { createContext, useCallback, useContext, useEffect, type ReactNode } from 'react';
import { usePolling } from '../lib/usePolling';
import { ResourceState } from '../components/ResourceState';
import { useApi } from './ApiContext';
import type { Catalogue } from './types';
import { useResource } from './useResource';

const MarketContext = createContext<Catalogue | null>(null);

/** Prices, hidden services and new trades reach open apps within this time. */
const CATALOGUE_REFRESH_MS = 30_000;

/**
 * Loads the catalogue, fee and time zone for every page below it, and keeps them fresh: again every
 * 30 seconds and whenever the app comes back to the screen, so catalogue changes show up straight away.
 */
export function MarketProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const load = useCallback(() => api.get<Catalogue>('/catalogue'), [api]);
  const { state, reload } = useResource(load);
  usePolling(reload, CATALOGUE_REFRESH_MS);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [reload]);
  return (
    <ResourceState state={state} reload={reload}>
      {(catalogue) => <MarketContext.Provider value={catalogue}>{children}</MarketContext.Provider>}
    </ResourceState>
  );
}

export function useMarket(): Catalogue {
  const value = useContext(MarketContext);
  if (!value) {
    throw new Error('useMarket must be used inside MarketProvider');
  }
  return value;
}
