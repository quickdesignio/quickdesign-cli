import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeBff, nowS, runCli, tempHome, writeAuth } from './helpers.mjs';

let home;
let bff;
const ROW = { id: 9, image: null, video_url: null, subjectLine: 'Summer', isArchived: false };
beforeEach(() => {
  home = tempHome();
  writeAuth(home, { authType: 'oauth', token: 'access-1', refreshToken: 'r1', userId: 'user-1', expiresAt: nowS() + 3600 });
});
afterEach(async () => {
  await bff?.close();
  bff = undefined;
});

test('design list asks the BFF with the CLI filters and prints the rows', async () => {
  bff = await fakeBff(() => ({ json: { success: true, data: [ROW] } }));
  const { code, stdout } = await runCli(['design', 'list', '--limit', '5', '--category', '7', '--assets-only', '--archived']);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), [ROW]);
  const call = bff.calls[0];
  assert.equal(call.path, '/api/designs');
  assert.deepEqual(call.query, { limit: '5', offset: '0', category: '7', include_archived: 'true', assets_only: 'true' });
  assert.equal(call.headers.authorization, 'Bearer access-1');
});

test('design list --select keeps only those columns', async () => {
  bff = await fakeBff(() => ({ json: { success: true, data: [ROW] } }));
  const { stdout } = await runCli(['design', 'list', '--select', 'id,subjectLine']);
  assert.deepEqual(JSON.parse(stdout), [{ id: 9, subjectLine: 'Summer' }]);
});

test('design get / delete hit the per-design routes', async () => {
  bff = await fakeBff(({ method, path }) => {
    if (path !== '/api/designs/9') return { status: 404, json: { success: false, error: 'Not found' } };
    if (method === 'GET') return { json: { success: true, data: ROW } };
    if (method === 'DELETE') return { json: { success: true, data: { id: 9, archived: true } } };
    return { status: 405, json: { success: false, error: 'Method not allowed' } };
  });
  assert.deepEqual(JSON.parse((await runCli(['design', 'get', '9'])).stdout), ROW);
  const del = await runCli(['design', 'delete', '9']);
  assert.equal(del.code, 0);
  assert.deepEqual(JSON.parse(del.stdout), { id: 9, archived: true });
  assert.equal(bff.calls[1].method, 'DELETE');
  assert.equal(bff.calls[1].path, '/api/designs/9');
});

test('a missing design is exit 2 with a plain message', async () => {
  bff = await fakeBff(() => ({ status: 404, json: { success: false, error: 'Design not found', code: 'DESIGN_NOT_FOUND' } }));
  const { code, stderr } = await runCli(['design', 'get', '10']);
  assert.equal(code, 2);
  assert.match(stderr, /No design with id 10/);
  assert.equal((await runCli(['design', 'get', 'abc'])).code, 2);
});

test('design download saves the image', async () => {
  bff = await fakeBff(({ path }) =>
    path === '/files/9.png'
      ? { raw: Buffer.from('PNGDATA'), headers: { 'Content-Type': 'image/png' } }
      : { json: { success: true, data: { ...ROW, image: `${bff.url}/files/9.png` } } },
  );
  const out = join(home, 'out.png');
  const { code } = await runCli(['design', 'download', '9', '-o', out]);
  assert.equal(code, 0);
  assert.ok(existsSync(out));
  assert.equal(readFileSync(out, 'latin1'), 'PNGDATA');
});
