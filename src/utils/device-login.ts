/**
 * `quickdesign login` — device authorization (RFC 8628) against the BFF's
 * OAuth server. Prints a short code and a URL, then polls /token while the
 * user approves the code in any browser where they are signed in to
 * QuickDesign. Nothing has to reach this machine, so it works over SSH, in
 * containers and from Claude Code's `!` shell — the old loopback login fell
 * back to a pasted token there, which never renewed, and otherwise copied the
 * browser's own Supabase session (spec R1, R5).
 */
import open from 'open';
import kleur from 'kleur';
import { CLI_CLIENT_ID, resolveBaseUrl } from '../config.js';
import { versionHeaders } from '../version.js';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const EXPIRED = 'Code expired — run `quickdesign login` again.';

export interface DeviceSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  /** When the request that returned these tokens was sent (ms) — writeSession counts expires_in from it. */
  requestSentAt: number;
}

/** Seams for tests: network, clock, output and browser. */
export interface DeviceLoginDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  openBrowser?: (url: string) => Promise<unknown>;
}

interface DeviceStart {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
}

interface TokenPoll {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}

/**
 * The server's OAuth error code, or undefined. `error` is not always a code:
 * the BFF's rate limiter puts a sentence there. Never show the user prose.
 */
function oauthCode(error: unknown): string | undefined {
  return typeof error === 'string' && /^[a-z_]+$/.test(error) ? error : undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Only try a browser where one can open; the printed link always works. */
function canOpenBrowser(): boolean {
  if (process.env.QUICKDESIGN_NO_BROWSER) return false;
  if (process.platform !== 'linux') return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.WSL_DISTRO_NAME);
}

export async function deviceLogin(opts: { timeoutMs?: number } = {}, deps: DeviceLoginDeps = {}): Promise<DeviceSession> {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const base = resolveBaseUrl().replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...versionHeaders() };

  let startRes: Response;
  try {
    startRes = await doFetch(`${base}/api/mcp/oauth/device_authorization`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ client_id: CLI_CLIENT_ID, scope: 'mcp.tools' }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error(`Could not reach QuickDesign (${hostOf(base)}) — check your connection or QUICKDESIGN_BASE_URL and try again.`);
  }
  const start = (await startRes.json().catch(() => ({}))) as DeviceStart;
  if (!startRes.ok || !start.device_code || !start.user_code || !start.verification_uri || !start.expires_in) {
    if (startRes.status === 429) throw new Error('Too many login attempts from this network — try again in 15 minutes.');
    const code = oauthCode(start.error);
    throw new Error(`Could not start login (HTTP ${startRes.status}${code ? `, ${code}` : ''}) — try again in a minute.`);
  }

  const link = start.verification_uri_complete ?? start.verification_uri;
  log('');
  log(kleur.bold('QuickDesign CLI login'));
  log(`  1. Open   ${kleur.cyan(start.verification_uri)}`);
  log(`  2. Enter  ${kleur.bold().green(start.user_code)}`);
  log(kleur.dim(`  (or open ${link} — on any device where you are signed in to QuickDesign)`));
  log(kleur.dim(`  Waiting for approval… the code expires in ${Math.round(start.expires_in / 60)} min.`));
  if (canOpenBrowser()) {
    // open() resolves to the spawned child: without an 'error' listener a
    // missing or non-executable opener (ENOENT, EACCES) would crash the CLI.
    void (deps.openBrowser ?? open)(link)
      .then((child) => (child as { on?: (event: string, listener: () => void) => unknown } | undefined)?.on?.('error', () => undefined))
      .catch(() => undefined);
  }

  let interval = Math.max(1, start.interval ?? 5) * 1000;
  const deadline = now() + Math.min(start.expires_in * 1000, opts.timeoutMs ?? Number.POSITIVE_INFINITY);
  while (now() < deadline) {
    await sleep(interval);
    const requestSentAt = now();
    let res: Response;
    try {
      res = await doFetch(`${base}/api/mcp/oauth/token`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ grant_type: DEVICE_GRANT, device_code: start.device_code, client_id: CLI_CLIENT_ID }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      continue; // network blip — keep polling until the code expires
    }
    const body = (await res.json().catch(() => ({}))) as TokenPoll;
    if (res.ok && body.access_token && body.refresh_token) {
      return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresIn: body.expires_in ?? 3600, requestSentAt };
    }
    if (body.error === 'authorization_pending' || res.status >= 500) continue;
    // A 429 (rate limiter or proxy), whatever its body, means the same as slow_down.
    if (body.error === 'slow_down' || res.status === 429) {
      interval += 5000;
      continue;
    }
    if (body.error === 'access_denied') throw new Error('Authorization was declined.');
    if (body.error === 'expired_token') throw new Error(EXPIRED);
    const code = oauthCode(body.error);
    throw new Error(`Login failed (HTTP ${res.status}${code ? `, ${code}` : ''}) — run \`quickdesign login\` again.`);
  }
  throw new Error(EXPIRED);
}
