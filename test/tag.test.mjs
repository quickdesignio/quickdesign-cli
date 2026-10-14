import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeBff, nowS, plain, runCli, tempHome, writeAuth } from './helpers.mjs';

let home;
let bff;
const WINNER = { id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'winner', color: 'green', count: 24, last_used_at: '2026-10-14T09:00:00Z' };
const YUZUK = { id: 'aaaaaaaa-0000-0000-0000-000000000002', name: 'Yüzük', color: 'purple', count: 1, last_used_at: null };
const REVIZE = { id: 'aaaaaaaa-0000-0000-0000-000000000003', name: 'revize', color: 'red', count: 9, last_used_at: '2026-10-13T09:00:00Z' };
const TAGS = [WINNER, REVIZE, YUZUK];
/** fakeBff decodes request bodies as latin1, so a non-ASCII name arrives as its UTF-8 bytes read as latin1. */
const wire = (s) => Buffer.from(s, 'utf8').toString('latin1');

beforeEach(() => {
  home = tempHome();
  writeAuth(home, { authType: 'oauth', token: 'access-1', refreshToken: 'r1', userId: 'user-1', expiresAt: nowS() + 3600 });
});
afterEach(async () => {
  await bff?.close();
  bff = undefined;
});

test('tag list asks the BFF and prints the tags as JSON', async () => {
  bff = await fakeBff(() => ({ json: { tags: TAGS } }));
  const { code, stdout } = await runCli(['tag', 'list']);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { tags: TAGS });
  assert.equal(bff.calls.length, 1);
  assert.equal(bff.calls[0].method, 'GET');
  assert.equal(bff.calls[0].path, '/api/design-tags');
  assert.equal(bff.calls[0].headers.authorization, 'Bearer access-1');
});

test('tag list --human prints one line per tag with its design count', async () => {
  bff = await fakeBff(() => ({ json: { tags: TAGS } }));
  const { code, stdout } = await runCli(['tag', 'list', '--human']);
  assert.equal(code, 0);
  const out = plain(stdout);
  assert.match(out, /● winner\s+24 designs/);
  assert.match(out, /● Yüzük\s+1 design\b/);
  assert.match(out, new RegExp(REVIZE.id));
});

test('tag list --human with no tags says how to add one', async () => {
  bff = await fakeBff(() => ({ json: { tags: [] } }));
  const { code, stdout, stderr } = await runCli(['tag', 'list', '--human']);
  assert.equal(code, 0);
  assert.equal(stdout, '');
  assert.match(stderr, /No tags yet/);
  assert.match(stderr, /quickdesign tag add/);
});

test('a BFF without the tag routes says it needs a newer BFF', async () => {
  bff = await fakeBff(() => ({ status: 404, json: { success: false, error: 'Route GET /api/design-tags not found', message: 'NOT_FOUND' } }));
  const { code, stderr } = await runCli(['tag', 'list']);
  assert.equal(code, 1);
  assert.match(stderr, /does not support tags yet; it needs a newer BFF/);
});

test('a BFF whose tag tables are missing says the migration is pending', async () => {
  bff = await fakeBff(() => ({ status: 503, json: { success: false, error: 'Design tags are not available', code: 'design_tags_unavailable' } }));
  const { code, stderr } = await runCli(['tag', 'list']);
  assert.equal(code, 1);
  assert.match(stderr, /aren't available on this QuickDesign server yet/);
  assert.match(stderr, /migration/);
});
