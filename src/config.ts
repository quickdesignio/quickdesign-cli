/**
 * Auth + settings are kept in ~/.config/quickdesign/auth.json (0600 on Unix).
 * No secrets leak via ls — only the owning user can read the file.
 *
 * Shape:
 * {
 *   "token":     "<supabase JWT>",
 *   "userId":    "<uuid>",
 *   "email":     "you@example.com",
 *   "expiresAt": 1730000000,      // unix seconds
 *   "baseUrl":   "https://app.quickdesign.io"  // optional override
 * }
 */
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const DEFAULT_BASE_URL = 'https://app.quickdesign.io';

/**
 * Prod Supabase REST proxy. The raw `*.supabase.co` host stopped resolving
 * publicly — `my.quickdesign.io` is the production proxy in front of it. Env
 * override (`QUICKDESIGN_SUPABASE_URL`) still wins.
 */
export const DEFAULT_SUPABASE_URL = 'https://my.quickdesign.io';

/**
 * Public Supabase anon key. The same value is shipped in the SPA bundle
 * (`src/lib/supabase.ts`) — RLS gates everything so the key alone grants no
 * privileges. Keeps `design` subcommands and the refresh-token flow working
 * out of the box without making the user run `quickdesign auth config set
 * supabase_anon_key …`. Env override still wins.
 */
export const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93YXhpanptcnl6ZXB0dWx5d3pvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDUyMzIzNDksImV4cCI6MjA2MDgwODM0OX0.ChUrNv7wNB5sFxR34YaUZ5XLcQtcMTTCq9AwKP0mFuU';

export interface StoredConfig {
  token?: string;
  /**
   * Supabase refresh token. Lets us mint a new access_token without prompting
   * the user. Lives much longer than `token` (Supabase default: rotates on use,
   * fails after long inactivity). Stored alongside the access token in
   * ~/.config/quickdesign/auth.json (0600).
   */
  refreshToken?: string;
  userId?: string;
  email?: string;
  /** Unix seconds, not milliseconds. */
  expiresAt?: number;
  baseUrl?: string;
  /** Override Supabase REST base (default: DEFAULT_SUPABASE_URL). */
  supabaseUrl?: string;
  /** Supabase anon key — required for PostgREST + auth refresh calls. */
  supabaseAnonKey?: string;
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

/**
 * Effective Supabase REST base URL — env > config > hardcoded prod default.
 * `design` subcommands need this to hit PostgREST directly with the user's JWT.
 */
export function resolveSupabaseUrl(): string {
  return (
    process.env.QUICKDESIGN_SUPABASE_URL?.trim()
    || readConfig().supabaseUrl
    || DEFAULT_SUPABASE_URL
  );
}

/**
 * Effective Supabase anon key — env > config > hardcoded SPA-public default.
 */
export function resolveSupabaseAnonKey(): string | undefined {
  const env = process.env.QUICKDESIGN_SUPABASE_ANON_KEY?.trim();
  if (env) return env;
  return readConfig().supabaseAnonKey || DEFAULT_SUPABASE_ANON_KEY;
}

/**
 * Refresh the stored Supabase access token using the saved refresh token.
 *
 * Returns the new access token on success. Throws on failure — the refresh
 * token may have been rotated, expired, or revoked, in which case the caller
 * should surface a "please log in again" error.
 */
export async function refreshAccessToken(): Promise<string> {
  const cfg = readConfig();
  if (!cfg.refreshToken) {
    throw new Error('No refresh token stored. Run `quickdesign auth login`.');
  }
  const anonKey = resolveSupabaseAnonKey();
  if (!anonKey) {
    throw new Error('Missing Supabase anon key — cannot refresh token.');
  }

  const base = resolveSupabaseUrl().replace(/\/$/, '');
  const url = `${base}/auth/v1/token?grant_type=refresh_token`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
    },
    body: JSON.stringify({ refresh_token: cfg.refreshToken }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Refresh failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    expires_at?: number;
    user?: { id?: string; email?: string };
  };

  if (!json.access_token) {
    throw new Error('Refresh response had no access_token');
  }

  const parsed = parseJwtExpiry(json.access_token);
  writeConfig({
    ...cfg,
    token: json.access_token,
    // Supabase rotates refresh tokens; persist the new one so the next refresh
    // doesn't fail with "Already Used".
    refreshToken: json.refresh_token ?? cfg.refreshToken,
    expiresAt: parsed?.expiresAt ?? json.expires_at,
    userId: parsed?.userId ?? json.user?.id ?? cfg.userId,
    email: parsed?.email ?? json.user?.email ?? cfg.email,
  });

  return json.access_token;
}

/**
 * Return a fresh access token. If the stored token is still valid, returns it
 * as-is. If it's expired or near expiry and a refresh token exists, transparently
 * refreshes. Throws if no token is configured at all.
 */
export async function ensureFreshToken(): Promise<string | undefined> {
  // Env override always wins — assume the operator knows it's fresh.
  const envTok = process.env.QUICKDESIGN_TOKEN?.trim();
  if (envTok) return envTok;

  const cfg = readConfig();
  if (!cfg.token) return undefined;
  if (tokenStillValid(cfg)) return cfg.token;

  // Expired access_token: try to refresh.
  if (!cfg.refreshToken) return cfg.token; // legacy session — let the caller hit 401
  return refreshAccessToken();
}
