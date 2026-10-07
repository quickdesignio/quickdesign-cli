import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeBff, nowS, plain, runCli, tempHome, writeAuth } from './helpers.mjs';

let home;
let bff;
const COL = 'cccccccc-0000-0000-0000-000000000001';
const COLLECTION = { id: COL, name: 'Summer drop', description: null, owner: 'you', shared_with_team: false, item_count: 2 };
const ITEMS = [
  { item_id: 'i1', source: 'design', design_id: 84813, type: 'image', title: 'AI image', image_url: 'https://ext.quickdesign.io/u/a.png', thumbnail_url: null, video_url: null, added_at: '2026-10-06T09:00:00Z' },
  { item_id: 'i2', source: 'spy_ad', design_id: null, type: 'video', title: 'Hook', image_url: null, thumbnail_url: null, video_url: 'https://library.quickdesign.io/spy-ads/b/1.mp4', added_at: '2026-10-05T09:00:00Z' },
];
beforeEach(() => {
  home = tempHome();
  writeAuth(home, { authType: 'oauth', token: 'access-1', refreshToken: 'r1', userId: 'user-1', expiresAt: nowS() + 3600 });
});
afterEach(async () => {
  await bff?.close();
  bff = undefined;
});

test('collection list asks the BFF and prints total + collections', async () => {
  bff = await fakeBff(() => ({ json: { success: true, data: { total: 1, collections: [COLLECTION] } } }));
  const { code, stdout } = await runCli(['collection', 'list', '--limit', '5', '--offset', '10']);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { total: 1, collections: [COLLECTION] });
  const call = bff.calls[0];
  assert.equal(call.path, '/api/collections');
  assert.deepEqual(call.query, { limit: '5', offset: '10' });
  assert.equal(call.headers.authorization, 'Bearer access-1');
});

test('collection list --human prints one line per collection', async () => {
  bff = await fakeBff(() => ({ json: { success: true, data: { total: 1, collections: [COLLECTION] } } }));
  const { code, stdout } = await runCli(['collection', 'list', '--human']);
  assert.equal(code, 0);
  assert.match(plain(stdout), new RegExp(`${COL}\\s+Summer drop\\s+2 items`));
});

test('collection get prints the collection with a page of its items', async () => {
  bff = await fakeBff(() => ({ json: { success: true, data: { collection: COLLECTION, total: 2, items: ITEMS } } }));
  const { code, stdout } = await runCli(['collection', 'get', COL, '--limit', '2']);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { collection: COLLECTION, total: 2, items: ITEMS });
  assert.equal(bff.calls[0].path, `/api/collections/${COL}`);
  assert.deepEqual(bff.calls[0].query, { limit: '2', offset: '0' });
});

test('collection get --human lists the items with their URLs', async () => {
  bff = await fakeBff(() => ({ json: { success: true, data: { collection: COLLECTION, total: 2, items: ITEMS } } }));
  const out = plain((await runCli(['collection', 'get', COL, '--human'])).stdout);
  assert.match(out, /Summer drop/);
  assert.match(out, /84813\s+image\s+AI image/);
  assert.match(out, /spy ad\s+video\s+Hook/);
  assert.match(out, /library\.quickdesign\.io\/spy-ads\/b\/1\.mp4/);
});

test('an unknown collection is exit 2 with a plain message; a bad id never reaches the BFF', async () => {
  bff = await fakeBff(() => ({ status: 404, json: { success: false, error: 'Collection not found', code: 'COLLECTION_NOT_FOUND' } }));
  const { code, stderr } = await runCli(['collection', 'get', COL]);
  assert.equal(code, 2);
  assert.match(stderr, new RegExp(`No collection with id ${COL}`));
  const bad = await runCli(['collection', 'get', 'summer']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /collection list/);
  assert.equal(bff.calls.length, 1);
});
