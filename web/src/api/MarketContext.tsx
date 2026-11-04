import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { ResourceState } from '../components/ResourceState';
import { useApi } from './ApiContext';
import type { Catalogue } from './types';
import { useResource } from './useResource';

const MarketContext = createContext<Catalogue | null>(null);

/** Loads the catalogue, fee and time zone once for every page below it. */
export function MarketProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const load = useCallback(() => api.get<Catalogue>('/catalogue'), [api]);
  const { state, reload } = useResource(load);
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
