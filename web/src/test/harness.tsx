import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';
import { ApiProvider } from '../api/ApiContext';
import { createApi } from '../api/client';
import { MarketProvider } from '../api/MarketContext';
import type { Catalogue, User } from '../api/types';
import { AppRoutes } from '../App';
import { AuthProvider } from '../auth/AuthContext';
import type { AppConfig } from '../config';

export const BASE = 'http://api.test';
export const config: AppConfig = { site: 'app', apiBaseUrl: BASE, termsUrl: null, privacyUrl: null };

export const catalogue: Catalogue = {
  timezone: 'Europe/Berlin',
  feeCents: 290,
  proSharePct: 82,
  categories: [
    {
      id: 'cat-garden',
      slug: 'gardening',
      name: 'Gardening',
      icon: 'leaf',
      approvedPros: 3,
      services: [
        {
          id: 'svc-mow',
          categoryId: 'cat-garden',
          name: 'Lawn mowing',
          description: 'Mow, edge and clear',
          priceCents: 3500,
          durationMinutes: 60,
          sizeSmallPct: 100,
          sizeMediumPct: 130,
          sizeLargePct: 170,
          sortOrder: 0,
          active: true,
          pricing: 'fixed',
          isNew: false,
        },
      ],
    },
  ],
};

export const users: Record<'customer' | 'pro' | 'admin' | 'new', User> = {
  customer: { id: 'u-customer', role: 'customer', phone: '+4915100000001', username: null, email: null, firstName: 'Sara', lastName: null },
  pro: { id: 'u-pro', role: 'pro', phone: '+4915100000002', username: null, email: null, firstName: 'Daniel', lastName: null },
  admin: {
    id: 'u-admin',
    role: 'admin',
    phone: null,
    username: 'admin',
    email: null,
    firstName: null,
    lastName: null,
    adminRole: 'admin',
    areas: ['overview', 'bookings', 'providers', 'plans', 'catalogue', 'fees', 'zones', 'notifications', 'team'],
  },
  new: { id: 'u-new', role: null, phone: '+4915100000003', username: null, email: null, firstName: null, lastName: null },
};

type Answer = { status?: number; body?: unknown };
/** A fixed answer, or a function of the request; a function may answer later (a Promise) to test "sending" states. */
type Reply = Answer | ((request: { body: unknown; url: URL }) => Answer | Promise<Answer>);

export interface FakeApi {
  /** Every call made, as "METHOD /path". */
  calls: string[];
  bodies: Record<string, unknown>;
  on: (route: string, reply: Reply) => void;
}

/**
 * Replaces fetch with a router keyed by "METHOD /path" (query string ignored). Unknown routes answer
 * 404, so a test fails loudly when a page calls something unexpected.
 */
export function fakeApi(user: User | null): FakeApi {
  const routes = new Map<string, Reply>();
  const calls: string[] = [];
  const bodies: Record<string, unknown> = {};
  routes.set('GET /catalogue', { body: catalogue });
  routes.set('GET /inbox', { body: { messages: [], unread: 0 } });
  routes.set('GET /auth/me', user ? { body: { user } } : { status: 401, body: { error: 'unauthenticated' } });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const key = `${init?.method ?? 'GET'} ${url.pathname}`;
      calls.push(key);
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body;
      bodies[key] = body;
      const reply = routes.get(key);
      const resolved = await (typeof reply === 'function' ? reply({ body, url }) : (reply ?? { status: 404, body: { error: 'not_found' } }));
      const status = resolved.status ?? 200;
      return new Response(status === 204 ? null : JSON.stringify(resolved.body ?? {}), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return { calls, bodies, on: (route, reply) => routes.set(route, reply) };
}

/** Renders a page of the site it belongs to: /admin pages on the control panel, the rest in the app. */
export function renderAt(path: string, site: 'app' | 'admin' = path.startsWith('/admin') ? 'admin' : 'app') {
  return render(
    <ApiProvider api={createApi(BASE)} config={config}>
      <AuthProvider>
        <MarketProvider>
          <RouterProvider router={createMemoryRouter([{ path: '*', element: <AppRoutes site={site} /> }], { initialEntries: [path] })} />
        </MarketProvider>
      </AuthProvider>
    </ApiProvider>,
  );
}
