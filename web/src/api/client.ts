/** The API answered with an error. Anything else that fails is a network problem. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  /** With `validation_failed`: the field the API refused, such as "email" or "priceCents". */
  readonly field: string | undefined;
  /** The whole error answer, for errors that carry more than a code (e.g. `account_suspended`). */
  readonly body: Record<string, unknown> | null;

  constructor(status: number, code?: string, field?: string, body: Record<string, unknown> | null = null) {
    super(`API responded with status ${status}`);
    this.status = status;
    this.code = code;
    this.field = field;
    this.body = body;
  }
}

/** How a suspended person can reach the team; each may be missing. */
export interface SupportContact {
  email: string | null;
  phone: string | null;
}

/** What the API says about a suspended account, only after the person proved who they are (D87). */
export interface Suspension {
  /** What the team chose to tell the person; null when they shared nothing. */
  message: string | null;
  support: SupportContact;
}

/** The suspension in an `account_suspended` answer, or null for any other error. */
export function suspensionOf(error: unknown): Suspension | null {
  if (!(error instanceof ApiError) || error.code !== 'account_suspended') {
    return null;
  }
  const body = error.body ?? {};
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);
  const support = (typeof body.support === 'object' && body.support !== null ? body.support : {}) as Record<string, unknown>;
  return { message: text(body.message), support: { email: text(support.email), phone: text(support.phone) } };
}

export interface Api {
  baseUrl: string;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  delete<T = void>(path: string): Promise<T>;
  /** Sends one file as multipart form data. */
  upload<T>(path: string, file: File): Promise<T>;
  /** Address of an uploaded file; the browser sends the session cookie with it. */
  fileUrl(id: string): string;
  /**
   * Calls `listener` whenever any request finds the account suspended, so the app can show why at once,
   * also in the middle of a session (D87). Returns a function that stops listening.
   */
  onSuspended(listener: (suspension: Suspension) => void): () => void;
}

export function createApi(baseUrl: string): Api {
  const suspendedListeners = new Set<(suspension: Suspension) => void>();

  async function send<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, { ...init, credentials: 'include' });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      const code = typeof body?.error === 'string' ? body.error : undefined;
      const field = typeof body?.field === 'string' ? body.field : undefined;
      const error = new ApiError(response.status, code, field, body);
      const suspension = suspensionOf(error);
      if (suspension) {
        for (const listener of suspendedListeners) listener(suspension);
      }
      throw error;
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  return {
    baseUrl,
    get: (path) => send(path, { method: 'GET' }),
    post: (path, body) => send(path, json('POST', body)),
    patch: (path, body) => send(path, json('PATCH', body)),
    put: (path, body) => send(path, json('PUT', body)),
    delete: (path) => send(path, { method: 'DELETE' }),
    upload: (path, file) => {
      const form = new FormData();
      form.append('file', file);
      return send(path, { method: 'POST', body: form });
    },
    fileUrl: (id) => `${baseUrl}/files/${encodeURIComponent(id)}`,
    onSuspended: (listener) => {
      suspendedListeners.add(listener);
      return () => {
        suspendedListeners.delete(listener);
      };
    },
  };
}
