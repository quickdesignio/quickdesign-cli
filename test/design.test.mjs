import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  assert.equal(bff.calls.length, 1, 'no tag lookup without --tag');
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

const UPLOADED = 'https://ext.quickdesign.io/user-1/clip.mp4';

test('design create uploads a local file, then saves it as a design', async () => {
  bff = await fakeBff(({ path }) =>
    path === '/api/uploads'
      ? { json: { success: true, publicUrl: UPLOADED } }
      : { status: 201, json: { success: true, data: { ...ROW, id: 77, video_url: UPLOADED } } },
  );
  const file = join(home, 'clip.mp4');
  writeFileSync(file, 'MP4DATA');
  const { code, stdout } = await runCli(['design', 'create', file, '--title', 'Ottasilver v2']);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { ...ROW, id: 77, video_url: UPLOADED });
  assert.equal(bff.calls[0].path, '/api/uploads');
  assert.match(bff.calls[0].body, /MP4DATA/);
  assert.equal(bff.calls[1].method, 'POST');
  assert.equal(bff.calls[1].path, '/api/designs');
  assert.deepEqual(bff.calls[1].body, { url: UPLOADED, title: 'Ottasilver v2', asset: false });
});

test('design create sends a URL as is, and --asset saves it as a library upload', async () => {
  bff = await fakeBff(() => ({ status: 201, json: { success: true, data: { ...ROW, id: 78 } } }));
  const { code } = await runCli(['design', 'create', UPLOADED, '--asset']);
  assert.equal(code, 0);
  assert.equal(bff.calls.length, 1);
  assert.deepEqual(bff.calls[0].body, { url: UPLOADED, asset: true });
});

test('design create on a missing file is exit 2 and calls nothing', async () => {
  bff = await fakeBff(() => ({ json: { success: true } }));
  const { code, stderr } = await runCli(['design', 'create', join(home, 'nope.mp4')]);
  assert.equal(code, 2);
  assert.match(stderr, /nope\.mp4/);
  assert.equal(bff.calls.length, 0);
});

test('design create explains a server that does not have the route yet', async () => {
  bff = await fakeBff(() => ({ status: 404, json: { success: false, error: 'Route not found' } }));
  const { code, stderr } = await runCli(['design', 'create', UPLOADED]);
  assert.equal(code, 1);
  assert.match(stderr, /does not support `design create` yet/);
});

test('design create shows the server\'s reason for a rejected file', async () => {
  bff = await fakeBff(() => ({
    status: 400,
    json: { success: false, error: 'The uploaded file was not found', code: 'FILE_NOT_FOUND' },
  }));
  const { code, stderr } = await runCli(['design', 'create', UPLOADED]);
  assert.equal(code, 1);
  assert.match(stderr, /The uploaded file was not found/);
});

const WINNER = { id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'winner', color: 'green', count: 24, last_used_at: null };
const YUZUK = { id: 'aaaaaaaa-0000-0000-0000-000000000002', name: 'Yüzük', color: 'purple', count: 1, last_used_at: null };
const TAGGED = { ...ROW, tags: ['winner', 'Yüzük'] };

test('design list --tag resolves the names (any case) and asks for designs that carry all of them', async () => {
  bff = await fakeBff(({ path }) =>
    path === '/api/design-tags' ? { json: { tags: [WINNER, YUZUK] } } : { json: { success: true, data: [TAGGED] } },
  );
  const { code, stdout } = await runCli(['design', 'list', '--tag', 'WINNER', '--tag', 'yüzük', '--tag', 'Winner']);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), [TAGGED]);
  assert.equal(bff.calls.length, 2);
  assert.equal(bff.calls[0].path, '/api/design-tags');
  assert.equal(bff.calls[1].path, '/api/designs');
  assert.deepEqual(bff.calls[1].query, { limit: '50', offset: '0', tags: 'winner,Yüzük' });
});

test('design list --tag <id> resolves the id and sends the canonical name', async () => {
  bff = await fakeBff(({ path }) =>
    path === '/api/design-tags' ? { json: { tags: [WINNER, YUZUK] } } : { json: { success: true, data: [TAGGED] } },
  );
  const { code } = await runCli(['design', 'list', '--tag', YUZUK.id.toUpperCase()]);
  assert.equal(code, 0);
  assert.equal(bff.calls.length, 2);
  assert.equal(bff.calls[0].path, '/api/design-tags');
  assert.equal(bff.calls[1].path, '/api/designs');
  assert.equal(bff.calls[1].query.tags, 'Yüzük');
});

test('design list --tag with a tag the team does not have is exit 2 and lists nothing', async () => {
  bff = await fakeBff(({ path }) =>
    path === '/api/design-tags' ? { json: { tags: [WINNER] } } : { json: { success: true, data: [TAGGED] } },
  );
  const { code, stderr } = await runCli(['design', 'list', '--tag', 'winner', '--tag', 'nope']);
  assert.equal(code, 2);
  assert.match(stderr, /No tag named "nope"/);
  assert.equal(bff.calls.length, 1);
  assert.ok(bff.calls.every((c) => c.path === '/api/design-tags'));
});

test('design list --tag with more than 10 distinct tags is exit 2 without asking for designs', async () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ ...WINNER, id: `aaaaaaaa-0000-0000-0000-0000000001${String(i).padStart(2, '0')}`, name: `t${i}` }));
  bff = await fakeBff(({ path }) =>
    path === '/api/design-tags' ? { json: { tags: many } } : { json: { success: true, data: [] } },
  );
  const args = ['design', 'list', ...many.flatMap((t) => ['--tag', t.name])];
  const { code, stderr } = await runCli(args);
  assert.equal(code, 2);
  assert.match(stderr, /At most 10 tags/);
  assert.equal(bff.calls.length, 1);
  assert.ok(bff.calls.every((c) => c.path === '/api/design-tags'));
});

test('design list --tag warns about unknown_tags the server reports and prints an empty list', async () => {
  bff = await fakeBff(({ path }) =>
    path === '/api/design-tags'
      ? { json: { tags: [WINNER] } }
      : { json: { success: true, data: [], unknown_tags: ['winner'] } },
  );
  const { code, stdout, stderr } = await runCli(['design', 'list', '--tag', 'winner']);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), []);
  assert.match(stderr, /unknown tag.*winner/i);
});

test('design list --tag never prints an unfiltered list from a BFF that ignores the filter', async () => {
  // Tag routes exist, but /api/designs predates `tags`: it drops the query and returns every design.
  bff = await fakeBff(({ path }) =>
    path === '/api/design-tags' ? { json: { tags: [WINNER] } } : { json: { success: true, data: [ROW] } },
  );
  const { code, stdout, stderr } = await runCli(['design', 'list', '--tag', 'winner']);
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /does not support `design list --tag` yet; it needs a newer BFF/);
});

test('design list --tag on a BFF without tags at all says it needs a newer BFF', async () => {
  bff = await fakeBff(() => ({ status: 404, json: { success: false, error: 'Route GET /api/design-tags not found', message: 'NOT_FOUND' } }));
  const { code, stderr } = await runCli(['design', 'list', '--tag', 'winner']);
  assert.equal(code, 1);
  assert.match(stderr, /does not support tags yet; it needs a newer BFF/);
});

test('design list --tag says so when the tag tables are not migrated yet', async () => {
  bff = await fakeBff(({ path }) =>
    path === '/api/design-tags'
      ? { json: { tags: [WINNER] } }
      : { status: 503, json: { success: false, error: 'unavailable', code: 'design_tags_unavailable' } },
  );
  const { code, stderr } = await runCli(['design', 'list', '--tag', 'winner']);
  assert.equal(code, 1);
  assert.match(stderr, /Tags aren't available on this QuickDesign server yet/);
});

test('design list --tag with --select still checks the rows before keeping columns', async () => {
  bff = await fakeBff(({ path }) =>
    path === '/api/design-tags' ? { json: { tags: [WINNER] } } : { json: { success: true, data: [TAGGED] } },
  );
  const { code, stdout } = await runCli(['design', 'list', '--tag', 'winner', '--select', 'id']);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), [{ id: 9 }]);
});

test('design list --tag with an empty or blank value is exit 2 before any request', async () => {
  for (const v of ['', '  ']) {
    bff = await fakeBff(() => ({ json: { success: true, data: [] } }));
    const { code, stderr } = await runCli(['design', 'list', '--tag', v]);
    assert.equal(code, 2);
    assert.match(stderr, /Tag name must not be empty/);
    assert.equal(bff.calls.length, 0);
    await bff.close();
  }
  bff = undefined;
});
