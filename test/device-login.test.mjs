import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { plain, tempHome } from './helpers.mjs';

const { deviceLogin } = await import('../dist/utils/device-login.js');

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const START = {
  status: 200,
  json: {
    device_code: 'dc-1',
    user_code: 'ABCD-EFGH',
    verification_uri: 'https://app.quickdesign.io/device',
    verification_uri_complete: 'https://app.quickdesign.io/device?code=ABCD-EFGH',
    expires_in: 600,
    interval: 5,
  },
};
const TOKENS = { status: 200, json: { access_token: 'a1', refresh_token: 'r1', expires_in: 3600, token_type: 'Bearer' } };
const err = (error) => ({ status: 400, json: { error } });

/** Scripted fetch + virtual clock: sleeping advances time instead of waiting. */
function harness(script) {
  const calls = [];
  const sleeps = [];
  const lines = [];
  const opened = [];
  let t = 0;
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const next = script.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.json), { status: next.status, headers: { 'Content-Type': 'application/json' } });
  };
  return {
    calls,
    sleeps,
    lines,
    opened,
    deps: {
      fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      now: () => t,
      log: (line) => lines.push(plain(line)),
      openBrowser: async (url) => {
        opened.push(url);
      },
    },
  };
}

beforeEach(() => {
  tempHome();
  process.env.QUICKDESIGN_BASE_URL = 'http://bff.test';
  delete process.env.QUICKDESIGN_NO_BROWSER;
  process.env.DISPLAY = ':0';
});

test('prints the code and URL, opens the browser, and polls until approved', async () => {
  const h = harness([START, err('authorization_pending'), err('authorization_pending'), TOKENS]);
  const session = await deviceLogin({}, h.deps);

  assert.deepEqual(session, { accessToken: 'a1', refreshToken: 'r1', expiresIn: 3600 });
  assert.equal(h.calls[0].url, 'http://bff.test/api/mcp/oauth/device_authorization');
  assert.deepEqual(h.calls[0].body, { client_id: 'quickdesign-cli', scope: 'mcp.tools' });
  assert.equal(h.calls[1].url, 'http://bff.test/api/mcp/oauth/token');
  assert.deepEqual(h.calls[1].body, { grant_type: DEVICE_GRANT, device_code: 'dc-1', client_id: 'quickdesign-cli' });
  assert.deepEqual(h.sleeps, [5000, 5000, 5000]);
  const out = h.lines.join('\n');
  assert.match(out, /ABCD-EFGH/);
  assert.match(out, /https:\/\/app\.quickdesign\.io\/device/);
  assert.deepEqual(h.opened, ['https://app.quickdesign.io/device?code=ABCD-EFGH']);
});

test('slow_down adds five seconds to the interval', async () => {
  const h = harness([START, err('slow_down'), TOKENS]);
  await deviceLogin({}, h.deps);
  assert.deepEqual(h.sleeps, [5000, 10000]);
});

test('a 429 while polling backs off like slow_down instead of ending the login', async () => {
  const limited = { status: 429, json: { error: 'Too many requests from this IP, please try again later' } };
  const h = harness([START, limited, TOKENS]);
  assert.equal((await deviceLogin({}, h.deps)).accessToken, 'a1');
  assert.deepEqual(h.sleeps, [5000, 10000]);
});

test('server prose in an error never reaches the user', async () => {
  const h = harness([START, { status: 400, json: { error: 'Bad things happened' } }]);
  await assert.rejects(deviceLogin({}, h.deps), (e) => {
    assert.doesNotMatch(e.message, /Bad things/);
    assert.equal(e.message, 'Login failed (HTTP 400) — run `quickdesign login` again.');
    return true;
  });
});

test('a rate-limited start says when to try again', async () => {
  const h = harness([{ status: 429, json: { error: 'Too many requests from this IP, please try again later' } }]);
  await assert.rejects(deviceLogin({}, h.deps), { message: 'Too many login attempts from this network — try again in 15 minutes.' });
});

test('a network blip does not end the login', async () => {
  const h = harness([START, new TypeError('fetch failed'), TOKENS]);
  assert.equal((await deviceLogin({}, h.deps)).accessToken, 'a1');
});

test('a 5xx while polling is retried', async () => {
  const h = harness([START, { status: 502, json: {} }, TOKENS]);
  assert.equal((await deviceLogin({}, h.deps)).accessToken, 'a1');
});

test('a declined request stops with a clear message', async () => {
  const h = harness([START, err('access_denied')]);
  await assert.rejects(deviceLogin({}, h.deps), { message: 'Authorization was declined.' });
});

test('an expired code says to log in again', async () => {
  const h = harness([START, err('expired_token')]);
  await assert.rejects(deviceLogin({}, h.deps), { message: 'Code expired — run `quickdesign login` again.' });
});

test('gives up when the code runs out locally too', async () => {
  const short = { status: 200, json: { ...START.json, expires_in: 10 } };
  const h = harness([short, err('authorization_pending'), err('authorization_pending')]);
  await assert.rejects(deviceLogin({}, h.deps), { message: 'Code expired — run `quickdesign login` again.' });
  assert.equal(h.calls.length, 3);
});

test('a refused start explains itself', async () => {
  const h = harness([{ status: 400, json: { error: 'unauthorized_client' } }]);
  await assert.rejects(deviceLogin({}, h.deps), /Could not start login \(HTTP 400, unauthorized_client\)/);
});

test('does not try to open a browser when told not to, or without a display on Linux', async () => {
  process.env.QUICKDESIGN_NO_BROWSER = '1';
  const h1 = harness([START, TOKENS]);
  await deviceLogin({}, h1.deps);
  assert.deepEqual(h1.opened, []);

  delete process.env.QUICKDESIGN_NO_BROWSER;
  if (process.platform === 'linux') {
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    delete process.env.WSL_DISTRO_NAME;
    const h2 = harness([START, TOKENS]);
    await deviceLogin({}, h2.deps);
    assert.deepEqual(h2.opened, []);
  }
});
