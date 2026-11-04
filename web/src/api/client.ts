/** The API answered with an error. Anything else that fails is a network problem. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code?: string) {
    super(`API responded with status ${status}`);
    this.status = status;
    this.code = code;
  }
}

export interface Api {
  baseUrl: string;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  /** Sends one file as multipart form data. */
  upload<T>(path: string, file: File): Promise<T>;
  /** Address of an uploaded file; the browser sends the session cookie with it. */
  fileUrl(id: string): string;
}

export function createApi(baseUrl: string): Api {
  async function send<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, { ...init, credentials: 'include' });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new ApiError(response.status, body?.error);
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
    upload: (path, file) => {
      const form = new FormData();
      form.append('file', file);
      return send(path, { method: 'POST', body: form });
    },
    fileUrl: (id) => `${baseUrl}/files/${encodeURIComponent(id)}`,
  };
}
