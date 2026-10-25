import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { delay, fakeBff, nowS, plain, runCli, tempHome, writeAuth } from './helpers.mjs';

let home;
let bff;
const PNG = Buffer.from('89504e470d0a1a0a-fake-png-bytes', 'latin1');
const TAB = {
  tabId: 'tab-1',
  project: { id: 'p1', name: 'Summer promo' },
  durationSec: 83.5,
  trackCount: 3,
  clipCount: 9,
  focusedAt: '2026-10-26T10:00:00.000Z',
  saves: [],
};
const HEADER = { tabId: 'tab-1', project: { id: 'p1', name: 'Summer promo' } };
const NO_TAB_HINT = 'No QuickDesign video editor is open. Ask the user to open the video editor in QuickDesign.';

const rpc = (call, result) => ({ jsonrpc: '2.0', id: call.body.id, result });
const text = (t) => ({ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) });
const sse = (...messages) => ({
  raw: messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join(''),
  headers: { 'Content-Type': 'text/event-stream' },
});

beforeEach(() => {
  home = tempHome();
  writeAuth(home, { authType: 'oauth', token: 'access-1', refreshToken: 'r1', userId: 'user-1', expiresAt: nowS() + 3600 });
});
afterEach(async () => {
  await bff?.close();
  bff = undefined;
});

test('editor status with one tab prints a line for it', async () => {
  bff = await fakeBff((call) => ({ json: rpc(call, { content: [text({ open: true, tabs: [TAB] })] }) }));
  const { code, stdout } = await runCli(['editor', 'status']);
  assert.equal(code, 0);
  const out = plain(stdout);
  assert.match(out, /tab-1/);
  assert.match(out, /Summer promo/);
  assert.match(out, /1m23\.5s/);
  assert.match(out, /3 tracks, 9 clips/);
  assert.equal(bff.calls[0].body.params.name, 'quickdesign_editor_status');
});

test('editor status --json prints the parsed JSON', async () => {
  bff = await fakeBff((call) => ({ json: rpc(call, { content: [text({ open: true, tabs: [TAB] })] }) }));
  const { code, stdout } = await runCli(['editor', 'status', '--json']);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { open: true, tabs: [TAB] });
});

test('editor status with no tab prints the hint and exits 1', async () => {
  bff = await fakeBff((call) => ({ json: rpc(call, { content: [text({ open: false, tabs: [], hint: NO_TAB_HINT })] }) }));
  const { code, stdout, stderr } = await runCli(['editor', 'status']);
  assert.equal(code, 1);
  assert.match(stderr, /open the video editor in QuickDesign/);
  assert.equal(stdout, '');
});

test('editor tools lists names with the first sentence of each description', async () => {
  const tools = [
    { name: 'cut_ranges', description: 'Remove time ranges. Give every range in one call.', inputSchema: {} },
    { name: 'view_frames', description: 'Look at the video: renders frames. More text.', inputSchema: {} },
  ];
  bff = await fakeBff((call) => ({ json: rpc(call, { content: [text({ ...HEADER, tools })] }) }));
  const { code, stdout } = await runCli(['editor', 'tools', '--tab', 'tab-9']);
  assert.equal(code, 0);
  const lines = plain(stdout).trim().split('\n');
  assert.deepEqual(lines, ['cut_ranges  Remove time ranges.', 'view_frames  Look at the video: renders frames.']);
  assert.deepEqual(bff.calls[0].body.params.arguments, { tabId: 'tab-9' });
  const json = await runCli(['editor', 'tools', '--json']);
  assert.deepEqual(JSON.parse(json.stdout).tools, tools);
});

test('editor call over SSE with text and an image writes the file and prints its path', async () => {
  bff = await fakeBff((call) =>
    sse(
      { jsonrpc: '2.0', method: 'notifications/message', params: {} },
      rpc(call, {
        content: [
          text(HEADER),
          text({ ok: true, summary: 'Rendered 8 frames', data: { count: 8 } }),
          { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
        ],
      }),
    ),
  );
  const out = join(mkdtempSync(join(tmpdir(), 'qd-editor-')), 'sheet.png');
  const { code, stdout } = await runCli(['editor', 'call', 'view_frames', '{"count":8}', '--out', out]);
  assert.equal(code, 0);
  assert.match(stdout, /"summary": "Rendered 8 frames"/);
  assert.match(stdout, new RegExp(`image saved: ${out}`));
  assert.deepEqual(readFileSync(out), PNG);
});

test('editor call without --out saves under the temp dir with the mime extension, several images get -1 -2', async () => {
  bff = await fakeBff((call) =>
    ({
      json: rpc(call, {
        content: [
          text({ ok: true, summary: 'two', data: {} }),
          { type: 'image', data: PNG.toString('base64'), mimeType: 'image/jpeg' },
          { type: 'image', data: PNG.toString('base64'), mimeType: 'image/webp' },
        ],
      }),
    }),
  );
  const { code, stdout } = await runCli(['editor', 'call', 'inspect_preview']);
  assert.equal(code, 0);
  const paths = [...stdout.matchAll(/image saved: (.+)/g)].map((m) => m[1]);
  assert.equal(paths.length, 2);
  assert.match(paths[0], /quickdesign-editor-inspect_preview-\d+-1\.jpg$/);
  assert.match(paths[1], /quickdesign-editor-inspect_preview-\d+-2\.webp$/);
  for (const p of paths) assert.ok(existsSync(p));
});

test('editor call --json lists parsed content, image paths and isError', async () => {
  bff = await fakeBff((call) =>
    ({
      json: rpc(call, {
        content: [text(HEADER), text({ ok: true, summary: 'ok', data: {} }), text('plain words'),
          { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }],
      }),
    }),
  );
  const out = join(mkdtempSync(join(tmpdir(), 'qd-editor-')), 'a.png');
  const { code, stdout } = await runCli(['editor', 'call', 'view_frames', '--json', '--out', out]);
  assert.equal(code, 0);
  const j = JSON.parse(stdout);
  assert.deepEqual(j.content, [HEADER, { ok: true, summary: 'ok', data: {} }, 'plain words']);
  assert.deepEqual(j.images, [out]);
  assert.equal(j.isError, false);
});

test('editor call with a plain JSON reply prints the result', async () => {
  bff = await fakeBff((call) => ({ json: rpc(call, { content: [text(HEADER), text({ ok: true, summary: 'Cut 3 ranges', data: {} })] }) }));
  const { code, stdout } = await runCli(['editor', 'call', 'cut_ranges', '{"ranges":[{"startSec":1,"endSec":2}]}']);
  assert.equal(code, 0);
  assert.match(stdout, /Cut 3 ranges/);
});

test('editor call with isError exits 1 and prints the message on stderr', async () => {
  bff = await fakeBff((call) => ({ json: rpc(call, { isError: true, content: [text('Unknown editor tool "nope". Call quickdesign_editor_tools for the list.')] }) }));
  const { code, stdout, stderr } = await runCli(['editor', 'call', 'nope']);
  assert.equal(code, 1);
  assert.match(stderr, /Unknown editor tool "nope"/);
  assert.equal(stdout, '');
});

test('an unknown MCP tool (live editing off) says it is not available on this server', async () => {
  bff = await fakeBff((call) => ({ json: { jsonrpc: '2.0', id: call.body.id, error: { code: -32602, message: 'MCP error -32602: Tool quickdesign_editor_status not found' } } }));
  const { code, stderr } = await runCli(['editor', 'status']);
  assert.equal(code, 1);
  assert.match(stderr, /Live video-editor editing isn't available on this QuickDesign server\./);
});

test('other JSON-RPC errors surface their message', async () => {
  bff = await fakeBff((call) => ({ json: { jsonrpc: '2.0', id: call.body.id, error: { code: -32602, message: 'Invalid arguments: designId' } } }));
  const { code, stderr } = await runCli(['editor', 'add-media', '5']);
  assert.equal(code, 1);
  assert.match(stderr, /Invalid arguments: designId/);
});

test('invalid args JSON or a non-object exits 2 without calling the server', async () => {
  bff = await fakeBff((call) => ({ json: rpc(call, { content: [text({ ok: true })] }) }));
  const bad = await runCli(['editor', 'call', 'cut_ranges', '{nope']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /not valid JSON/);
  const arr = await runCli(['editor', 'call', 'cut_ranges', '[1,2]']);
  assert.equal(arr.code, 2);
  assert.match(arr.stderr, /must be a JSON object/);
  assert.equal(bff.calls.length, 0);
});

test('--args-file reads the args from a file', async () => {
  bff = await fakeBff((call) => ({ json: rpc(call, { content: [text({ ok: true, summary: 'done' })] }) }));
  const file = join(mkdtempSync(join(tmpdir(), 'qd-editor-')), 'args.json');
  writeFileSync(file, '{"ranges":[{"startSec":1,"endSec":2.5}],"keepTrackIds":["music"]}');
  const { code } = await runCli(['editor', 'call', 'cut_ranges', '--args-file', file]);
  assert.equal(code, 0);
  assert.deepEqual(bff.calls[0].body.params.arguments.args, { ranges: [{ startSec: 1, endSec: 2.5 }], keepTrackIds: ['music'] });
  const missing = await runCli(['editor', 'call', 'cut_ranges', '--args-file', join(tmpdir(), 'qd-nope-404.json')]);
  assert.equal(missing.code, 2);
});

test('the request carries the bearer, the JSON-RPC body and the Accept header', async () => {
  bff = await fakeBff((call) => ({ json: rpc(call, { content: [text(HEADER), text({ ok: true, summary: 'ok' })] }) }));
  const { code } = await runCli(['editor', 'call', 'get_clip', '{"clipId":"c1"}', '--tab', 'tab-7']);
  assert.equal(code, 0);
  const c = bff.calls[0];
  assert.equal(c.method, 'POST');
  assert.equal(c.path, '/api/mcp');
  assert.equal(c.headers.authorization, 'Bearer access-1');
  assert.equal(c.headers.accept, 'application/json, text/event-stream');
  assert.match(c.headers['content-type'], /application\/json/);
  assert.equal(c.body.jsonrpc, '2.0');
  assert.equal(c.body.method, 'tools/call');
  assert.deepEqual(c.body.params, {
    name: 'quickdesign_editor_call',
    arguments: { tool: 'get_clip', args: { clipId: 'c1' }, tabId: 'tab-7' },
  });
});

test('add-media prints the mediaId and sends the design id', async () => {
  bff = await fakeBff((call) => ({ json: rpc(call, { content: [text({ ...HEADER, name: 'clip' }), text({ ok: true, summary: 'Imported', data: { mediaId: 'media-42' } })] }) }));
  const { code, stdout } = await runCli(['editor', 'add-media', '4521', '--tab', 'tab-1']);
  assert.equal(code, 0);
  assert.match(stdout, /mediaId: media-42/);
  assert.deepEqual(bff.calls[0].body.params, { name: 'quickdesign_editor_add_media', arguments: { designId: 4521, tabId: 'tab-1' } });
  assert.equal((await runCli(['editor', 'add-media', 'abc'])).code, 2);
});

test('save prints the saveId and points to editor status', async () => {
  bff = await fakeBff((call) => ({ json: rpc(call, { content: [text({ ...HEADER, saveId: 'save-9', status: 'saving' })] }) }));
  const { code, stdout, stderr } = await runCli(['editor', 'save', '--title', 'Final cut', '--collection', 'col-1']);
  assert.equal(code, 0);
  assert.match(stdout, /save-9/);
  assert.match(stderr, /quickdesign editor status/);
  assert.deepEqual(bff.calls[0].body.params.arguments, { title: 'Final cut', collectionId: 'col-1' });
});

test('a no-editor error result from any subcommand exits 1 with the hint', async () => {
  bff = await fakeBff((call) => ({ json: rpc(call, { isError: true, content: [text(NO_TAB_HINT)] }) }));
  const { code, stderr } = await runCli(['editor', 'save']);
  assert.equal(code, 1);
  assert.match(stderr, /open the video editor in QuickDesign/);
});

test('every editor subcommand --help says the video editor must be open', async () => {
  for (const sub of ['status', 'tools', 'call', 'add-media', 'save']) {
    const { stdout } = await runCli(['editor', sub, '--help']);
    assert.match(stdout.replace(/\s+/g, ' '), /video editor must be open/, sub);
  }
});

test('transcribe_clip waits longer than other editor tools', async () => {
  const { editorCallTimeoutMs } = await import('../dist/utils/mcp.js');
  assert.equal(editorCallTimeoutMs('transcribe_clip'), 200_000);
  assert.equal(editorCallTimeoutMs('cut_ranges'), 75_000);
});

const noStack = (stderr) => assert.doesNotMatch(stderr, /\n\s+at /);

test('a JSON-RPC "Session not found" error surfaces as-is, not as "not available"', async () => {
  bff = await fakeBff((call) => ({ json: { jsonrpc: '2.0', id: call.body.id, error: { code: -32001, message: 'Session not found' } } }));
  const { code, stderr } = await runCli(['editor', 'status']);
  assert.equal(code, 1);
  assert.match(stderr, /Session not found/);
  assert.doesNotMatch(stderr, /isn't available/);
});

test('a reply that never comes ends with a one-line timeout error', async () => {
  bff = await fakeBff(async () => { await delay(5000); return {}; });
  const { code, stderr } = await runCli(['editor', 'call', 'cut_ranges'], { QUICKDESIGN_EDITOR_TIMEOUT_MS: '300' });
  assert.equal(code, 1);
  assert.match(stderr, /The editor did not answer within 300ms\./);
  noStack(stderr);
});

test('a reply with no matching id is a clear error', async () => {
  bff = await fakeBff((call) => ({ json: { jsonrpc: '2.0', id: call.body.id + 1000, result: { content: [text('x')] } } }));
  const { code, stderr } = await runCli(['editor', 'status']);
  assert.equal(code, 1);
  assert.match(stderr, /sent no answer for this call/);
  noStack(stderr);
});

test('a non-JSON reply body is a clear error', async () => {
  bff = await fakeBff(() => ({ raw: '<html>oops</html>', headers: { 'Content-Type': 'text/html' } }));
  const { code, stderr } = await runCli(['editor', 'status']);
  assert.equal(code, 1);
  assert.match(stderr, /Unexpected reply from the QuickDesign MCP endpoint\./);
  noStack(stderr);
});

test('an image that cannot be written says the edit was applied', async () => {
  bff = await fakeBff((call) => ({ json: rpc(call, { content: [text({ ok: true, summary: 'Rendered' }), { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }] }) }));
  const blocker = join(mkdtempSync(join(tmpdir(), 'qd-editor-')), 'file');
  writeFileSync(blocker, 'x');
  const { code, stderr } = await runCli(['editor', 'call', 'view_frames', '--out', join(blocker, 'sub', 'a.png')]);
  assert.equal(code, 1);
  assert.match(stderr, /The edit was applied, but the image could not be saved: /);
  noStack(stderr);
});

test('image extensions come from a small table (svg, gif) and fall back to bin', async () => {
  bff = await fakeBff((call) => ({ json: rpc(call, { content: [
    { type: 'image', data: 'AA==', mimeType: 'image/svg+xml' },
    { type: 'image', data: 'AA==', mimeType: 'image/gif' },
    { type: 'image', data: 'AA==', mimeType: 'image/x-weird' },
  ] }) }));
  const { stdout } = await runCli(['editor', 'call', 'inspect_preview']);
  const paths = [...stdout.matchAll(/image saved: (.+)/g)].map((m) => m[1]);
  assert.deepEqual(paths.map((p) => p.split('.').pop()), ['svg', 'gif', 'bin']);
});

test('an empty content array prints a "(no output)" note', async () => {
  bff = await fakeBff((call) => ({ json: rpc(call, { content: [] }) }));
  const { code, stderr } = await runCli(['editor', 'call', 'noop']);
  assert.equal(code, 0);
  assert.match(stderr, /\(no output\)/);
});
