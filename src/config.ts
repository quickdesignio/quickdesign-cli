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

export interface StoredConfig {
  token?: string;
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
