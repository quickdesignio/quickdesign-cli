import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeBff, nowS, runCli, tempHome, writeAuth } from './helpers.mjs';

let home;
let bff;
const I2V = '/api/async-seedance-video/start-image-to-video';

beforeEach(() => {
  home = tempHome();
  writeAuth(home, { authType: 'oauth', token: 'access-1', refreshToken: 'r1', userId: 'user-1', expiresAt: nowS() + 3600 });
});
afterEach(async () => {
  await bff?.close();
  bff = undefined;
});

test('video generate --end-image sends end_image_url on the seedance i2v route', async () => {
  bff = await fakeBff(() => ({ json: { success: true, data: { jobId: 'vid-1', status: 'queued' } } }));
  const { code, stdout, stderr } = await runCli([
    'video', 'generate', '--provider', 'seedance', '--model', 'gemini-omni-flash-1.2-i2v',
    '--image', 'https://cdn.example/start.jpg', '--end-image', 'https://cdn.example/end.jpg',
    '--duration', '8', '--resolution', '1080p', '--aspect-ratio', '9:16', '-p', 'walks out of frame',
  ]);
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).request_id, 'vid-1');
  const call = bff.calls.find((c) => c.path === I2V);
  assert.equal(call.body.model, 'gemini-omni-flash-1.2-i2v');
  assert.equal(call.body.imageUrl, 'https://cdn.example/start.jpg');
  assert.equal(call.body.end_image_url, 'https://cdn.example/end.jpg');
  assert.equal(call.body.duration, 8);
});

test('video generate without --end-image sends no end_image_url', async () => {
  bff = await fakeBff(() => ({ json: { success: true, data: { jobId: 'vid-2', status: 'queued' } } }));
  const { code } = await runCli(['video', 'generate', '--provider', 'seedance', '--model', 'seedance-2.5', '--reference-image', 'https://cdn.example/a.jpg', '-p', 'x']);
  assert.equal(code, 0);
  const call = bff.calls.find((c) => c.path === I2V);
  assert.equal('end_image_url' in call.body, false);
  assert.deepEqual(call.body.image_urls, ['https://cdn.example/a.jpg']);
});
