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

  const startRes = await doFetch(`${base}/api/mcp/oauth/device_authorization`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ client_id: CLI_CLIENT_ID, scope: 'mcp.tools' }),
    signal: AbortSignal.timeout(30_000),
  });
  const start = (await startRes.json().catch(() => ({}))) as DeviceStart;
  if (!startRes.ok || !start.device_code || !start.user_code || !start.verification_uri || !start.expires_in) {
    throw new Error(`Could not start login (HTTP ${startRes.status}${start.error ? `, ${start.error}` : ''}).`);
  }

  const link = start.verification_uri_complete ?? start.verification_uri;
  log('');
  log(kleur.bold('QuickDesign CLI login'));
  log(`  1. Open   ${kleur.cyan(start.verification_uri)}`);
  log(`  2. Enter  ${kleur.bold().green(start.user_code)}`);
  log(kleur.dim(`  (or open ${link} — on any device where you are signed in to QuickDesign)`));
  log(kleur.dim(`  Waiting for approval… the code expires in ${Math.round(start.expires_in / 60)} min.`));
  if (canOpenBrowser()) void (deps.openBrowser ?? open)(link).catch(() => undefined);

  let interval = Math.max(1, start.interval ?? 5) * 1000;
  const deadline = now() + Math.min(start.expires_in * 1000, opts.timeoutMs ?? Number.POSITIVE_INFINITY);
  while (now() < deadline) {
    await sleep(interval);
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
      return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresIn: body.expires_in ?? 3600 };
    }
    if (body.error === 'authorization_pending' || res.status >= 500) continue;
    if (body.error === 'slow_down') {
      interval += 5000;
      continue;
    }
    if (body.error === 'access_denied') throw new Error('Authorization was declined.');
    if (body.error === 'expired_token') throw new Error(EXPIRED);
    throw new Error(`Login failed (HTTP ${res.status}${body.error ? `, ${body.error}` : ''}).`);
  }
  throw new Error(EXPIRED);
}
