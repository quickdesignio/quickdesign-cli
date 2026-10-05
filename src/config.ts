/**
 * Auth + settings are kept in ~/.config/quickdesign/auth.json (0600 on Unix).
 * No secrets leak via ls — only the owning user can read the file.
 *
 * Device-login session (CLI ≥ 0.17, `quickdesign login`):
 * {
 *   "authType":     "oauth",
 *   "token":        "<access token, 1 h>",
 *   "refreshToken": "<refresh token — 90 days, renewed on every use>",
 *   "userId":       "<uuid>",
 *   "expiresAt":    1730000000,                     // unix seconds
 *   "baseUrl":      "https://app.quickdesign.io"    // optional override
 * }
 *
 * Without "authType" the token came from `login --token` or from CLI ≤ 0.16
 * (a copy of the browser's Supabase session): it is used until it expires and
 * never renewed.
 */
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  existsSync,
  unlinkSync,
  openSync,
  closeSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { versionHeaders } from './version.js';

export const DEFAULT_BASE_URL = 'https://app.quickdesign.io';

/** The CLI's client id on the BFF's OAuth server (first-party, public). */
export const CLI_CLIENT_ID = 'quickdesign-cli';

/** Budget for one renewal round trip. */
export const REFRESH_TIMEOUT_MS = 30_000;
/**
 * A lock older than this belongs to a dead process. It must exceed
 * REFRESH_TIMEOUT_MS: a slow but live renewal that loses its lock lets a
 * second process renew with the same refresh token (spec R3).
 */
export const LOCK_STALE_MS = 45_000;
/** How long a process waits for a sibling's renewal before giving up. */
export const LOCK_WAIT_MS = 60_000;

export interface StoredConfig {
  /** 'oauth' = device-login session that renews itself. Absent = a token used until it expires. */
  authType?: 'oauth';
  token?: string;
  /** Rotates on every use. Only meaningful with authType 'oauth' (CLI ≤ 0.16 kept a Supabase one here). */
  refreshToken?: string;
  userId?: string;
  email?: string;
  /** Unix seconds, not milliseconds. */
  expiresAt?: number;
  baseUrl?: string;
}

export function configPath(): string {
  return join(homedir(), '.config', 'quickdesign', 'auth.json');
}

export function readConfig(): StoredConfig {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as StoredConfig;
  } catch {
    return {};
  }
}

export function writeConfig(c: StoredConfig): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(c, null, 2), 'utf8');
  try { chmodSync(p, 0o600); } catch { /* Windows: no-op */ }
}

export function clearConfig(): void {
  const p = configPath();
  if (existsSync(p)) unlinkSync(p);
}

/**
 * Effective base URL — env var beats config file beats default.
 * QUICKDESIGN_BASE_URL is the only supported env override.
 */
export function resolveBaseUrl(): string {
  return process.env.QUICKDESIGN_BASE_URL?.trim() || readConfig().baseUrl || DEFAULT_BASE_URL;
}

/**
 * Effective token — env var beats config file. Returns undefined if neither set.
 * QUICKDESIGN_TOKEN is the only supported env override.
 */
export function resolveToken(): string | undefined {
  const envTok = process.env.QUICKDESIGN_TOKEN?.trim();
  if (envTok) return envTok;
  return readConfig().token || undefined;
}

/** Best-effort parse of JWT expiry (exp claim, unix seconds). Returns null on bad JWT. */
export function parseJwtExpiry(jwt: string): { userId?: string; email?: string; expiresAt?: number } | null {
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as {
      sub?: string;
      email?: string;
      exp?: number;
    };
    return { userId: payload.sub, email: payload.email, expiresAt: payload.exp };
  } catch {
    return null;
  }
}

/** Returns true if the stored token exists and is still valid (with a 60s safety margin). */
export function tokenStillValid(c: StoredConfig = readConfig()): boolean {
  if (!c.token) return false;
  if (!c.expiresAt) return true;                              // legacy / missing — treat as valid
  return c.expiresAt * 1000 > Date.now() + 60 * 1000;
}

/** The stored session cannot be renewed; the user has to run `quickdesign login`. */
export class SessionEndedError extends Error {
  constructor(message = 'Session ended — run `quickdesign login`.') {
    super(message);
    this.name = 'SessionEndedError';
  }
}

/**
 * Persist a device-login session. Writes a clean shape: drops CLI ≤ 0.16 Supabase fields.
 *
 * `expiresAt` comes from this machine's clock — when the token request was
 * sent plus `expires_in` — not from the JWT's `exp`, so a clock that runs
 * behind the server's still renews before the server refuses the token.
 */
export function writeSession(s: { accessToken: string; refreshToken: string; expiresIn: number; requestSentAt?: number }): void {
  const existing = readConfig();
  const claims = parseJwtExpiry(s.accessToken);
  const userId = claims?.userId ?? existing.userId;
  writeConfig({
    authType: 'oauth',
    token: s.accessToken,
    refreshToken: s.refreshToken,
    userId,
    // Our access tokens carry no email; keep a known one for the same user.
    email: claims?.email ?? (userId && userId === existing.userId ? existing.email : undefined),
    expiresAt: Math.floor((s.requestSentAt ?? Date.now()) / 1000) + s.expiresIn,
    ...(existing.baseUrl ? { baseUrl: existing.baseUrl } : {}),
  });
}

/** Path to the refresh-mutex lockfile. */
function refreshLockPath(): string {
  return join(dirname(configPath()), 'refresh.lock');
}

/** Block this thread without burning CPU — the lock below is synchronous on purpose (no deps). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Acquire an exclusive cross-process lock around a renewal.
 *
 * The server rotates refresh tokens on every use, so two processes renewing
 * with the same one race; this lock serializes renewals across every
 * `quickdesign` process on the machine (the server also tolerates a race for
 * 30 s, but one renewal is cheaper than two).
 *
 * A lock older than `staleMs` is from a dead process and is removed. Caller
 * MUST release via the returned thunk.
 */
function acquireRefreshLock(timeoutMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS): () => void {
  const path = refreshLockPath();
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return (): void => {
        try { unlinkSync(path); } catch { /* already gone */ }
      };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      try {
        const age = Date.now() - statSync(path).mtimeMs;
        if (age > staleMs) {
          try { unlinkSync(path); } catch { /* race */ }
          continue;
        }
      } catch { /* lock vanished */ continue; }
      if (Date.now() > deadline) {
        throw new Error(`Another quickdesign process has been renewing the session for over ${Math.round(timeoutMs / 1000)} s. Try again.`);
      }
      sleepSync(200);
    }
  }
}

/**
 * Run `fn` while holding the renewal lock, so a write to auth.json (login,
 * logout, config set) never interleaves with a sibling's renewal: a renewal
 * that finishes after a logout would bring the session back, and one that
 * finishes after a login would switch back to the old account.
 *
 * The lock is synchronous: never call this while this process is renewing.
 */
export async function withSessionLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const release = acquireRefreshLock();
  try {
    return await fn();
  } finally {
    release();
  }
}

interface TokenEndpointBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}

let inflightRefresh: Promise<string> | null = null;

/**
 * Renew the stored session at the BFF (`/api/mcp/oauth/token`) and return the
 * new access token. Concurrent callers in one process share one renewal —
 * the file lock is synchronous, so two awaits on it in the same process would
 * otherwise deadlock until it went stale.
 *
 * Throws SessionEndedError when the session cannot be renewed (no device-login
 * session, or the server answers invalid_grant: revoked, rotated away, or idle
 * for 90 days). Other failures throw a retryable Error and keep the session.
 */
export function refreshAccessToken(): Promise<string> {
  return sharedRefresh();
}

/**
 * The server refused `rejected` (401 TOKEN_EXPIRED / INVALID_TOKEN) although
 * this machine still thinks it is valid — its clock runs behind, or the
 * server's keys changed. Renew anyway and return a different token.
 *
 * Shares the in-flight renewal with refreshAccessToken: parallel rejections in
 * one process make one `/token` call, and a sibling process that already
 * renewed wins without a call (re-read under the lock). Throws like
 * refreshAccessToken.
 */
export async function renewRejected(rejected: string): Promise<string> {
  const pending = inflightRefresh;
  if (pending) {
    const token = await pending;
    if (token !== rejected) return token;
  }
  return sharedRefresh(rejected);
}

function sharedRefresh(rejected?: string): Promise<string> {
  if (!inflightRefresh) {
    inflightRefresh = refreshUnderLock(rejected).finally(() => {
      inflightRefresh = null;
    });
  }
  return inflightRefresh;
}

/** `rejected`: a token the server refused — renew even if it looks valid here. */
function refreshUnderLock(rejected?: string): Promise<string> {
  return withSessionLock(async () => {
    // Re-read AFTER the lock — a sibling may have renewed while we waited.
    const cfg = readConfig();
    if (cfg.token && cfg.token !== rejected && tokenStillValid(cfg)) return cfg.token;
    if (cfg.authType !== 'oauth' || !cfg.refreshToken) throw new SessionEndedError();

    const requestSentAt = Date.now();
    let res: Response;
    try {
      res = await fetch(`${resolveBaseUrl().replace(/\/$/, '')}/api/mcp/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...versionHeaders() },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: cfg.refreshToken, client_id: CLI_CLIENT_ID }),
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`Could not reach QuickDesign to renew the session (${err instanceof Error ? err.message : String(err)}). Try again.`);
    }
    const body = (await res.json().catch(() => ({}))) as TokenEndpointBody;
    if (res.ok && body.access_token && body.refresh_token) {
      writeSession({ accessToken: body.access_token, refreshToken: body.refresh_token, expiresIn: body.expires_in ?? 3600, requestSentAt });
      return body.access_token;
    }
    // A sibling whose lock went stale may have rotated the token first and
    // left a good one behind — use it instead of logging the user out.
    const latest = readConfig();
    if (latest.token && latest.token !== cfg.token && tokenStillValid(latest)) return latest.token;
    if (body.error === 'invalid_grant') throw new SessionEndedError();
    throw new Error(`QuickDesign could not renew the session (HTTP ${res.status}). Try again.`);
  });
}

/**
 * A usable access token: QUICKDESIGN_TOKEN if set, else the stored one,
 * renewed when it is about to expire. undefined = not logged in.
 */
export async function ensureFreshToken(): Promise<string | undefined> {
  return (await currentBearer()).token;
}

/**
 * ensureFreshToken, plus whether the token came from a stored device-login
 * session — the only kind renewRejected can replace when the server refuses
 * it (QUICKDESIGN_TOKEN and pasted or CLI ≤ 0.16 tokens cannot renew).
 */
export async function currentBearer(): Promise<{ token: string | undefined; renewable: boolean }> {
  // Env override always wins — assume the operator knows it's fresh.
  const envTok = process.env.QUICKDESIGN_TOKEN?.trim();
  if (envTok) return { token: envTok, renewable: false };

  const cfg = readConfig();
  const renewable = cfg.authType === 'oauth';
  if (!cfg.token) return { token: undefined, renewable: false };
  if (tokenStillValid(cfg)) return { token: cfg.token, renewable };
  if (!renewable) throw new SessionEndedError();
  return { token: await refreshAccessToken(), renewable };
}

/** Best effort: tell the server to forget this session (`logout`, or the one a login replaced). Never throws. */
export async function revokeSession(cfg: StoredConfig = readConfig()): Promise<void> {
  if (cfg.authType !== 'oauth' || !cfg.refreshToken) return;
  try {
    await fetch(`${resolveBaseUrl().replace(/\/$/, '')}/api/mcp/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...versionHeaders() },
      body: JSON.stringify({ token: cfg.refreshToken, token_type_hint: 'refresh_token', client_id: CLI_CLIENT_ID }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Offline: the local logout still happens.
  }
}
