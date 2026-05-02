/**
 * Tiny typed wrapper around fetch:
 *  - prepends resolved base URL
 *  - attaches Bearer token when available
 *  - normalizes errors → ApiError (with status + server body)
 *  - supports JSON responses + raw streaming (for SSE endpoints)
 */
import {
  resolveBaseUrl,
  ensureFreshToken,
  resolveSupabaseUrl,
  resolveSupabaseAnonKey,
} from './config.js';
import { parseSse, type SseFrame } from './utils/sse.js';

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
    // Transparently refreshes a near-expired access_token if a refresh token is
    // stored. Throws only when refresh fails outright — the caller surfaces a
    // "log in again" message in that case.
    let token: string | undefined;
    try {
      token = await ensureFreshToken();
    } catch (err) {
      throw new ApiError(
        `Token refresh failed (${err instanceof Error ? err.message : String(err)}). Run \`quickdesign auth login\` again.`,
        401,
        { code: 'TOKEN_REFRESH_FAILED' },
        path,
      );
    }
    if (token) headers.Authorization = `Bearer ${token}`;
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

/**
 * POST a JSON body to an SSE endpoint and yield parsed frames.
 *
 * The BFF's brand-dna endpoint (and likely future Claude-streamed endpoints)
 * use Server-Sent Events. Node's fetch doesn't ship an EventSource, so we POST
 * manually and feed the response body to the line-buffered parser in
 * `utils/sse.ts`.
 */
export async function* streamSse<T = unknown>(
  path: string,
  body: unknown,
  opts: Omit<RequestOptions, 'raw' | 'body' | 'method'> = {},
): AsyncIterable<SseFrame<T>> {
  const url = buildUrl(path, opts.query);
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
    ...(opts.headers ?? {}),
  };

  const wantAuth = opts.auth !== false;
  if (wantAuth) {
    let token: string | undefined;
    try {
      token = await ensureFreshToken();
    } catch (err) {
      throw new ApiError(
        `Token refresh failed (${err instanceof Error ? err.message : String(err)}). Run \`quickdesign auth login\` again.`,
        401,
        { code: 'TOKEN_REFRESH_FAILED' },
        path,
      );
    }
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
    signal: opts.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep text */ }
    const message = (parsed as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`;
    throw new ApiError(message, res.status, parsed, path);
  }

  yield* parseSse<T>(res.body);
}

/**
 * Call Supabase's PostgREST directly with the user's JWT.
 *
 * `designs` and other user-owned tables have RLS that filters on
 * `createdBy = auth.uid()`, so using the anon key + the user's JWT is both
 * safe and matches the frontend's pattern (see
 * `src/components/AssetSelectionModal/utils/supabaseQuery.ts`).
 *
 * Returns the parsed JSON body; set `opts.raw = true` to get the Response.
 */
export async function requestSupabase<T = unknown>(
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const base = resolveSupabaseUrl().replace(/\/$/, '');
  const clean = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${base}${clean}`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }

  const anonKey = resolveSupabaseAnonKey();
  if (!anonKey) {
    throw new ApiError(
      'Supabase anon key is not configured. Set QUICKDESIGN_SUPABASE_ANON_KEY or run `quickdesign config set supabase_anon_key <key>`.',
      500,
      { code: 'MISSING_ANON_KEY' },
      path,
    );
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    apikey: anonKey,
    ...(opts.headers ?? {}),
  };

  const wantAuth = opts.auth !== false;
  if (wantAuth) {
    let token: string | undefined;
    try {
      token = await ensureFreshToken();
    } catch (err) {
      throw new ApiError(
        `Token refresh failed (${err instanceof Error ? err.message : String(err)}). Run \`quickdesign auth login\` again.`,
        401,
        { code: 'TOKEN_REFRESH_FAILED' },
        path,
      );
    }
    if (!token) {
      throw new ApiError(
        'Not logged in. Run `quickdesign auth login` or set QUICKDESIGN_TOKEN.',
        401,
        { code: 'NO_TOKEN' },
        path,
      );
    }
    headers.Authorization = `Bearer ${token}`;
  }

  let body: BodyInit | undefined;
  if (opts.body !== undefined && opts.body !== null) {
    body = JSON.stringify(opts.body);
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
  }

  const res = await fetch(url, {
    method: opts.method ?? (body ? 'POST' : 'GET'),
    headers,
    body,
    signal: opts.signal,
  });

  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try { parsed = JSON.parse(text); } catch { /* keep text */ }
  }

  if (!res.ok) {
    const message = (parsed as { message?: string; error?: string } | null)?.message
      ?? (parsed as { error?: string } | null)?.error
      ?? `${res.status} ${res.statusText}`;
    throw new ApiError(message, res.status, parsed, path);
  }

  return parsed as T;
}
