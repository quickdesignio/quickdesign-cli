import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, delay, fakeBff, jwtWith, nowS, readAuth, runCli, tempHome, writeAuth } from './helpers.mjs';

const cfg = await import('../dist/config.js');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'fresh-token.mjs');

let home;
let bff;
const freshPair = () => ({
  access_token: jwtWith({ sub: 'user-1', exp: nowS() + 3600 }),
  refresh_token: 'r2',
  expires_in: 3600,
  token_type: 'Bearer',
});
const expiredSession = () => ({ authType: 'oauth', token: 'old-access', refreshToken: 'r1', userId: 'user-1', expiresAt: nowS() - 10 });

beforeEach(() => {
  home = tempHome();
});
afterEach(async () => {
  await bff?.close();
  bff = undefined;
});

test('the refresh lock outlives a slow refresh (spec R3)', () => {
  assert.ok(cfg.LOCK_STALE_MS > cfg.REFRESH_TIMEOUT_MS);
});

test('a valid session token is used as is', async () => {
  bff = await fakeBff(() => ({ status: 500 }));
  writeAuth(home, { authType: 'oauth', token: 'access-1', refreshToken: 'r1', expiresAt: nowS() + 3600 });
  assert.equal(await cfg.ensureFreshToken(), 'access-1');
  assert.equal(bff.calls.length, 0);
});

test('an expired session renews at the BFF and stores the new pair', async () => {
  const pair = freshPair();
  bff = await fakeBff(() => ({ json: pair }));
  writeAuth(home, expiredSession());

  assert.equal(await cfg.ensureFreshToken(), pair.access_token);

  assert.equal(bff.calls.length, 1);
  assert.equal(bff.calls[0].path, '/api/mcp/oauth/token');
  assert.deepEqual(bff.calls[0].body, { grant_type: 'refresh_token', refresh_token: 'r1', client_id: 'quickdesign-cli' });
  assert.match(bff.calls[0].headers['user-agent'], /^quickdesign-cli\//);
  const saved = readAuth(home);
  assert.equal(saved.authType, 'oauth');
  assert.equal(saved.token, pair.access_token);
  assert.equal(saved.refreshToken, 'r2');
  assert.equal(saved.userId, 'user-1');
  assert.ok(saved.expiresAt > nowS() + 3000);
});

test("expiresAt counts expires_in from this machine's clock, not the token's exp", async () => {
  // A server clock far ahead of this one: by the JWT's exp the token is long expired.
  const pair = { access_token: jwtWith({ sub: 'user-1', exp: nowS() - 86400 }), refresh_token: 'r2', expires_in: 3600 };
  bff = await fakeBff(() => ({ json: pair }));
  writeAuth(home, expiredSession());

  const before = nowS();
  assert.equal(await cfg.ensureFreshToken(), pair.access_token);
  const after = nowS();

  const { expiresAt } = readAuth(home);
  assert.ok(expiresAt >= before + 3600 && expiresAt <= after + 3600, `expiresAt ${expiresAt}, now ${after}`);
  // Valid here for an hour: the next command does not renew again.
  assert.equal(await cfg.ensureFreshToken(), pair.access_token);
  assert.equal(bff.calls.length, 1);
});

test('writeSession counts expires_in from when the token request was sent', () => {
  cfg.writeSession({ accessToken: jwtWith({ sub: 'user-1', exp: 1 }), refreshToken: 'r1', expiresIn: 3600, requestSentAt: 1_700_000_000_900 });
  assert.equal(readAuth(home).expiresAt, 1_700_000_000 + 3600);
});

test('invalid_grant ends the session with a login hint and no server text', async () => {
  bff = await fakeBff(() => ({ status: 400, json: { error: 'invalid_grant', error_description: 'Refresh token revoked' } }));
  writeAuth(home, expiredSession());
  await assert.rejects(cfg.ensureFreshToken(), (err) => {
    assert.ok(err instanceof cfg.SessionEndedError);
    assert.equal(err.message, 'Session ended — run `quickdesign login`.');
    return true;
  });
});

test('a token a sibling process left behind beats invalid_grant', async () => {
  const sibling = jwtWith({ sub: 'user-1', exp: nowS() + 3600 });
  bff = await fakeBff(() => {
    // The sibling renewed first (its lock went stale) and rotated r1 away.
    writeAuth(home, { authType: 'oauth', token: sibling, refreshToken: 'r3', userId: 'user-1', expiresAt: nowS() + 3600 });
    return { status: 400, json: { error: 'invalid_grant' } };
  });
  writeAuth(home, expiredSession());
  assert.equal(await cfg.ensureFreshToken(), sibling);
});

test('a 5xx is a retryable error, not a logout', async () => {
  bff = await fakeBff(() => ({ status: 503, json: { error: 'server_error' } }));
  writeAuth(home, expiredSession());
  await assert.rejects(cfg.ensureFreshToken(), (err) => {
    assert.ok(!(err instanceof cfg.SessionEndedError));
    assert.match(err.message, /HTTP 503\)\. Try again\./);
    return true;
  });
  assert.equal(readAuth(home).refreshToken, 'r1');
});

test('a CLI ≤ 0.16 session works until it expires, then asks for login without calling anyone', async () => {
  bff = await fakeBff(() => ({ status: 500 }));
  writeAuth(home, { token: 'legacy', refreshToken: 'supabase-rt', expiresAt: nowS() + 3600 });
  assert.equal(await cfg.ensureFreshToken(), 'legacy');

  writeAuth(home, { token: 'legacy', refreshToken: 'supabase-rt', expiresAt: nowS() - 10 });
  await assert.rejects(cfg.ensureFreshToken(), cfg.SessionEndedError);
  assert.equal(bff.calls.length, 0);
});

test('QUICKDESIGN_TOKEN wins over the stored session', async () => {
  bff = await fakeBff(() => ({ status: 500 }));
  writeAuth(home, expiredSession());
  process.env.QUICKDESIGN_TOKEN = 'env-token';
  try {
    assert.equal(await cfg.ensureFreshToken(), 'env-token');
  } finally {
    delete process.env.QUICKDESIGN_TOKEN;
  }
  assert.equal(bff.calls.length, 0);
});

test('concurrent callers in one process share one renewal', async () => {
  const pair = freshPair();
  bff = await fakeBff(async () => {
    await delay(200);
    return { json: pair };
  });
  writeAuth(home, expiredSession());
  const [a, b] = await Promise.all([cfg.ensureFreshToken(), cfg.ensureFreshToken()]);
  assert.equal(a, pair.access_token);
  assert.equal(b, pair.access_token);
  assert.equal(bff.calls.length, 1);
});

test('two processes renewing at once make one call and get the same token', async () => {
  const pair = freshPair();
  bff = await fakeBff(async () => {
    await delay(500);
    return { json: pair };
  });
  writeAuth(home, expiredSession());
  const run = () =>
    new Promise((resolve, reject) => {
      execFile(process.execPath, [FIXTURE], { env: { ...process.env } }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(a, pair.access_token);
  assert.equal(b, pair.access_token);
  assert.equal(bff.calls.length, 1);
});

test('commands report an ended session as one actionable line', async () => {
  bff = await fakeBff(() => ({ status: 500 }));
  writeAuth(home, { token: 'legacy', expiresAt: nowS() - 10 });
  const { code, stderr } = await runCli(['template', 'list']);
  assert.equal(code, 1);
  assert.match(stderr, /Session ended — run `quickdesign login`\./);
  assert.equal(bff.calls.length, 0);
});

// --output events: no spinner, so stderr holds only what the auth path prints.
test('brand dna shows an ended session as one line, without its login hint', async () => {
  bff = await fakeBff(() => ({ status: 500 }));
  writeAuth(home, { token: 'legacy', expiresAt: nowS() - 10 });
  const { code, stderr } = await runCli(['brand', 'dna', 'https://brand.test', '--output', 'events']);
  assert.equal(code, 1);
  assert.deepEqual(stderr.trim().split('\n'), ['error Session ended — run `quickdesign login`.']);
  assert.equal(bff.calls.length, 0);
});

test('brand dna does not tell the user to log in when a renewal only failed', async () => {
  bff = await fakeBff(() => ({ status: 503, json: { error: 'server_error' } }));
  writeAuth(home, expiredSession());
  const { code, stderr } = await runCli(['brand', 'dna', 'https://brand.test', '--output', 'events']);
  assert.equal(code, 1);
  assert.deepEqual(stderr.trim().split('\n'), ['error QuickDesign could not renew the session (HTTP 503). Try again.']);
});
