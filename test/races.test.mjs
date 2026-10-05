// login / logout racing a sibling process's renewal (the session lock), and
// re-login revoking the session it replaces.
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, delay, fakeBff, jwtWith, nowS, readAuth, runCli, tempHome, writeAuth } from './helpers.mjs';

const FIXTURE = join(ROOT, 'test', 'fixtures', 'fresh-token.mjs');
const DEVICE_PATH = '/api/mcp/oauth/device_authorization';
const TOKEN_PATH = '/api/mcp/oauth/token';
const REVOKE_PATH = '/api/mcp/oauth/revoke';

let home;
let bff;
beforeEach(() => {
  home = tempHome();
});
afterEach(async () => {
  await bff?.close();
  bff = undefined;
});

/** A promise plus the function that resolves it. */
function event() {
  let fire;
  const happened = new Promise((resolve) => {
    fire = resolve;
  });
  return { happened, fire };
}
/** `promise`, or give up after `ms` so a broken run fails instead of hanging. */
const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms).unref())]);

/** Another `quickdesign` process renewing the stored session (test/fixtures/fresh-token.mjs). */
const siblingRenewal = () =>
  new Promise((resolve) => {
    execFile(process.execPath, [FIXTURE], { env: { ...process.env } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });

const pairFor = (sub, refresh) => ({ json: { access_token: jwtWith({ sub, exp: nowS() + 3600 }), refresh_token: refresh, expires_in: 3600 } });
const deviceStart = () => ({ json: { device_code: 'dc', user_code: 'ABCD-EFGH', verification_uri: `${bff.url}/device`, expires_in: 600, interval: 1 } });
const expiredA = () => ({ authType: 'oauth', token: 'old', refreshToken: 'rA1', userId: 'user-A', expiresAt: nowS() - 10 });
const revoked = () => bff.calls.filter((c) => c.path === REVOKE_PATH).map((c) => c.body.token);

test('logout while a sibling renews: the live token is revoked and the session stays gone', async () => {
  const renewing = event();
  bff = await fakeBff(async ({ path }) => {
    if (path === TOKEN_PATH) {
      renewing.fire();
      await delay(800);
      return pairFor('user-A', 'rA2');
    }
    return { json: {} };
  });
  writeAuth(home, expiredA());

  const sibling = siblingRenewal();
  await renewing.happened;
  const logout = await runCli(['logout']);
  const renewal = await sibling;

  assert.equal(logout.code, 0, logout.stderr);
  assert.equal(renewal.code, 0, renewal.stderr);
  assert.equal(readAuth(home), null);
  // rA1 was rotated away by the renewal; rA2 is the one that was live.
  assert.deepEqual(revoked(), ['rA2']);
});

test('login as B while a sibling renews A ends as B', async () => {
  const renewing = event();
  const approved = event();
  bff = await fakeBff(async ({ path, body }) => {
    if (path === DEVICE_PATH) return deviceStart();
    if (path === REVOKE_PATH) return { json: {} };
    if (body.grant_type === 'refresh_token') {
      renewing.fire();
      // Still renewing A when B's tokens reach the login.
      await within(approved.happened, 10_000);
      await delay(300);
      return pairFor('user-A', 'rA2');
    }
    approved.fire();
    return pairFor('user-B', 'rB1');
  });
  writeAuth(home, expiredA());

  const sibling = siblingRenewal();
  await renewing.happened;
  const login = await runCli(['login']);
  const renewal = await sibling;

  assert.equal(login.code, 0, login.stderr);
  assert.equal(renewal.code, 0, renewal.stderr);
  const saved = readAuth(home);
  assert.equal(saved.userId, 'user-B');
  assert.equal(saved.refreshToken, 'rB1');
  // The session B replaced is A as the renewal left it.
  assert.deepEqual(revoked(), ['rA2']);
});

test('re-login revokes the previous session, never the new one', async () => {
  bff = await fakeBff(({ path }) => {
    if (path === DEVICE_PATH) return deviceStart();
    if (path === REVOKE_PATH) return { json: {} };
    return pairFor('user-B', 'rB1');
  });
  writeAuth(home, { authType: 'oauth', token: 'access-A', refreshToken: 'rA1', userId: 'user-A', expiresAt: nowS() + 3600 });

  const { code, stderr } = await runCli(['login']);

  assert.equal(code, 0, stderr);
  assert.equal(readAuth(home).refreshToken, 'rB1');
  const revokes = bff.calls.filter((c) => c.path === REVOKE_PATH);
  assert.deepEqual(revokes.map((c) => c.body), [{ token: 'rA1', token_type_hint: 'refresh_token', client_id: 'quickdesign-cli' }]);
  assert.equal(bff.calls.at(-1).path, REVOKE_PATH, 'revoked only once the new session arrived');
});
