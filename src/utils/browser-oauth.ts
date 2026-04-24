/**
 * Browser-based auth handshake.
 *
 * Flow:
 *   1. CLI picks a random localhost port, spins up a one-shot HTTP server.
 *   2. CLI opens `${baseUrl}/cli-auth?port=<port>&state=<nonce>` in the user's default browser.
 *   3. The web app (already logged in via Supabase) reads its session's access_token,
 *      checks the query params, and POSTs to `http://localhost:<port>/token` with
 *      { token, state, email?, userId? } — OR it redirects there via a form GET.
 *   4. Our server validates the state nonce, stores the token, and returns a
 *      tiny HTML "you can close this tab" page.
 *   5. CLI resolves the awaited promise, shuts the server down.
 *
 * Design notes:
 *   - We bind to 127.0.0.1 only (never 0.0.0.0) — token must not leak on LAN.
 *   - We enforce a strict state nonce to block a malicious site from pushing
 *     tokens to a stale CLI server.
 *   - We accept both POST (JSON) and GET (query-string) — the frontend page may
 *     redirect or fetch, either is fine.
 *   - CORS: we echo `Access-Control-Allow-Origin` back for the POST path so
 *     the SPA can fetch() the localhost endpoint without a preflight failure.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import open from 'open';
import { resolveBaseUrl } from '../config.js';

export interface OauthResult {
  token: string;
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
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
  };
}

export async function browserLogin(opts: { timeoutMs?: number } = {}): Promise<OauthResult> {
  const timeout = opts.timeoutMs ?? 120_000;
  const state = randomBytes(16).toString('hex');
  const baseUrl = resolveBaseUrl().replace(/\/$/, '');

  return new Promise<OauthResult>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const cors = corsHeaders(req);

      // Preflight
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

      const handle = (payload: { token?: string; state?: string; email?: string; userId?: string }) => {
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
        // Narrow for TS after the guard above.
        const { token, email, userId } = payload as { token: string; email?: string; userId?: string };
        // Give the response a moment to flush before we tear down the server.
        setTimeout(() => {
          server.close();
          resolve({ token, email, userId });
        }, 50);
      };

      if (req.method === 'GET') {
        handle({
          token: url.searchParams.get('token') ?? undefined,
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
            handle(body);
          } catch {
            respondError(res, cors, 400, 'invalid json body');
          }
        });
        return;
      }

      respondError(res, cors, 405, 'method not allowed');
    });

    server.on('error', (err) => reject(err));

    // 0 = let the OS pick an open port.
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('failed to bind local OAuth server'));
        return;
      }
      const port = addr.port;
      const authUrl = `${baseUrl}/cli-auth?port=${port}&state=${state}`;

      const timer = setTimeout(() => {
        server.close();
        reject(new Error(
          `Login timed out after ${Math.round(timeout / 1000)}s — ` +
          `open ${authUrl} manually, or re-run \`quickdesign login\`.`,
        ));
      }, timeout);
      server.once('close', () => clearTimeout(timer));

      process.stderr.write(
        `Opening browser to finish login…\n` +
        `If it doesn't open, visit: ${authUrl}\n`,
      );

      open(authUrl).catch(() => {
        process.stderr.write(
          `Failed to auto-open browser. Visit this URL manually:\n  ${authUrl}\n`,
        );
      });
    });
  });
}

function respondError(res: ServerResponse, cors: Record<string, string>, status: number, msg: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain', ...cors });
  res.end(msg);
}
