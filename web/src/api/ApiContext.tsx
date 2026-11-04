import { createContext, useContext, type ReactNode } from 'react';
import type { AppConfig } from '../config';
import type { Api } from './client';

interface ApiContextValue {
  api: Api;
  config: AppConfig;
}

const ApiContext = createContext<ApiContextValue | null>(null);

export function ApiProvider({ api, config, children }: ApiContextValue & { children: ReactNode }) {
  return <ApiContext.Provider value={{ api, config }}>{children}</ApiContext.Provider>;
}

function useApiContext(): ApiContextValue {
  const value = useContext(ApiContext);
  if (!value) {
    throw new Error('useApi must be used inside ApiProvider');
  }
  return value;
}

export const useApi = () => useApiContext().api;
export const useAppConfig = () => useApiContext().config;
