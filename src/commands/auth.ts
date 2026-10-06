/**
 * `quickdesign login|logout|whoami|config` and `auth token`.
 *
 * Login is device authorization against the BFF's OAuth server
 * (utils/device-login.ts): the CLI prints a code, the user approves it in any
 * signed-in browser, and the CLI keeps a session that renews itself (1 h
 * access, 90-day sliding refresh). `--token <jwt>` stays as the CI escape
 * hatch: such a token is used until it expires and never renewed.
 */
import { Command } from 'commander';
import kleur from 'kleur';
import { deviceLogin } from '../utils/device-login.js';
import {
  readConfig,
  writeConfig,
  writeSession,
  clearConfig,
  revokeSession,
  ensureFreshToken,
  resolveBaseUrl,
  configPath,
  parseJwtExpiry,
  tokenStillValid,
  withSessionLock,
  type StoredConfig,
} from '../config.js';
import { request, ApiError } from '../client.js';
import { emitJson, fail, note } from '../utils/output.js';

export interface LoginOpts { token?: string; tokenStdin?: boolean; timeout?: number }
export async function loginAction(opts: LoginOpts): Promise<void> {
  try {
    const tok = opts.token ?? (opts.tokenStdin ? await readStdinLine() : undefined);
    if (tok) {
      await saveToken(tok);
      return;
    }
    // Waiting for approval can take minutes: only the write takes the lock.
    const session = await deviceLogin({ timeoutMs: opts.timeout });
    await replaceSession(() => writeSession(session), session.refreshToken);
    const cfg = readConfig();
    process.stderr.write(
      `\n${kleur.green().bold('✓ Login successful')}\n` +
      `  user    : ${kleur.bold(cfg.email ?? cfg.userId ?? '(unknown)')}\n` +
      `  session : ${kleur.dim('renews itself — stays signed in while you use it (90 days idle)')}\n` +
      `  config  : ${configPath()}\n` +
      `\n  ${kleur.dim('try:')} ${kleur.cyan('quickdesign whoami')}\n\n`,
    );
  } catch (err) {
    fail(err);
  }
}

/**
 * Store a new session under the renewal lock — a sibling mid-renewal would
 * otherwise write the old account back over it — then revoke the session it
 * replaced (best effort; never the new one).
 */
async function replaceSession(write: (previous: StoredConfig) => void, newRefreshToken?: string): Promise<void> {
  const previous = await withSessionLock(() => {
    const current = readConfig();
    write(current);
    return current;
  });
  if (previous.refreshToken !== newRefreshToken) await revokeSession(previous);
}

async function logoutAction(): Promise<void> {
  // Under the lock, a sibling's renewal finishes first: the token revoked is
  // the live one, and nothing writes the session back afterwards.
  await withSessionLock(async () => {
    await revokeSession(readConfig());
    clearConfig();
  });
  note(`Removed ${configPath()}`);
}

function sessionKind(cfg: StoredConfig): string {
  if (process.env.QUICKDESIGN_TOKEN?.trim()) return 'QUICKDESIGN_TOKEN (env)';
  if (cfg.authType === 'oauth') return 'device login (renews itself)';
  return cfg.token ? 'token (expires, never renewed)' : 'none';
}

interface WhoamiOpts { json?: boolean }
async function whoamiAction(opts: WhoamiOpts): Promise<void> {
  if (!readConfig().token && !process.env.QUICKDESIGN_TOKEN?.trim()) fail('Not logged in. Run `quickdesign login`.', 2);

  // Ping first: it renews an expired session, so what is printed is current.
  let pingOk = false;
  let pingError: string | undefined;
  try {
    await request<unknown>('/api/spy-brands/following', { query: { limit: 1 } });
    pingOk = true;
  } catch (err) {
    pingError = err instanceof ApiError ? `${err.status} ${err.message}` : String(err);
  }

  const cfg = readConfig();
  const out = {
    userId: cfg.userId,
    email: cfg.email,
    expiresAt: cfg.expiresAt,
    valid: tokenStillValid(cfg),
    session: sessionKind(cfg),
    baseUrl: resolveBaseUrl(),
    configFile: configPath(),
    pingOk,
    ...(pingError ? { pingError } : {}),
  };
  if (opts.json) emitJson(out);
  else printWhoami(out);
}

/** For scripts: `curl -H "Authorization: Bearer $(quickdesign auth token)" …`. Renews when needed. */
async function tokenAction(): Promise<void> {
  try {
    const token = await ensureFreshToken();
    if (!token) fail('Not logged in. Run `quickdesign login`.', 2);
    process.stdout.write(`${token}\n`);
  } catch (err) {
    fail(err);
  }
}

/** Credentials are never printed by `config` (the refresh token is a 90-day credential) and only set by login. */
const SECRET_KEYS = new Set(['token', 'refreshToken']);
const CREDENTIAL_KEYS = new Set(['token', 'refreshToken', 'authType', 'userId', 'expiresAt']);

function redacted(cfg: StoredConfig): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(cfg).map(([k, v]) => [k, SECRET_KEYS.has(k) && typeof v === 'string' ? `<${v.length} chars hidden>` : v]),
  );
}

/** Wire the login/logout/whoami trio onto a parent (top-level program OR `auth`
 *  subcommand). Registered on both so `quickdesign login` and `quickdesign auth
 *  login` both work. */
function registerAuthShortcuts(parent: Command): void {
  parent
    .command('login')
    .description('Log in — prints a code to approve in your browser (works over SSH too)')
    .option('--token <jwt>', 'Store a raw access token instead (CI / scripted; never renewed)')
    .option('--token-stdin', 'Read that token from stdin (one line)')
    .option('--timeout <ms>', 'Stop waiting for approval after <ms> (default: when the code expires)', (v) => parseInt(v, 10))
    .action(loginAction);

  parent
    .command('logout')
    .description('Sign this CLI out (revokes the session) and remove the stored token')
    .action(logoutAction);

  parent
    .command('whoami')
    .description('Show the currently authenticated user')
    .option('--json', 'Emit JSON', false)
    .action(whoamiAction);
}

export function registerAuthCommands(program: Command): void {
  // Top-level shortcuts so `quickdesign login` works.
  registerAuthShortcuts(program);

  // Full `auth …` namespace too, for discoverability.
  const auth = program.command('auth').description('Authentication commands');
  registerAuthShortcuts(auth);

  auth
    .command('token')
    .description('Print a valid access token, renewing the session if needed (for scripts)')
    .action(tokenAction);

  auth
    .command('config')
    .description('Get/set config values')
    .argument('<action>', 'get | set | path | show')
    .argument('[key]', 'Config key (e.g. baseUrl)')
    .argument('[value]', 'Config value')
    .action(async (action: string, key?: string, value?: string) => {
      if (action === 'path') {
        process.stdout.write(`${configPath()}\n`);
        return;
      }
      if (action === 'show') {
        emitJson(redacted(readConfig()));
        return;
      }
      if (action === 'get') {
        if (!key) fail('Usage: quickdesign auth config get <key>', 2);
        if (key === 'token') {
          await tokenAction();
          return;
        }
        if (key === 'refreshToken') fail('The refresh token is never printed. Use `quickdesign auth token` for an access token.', 2);
        const v = (readConfig() as Record<string, unknown>)[key!];
        process.stdout.write(`${v ?? ''}\n`);
        return;
      }
      if (action === 'set') {
        if (!key) fail('Usage: quickdesign auth config set <key> <value>', 2);
        if (CREDENTIAL_KEYS.has(key!)) fail('Credentials are set by `quickdesign login` (or `login --token`).', 2);
        if (value === undefined) fail('Missing value', 2);
        // Locked, so a sibling's renewal is not overwritten with the old tokens.
        await withSessionLock(() => {
          const cfg = readConfig() as Record<string, unknown>;
          cfg[key!] = value;
          writeConfig(cfg as never);
        });
        note(`Set ${key} in ${configPath()}`);
        return;
      }
      fail(`Unknown action: ${action}`, 2);
    });
}

async function saveToken(jwt: string): Promise<void> {
  const parsed = parseJwtExpiry(jwt);
  if (!parsed) fail('Provided token is not a valid JWT', 2);
  // A pasted token cannot renew itself: it replaces (and revokes) any device-login session.
  await replaceSession((existing) =>
    writeConfig({
      token: jwt,
      userId: parsed!.userId,
      email: parsed!.email,
      expiresAt: parsed!.expiresAt,
      ...(existing.baseUrl ? { baseUrl: existing.baseUrl } : {}),
    }),
  );
  const who = parsed!.email ?? parsed!.userId ?? '(anonymous)';
  const expISO = parsed!.expiresAt ? new Date(parsed!.expiresAt * 1000).toISOString() : '(unknown)';
  process.stderr.write(
    `\n${kleur.green().bold('✓ Token stored')}\n` +
    `  user    : ${kleur.bold(who)}\n` +
    `  expires : ${expISO}  ${kleur.yellow('never renewed — `quickdesign login` gives a session that renews itself')}\n` +
    `  config  : ${configPath()}\n\n`,
  );
}

function readStdinLine(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data.trim().split('\n')[0] ?? ''));
  });
}

function printWhoami(r: {
  userId?: string;
  email?: string;
  expiresAt?: number;
  valid: boolean;
  session: string;
  baseUrl: string;
  configFile: string;
  pingOk?: boolean;
  pingError?: string;
}): void {
  const exp = r.expiresAt ? new Date(r.expiresAt * 1000).toISOString() : '(unknown)';
  process.stdout.write(
    `${kleur.bold('QuickDesign CLI auth status')}\n` +
    `  user      : ${r.email ?? '(no email claim)'}\n` +
    `  userId    : ${r.userId ?? '(unknown)'}\n` +
    `  session   : ${r.session}\n` +
    `  token exp : ${exp} ${r.valid ? kleur.green('(valid)') : kleur.red('(expired)')}\n` +
    `  baseUrl   : ${r.baseUrl}\n` +
    `  config    : ${r.configFile}\n` +
    `  liveCheck : ${r.pingOk ? kleur.green('ok') : kleur.red(`failed — ${r.pingError ?? ''}`)}\n`,
  );
}
