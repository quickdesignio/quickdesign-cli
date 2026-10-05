import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeBff, jwtWith, nowS, readAuth, runCli, tempHome, writeAuth } from './helpers.mjs';

let home;
let bff;
beforeEach(() => {
  home = tempHome();
});
afterEach(async () => {
  await bff?.close();
  bff = undefined;
});

const session = (over = {}) => ({ authType: 'oauth', token: 'access-1', refreshToken: 'r1', userId: 'user-1', expiresAt: nowS() + 3600, ...over });

test('login: device flow end to end, stored as a renewing session', async () => {
  const access = jwtWith({ sub: 'user-1', exp: nowS() + 3600 });
  let polls = 0;
  bff = await fakeBff(({ path }) => {
    if (path === '/api/mcp/oauth/device_authorization') {
      return {
        json: {
          device_code: 'dc-1',
          user_code: 'ABCD-EFGH',
          verification_uri: `${bff.url}/device`,
          verification_uri_complete: `${bff.url}/device?code=ABCD-EFGH`,
          expires_in: 600,
          interval: 1,
        },
      };
    }
    polls += 1;
    return polls === 1
      ? { status: 400, json: { error: 'authorization_pending' } }
      : { json: { access_token: access, refresh_token: 'r1', expires_in: 3600, token_type: 'Bearer' } };
  });
  writeAuth(home, { token: 'legacy', refreshToken: 'supabase-rt', supabaseAnonKey: 'x', baseUrl: bff.url });

  const { code, stderr } = await runCli(['login']);

  assert.equal(code, 0, stderr);
  assert.match(stderr, /ABCD-EFGH/);
  assert.match(stderr, /Login successful/);
  const saved = readAuth(home);
  assert.equal(saved.authType, 'oauth');
  assert.equal(saved.token, access);
  assert.equal(saved.refreshToken, 'r1');
  assert.equal(saved.userId, 'user-1');
  assert.equal(saved.baseUrl, bff.url);
  assert.equal(saved.supabaseAnonKey, undefined);
});

test('whoami renews first and reports the session kind', async () => {
  const access = jwtWith({ sub: 'user-1', exp: nowS() + 3600 });
  bff = await fakeBff(({ path }) =>
    path === '/api/mcp/oauth/token'
      ? { json: { access_token: access, refresh_token: 'r2', expires_in: 3600 } }
      : { json: { data: [] } },
  );
  writeAuth(home, session({ token: 'old', expiresAt: nowS() - 10 }));

  const { code, stdout } = await runCli(['whoami', '--json']);

  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.session, 'device login (renews itself)');
  assert.equal(out.valid, true);
  assert.equal(out.pingOk, true);
  assert.equal(bff.calls.find((c) => c.path === '/api/spy-brands/following').headers.authorization, `Bearer ${access}`);
});

test('auth token prints a usable token for scripts', async () => {
  bff = await fakeBff(() => ({ status: 500 }));
  writeAuth(home, session());
  const { code, stdout } = await runCli(['auth', 'token']);
  assert.equal(code, 0);
  assert.equal(stdout, 'access-1\n');
});

test('config show hides secrets; get refreshToken refuses; get token prints a usable one', async () => {
  bff = await fakeBff(() => ({ status: 500 }));
  writeAuth(home, session());

  const show = await runCli(['auth', 'config', 'show']);
  assert.equal(show.code, 0);
  assert.doesNotMatch(show.stdout, /access-1|"r1"/);
  assert.match(show.stdout, /hidden/);

  const getRefresh = await runCli(['auth', 'config', 'get', 'refreshToken']);
  assert.equal(getRefresh.code, 2);
  assert.doesNotMatch(getRefresh.stdout + getRefresh.stderr, /r1\b/);

  const getToken = await runCli(['auth', 'config', 'get', 'token']);
  assert.equal(getToken.stdout, 'access-1\n');

  const setSecret = await runCli(['auth', 'config', 'set', 'refreshToken', 'x']);
  assert.equal(setSecret.code, 2);
  assert.equal(readAuth(home).refreshToken, 'r1');
});

test('logout revokes the session at the server and removes the file', async () => {
  bff = await fakeBff(() => ({ json: {} }));
  writeAuth(home, session());
  const { code } = await runCli(['logout']);
  assert.equal(code, 0);
  assert.deepEqual(bff.calls[0].body, { token: 'r1', token_type_hint: 'refresh_token', client_id: 'quickdesign-cli' });
  assert.equal(bff.calls[0].path, '/api/mcp/oauth/revoke');
  assert.equal(readAuth(home), null);
});

test('login --token stores a pasted token that is never renewed', async () => {
  bff = await fakeBff(() => ({ status: 500 }));
  writeAuth(home, session());
  const pasted = jwtWith({ sub: 'user-2', email: 'a@b.co', exp: nowS() + 600 });
  const { code } = await runCli(['login', '--token', pasted]);
  assert.equal(code, 0);
  const saved = readAuth(home);
  assert.equal(saved.token, pasted);
  assert.equal(saved.authType, undefined);
  assert.equal(saved.refreshToken, undefined);
  assert.equal(saved.userId, 'user-2');
});
