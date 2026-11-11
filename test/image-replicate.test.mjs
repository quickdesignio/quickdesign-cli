import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeBff, nowS, runCli, tempHome, writeAuth } from './helpers.mjs';

let home;
let bff;
const PNG = Buffer.from('89504e470d0a1a0a-fake-png-bytes', 'latin1');
const rpc = (call, result) => ({ jsonrpc: '2.0', id: call.body.id, result });
const text = (t) => ({ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) });
const STARTED = {
  request_id: 'req-1',
  request_ids: ['req-1', 'req-2'],
  status: 'queued',
  model: 'nano-banana-2-1',
  token_cost: 4,
  template_id: 88,
  reference_image_url: 'https://ext.quickdesign.io/templates/2/88.png',
  aspect_ratio: '4:5',
  product_image_count: 1,
  logo_count: 0,
};
const replicate = (...args) => runCli(['image', 'replicate', ...args]);

beforeEach(() => {
  home = tempHome();
  writeAuth(home, { authType: 'oauth', token: 'access-1', refreshToken: 'r1', userId: 'user-1', expiresAt: nowS() + 3600 });
});
afterEach(async () => {
  await bff?.close();
  bff = undefined;
});

test('image replicate calls the quickdesign_replicate_ad MCP tool and prints the started job', async () => {
  bff = await fakeBff((call) => ({ json: rpc(call, { content: [text(STARTED)] }) }));
  const { code, stdout, stderr } = await replicate('--template', '88', '--product', 'https://cdn.example/p.png', '--num', '2', '--resolution', '2K', '--brand-kit', '11111111-1111-4111-8111-111111111111', '--notes', ' keep the headline ');
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { request_id: 'req-1', request_ids: ['req-1', 'req-2'], status: 'queued', model: 'nano-banana-2-1', token_cost: 4, aspect_ratio: '4:5' });
  assert.equal(bff.calls.length, 1);
  const call = bff.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/api/mcp');
  assert.equal(call.headers.authorization, 'Bearer access-1');
  assert.equal(call.body.method, 'tools/call');
  assert.equal(call.body.params.name, 'quickdesign_replicate_ad');
  assert.deepEqual(call.body.params.arguments, {
    template_id: 88,
    product_image_urls: ['https://cdn.example/p.png'],
    brand_kit_id: '11111111-1111-4111-8111-111111111111',
    notes: 'keep the headline',
    num: 2,
    resolution: '2K',
  });
});

test('image replicate --reference uploads a local file first and sends its URL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qd-rep-'));
  const ref = join(dir, 'ad.png');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(ref, PNG);
  bff = await fakeBff((call) => {
    if (call.path === '/api/uploads') return { json: { success: true, publicUrl: 'https://ext.quickdesign.io/user-1/ad.png' } };
    return { json: rpc(call, { content: [text({ ...STARTED, template_id: null })] }) };
  });
  const { code, stderr } = await replicate('--reference', ref, '--product', 'https://cdn.example/p.png', '--aspect-ratio', '9:16');
  assert.equal(code, 0, stderr);
  const mcp = bff.calls.find((c) => c.path === '/api/mcp');
  assert.equal(mcp.body.params.arguments.reference_image_url, 'https://ext.quickdesign.io/user-1/ad.png');
  assert.equal(mcp.body.params.arguments.aspect_ratio, '9:16');
  assert.equal('template_id' in mcp.body.params.arguments, false);
});

test('image replicate checks its inputs before calling the server', async () => {
  bff = await fakeBff(() => ({ status: 500 }));
  const cases = [
    [['--product', 'https://cdn.example/p.png'], /exactly one of --template/],
    [['--template', '88', '--reference', 'https://cdn.example/ad.png', '--product', 'https://cdn.example/p.png'], /exactly one of --template/],
    [['--template', '88'], /--product/],
    [['--template', '88', ...Array.from({ length: 6 }, (_, i) => ['--product', `https://cdn.example/p${i}.png`]).flat()], /At most 5/],
    [['--template', '88', '--product', 'https://cdn.example/p.png', '--num', '5'], /--num must be 1-4/],
    [['--template', '88', '--product', 'https://cdn.example/p.png', '--aspect-ratio', '3:2'], /--aspect-ratio/],
    [['--template', '88', '--product', 'https://cdn.example/p.png', '--resolution', '8K'], /--resolution/],
    [['--template', '0', '--product', 'https://cdn.example/p.png'], /--template must be/],
  ];
  for (const [args, re] of cases) {
    const { code, stderr } = await replicate(...args);
    assert.equal(code, 2, args.join(' '));
    assert.match(stderr, re);
  }
  assert.equal(bff.calls.length, 0);
});

test('image replicate shows the tool error, and an older BFF without the tool is reported plainly', async () => {
  bff = await fakeBff((call) => ({ json: rpc(call, { isError: true, content: [text('Template 88 is a video — use quickdesign_replicate_video for it.')] }) }));
  const refused = await replicate('--template', '88', '--product', 'https://cdn.example/p.png');
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Template 88 is a video/);
  await bff.close();
  bff = await fakeBff((call) => ({ json: { jsonrpc: '2.0', id: call.body.id, error: { code: -32602, message: 'MCP error -32602: Tool quickdesign_replicate_ad not found' } } }));
  const old = await replicate('--template', '88', '--product', 'https://cdn.example/p.png');
  assert.equal(old.code, 1);
  assert.match(old.stderr, /needs a newer BFF/);
});

test('image replicate --wait polls every variation and -o saves them side by side', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qd-rep-out-'));
  const out = join(dir, 'ad.png');
  const polls = { 'req-1': 0, 'req-2': 0 };
  bff = await fakeBff((call) => {
    if (call.path === '/api/mcp') return { json: rpc(call, { content: [text(STARTED)] }) };
    const m = call.path.match(/^\/api\/image-generation\/(status|result)\/(req-\d)$/);
    if (m && m[1] === 'status') {
      polls[m[2]] += 1;
      // req-2 finishes first; req-1 needs a second poll.
      const done = m[2] === 'req-2' || polls[m[2]] >= 2;
      return { json: { status: done ? 'completed' : 'processing' } };
    }
    // The fake BFF serves the downloads too: the result URLs point at it.
    if (m && m[1] === 'result') return { json: { storage_urls: [`${bff.url}/u/${m[2]}.png`], design_id: m[2] === 'req-1' ? '901' : '902' } };
    if (call.path.startsWith('/u/')) return { raw: PNG.toString('latin1'), headers: { 'content-type': 'image/png' } };
    return { status: 404 };
  });
  const { code, stdout, stderr } = await runCli(['image', 'replicate', '--template', '88', '--product', 'https://cdn.example/p.png', '-o', out]);
  assert.equal(code, 0, stderr);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.request_id, 'req-1');
  assert.deepEqual(parsed.results.map((r) => r.request_id), ['req-1', 'req-2']);
  assert.equal(parsed.results[0].designId, '901');
  assert.equal(parsed.results[0].outputPath, out);
  assert.equal(parsed.results[1].outputPath, join(dir, 'ad-2.png'));
  assert.ok(polls['req-1'] >= 2);
  assert.ok(existsSync(out) && existsSync(join(dir, 'ad-2.png')));
  assert.equal(readFileSync(join(dir, 'ad-2.png')).length, PNG.length);
});
