/**
 * Browser-based auth handshake (with terminal paste fallback).
 *
 * Flow:
 *   1. CLI picks a random localhost port, spins up a one-shot HTTP server.
 *   2. CLI opens `${baseUrl}/cli-auth?port=<port>&state=<nonce>` in the user's
 *      default browser.
 *   3. The web app (already logged in via Supabase) reads its session's
 *      access_token, checks the query params, and POSTs to
 *      `http://127.0.0.1:<port>/token` with { token, state, refresh_token?, … }.
 *   4. Our server validates the state nonce, returns a "you can close this
 *      tab" page, and the awaited promise resolves.
 *
 * Manual fallback (covers firewalled / SSH / corporate-VPN setups where Chrome
 * can't reach localhost):
 *   - The CliAuth page also displays the access_token in a copy box.
 *   - While the local HTTP server is listening, the CLI ALSO listens on stdin.
 *     If the user pastes a JWT into the terminal where `quickdesign login` is
 *     running and presses Enter, that path wins the race and the browser flow
 *     is cancelled.
 *
 * Design notes:
 *   - We bind to 127.0.0.1 only (never 0.0.0.0) — token must not leak on LAN.
 *   - We enforce a strict state nonce on the browser path to block a malicious
 *     site from pushing tokens to a stale CLI server.
 *   - Stdin paste is only enabled when stdin is a TTY (skipped in CI / piped).
 *   - PNA: Chrome 130+ blocks HTTPS→localhost without
 *     `Access-Control-Allow-Private-Network: true` on the preflight. We echo
 *     it back when the request asks for it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import open from 'open';
import kleur from 'kleur';
import { resolveBaseUrl, parseJwtExpiry } from '../config.js';

export interface OauthResult {
  token: string;
  /** Supabase refresh token — present when the web app sends it. Used to mint a
   *  new access token without re-prompting the user. Manual paste path leaves
   *  this undefined (user can re-run login when the access token expires). */
  refreshToken?: string;
  userId?: string;
  email?: string;
}

const CLOSE_HTML = `<!doctype html>
<html><head><title>QuickDesign CLI</title>
<style>body{font:15px/1.5 system-ui,-apple-system,sans-serif;padding:3rem;max-width:440px;margin:auto;color:#1a1a1a}
h1{font-weight:600;font-size:1.25rem;margin:0 0 .25rem}p{color:#666;margin:0}
.dot{display:inline-block;width:.5rem;height:.5rem;border-radius:50%;background:#22c55e;margin-right:.5rem}</style>
</head><body>
<h1><span class="dot"></span>QuickDesign CLI authenticated</h1>
<p>You can close this tab and return to your terminal.</p>
<script>setTimeout(()=>window.close(),800);</script>
</body></html>`;

function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin ?? '*';
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
  };
  // Chrome 130+ Private Network Access: an HTTPS page (the SPA) calling
  // http://127.0.0.1:<port> is a public→private request and is blocked unless
  // the local server explicitly opts in on the preflight. Without this header
  // the browser surfaces ERR_CONNECTION_REFUSED on the actual POST.
  if (req.headers['access-control-request-private-network']) {
    headers['Access-Control-Allow-Private-Network'] = 'true';
  }
  return headers;
}

function respondError(res: ServerResponse, cors: Record<string, string>, status: number, msg: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain', ...cors });
  res.end(msg);
}

export async function browserLogin(opts: { timeoutMs?: number } = {}): Promise<OauthResult> {
  const timeout = opts.timeoutMs ?? 300_000;
  const state = randomBytes(16).toString('hex');
  const baseUrl = resolveBaseUrl().replace(/\/$/, '');

  return new Promise<OauthResult>((resolve, reject) => {
    let done = false;
    let stdinHandler: ((c: Buffer) => void) | null = null;
    let timer: NodeJS.Timeout | null = null;
    let server: Server;

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (stdinHandler) {
        process.stdin.removeListener('data', stdinHandler);
        try { process.stdin.pause(); } catch { /* ignore */ }
        stdinHandler = null;
      }
      try { server?.close(); } catch { /* ignore */ }
    };

    const finish = (result: OauthResult): void => {
      if (done) return;
      done = true;
      cleanup();
      resolve(result);
    };

    const fail = (err: Error): void => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    };

    // ── HTTP server (browser path) ──────────────────────────────────────────
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const cors = corsHeaders(req);

      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        res.end();
        return;
      }

      if (url.pathname !== '/token') {
        res.writeHead(404, { 'Content-Type': 'text/plain', ...cors });
        res.end('not found');
        return;
      }

      const handle = (payload: {
        token?: string;
        refreshToken?: string;
        state?: string;
        email?: string;
        userId?: string;
      }): void => {
        if (!payload.token || !payload.state) {
          respondError(res, cors, 400, 'missing token or state');
          return;
        }
        if (payload.state !== state) {
          respondError(res, cors, 403, 'state mismatch');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...cors });
        res.end(CLOSE_HTML);
        const { token, refreshToken, email, userId } = payload as {
          token: string;
          refreshToken?: string;
          email?: string;
          userId?: string;
        };
        // Clear the dangling stdin "paste token >" prompt and confirm the
        // browser path won the race before saveToken writes its note.
        process.stderr.write('\n' + kleur.green('  ✓ token received from browser') + '\n');
        // Give the response a moment to flush before we tear down the server.
        setTimeout(() => finish({ token, refreshToken, email, userId }), 50);
      };

      if (req.method === 'GET') {
        handle({
          token: url.searchParams.get('token') ?? undefined,
          refreshToken:
            url.searchParams.get('refreshToken')
            ?? url.searchParams.get('refresh_token')
            ?? undefined,
          state: url.searchParams.get('state') ?? undefined,
          email: url.searchParams.get('email') ?? undefined,
          userId: url.searchParams.get('userId') ?? undefined,
        });
        return;
      }

      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8');
            const body = raw ? (JSON.parse(raw) as Record<string, string>) : {};
            handle({
              token: body.token,
              refreshToken: body.refreshToken ?? body.refresh_token,
              state: body.state,
              email: body.email,
              userId: body.userId,
            });
          } catch {
            respondError(res, cors, 400, 'invalid json body');
          }
        });
        return;
      }

      respondError(res, cors, 405, 'method not allowed');
    });

    server.on('error', (err) => fail(err));

    // 0 = let the OS pick an open port.
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        fail(new Error('failed to bind local OAuth server'));
        return;
      }
      const port = addr.port;
      const authUrl = `${baseUrl}/cli-auth?port=${port}&state=${state}`;

      timer = setTimeout(() => {
        fail(new Error(
          `Login timed out after ${Math.round(timeout / 1000)}s — ` +
          `re-run \`quickdesign login\`, or pass --token <jwt> directly.`,
        ));
      }, timeout);

      // ── User-facing prompt: browser URL + manual paste invite ─────────────
      process.stderr.write(
        `\n${kleur.bold('QuickDesign CLI login')}\n` +
        `  1. ${kleur.dim('Browser path  →')} opening ${kleur.cyan(authUrl)}\n`,
      );

      const ttyPaste = process.stdin.isTTY === true;
      if (ttyPaste) {
        process.stderr.write(
          `  2. ${kleur.dim('Manual path   →')} or paste the access token shown on that page here:\n` +
          `     ${kleur.dim('(useful when your browser cannot reach localhost — corp VPN, SSH, etc.)')}\n` +
          `     ${kleur.bold('paste token >')} `,
        );
      } else {
        process.stderr.write(
          `  2. ${kleur.dim('Manual path   →')} stdin is not a TTY; pass --token <jwt> instead.\n`,
        );
      }

      open(authUrl).catch(() => {
        process.stderr.write(
          kleur.yellow(`\n  (couldn't auto-open browser — visit the URL above manually)\n`),
        );
      });

      // ── stdin paste path (interactive only) ────────────────────────────
      if (ttyPaste) {
        let buffer = '';
        stdinHandler = (chunk: Buffer): void => {
          if (done) return;
          buffer += chunk.toString('utf8');
          let nl = buffer.indexOf('\n');
          while (nl >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line.length > 0) {
              const parsed = parseJwtExpiry(line);
              if (parsed) {
                process.stderr.write(kleur.green('  ✓ token accepted from terminal\n'));
                finish({
                  token: line,
                  userId: parsed.userId,
                  email: parsed.email,
                  // Manual path has no refresh_token — user re-runs login when
                  // the access token expires (~1h).
                });
                return;
              }
              process.stderr.write(
                kleur.red('  ✗ doesn\'t look like a JWT (need 3 dot-separated parts) — try again:\n') +
                `     ${kleur.bold('paste token >')} `,
              );
            }
            nl = buffer.indexOf('\n');
          }
        };
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', stdinHandler);
        process.stdin.resume();
      }
    });
  });
}
