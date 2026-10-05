/**
 * Tiny typed wrapper around fetch:
 *  - prepends resolved base URL
 *  - attaches Bearer token when available
 *  - normalizes errors → ApiError (with status + server body)
 *  - supports JSON responses + raw streaming (for SSE endpoints)
 */
import { resolveBaseUrl, currentBearer, renewRejected, SessionEndedError } from './config.js';
import { parseSse, type SseFrame } from './utils/sse.js';
import { versionHeaders } from './version.js';

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

/** Default overall budget for JSON request/response round trips. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Caller-supplied signal wins; otherwise apply a default timeout so a hung
 * server can never wedge the CLI forever. Note for future `raw: true` callers:
 * the raw Response shares this 120s budget — pass your own signal when
 * streaming large bodies.
 */
function effectiveSignal(signal?: AbortSignal, ms = DEFAULT_REQUEST_TIMEOUT_MS): AbortSignal {
  return signal ?? AbortSignal.timeout(ms);
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

/**
 * A renewal failure as an ApiError. An ended session becomes one actionable
 * line; a failed renewal keeps its own message (it never carries a server's
 * response body).
 */
function renewalError(err: unknown, path: string): ApiError {
  if (err instanceof SessionEndedError) {
    return new ApiError(err.message, 401, { code: 'SESSION_ENDED' }, path);
  }
  return new ApiError(err instanceof Error ? err.message : String(err), 401, { code: 'TOKEN_REFRESH_FAILED' }, path);
}

/** The bearer for a request, renewing the session when needed. */
async function bearerFor(path: string): Promise<{ token: string | undefined; renewable: boolean }> {
  try {
    return await currentBearer();
  } catch (err) {
    throw renewalError(err, path);
  }
}

/** The BFF's `message` codes for a bearer it refused (auth.middleware → AppError). */
const REJECTED_TOKEN_CODES = new Set(['TOKEN_EXPIRED', 'INVALID_TOKEN']);

async function serverRejectedToken(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  const body = (await res.clone().json().catch(() => null)) as { message?: unknown } | null;
  return typeof body?.message === 'string' && REJECTED_TOKEN_CODES.has(body.message);
}

/**
 * Send a request with the session's bearer (`send(undefined)` = no auth).
 *
 * When the server refuses a device-login bearer that this machine still
 * thinks is valid (its clock runs behind, or the server's keys changed),
 * renew the session once and send again with the new token. Only on 401
 * TOKEN_EXPIRED / INVALID_TOKEN, never twice, never for QUICKDESIGN_TOKEN or
 * a pasted token — those cannot renew. `send` must be callable twice: every
 * body the client sends (JSON or plain strings, FormData, URLSearchParams) is.
 */
async function sendWithSession(
  path: string,
  wantAuth: boolean,
  send: (token: string | undefined) => Promise<Response>,
): Promise<Response> {
  const bearer = wantAuth ? await bearerFor(path) : { token: undefined, renewable: false };
  const res = await send(bearer.token);
  if (!bearer.token || !bearer.renewable || !(await serverRejectedToken(res))) return res;

  void res.body?.cancel().catch(() => undefined);              // read through the clone already
  let renewed: string;
  try {
    renewed = await renewRejected(bearer.token);
  } catch (err) {
    throw renewalError(err, path);
  }
  return send(renewed);
}

function withBearer(headers: Record<string, string>, token: string | undefined): Record<string, string> {
  return token ? { ...headers, Authorization: `Bearer ${token}` } : headers;
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
    ...versionHeaders(),
    ...(opts.headers ?? {}),
  };

  // Strings, FormData and URLSearchParams can all be sent twice (see sendWithSession).
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

  const method = opts.method ?? (body ? 'POST' : 'GET');
  const res = await sendWithSession(path, opts.auth !== false, (token) =>   // auth defaults true
    fetch(url, { method, headers: withBearer(headers, token), body, signal: effectiveSignal(opts.signal) }),
  );

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
    // Legacy routes answer `{ error: "…" }`; /api/v1-shaped ones (e.g.
    // /api/templates) answer `{ error: { code, message } }`.
    const err = (parsed as { error?: string | { message?: string } } | null)?.error;
    const message = (typeof err === 'string' ? err : err?.message) ?? `${res.status} ${res.statusText}`;
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
    ...versionHeaders(),
    ...(opts.headers ?? {}),
  };

  const payload = JSON.stringify(body ?? {});

  // Connect-timeout only: abort if headers don't arrive within 30s, but once
  // the stream is open let it run as long as it likes (brand-dna streams for
  // minutes). The caller's signal keeps propagating for the whole stream.
  const connect = async (token: string | undefined): Promise<Response> => {
    const controller = new AbortController();
    const connectTimer = setTimeout(
      () => controller.abort(new Error('SSE connect timeout (30s)')),
      30_000,
    );
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => controller.abort(opts.signal!.reason), { once: true });
    }
    try {
      return await fetch(url, {
        method: 'POST',
        headers: withBearer(headers, token),
        body: payload,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(connectTimer);
    }
  };

  const res = await sendWithSession(path, opts.auth !== false, connect);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep text */ }
    const message = (parsed as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`;
    throw new ApiError(message, res.status, parsed, path);
  }

  yield* parseSse<T>(res.body);
}
