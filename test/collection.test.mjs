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

const OTTA = { ...COLLECTION, id: 'cccccccc-0000-0000-0000-0000000000a1', name: 'Otta Week 1' };
const OTTA_EDIT = { ...COLLECTION, id: 'cccccccc-0000-0000-0000-0000000000a2', name: 'Otta Week 1 - Edit' };
const ADDED = { collection_id: COL, added: [85725], already_in_collection: [85330], not_found: [] };

test('collection add posts the design ids to the collection and prints the result', async () => {
  bff = await fakeBff(() => ({ json: { success: true, data: ADDED } }));
  const { code, stdout } = await runCli(['collection', 'add', COL, '85725', '85330']);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), ADDED);
  assert.equal(bff.calls.length, 1);
  const call = bff.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.path, `/api/collections/${COL}/items`);
  assert.deepEqual(call.body, { design_ids: [85725, 85330] });
  assert.equal(call.headers.authorization, 'Bearer access-1');
});

test('collection add takes an exact collection name (any case), never a near match', async () => {
  bff = await fakeBff((call) =>
    call.method === 'GET'
      ? { json: { success: true, data: { total: 2, collections: [OTTA_EDIT, OTTA] } } }
      : { json: { success: true, data: { ...ADDED, collection_id: OTTA.id } } },
  );
  const { code } = await runCli(['collection', 'add', 'otta week 1', '85725']);
  assert.equal(code, 0);
  assert.equal(bff.calls[0].path, '/api/collections');
  assert.equal(bff.calls[1].path, `/api/collections/${OTTA.id}/items`);
});

test('collection add refuses a name that matches no collection, or more than one', async () => {
  bff = await fakeBff(() => ({ json: { success: true, data: { total: 2, collections: [OTTA_EDIT, { ...OTTA_EDIT, id: COL, name: 'otta week 1 - edit' }] } } }));
  const none = await runCli(['collection', 'add', 'Otta Week 1', '85725']);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /No collection named "Otta Week 1"/);
  const many = await runCli(['collection', 'add', 'Otta Week 1 - Edit', '85725']);
  assert.equal(many.code, 2);
  assert.match(many.stderr, /2 collections are named/);
  assert.match(many.stderr, new RegExp(COL));
  assert.ok(bff.calls.every((c) => c.method === 'GET'), 'nothing was posted');
});

test('collection add checks the design ids before calling the BFF', async () => {
  bff = await fakeBff(() => ({ json: { success: true, data: ADDED } }));
  for (const bad of ['abc', '0', '1.5']) {
    const { code, stderr } = await runCli(['collection', 'add', COL, bad]);
    assert.equal(code, 2, bad);
    assert.match(stderr, /design id/i);
  }
  // commander reads a negative number as an unknown option and stops there.
  assert.notEqual((await runCli(['collection', 'add', COL, '-3'])).code, 0);
  const tooMany = Array.from({ length: 51 }, (_, i) => String(i + 1));
  const over = await runCli(['collection', 'add', COL, ...tooMany]);
  assert.equal(over.code, 2);
  assert.match(over.stderr, /50/);
  assert.equal(bff.calls.length, 0);
});

test('collection add: an unknown collection id is exit 2', async () => {
  bff = await fakeBff(() => ({ status: 404, json: { success: false, error: 'Collection not found', code: 'COLLECTION_NOT_FOUND' } }));
  const { code, stderr } = await runCli(['collection', 'add', COL, '85725']);
  assert.equal(code, 2);
  assert.match(stderr, new RegExp(`No collection with id ${COL}`));
});

test('collection add warns about design ids it could not add', async () => {
  bff = await fakeBff(() => ({ json: { success: true, data: { ...ADDED, not_found: [7] } } }));
  const { code, stdout, stderr } = await runCli(['collection', 'add', COL, '85725', '85330', '7']);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout).not_found, [7]);
  assert.match(stderr, /not found or not yours to add: 7/);
});

test('collection add --human summarises what happened to each id', async () => {
  bff = await fakeBff(() => ({ json: { success: true, data: { ...ADDED, not_found: [7] } } }));
  const out = plain((await runCli(['collection', 'add', COL, '85725', '85330', '7', '--human'])).stdout);
  assert.match(out, /Added 1: 85725/);
  assert.match(out, /Already there 1: 85330/);
  assert.match(out, /Not found 1: 7/);
});

test('collection add on a BFF without the route says it needs a newer server', async () => {
  bff = await fakeBff(() => ({ status: 404, raw: '<!DOCTYPE html><pre>Cannot POST</pre>', headers: { 'content-type': 'text/html' } }));
  const { code, stderr } = await runCli(['collection', 'add', COL, '85725']);
  assert.equal(code, 1);
  assert.match(stderr, /needs a newer BFF/);
});
