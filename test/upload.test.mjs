import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeBff, nowS, tempHome, writeAuth } from './helpers.mjs';

const { uploadLocalFile } = await import('../dist/utils/upload.js');

let home;
let bff;
beforeEach(() => {
  home = tempHome();
  writeAuth(home, { authType: 'oauth', token: 'access-1', refreshToken: 'r1', userId: 'user-1', expiresAt: nowS() + 3600 });
});
afterEach(async () => {
  await bff?.close();
  bff = undefined;
});

test('uploads through the BFF with the session and the pinned name', async () => {
  bff = await fakeBff(() => ({ json: { success: true, publicUrl: 'https://ext.quickdesign.io/user-1/social-abc.png', key: 'user-1/social-abc.png' } }));
  const file = join(home, 'local.png');
  writeFileSync(file, 'PNGDATA');

  const url = await uploadLocalFile(file, 'social-abc.png');

  assert.equal(url, 'https://ext.quickdesign.io/user-1/social-abc.png');
  const call = bff.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/api/uploads');
  assert.equal(call.headers.authorization, 'Bearer access-1');
  assert.match(call.headers['content-type'], /^multipart\/form-data/);
  assert.match(call.body, /name="filename"\r\n\r\nsocial-abc\.png/);
  assert.match(call.body, /Content-Type: image\/png/);
  assert.match(call.body, /PNGDATA/);
});

test('a file over 200 MB is refused before anything is sent', async () => {
  bff = await fakeBff(() => ({ json: {} }));
  const file = join(home, 'huge.mp4');
  writeFileSync(file, '');
  truncateSync(file, 201 * 1024 * 1024);
  await assert.rejects(uploadLocalFile(file), /limited to 200 MB/);
  assert.equal(bff.calls.length, 0);
});

test('a 413 from the proxy (HTML, not JSON) is reported as too large', async () => {
  bff = await fakeBff(() => ({ status: 413, raw: '<html>413 Request Entity Too Large</html>', headers: { 'Content-Type': 'text/html' } }));
  const file = join(home, 'big.mp4');
  writeFileSync(file, 'x');
  await assert.rejects(uploadLocalFile(file), { name: 'Error', message: 'big.mp4 is too large; uploads are limited to 200 MB.' });
});

test('not logged in says so', async () => {
  bff = await fakeBff(() => ({ json: {} }));
  writeAuth(home, {});
  const file = join(home, 'x.png');
  writeFileSync(file, 'x');
  await assert.rejects(uploadLocalFile(file), /Not logged in/);
});

test('the server\'s refusal is passed on', async () => {
  bff = await fakeBff(() => ({ status: 400, json: { success: false, error: 'Unsupported file type: application/octet-stream', code: 'UPLOAD_REJECTED' } }));
  const file = join(home, 'x.bin');
  writeFileSync(file, 'x');
  await assert.rejects(uploadLocalFile(file), /Unsupported file type/);
});
