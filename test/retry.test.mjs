// A server 401 on a session token that still looks valid here (clock behind,
// server keys changed): one forced renewal, one re-send, never more.
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, delay, fakeBff, jwtWith, nowS, readAuth, runCli, tempHome, writeAuth } from './helpers.mjs';

const { request, streamSse, ApiError } = await import('../dist/client.js');
const { uploadLocalFile } = await import('../dist/utils/upload.js');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'request.mjs');

const TOKEN_PATH = '/api/mcp/oauth/token';
/** What the BFF's supabaseAuth answers for a bearer it refuses. */
const refused = (message = 'INVALID_TOKEN', status = 401) => ({
  status,
  json: { success: false, error: message === 'TOKEN_EXPIRED' ? 'Token expired' : 'Invalid token', message },
});

let home;
let bff;
beforeEach(() => {
  home = tempHome();
});
afterEach(async () => {
  delete process.env.QUICKDESIGN_TOKEN;
  await bff?.close();
  bff = undefined;
});

/** Valid for another hour by this machine's clock. */
const session = (over = {}) => ({ authType: 'oauth', token: 'access-1', refreshToken: 'r1', userId: 'user-1', expiresAt: nowS() + 3600, ...over });
const freshPair = () => ({ access_token: jwtWith({ sub: 'user-1', exp: nowS() + 3600 }), refresh_token: 'r2', expires_in: 3600 });

/** Accepts only `pair`'s access token; renews to `pair`; refuses anything else with `refusal`. */
function sessionBff(pair, refusal = refused()) {
  return fakeBff(({ path, headers }) => {
    if (path === TOKEN_PATH) return { json: pair };
    return headers.authorization === `Bearer ${pair.access_token}` ? { json: { ok: true } } : refusal;
  });
}
const tokenCalls = () => bff.calls.filter((c) => c.path === TOKEN_PATH);
const resourceCalls = () => bff.calls.filter((c) => c.path !== TOKEN_PATH);

test('a refused session token is renewed once and the request re-sent with the new one', async () => {
  const pair = freshPair();
  bff = await sessionBff(pair);
  writeAuth(home, session());

  assert.deepEqual(await request('/api/things', { method: 'POST', body: { name: 'x' } }), { ok: true });

  assert.deepEqual(bff.calls.map((c) => [c.path, c.headers.authorization ?? null]), [
    ['/api/things', 'Bearer access-1'],
    [TOKEN_PATH, null],
    ['/api/things', `Bearer ${pair.access_token}`],
  ]);
  assert.equal(bff.calls[1].body.refresh_token, 'r1');
  assert.deepEqual(bff.calls[2].body, { name: 'x' });
  const saved = readAuth(home);
  assert.equal(saved.token, pair.access_token);
  assert.equal(saved.refreshToken, 'r2');
});

test('a command recovers from TOKEN_EXPIRED when this clock runs behind', async () => {
  const pair = freshPair();
  bff = await sessionBff(pair, refused('TOKEN_EXPIRED'));
  writeAuth(home, session());

  const { code, stdout, stderr } = await runCli(['whoami', '--json']);

  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).pingOk, true);
  assert.equal(tokenCalls().length, 1);
  assert.deepEqual(resourceCalls().map((c) => c.headers.authorization), ['Bearer access-1', `Bearer ${pair.access_token}`]);
});

test('streamSse renews and reconnects before it yields anything', async () => {
  const pair = freshPair();
  bff = await fakeBff(({ path, headers }) => {
    if (path === TOKEN_PATH) return { json: pair };
    if (headers.authorization !== `Bearer ${pair.access_token}`) return refused();
    return { raw: 'data: {"type":"complete","data":{"name":"Brand"}}\n\n', headers: { 'Content-Type': 'text/event-stream' } };
  });
  writeAuth(home, session());

  const frames = [];
  for await (const frame of streamSse('/api/brand-dna/stream-extract', { url: 'https://brand.test' })) frames.push(frame.data);

  assert.deepEqual(frames, [{ type: 'complete', data: { name: 'Brand' } }]);
  assert.equal(tokenCalls().length, 1);
  assert.deepEqual(resourceCalls().map((c) => c.body), [{ url: 'https://brand.test' }, { url: 'https://brand.test' }]);
});

test('an upload (FormData) is re-sent whole after the renewal', async () => {
  const pair = freshPair();
  bff = await fakeBff(({ path, headers }) => {
    if (path === TOKEN_PATH) return { json: pair };
    if (headers.authorization !== `Bearer ${pair.access_token}`) return refused();
    return { json: { success: true, publicUrl: 'https://ext.quickdesign.io/user-1/a.png' } };
  });
  writeAuth(home, session());
  const file = join(home, 'a.png');
  writeFileSync(file, 'PNGDATA');

  assert.equal(await uploadLocalFile(file, 'a.png'), 'https://ext.quickdesign.io/user-1/a.png');

  const [first, retried] = resourceCalls();
  assert.equal(retried.headers.authorization, `Bearer ${pair.access_token}`);
  assert.match(retried.body, /name="filename"\r\n\r\na\.png/);
  assert.match(retried.body, /PNGDATA/);
  assert.equal(retried.body.length, first.body.length);
});

test('a second refusal is not retried: two calls, one renewal, then the error', async () => {
  bff = await fakeBff(({ path }) => (path === TOKEN_PATH ? { json: freshPair() } : refused()));
  writeAuth(home, session());

  const { code, stderr } = await runCli(['template', 'list']);

  assert.equal(code, 1);
  assert.match(stderr, /error Invalid token/);
  assert.equal(resourceCalls().length, 2);
  assert.equal(tokenCalls().length, 1);
});

test('QUICKDESIGN_TOKEN and stored tokens that cannot renew are never renewed on a 401', async () => {
  bff = await fakeBff(({ path }) => (path === TOKEN_PATH ? { json: freshPair() } : refused()));

  process.env.QUICKDESIGN_TOKEN = 'env-token';
  writeAuth(home, session());
  await assert.rejects(request('/api/things'), (err) => err instanceof ApiError && err.status === 401);
  delete process.env.QUICKDESIGN_TOKEN;

  // `login --token` / CLI ≤ 0.16: no authType, still valid by its exp.
  writeAuth(home, { token: 'legacy', refreshToken: 'supabase-rt', expiresAt: nowS() + 3600 });
  await assert.rejects(request('/api/things'), (err) => err instanceof ApiError && err.status === 401);

  assert.equal(tokenCalls().length, 0);
  assert.deepEqual(resourceCalls().map((c) => c.headers.authorization), ['Bearer env-token', 'Bearer legacy']);
});

test('only a 401 that names the token triggers a renewal', async () => {
  for (const refusal of [refused('INVALID_TOKEN', 403), refused('UNAUTHORIZED'), { status: 401, raw: 'Unauthorized' }, refused('INVALID_TOKEN', 429), refused('INVALID_TOKEN', 503)]) {
    bff = await sessionBff(freshPair(), refusal);
    writeAuth(home, session());
    await assert.rejects(request('/api/things'), ApiError);
    assert.equal(tokenCalls().length, 0, `status ${refusal.status}`);
    assert.equal(resourceCalls().length, 1);
    await bff.close();
  }
  bff = undefined;
});

test('a renewal that fails after a refusal reads like any other renewal failure', async () => {
  bff = await fakeBff(({ path }) => (path === TOKEN_PATH ? { status: 400, json: { error: 'invalid_grant' } } : refused()));
  writeAuth(home, session());
  await assert.rejects(request('/api/things'), (err) => {
    assert.equal(err.message, 'Session ended — run `quickdesign login`.');
    assert.equal(err.status, 401);
    assert.deepEqual(err.body, { code: 'SESSION_ENDED' });
    return true;
  });
  await bff.close();

  bff = await fakeBff(({ path }) => (path === TOKEN_PATH ? { status: 503, json: { error: 'server_error' } } : refused()));
  writeAuth(home, session());
  await assert.rejects(request('/api/things'), (err) => {
    assert.equal(err.message, 'QuickDesign could not renew the session (HTTP 503). Try again.');
    assert.deepEqual(err.body, { code: 'TOKEN_REFRESH_FAILED' });
    return true;
  });
  assert.equal(resourceCalls().length, 1);
});

test('parallel refusals in one process share one renewal', async () => {
  const pair = freshPair();
  bff = await fakeBff(async ({ path, headers }) => {
    if (path === TOKEN_PATH) {
      await delay(200);
      return { json: pair };
    }
    return headers.authorization === `Bearer ${pair.access_token}` ? { json: { ok: path } } : refused();
  });
  writeAuth(home, session());

  const out = await Promise.all([request('/api/a'), request('/api/b'), request('/api/c')]);

  assert.deepEqual(out, [{ ok: '/api/a' }, { ok: '/api/b' }, { ok: '/api/c' }]);
  assert.equal(tokenCalls().length, 1);
  assert.equal(resourceCalls().length, 6);
});

test('two processes refused at once make one renewal between them', async () => {
  const pair = freshPair();
  // Hold the first refusal until the second process has been refused too.
  let refusedCount = 0;
  let bothRefused;
  const barrier = new Promise((resolve) => {
    bothRefused = resolve;
    setTimeout(resolve, 5000).unref();
  });
  bff = await fakeBff(async ({ path, headers }) => {
    if (path === TOKEN_PATH) {
      await delay(300);
      return { json: pair };
    }
    if (headers.authorization === `Bearer ${pair.access_token}`) return { json: { ok: true } };
    refusedCount += 1;
    if (refusedCount === 2) bothRefused();
    await barrier;
    return refused();
  });
  writeAuth(home, session());
  const run = () =>
    new Promise((resolve, reject) => {
      execFile(process.execPath, [FIXTURE, '/api/things'], { env: { ...process.env } }, (err, stdout, stderr) =>
        err ? reject(new Error(stderr || err.message)) : resolve(stdout),
      );
    });

  const [a, b] = await Promise.all([run(), run()]);

  assert.equal(a, '{"ok":true}');
  assert.equal(b, '{"ok":true}');
  assert.equal(refusedCount, 2);
  assert.equal(tokenCalls().length, 1);
  assert.equal(readAuth(home).token, pair.access_token);
});
