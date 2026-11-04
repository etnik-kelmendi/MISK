import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useApi } from '../api/ApiContext';
import { ApiError } from '../api/client';
import type { User } from '../api/types';

type AuthState = { status: 'loading' } | { status: 'signedOut' } | { status: 'signedIn'; user: User } | { status: 'error' };

interface AuthContextValue {
  state: AuthState;
  /** Asks the API who is signed in, e.g. after a 401 or at start-up. */
  refresh: () => void;
  setUser: (user: User) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    api.get<{ user: User }>('/auth/me').then(
      ({ user }) => current && setState({ status: 'signedIn', user }),
      (error: unknown) => {
        if (!current) {
          return;
        }
        if (error instanceof ApiError && error.status === 401) {
          setState({ status: 'signedOut' });
        } else {
          console.error('Could not check the session', error);
          setState({ status: 'error' });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [api, attempt]);

  const refresh = useCallback(() => setAttempt((value) => value + 1), []);
  const setUser = useCallback((user: User) => setState({ status: 'signedIn', user }), []);
  const logout = useCallback(async () => {
    await api.post('/auth/logout').catch((error: unknown) => console.error('Logout failed', error));
    setState({ status: 'signedOut' });
  }, [api]);

  const value = useMemo(() => ({ state, refresh, setUser, logout }), [state, refresh, setUser, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return value;
}

/** The signed-in user. Only use below a route guard that guarantees one. */
export function useUser(): User {
  const { state } = useAuth();
  if (state.status !== 'signedIn') {
    throw new Error('useUser used without a signed-in user');
  }
  return state.user;
}
