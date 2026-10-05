/**
 * Test helpers. Tests import the BUILT CLI from dist/ (`npm test` builds
 * first). Every test gets its own HOME (where auth.json lives) and talks to a
 * fake BFF on 127.0.0.1 — never the real config or network.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = join(ROOT, 'dist', 'bin.js');
export const nowS = () => Math.floor(Date.now() / 1000);
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** A fresh HOME for this process; clears env that would bypass the stored session. */
export function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'qd-cli-test-'));
  process.env.HOME = home;
  process.env.QUICKDESIGN_NO_BROWSER = '1';
  delete process.env.QUICKDESIGN_TOKEN;
  return home;
}

const authFile = (home) => join(home, '.config', 'quickdesign', 'auth.json');

export function writeAuth(home, cfg) {
  mkdirSync(dirname(authFile(home)), { recursive: true });
  writeFileSync(authFile(home), JSON.stringify(cfg));
}

export function readAuth(home) {
  return existsSync(authFile(home)) ? JSON.parse(readFileSync(authFile(home), 'utf8')) : null;
}

/** A JWT-shaped token (unsigned — the CLI only reads its claims). */
export function jwtWith(claims) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}.sig`;
}

/**
 * Fake BFF. handler(call) → { status?, json? } or { status?, raw, headers? } (may be async).
 * call = { method, path, query, headers, body }: body is parsed JSON for JSON
 * requests, otherwise the raw (latin1) string. Points QUICKDESIGN_BASE_URL at it.
 */
export async function fakeBff(handler) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('latin1');
    const isJson = (req.headers['content-type'] ?? '').includes('application/json');
    const url = new URL(req.url, 'http://bff.test');
    const call = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body: isJson && raw ? JSON.parse(raw) : raw,
    };
    calls.push(call);
    const out = (await handler(call)) ?? {};
    if (out.raw !== undefined) {
      res.writeHead(out.status ?? 200, out.headers ?? {});
      res.end(out.raw);
      return;
    }
    res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out.json ?? {}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  process.env.QUICKDESIGN_BASE_URL = url;
  return {
    url,
    calls,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Run the built CLI in a child process with this test's HOME and fake BFF. */
export function runCli(args, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, NO_COLOR: '1', ...extraEnv } }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr: plain(stderr) });
    });
  });
}
