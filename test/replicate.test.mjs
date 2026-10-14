import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeBff, nowS, runCli, tempHome, writeAuth } from './helpers.mjs';

let home;
let bff;
const START = '/api/replicate-video/generate';
const photos = (n) => Array.from({ length: n }, (_, i) => ['--product', `https://cdn.example/p${i + 1}.png`]).flat();
const replicate = (...args) => runCli(['video', 'replicate', '--video', 'https://cdn.example/ref.mp4', ...args]);

beforeEach(() => {
  home = tempHome();
  writeAuth(home, { authType: 'oauth', token: 'access-1', refreshToken: 'r1', userId: 'user-1', expiresAt: nowS() + 3600 });
});
afterEach(async () => {
  await bff?.close();
  bff = undefined;
});

test('video replicate sends more than 3 --product photos; the server enforces the model limit', async () => {
  bff = await fakeBff(() => ({ status: 202, json: { success: true, jobId: 'job-1', cost: 346, duration: 12, aspectRatio: '9:16' } }));
  const { code, stdout, stderr } = await replicate(...photos(12));
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).request_id, 'job-1');
  const call = bff.calls.find((c) => c.path === START);
  assert.equal(call.body.productImageUrls.length, 12);
  assert.equal(call.body.productImageUrls[11], 'https://cdn.example/p12.png');
  assert.equal(call.body.source, 'cli');
});

test('video replicate shows the server refusal that names the limit', async () => {
  bff = await fakeBff(() => ({ status: 400, json: { success: false, error: 'Too many product images: at most 28 fit alongside the model image and logo' } }));
  const { code, stderr } = await replicate(...photos(29), '--model-image', 'https://cdn.example/m.png');
  assert.notEqual(code, 0);
  assert.match(stderr, /at most 28 fit alongside the model image and logo/);
});

test('video replicate refuses no --product or more than 30 before calling the server', async () => {
  bff = await fakeBff(() => ({ status: 500 }));
  const none = await replicate();
  assert.equal(none.code, 2);
  assert.match(none.stderr, /Pass at least one --product image/);
  const many = await replicate(...photos(31));
  assert.equal(many.code, 2);
  assert.match(many.stderr, /Pass at most 30 --product images \(got 31\)/);
  assert.equal(bff.calls.length, 0);
});

test('video replicate --help no longer says 1–3', async () => {
  const { stdout } = await runCli(['video', 'replicate', '--help']);
  const help = stdout.replace(/\s+/g, ' ');
  assert.doesNotMatch(help, /1–3/);
  assert.match(help, /as many as the video model takes beside --model-image and the brand logo, at most 30/);
});
