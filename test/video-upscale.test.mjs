import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeBff, nowS, runCli, tempHome, writeAuth } from './helpers.mjs';

let home;
let bff;
const START = '/api/async-video-upscale/start-upscale';
const upscale = (...args) => runCli(['video', 'upscale', '--video', 'https://cdn.example/final.mp4', '--duration-seconds', '12', ...args]);

beforeEach(() => {
  home = tempHome();
  writeAuth(home, { authType: 'oauth', token: 'access-1', refreshToken: 'r1', userId: 'user-1', expiresAt: nowS() + 3600 });
});
afterEach(async () => {
  await bff?.close();
  bff = undefined;
});

test('video upscale --provider gemini sends the target resolution and source height', async () => {
  bff = await fakeBff(() => ({ json: { success: true, data: { jobId: 'up-1', status: 'queued', token_cost: 96 } } }));
  const { code, stdout, stderr } = await upscale('--provider', 'gemini', '--target-resolution', '1080p', '--source-height', '720');
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { request_id: 'up-1', provider: 'gemini', status: 'queued', token_cost: 96 });
  const call = bff.calls.find((c) => c.path === START);
  assert.equal(call.method, 'POST');
  assert.equal(call.body.provider, 'gemini');
  assert.equal(call.body.video_url, 'https://cdn.example/final.mp4');
  assert.equal(call.body.duration_seconds, 12);
  assert.equal(call.body.target_resolution, '1080p');
  assert.equal(call.body.source_height, 720);
});

test('video upscale keeps topaz as the default and never sends source_height for it', async () => {
  bff = await fakeBff(() => ({ json: { success: true, data: { jobId: 'up-2', status: 'queued' } } }));
  const { code } = await upscale('--factor', '2', '--source-height', '720');
  assert.equal(code, 0);
  const call = bff.calls.find((c) => c.path === START);
  assert.equal(call.body.provider, 'topaz');
  assert.equal(call.body.upscale_factor, 2);
  assert.equal('source_height' in call.body, false);
});

test('video upscale refuses an unknown provider or a bad --source-height before calling the server', async () => {
  bff = await fakeBff(() => ({ status: 500 }));
  const unknown = await upscale('--provider', 'veo');
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown upscale provider: veo/);
  const bad = await upscale('--provider', 'gemini', '--source-height', 'abc');
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--source-height/);
  assert.equal(bff.calls.length, 0);
});

test('video upscale shows the server refusal for a clip the gemini upscaler does not take', async () => {
  bff = await fakeBff(() => ({ status: 400, json: { success: false, error: 'Gemini Omni Flash upscales videos of up to 15 s — this one is 40 s. Trim it, or use Topaz / ByteDance.' } }));
  const { code, stderr } = await upscale('--provider', 'gemini');
  assert.notEqual(code, 0);
  assert.match(stderr, /up to 15 s/);
});
