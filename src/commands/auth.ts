/**
 * `quickdesign login|logout|whoami|config`
 *
 * Login prefers the browser OAuth handshake (opens the browser, gets the JWT
 * back via a localhost callback). `--token <jwt>` is supported as an escape
 * hatch for CI/headless environments.
 */
import { Command } from 'commander';
import kleur from 'kleur';
import { browserLogin } from '../utils/browser-oauth.js';
import {
  readConfig,
  writeConfig,
  clearConfig,
  resolveBaseUrl,
  configPath,
  parseJwtExpiry,
  tokenStillValid,
} from '../config.js';
import { request, ApiError } from '../client.js';
import { emitJson, fail, note } from '../utils/output.js';

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Authentication commands');

  auth
    .command('login')
    .description('Log in — opens a browser to finish the OAuth handshake')
    .option('--token <jwt>', 'Use a raw Supabase JWT (CI / scripted / headless)')
    .option('--token-stdin', 'Read the JWT from stdin (one line)')
    .option('--timeout <ms>', 'Browser-flow timeout in ms', (v) => parseInt(v, 10), 120_000)
    .action(async (opts: { token?: string; tokenStdin?: boolean; timeout?: number }) => {
      try {
        const tok = opts.token ?? (opts.tokenStdin ? await readStdinLine() : undefined);
        if (tok) {
          saveToken(tok);
          return;
        }
        const result = await browserLogin({ timeoutMs: opts.timeout });
        saveToken(result.token, { email: result.email, userId: result.userId });
      } catch (err) {
        fail(err);
      }
    });

  auth
    .command('logout')
    .description('Remove the stored auth token')
    .action(() => {
      clearConfig();
      note(`Removed ${configPath()}`);
    });

  auth
    .command('whoami')
    .description('Show the currently authenticated user')
    .option('--json', 'Emit JSON', false)
    .action(async (opts: { json?: boolean }) => {
      const cfg = readConfig();
      if (!cfg.token) fail('Not logged in. Run `quickdesign login`.', 2);

      const base = {
        userId: cfg.userId,
        email: cfg.email,
        expiresAt: cfg.expiresAt,
        valid: tokenStillValid(cfg),
        baseUrl: resolveBaseUrl(),
        configFile: configPath(),
      };

      // Best-effort live ping to confirm the token is accepted by the BFF.
      try {
        await request<unknown>('/api/spy-brands/following', { query: { limit: 1 } });
        const full = { ...base, pingOk: true };
        if (opts.json) emitJson(full);
        else printWhoami(full);
      } catch (err) {
        const pingErr = err instanceof ApiError ? `${err.status} ${err.message}` : String(err);
        const full = { ...base, pingOk: false, pingError: pingErr };
        if (opts.json) emitJson(full);
        else printWhoami(full);
      }
    });

  auth
    .command('config')
    .description('Get/set config values')
    .argument('<action>', 'get | set | path | show')
    .argument('[key]', 'Config key (e.g. baseUrl)')
    .argument('[value]', 'Config value')
    .action((action: string, key?: string, value?: string) => {
      if (action === 'path') {
        process.stdout.write(`${configPath()}\n`);
        return;
      }
      if (action === 'show') {
        emitJson(readConfig());
        return;
      }
      if (action === 'get') {
        if (!key) fail('Usage: quickdesign auth config get <key>', 2);
        const v = (readConfig() as Record<string, unknown>)[key!];
        process.stdout.write(`${v ?? ''}\n`);
        return;
      }
      if (action === 'set') {
        if (!key) fail('Usage: quickdesign auth config set <key> <value>', 2);
        if (value === undefined) fail('Missing value', 2);
        const cfg = readConfig() as Record<string, unknown>;
        cfg[key!] = value;
        writeConfig(cfg as never);
        note(`Set ${key} in ${configPath()}`);
        return;
      }
      fail(`Unknown action: ${action}`, 2);
    });
}

function saveToken(jwt: string, extras: { email?: string; userId?: string } = {}): void {
  const parsed = parseJwtExpiry(jwt);
  if (!parsed) fail('Provided token is not a valid JWT', 2);
  const existing = readConfig();
  writeConfig({
    ...existing,
    token: jwt,
    userId: extras.userId ?? parsed!.userId,
    email: extras.email ?? parsed!.email,
    expiresAt: parsed!.expiresAt,
  });
  const who = extras.email ?? parsed!.email ?? extras.userId ?? parsed!.userId ?? '(anonymous)';
  note(`Logged in as ${kleur.bold(who)}  — token stored in ${configPath()}`);
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
    `  token exp : ${exp} ${r.valid ? kleur.green('(valid)') : kleur.red('(expired)')}\n` +
    `  baseUrl   : ${r.baseUrl}\n` +
    `  config    : ${r.configFile}\n` +
    `  liveCheck : ${r.pingOk ? kleur.green('ok') : kleur.red(`failed — ${r.pingError ?? ''}`)}\n`,
  );
}
