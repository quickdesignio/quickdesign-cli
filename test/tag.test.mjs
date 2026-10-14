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

const APPLIED = {
  added: [{ design_id: 85725, tag_id: WINNER.id }, { design_id: 85725, tag_id: YUZUK.id }],
  removed: [],
  already: [{ design_id: 85330, tag_id: WINNER.id }],
  created_tags: [],
  not_found: { designs: [], tags: [] },
  limit_reached: [],
};

test('tag add posts the designs and tag names (missing tags created) and prints the result', async () => {
  bff = await fakeBff(() => ({ json: APPLIED }));
  const { code, stdout } = await runCli(['tag', 'add', '85725', '85330', '--tag', 'winner', '--tag', 'Yüzük']);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), APPLIED);
  assert.equal(bff.calls.length, 1);
  const call = bff.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/api/design-tags/apply');
  assert.deepEqual(call.body, {
    designIds: [85725, 85330],
    add: [{ name: 'winner' }, { name: wire('Yüzük') }],
    createMissing: true,
  });
  assert.equal(call.headers.authorization, 'Bearer access-1');
});

test('tag add sends a name given twice in different case once, first spelling', async () => {
  bff = await fakeBff(() => ({ json: APPLIED }));
  const { code } = await runCli(['tag', 'add', '85725', '--tag', ' Winner ', '--tag', 'winner', '--tag', 'WINNER']);
  assert.equal(code, 0);
  assert.deepEqual(bff.calls[0].body.add, [{ name: 'Winner' }]);
});

test('tag add checks ids and names before calling the BFF', async () => {
  bff = await fakeBff(() => ({ json: APPLIED }));
  const noTag = await runCli(['tag', 'add', '85725']);
  assert.equal(noTag.code, 2);
  assert.match(noTag.stderr, /at least one --tag/);
  for (const bad of ['abc', '0', '1.5']) {
    const r = await runCli(['tag', 'add', bad, '--tag', 'winner']);
    assert.equal(r.code, 2, bad);
    assert.match(r.stderr, /design id/i);
  }
  const tooMany = Array.from({ length: 51 }, (_, i) => String(i + 1));
  const over = await runCli(['tag', 'add', ...tooMany, '--tag', 'winner']);
  assert.equal(over.code, 2);
  assert.match(over.stderr, /50/);
  const blank = await runCli(['tag', 'add', '85725', '--tag', '   ']);
  assert.equal(blank.code, 2);
  assert.match(blank.stderr, /must not be empty/);
  const long = await runCli(['tag', 'add', '85725', '--tag', 'x'.repeat(33)]);
  assert.equal(long.code, 2);
  assert.match(long.stderr, /at most 32 characters/);
  assert.equal(bff.calls.length, 0);
});

test('tag add accepts a 32-character name counted in characters, not bytes', async () => {
  bff = await fakeBff(() => ({ json: APPLIED }));
  const name = 'ü'.repeat(32);
  const { code } = await runCli(['tag', 'add', '85725', '--tag', name]);
  assert.equal(code, 0);
  assert.deepEqual(bff.calls[0].body.add, [{ name: wire(name) }]);
});

test('tag add reports what it could not do on stderr and keeps stdout JSON', async () => {
  bff = await fakeBff(() => ({
    json: {
      ...APPLIED,
      created_tags: [{ id: 'aaaaaaaa-0000-0000-0000-0000000000ff', name: 'black week', color: 'orange' }],
      not_found: { designs: [7], tags: [] },
      limit_reached: [85330],
    },
  }));
  const { code, stdout, stderr } = await runCli(['tag', 'add', '85725', '85330', '7', '--tag', 'black week']);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout).not_found.designs, [7]);
  assert.match(stderr, /designs not found or not yours to tag: 7/);
  assert.match(stderr, /already have 20 tags, skipped: 85330/);
  assert.match(stderr, /created tag: black week/);
});

test('tag add --human prints counts', async () => {
  bff = await fakeBff(() => ({ json: APPLIED }));
  const { code, stdout } = await runCli(['tag', 'add', '85725', '85330', '--tag', 'winner', '--human']);
  assert.equal(code, 0);
  assert.match(plain(stdout), /Added 2/);
  assert.match(plain(stdout), /Already there 1/);
});

test('tag add: a full workspace (422 tag_limit) is exit 2 with the server message', async () => {
  bff = await fakeBff(() => ({ status: 422, json: { success: false, error: 'Your team already has 200 tags', code: 'tag_limit' } }));
  const { code, stderr } = await runCli(['tag', 'add', '85725', '--tag', 'one more']);
  assert.equal(code, 2);
  assert.match(stderr, /already has 200 tags/);
});

test('tag remove posts the names to remove and never creates tags', async () => {
  const removed = { ...APPLIED, added: [], already: [], removed: [{ design_id: 85725, tag_id: REVIZE.id }] };
  bff = await fakeBff(() => ({ json: removed }));
  const { code, stdout } = await runCli(['tag', 'remove', '85725', '--tag', 'revize', '--tag', 'gone']);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), removed);
  assert.deepEqual(bff.calls[0].body, { designIds: [85725], remove: [{ name: 'revize' }, { name: 'gone' }] });
});

test('tag remove warns about tag names it did not find', async () => {
  bff = await fakeBff(() => ({ json: { ...APPLIED, added: [], already: [], not_found: { designs: [], tags: ['gone'] } } }));
  const { code, stderr } = await runCli(['tag', 'remove', '85725', '--tag', 'gone']);
  assert.equal(code, 0);
  assert.match(stderr, /tags not found: gone/);
});

test('tag remove --human prints how many came off', async () => {
  bff = await fakeBff(() => ({ json: { ...APPLIED, added: [], already: [], removed: [{ design_id: 85725, tag_id: REVIZE.id }] } }));
  const { stdout } = await runCli(['tag', 'remove', '85725', '--tag', 'revize', '--human']);
  assert.match(plain(stdout), /Removed 1/);
});

test('tag add rejects a comma in a tag name (exit 2, no request)', async () => {
  bff = await fakeBff(() => ({ json: APPLIED }));
  const { code, stderr } = await runCli(['tag', 'add', '1', '--tag', 'a,b']);
  assert.equal(code, 2);
  assert.match(stderr, /Tag name must not contain a comma/);
  assert.equal(bff.calls.length, 0);
});

test('tag add de-duplicates design ids before the 50 cap', async () => {
  bff = await fakeBff(() => ({ json: APPLIED }));
  const repeated = Array.from({ length: 60 }, (_, i) => String((i % 10) + 1));
  const { code } = await runCli(['tag', 'add', ...repeated, '--tag', 'winner']);
  assert.equal(code, 0);
  assert.deepEqual(bff.calls[0].body.designIds, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('tag add: a server 400 invalid is exit 2 with the server message', async () => {
  bff = await fakeBff(() => ({ status: 400, json: { success: false, error: 'designIds must hold 1 to 50 ids', code: 'invalid' } }));
  const { code, stderr } = await runCli(['tag', 'add', '85725', '--tag', 'winner']);
  assert.equal(code, 2);
  assert.match(stderr, /designIds must hold 1 to 50 ids/);
});


/** A fake BFF that serves the tag list on GET and hands other calls to `rest`. */
const withTagList = (rest) => (call) =>
  call.method === 'GET' && call.path === '/api/design-tags' ? { json: { tags: TAGS } } : rest(call);

test('tag rename finds the tag by name in any case and patches name and color', async () => {
  const renamed = { id: WINNER.id, name: 'kazanan', color: 'teal' };
  bff = await fakeBff(withTagList(() => ({ json: { tag: renamed } })));
  const { code, stdout } = await runCli(['tag', 'rename', 'WINNER', 'kazanan', '--color', 'Teal']);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { tag: renamed });
  assert.equal(bff.calls.length, 2);
  assert.equal(bff.calls[1].method, 'PATCH');
  assert.equal(bff.calls[1].path, `/api/design-tags/${WINNER.id}`);
  assert.deepEqual(bff.calls[1].body, { name: 'kazanan', color: 'teal' });
});

test('tag rename with only --color changes just the color; a tag id works too', async () => {
  bff = await fakeBff(withTagList(() => ({ json: { tag: { ...REVIZE, color: 'orange' } } })));
  const { code } = await runCli(['tag', 'rename', REVIZE.id, '--color', 'orange']);
  assert.equal(code, 0);
  assert.deepEqual(bff.calls[1].body, { color: 'orange' });
});

test('tag rename --human shows old → new', async () => {
  bff = await fakeBff(withTagList(() => ({ json: { tag: { id: WINNER.id, name: 'kazanan', color: 'green' } } })));
  const { stdout } = await runCli(['tag', 'rename', 'winner', 'kazanan', '--human']);
  assert.match(plain(stdout), /● winner → kazanan/);
});

test('tag rename checks its input before calling the BFF', async () => {
  bff = await fakeBff(withTagList(() => ({ json: {} })));
  const nothing = await runCli(['tag', 'rename', 'winner']);
  assert.equal(nothing.code, 2);
  assert.match(nothing.stderr, /new name, --color, or both/);
  const pink = await runCli(['tag', 'rename', 'winner', '--color', 'pink']);
  assert.equal(pink.code, 2);
  assert.match(pink.stderr, /Color must be one of green, yellow, orange, red, purple, blue, teal, gray/);
  const long = await runCli(['tag', 'rename', 'winner', 'y'.repeat(33)]);
  assert.equal(long.code, 2);
  assert.equal(bff.calls.length, 0);
});

test('tag rename of an unknown tag is exit 2 and patches nothing', async () => {
  bff = await fakeBff(withTagList(() => ({ json: {} })));
  const { code, stderr } = await runCli(['tag', 'rename', 'nope', 'yes']);
  assert.equal(code, 2);
  assert.match(stderr, /No tag named "nope"/);
  assert.equal(bff.calls.length, 1);
  assert.ok(bff.calls.every((c) => c.method === 'GET'));
});

test('tag rename to a name the team already uses (409) is exit 2 with the server message', async () => {
  bff = await fakeBff(withTagList(() => ({ status: 409, json: { success: false, error: 'A tag named "revize" already exists', code: 'tag_name_taken' } })));
  const { code, stderr } = await runCli(['tag', 'rename', 'winner', 'revize']);
  assert.equal(code, 2);
  assert.match(stderr, /already exists/);
});

test('tag rename of a tag a teammate just deleted (404 not_found) is exit 2', async () => {
  bff = await fakeBff(withTagList(() => ({ status: 404, json: { success: false, error: 'Tag not found', code: 'not_found' } })));
  const { code, stderr } = await runCli(['tag', 'rename', 'winner', 'kazanan']);
  assert.equal(code, 2);
  assert.match(stderr, /Tag not found/);
});

test('tag delete without --yes off a TTY refuses before any call', async () => {
  bff = await fakeBff(withTagList(() => ({ json: { removed_from: 9 } })));
  const { code, stderr } = await runCli(['tag', 'delete', 'revize']);
  assert.equal(code, 1);
  assert.match(stderr, /Refusing to delete a tag non-interactively without --yes/);
  assert.equal(bff.calls.length, 0);
});

test('tag delete --yes deletes the tag by name and prints what came off', async () => {
  bff = await fakeBff(withTagList(() => ({ json: { removed_from: 9 } })));
  const { code, stdout } = await runCli(['tag', 'delete', 'Revize', '--yes']);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { id: REVIZE.id, name: 'revize', removed_from: 9 });
  assert.equal(bff.calls[1].method, 'DELETE');
  assert.equal(bff.calls[1].path, `/api/design-tags/${REVIZE.id}`);
});

test('tag delete --yes --human says how many designs it came off', async () => {
  bff = await fakeBff(withTagList(() => ({ json: { removed_from: 1 } })));
  const { stdout } = await runCli(['tag', 'delete', 'Yüzük', '--yes', '--human']);
  assert.match(plain(stdout), /Deleted Yüzük \(removed from 1 design\)/);
});

test('tag delete of an unknown tag is exit 2; one a teammate already deleted is exit 2 too', async () => {
  bff = await fakeBff(withTagList(() => ({ status: 404, json: { success: false, error: 'Tag not found', code: 'not_found' } })));
  const unknown = await runCli(['tag', 'delete', 'nope', '--yes']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /No tag named "nope"/);
  const gone = await runCli(['tag', 'delete', 'winner', '--yes']);
  assert.equal(gone.code, 2);
  assert.match(gone.stderr, /Tag not found/);
});

test('tag rename with a comma in the new name is exit 2 and patches nothing', async () => {
  bff = await fakeBff(withTagList(() => ({ json: {} })));
  const { code, stderr } = await runCli(['tag', 'rename', 'winner', 'a,b']);
  assert.equal(code, 2);
  assert.match(stderr, /Tag name must not contain a comma/);
  assert.equal(bff.calls.length, 0);
  assert.ok(bff.calls.every((c) => c.method !== 'PATCH'));
});

test('tag rename of a tag to its own name in another case still patches', async () => {
  const renamed = { id: WINNER.id, name: 'Winner', color: 'green' };
  bff = await fakeBff(withTagList(() => ({ json: { tag: renamed } })));
  const { code, stdout } = await runCli(['tag', 'rename', 'winner', 'Winner']);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { tag: renamed });
  assert.equal(bff.calls.length, 2);
  assert.equal(bff.calls[1].method, 'PATCH');
  assert.equal(bff.calls[1].path, `/api/design-tags/${WINNER.id}`);
  assert.deepEqual(bff.calls[1].body, { name: 'Winner' });
});


test('tag remove with a tag id sends an id ref', async () => {
  bff = await fakeBff(() => ({ json: APPLIED }));
  const { code } = await runCli(['tag', 'remove', '1', '--tag', REVIZE.id.toUpperCase(), '--tag', REVIZE.id]);
  assert.equal(code, 0);
  assert.deepEqual(bff.calls[0].body, { designIds: [1], remove: [{ id: REVIZE.id.toUpperCase() }] });
});

test('tag add mixes id and name refs and still creates missing tags', async () => {
  bff = await fakeBff(() => ({ json: APPLIED }));
  const { code } = await runCli(['tag', 'add', '1', '--tag', REVIZE.id, '--tag', 'winner']);
  assert.equal(code, 0);
  assert.deepEqual(bff.calls[0].body, {
    designIds: [1],
    add: [{ id: REVIZE.id }, { name: 'winner' }],
    createMissing: true,
  });
});

test('tag list with an unexpected 200 body is exit 1', async () => {
  bff = await fakeBff(() => ({ json: {} }));
  const { code, stderr } = await runCli(['tag', 'list']);
  assert.equal(code, 1);
  assert.match(stderr, /Unexpected response from the server/);
});
