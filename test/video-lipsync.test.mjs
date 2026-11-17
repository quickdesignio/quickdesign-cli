import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeBff, nowS, runCli, tempHome, writeAuth } from './helpers.mjs';

let home;
let bff;
const rpc = (call, result) => ({ jsonrpc: '2.0', id: call.body.id, result });
const text = (t) => ({ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t) });
const JOB = 'lipsync_3f0c';
const STARTED = { jobId: JOB, status: 'processing', cost: 80, duration_sec: 7.4 };
const VIDEO = 'https://library.quickdesign.io/user-1/take.mp4';
const AUDIO = 'https://library.quickdesign.io/user-1/line.mp3';
const lipsync = (...args) => runCli(['video', 'lipsync', ...args]);
const status = (data) => ({ json: { success: true, data: { jobId: JOB, ...data } } });

beforeEach(() => {
  home = tempHome();
  writeAuth(home, { authType: 'oauth', token: 'access-1', refreshToken: 'r1', userId: 'user-1', expiresAt: nowS() + 3600 });
});
afterEach(async () => {
  await bff?.close();
  bff = undefined;
});

test('video lipsync calls the quickdesign_video_lipsync MCP tool and prints the started job', async () => {
  bff = await fakeBff((call) => ({ json: rpc(call, { content: [text(STARTED)] }) }));
  const { code, stdout, stderr } = await lipsync('--video', VIDEO, '--audio', AUDIO);
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { request_id: JOB, status: 'processing', token_cost: 80, duration_sec: 7.4 });
  assert.equal(bff.calls.length, 1);
  const call = bff.calls[0];
  assert.equal(call.path, '/api/mcp');
  assert.equal(call.headers.authorization, 'Bearer access-1');
  assert.equal(call.body.params.name, 'quickdesign_video_lipsync');
  assert.deepEqual(call.body.params.arguments, { video_url: VIDEO, audio_url: AUDIO });
});

test('video lipsync sends design ids as they are and shows the server note', async () => {
  const noteText = 'The speech (5.0 s) is shorter than the video (9.0 s), so the result ends with the speech.';
  bff = await fakeBff((call) => ({ json: rpc(call, { content: [text({ ...STARTED, note: noteText })] }) }));
  const { code, stdout, stderr } = await lipsync('--video-design', '88876', '--audio-design', '88901');
  assert.equal(code, 0, stderr);
  assert.deepEqual(bff.calls[0].body.params.arguments, { design_id: 88876, audio_design_id: 88901 });
  assert.equal(JSON.parse(stdout).note, noteText);
  assert.match(stderr, /shorter than the video/);
});

test('video lipsync uploads local files first and sends their URLs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qd-lip-'));
  const video = join(dir, 'take.mp4');
  const audio = join(dir, 'line.mp3');
  writeFileSync(video, 'video-bytes');
  writeFileSync(audio, 'audio-bytes');
  bff = await fakeBff((call) => {
    if (call.path === '/api/uploads') {
      return { json: { success: true, publicUrl: call.body.includes('take.mp4') ? VIDEO : AUDIO } };
    }
    return { json: rpc(call, { content: [text(STARTED)] }) };
  });
  const { code, stderr } = await lipsync('--video', video, '--audio', audio);
  assert.equal(code, 0, stderr);
  assert.equal(bff.calls.filter((c) => c.path === '/api/uploads').length, 2);
  const mcp = bff.calls.find((c) => c.path === '/api/mcp');
  assert.deepEqual(mcp.body.params.arguments, { video_url: VIDEO, audio_url: AUDIO });
});

test('video lipsync checks its inputs before calling the server', async () => {
  bff = await fakeBff(() => ({ status: 500 }));
  const cases = [
    [['--audio', AUDIO], /exactly one of --video or --video-design/],
    [['--video', VIDEO, '--video-design', '5', '--audio', AUDIO], /exactly one of --video or --video-design/],
    [['--video', VIDEO], /exactly one of --audio or --audio-design/],
    [['--video', VIDEO, '--audio', AUDIO, '--audio-design', '5'], /exactly one of --audio or --audio-design/],
    [['--video-design', 'abc', '--audio', AUDIO], /--video-design must be/],
    [['--video', VIDEO, '--audio-design', '0'], /--audio-design must be/],
    [['--video', VIDEO, '--audio', 'https://library.quickdesign.io/user-1/other.mp4?x=1'], /--audio takes an audio file/],
  ];
  for (const [args, re] of cases) {
    const { code, stderr } = await lipsync(...args);
    assert.equal(code, 2, args.join(' '));
    assert.match(stderr, re);
  }
  assert.equal(bff.calls.length, 0);
});

test('video lipsync shows the tool error, and an older BFF without the tool is reported plainly', async () => {
  bff = await fakeBff((call) => ({ json: rpc(call, { isError: true, content: [text('Not enough credits: this costs 80 credits and the balance is 12.')] }) }));
  const refused = await lipsync('--video', VIDEO, '--audio', AUDIO);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Not enough credits/);
  assert.equal(refused.stdout, '');
  await bff.close();
  bff = await fakeBff((call) => ({ json: { jsonrpc: '2.0', id: call.body.id, error: { code: -32602, message: 'MCP error -32602: Tool quickdesign_video_lipsync not found' } } }));
  const old = await lipsync('--video', VIDEO, '--audio', AUDIO);
  assert.equal(old.code, 1);
  assert.match(old.stderr, /needs a newer BFF/);
});

test('video lipsync -o waits on the status route and saves the result', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'qd-lip-out-')), 'synced.mp4');
  let polls = 0;
  bff = await fakeBff((call) => {
    if (call.path === '/api/mcp') return { json: rpc(call, { content: [text(STARTED)] }) };
    if (call.path === `/api/lipsync/status/${JOB}`) {
      polls += 1;
      return polls < 2 ? status({ status: 'processing' }) : status({ status: 'completed', result_video_url: `${bff.url}/files/synced.mp4` });
    }
    if (call.path === '/files/synced.mp4') return { raw: 'synced-bytes', headers: { 'Content-Type': 'video/mp4' } };
    return { status: 404 };
  });
  const { code, stdout, stderr } = await lipsync('--video', VIDEO, '--audio', AUDIO, '-o', out, '--interval', '20');
  assert.equal(code, 0, stderr);
  assert.equal(polls, 2);
  assert.deepEqual(JSON.parse(stdout), { request_id: JOB, url: `${bff.url}/files/synced.mp4`, outputPath: out });
  assert.equal(readFileSync(out, 'utf8'), 'synced-bytes');
});

test('video lipsync-wait fails with the job error; lipsync-status prints the status reply', async () => {
  bff = await fakeBff(() => status({ status: 'failed', error_message: 'No face found in the video' }));
  const waited = await runCli(['video', 'lipsync-wait', JOB, '--interval', '20']);
  assert.equal(waited.code, 1);
  assert.match(waited.stderr, /No face found in the video/);
  assert.equal(waited.stdout, '');
  const st = await runCli(['video', 'lipsync-status', JOB]);
  assert.equal(st.code, 0, st.stderr);
  assert.equal(JSON.parse(st.stdout).data.status, 'failed');
  assert.equal(bff.calls.at(-1).path, `/api/lipsync/status/${JOB}`);
});
