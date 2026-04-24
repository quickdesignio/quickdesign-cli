/**
 * Tiny typed wrapper around fetch:
 *  - prepends resolved base URL
 *  - attaches Bearer token when available
 *  - normalizes errors → ApiError (with status + server body)
 *  - supports JSON responses + raw streaming (for SSE endpoints)
 */
import { resolveBaseUrl, resolveToken, tokenStillValid, readConfig } from './config.js';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** Send Authorization: Bearer <token>. Defaults true when a token is configured. */
  auth?: boolean;
  /** Extra headers merged on top of defaults. */
  headers?: Record<string, string>;
  /** Abort signal (timeout etc.). */
  signal?: AbortSignal;
  /** Don't parse JSON — return the raw Response instead. Used for streaming endpoints. */
  raw?: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
    public path: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const base = resolveBaseUrl().replace(/\/$/, '');
  const clean = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${base}${clean}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export async function request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = buildUrl(path, opts.query);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(opts.headers ?? {}),
  };

  const wantAuth = opts.auth !== false;                             // default true
  if (wantAuth) {
    const token = resolveToken();
    if (token) {
      // If the stored token is visibly expired, don't even try.
      const cfg = readConfig();
      if (!tokenStillValid({ ...cfg, token })) {
        throw new ApiError(
          'Your QuickDesign token has expired. Run `quickdesign login` to get a new one.',
          401,
          { code: 'TOKEN_EXPIRED' },
          path,
        );
      }
      headers.Authorization = `Bearer ${token}`;
    }
  }

  let body: BodyInit | undefined;
  if (opts.body !== undefined && opts.body !== null) {
    if (opts.body instanceof FormData || opts.body instanceof URLSearchParams) {
      body = opts.body;
    } else if (typeof opts.body === 'string') {
      body = opts.body;
      headers['Content-Type'] = headers['Content-Type'] ?? 'text/plain';
    } else {
      body = JSON.stringify(opts.body);
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    }
  }

  const res = await fetch(url, {
    method: opts.method ?? (body ? 'POST' : 'GET'),
    headers,
    body,
    signal: opts.signal,
  });

  if (opts.raw) {
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApiError(`${res.status} ${res.statusText}`, res.status, text, path);
    }
    return res as unknown as T;
  }

  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep text */
    }
  }

  if (!res.ok) {
    const message = (parsed as { error?: string } | null)?.error
      ?? `${res.status} ${res.statusText}`;
    throw new ApiError(message, res.status, parsed, path);
  }

  return parsed as T;
}
