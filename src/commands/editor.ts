/**
 * `quickdesign editor status|tools|call|add-media|save`
 *
 * Drives the video editor the user has open in QuickDesign, live, through the
 * BFF's public MCP tools (`quickdesign_editor_*` on /api/mcp). Every command
 * needs the editor open in a browser tab, signed in as the same account.
 */
import { Command } from 'commander';
import kleur from 'kleur';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { callMcpTool, editorCallTimeoutMs, type McpContent, type McpToolResult } from '../utils/mcp.js';
import { emitJson, fail, note } from '../utils/output.js';

const NEEDS_EDITOR = 'The video editor must be open in QuickDesign (signed in as the same account).';
const NO_EDITOR_HINT =
  'No QuickDesign video editor is open. Ask the user to open the video editor in QuickDesign, then try again.';

type TextBlock = Extract<McpContent, { type: 'text' }>;
type ImageBlock = Extract<McpContent, { type: 'image' }>;

const texts = (r: McpToolResult): TextBlock[] => r.content.filter((c): c is TextBlock => c.type === 'text');
const images = (r: McpToolResult): ImageBlock[] => r.content.filter((c): c is ImageBlock => c.type === 'image');

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Run one MCP tool; a thrown error or an `isError` result ends the command (exit 1). */
async function run(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpToolResult> {
  let result: McpToolResult;
  try {
    result = await callMcpTool(name, args, { timeoutMs });
  } catch (err) {
    fail(err);
  }
  if (result.isError) failWith(result);
  return result;
}

function failWith(result: McpToolResult): never {
  const msg = texts(result).map((t) => t.text).join('\n') || 'The editor reported an error.';
  process.stderr.write(`${kleur.red('error')} ${msg}\n`);
  process.exit(1);
}

/** Remove undefined entries so they are not sent. */
function defined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

function find(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const o = value as Record<string, unknown>;
  if (o[key] !== undefined) return o[key];
  for (const v of Object.values(o)) {
    const hit = find(v, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

const fmtSec = (s: unknown): string => {
  const n = Number(s);
  if (!Number.isFinite(n)) return '?';
  const m = Math.floor(n / 60);
  return m > 0 ? `${m}m${(n - m * 60).toFixed(1)}s` : `${n.toFixed(1)}s`;
};

interface StatusTab {
  tabId: string;
  project?: { id?: string; name?: string };
  durationSec?: number;
  trackCount?: number;
  clipCount?: number;
  focusedAt?: string;
  saves?: unknown;
}

async function runStatus(opts: { json?: boolean }): Promise<void> {
  const result = await run('quickdesign_editor_status', {});
  const data = parseJson(texts(result)[0]?.text ?? '') as { open?: boolean; tabs?: StatusTab[]; hint?: string } | undefined;
  if (!data) fail('Unexpected reply from the editor status tool.');
  if (opts.json) emitJson(data);
  if (!data.open || !data.tabs?.length) {
    process.stderr.write(`${data.hint ?? NO_EDITOR_HINT}\n`);
    process.exit(1);
  }
  if (opts.json) return;
  for (const t of data.tabs) {
    const name = t.project?.name ?? '(untitled)';
    process.stdout.write(
      `${kleur.bold(t.tabId)}  ${name}  ${fmtSec(t.durationSec)}  ${t.trackCount ?? 0} tracks, ${t.clipCount ?? 0} clips` +
        `  ${kleur.dim(`focused ${t.focusedAt ?? '?'}`)}\n`,
    );
    const saves = Array.isArray(t.saves) ? t.saves : [];
    for (const s of saves as Array<Record<string, unknown>>) {
      process.stdout.write(`  ${kleur.dim(`save ${String(s.saveId ?? '')} ${String(s.status ?? '')}`)}\n`);
    }
  }
}

function firstSentence(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  const m = flat.match(/^.*?[.!?](?=\s|$)/);
  return m ? m[0] : flat;
}

async function runTools(opts: { tab?: string; json?: boolean }): Promise<void> {
  const result = await run('quickdesign_editor_tools', defined({ tabId: opts.tab }));
  const data = parseJson(texts(result)[0]?.text ?? '') as { tools?: Array<{ name: string; description?: string }> } | undefined;
  if (!data?.tools) fail('Unexpected reply from the editor tools tool.');
  if (opts.json) return emitJson(data);
  for (const t of data.tools) {
    process.stdout.write(`${kleur.bold(t.name)}  ${firstSentence(t.description ?? '')}\n`);
  }
}

/** Parse the `args` JSON object (inline, from a file, or stdin for `-`). */
function readArgs(inline: string | undefined, file: string | undefined): Record<string, unknown> {
  if (inline !== undefined && file !== undefined) fail('Give the args inline or with --args-file, not both.', 2);
  let raw = inline;
  if (file !== undefined) {
    try {
      raw = readFileSync(file === '-' ? 0 : file, 'utf8');
    } catch (err) {
      fail(`Cannot read args from ${file === '-' ? 'stdin' : file}: ${(err as Error).message}`, 2);
    }
  }
  if (raw === undefined || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('The args are not valid JSON. Pass a JSON object, e.g. \'{"clipId":"…"}\'.', 2);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('The args must be a JSON object.', 2);
  return parsed as Record<string, unknown>;
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};
const extFor = (mime: string): string => EXT[mime.toLowerCase().split(';')[0].trim()] ?? 'bin';

/** Write each image block to a file and return the absolute paths. */
function saveImages(blocks: ImageBlock[], tool: string, out: string | undefined): string[] {
  const stamp = Date.now();
  // Default files go into a fresh private dir, so a planted symlink in a shared tmpdir is never followed.
  const tmpDir = out || blocks.length === 0 ? undefined : mkdtempSync(path.join(tmpdir(), 'quickdesign-editor-'));
  return blocks.map((img, i) => {
    let target: string;
    if (out) {
      if (blocks.length === 1) target = out;
      else {
        const ext = path.extname(out);
        target = `${out.slice(0, out.length - ext.length)}-${i + 1}${ext}`;
      }
    } else {
      const safe = tool.replace(/[^\w.-]/g, '_');
      target = path.join(tmpDir!, `quickdesign-editor-${safe}-${stamp}${blocks.length > 1 ? `-${i + 1}` : ''}.${extFor(img.mimeType)}`);
    }
    const abs = path.resolve(target);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, Buffer.from(img.data, 'base64'), { flag: out ? 'w' : 'wx' });
    return abs;
  });
}

interface CallOpts {
  argsFile?: string;
  tab?: string;
  out?: string;
  json?: boolean;
}

async function runCall(tool: string, argsText: string | undefined, opts: CallOpts): Promise<void> {
  const args = readArgs(argsText, opts.argsFile);
  let result: McpToolResult;
  try {
    result = await callMcpTool('quickdesign_editor_call', defined({ tool, args, tabId: opts.tab }), {
      timeoutMs: editorCallTimeoutMs(tool),
    });
  } catch (err) {
    fail(err);
  }

  const blocks = texts(result);
  let paths: string[] = [];
  if (!result.isError) {
    try {
      paths = saveImages(images(result), tool, opts.out);
    } catch (err) {
      for (const b of blocks) process.stdout.write(`${b.text}\n`);
      fail(`The edit was applied, but the image could not be saved: ${(err as Error).message}`);
    }
  }

  if (opts.json) {
    emitJson({
      content: blocks.map((b) => parseJson(b.text) ?? b.text),
      images: paths,
      isError: result.isError,
    });
    if (result.isError) {
      process.stderr.write(`${kleur.red('error')} ${blocks.map((b) => b.text).join('\n')}\n`);
      process.exit(1);
    }
    return;
  }

  if (result.isError) failWith(result);

  if (result.content.length === 0) note('(no output)');

  // First block is the tab/project header when more than one text block came back.
  blocks.forEach((b, i) => {
    const json = parseJson(b.text);
    const isHeader = blocks.length > 1 && i === 0 && json && typeof json === 'object' && 'tabId' in (json as object);
    if (isHeader) {
      const h = json as { tabId?: string; project?: { name?: string } };
      note(`tab ${h.tabId}${h.project?.name ? `  ${h.project.name}` : ''}`);
    } else if (json !== undefined && typeof json === 'object') {
      emitJson(json);
    } else {
      process.stdout.write(`${b.text}\n`);
    }
  });
  for (const p of paths) process.stdout.write(`image saved: ${p}\n`);
}

async function runAddMedia(designId: string, opts: { tab?: string }): Promise<void> {
  if (!/^\d+$/.test(designId) || Number(designId) <= 0) fail('design-id must be a positive number.', 2);
  const result = await run('quickdesign_editor_add_media', defined({ designId: Number(designId), tabId: opts.tab }), 135_000);
  const parsed = texts(result).map((t) => parseJson(t.text));
  const mediaId = parsed.map((p) => find(p, 'mediaId')).find((v) => v !== undefined);
  if (mediaId !== undefined) process.stdout.write(`mediaId: ${String(mediaId)}\n`);
  else for (const t of texts(result)) process.stdout.write(`${t.text}\n`);
}

async function runSave(opts: { title?: string; collection?: string; tab?: string }): Promise<void> {
  if (opts.title !== undefined && opts.title.length > 200) fail('--title can be at most 200 characters.', 2);
  const result = await run(
    'quickdesign_editor_save',
    defined({ title: opts.title, collectionId: opts.collection, tabId: opts.tab }),
    20_000,
  );
  const parsed = texts(result).map((t) => parseJson(t.text));
  const saveId = parsed.map((p) => find(p, 'saveId')).find((v) => v !== undefined);
  if (saveId === undefined) {
    for (const t of texts(result)) process.stdout.write(`${t.text}\n`);
    return;
  }
  process.stdout.write(`saveId: ${String(saveId)}  (saving)\n`);
  note('Run `quickdesign editor status` to see when it is saved.');
}

export function registerEditorCommands(program: Command): void {
  const editor = program
    .command('editor')
    .description(`Edit the video open in the user's QuickDesign editor, live. ${NEEDS_EDITOR}`)
    .addHelpText('after', `\n${NEEDS_EDITOR} Start with \`editor status\`, then \`editor tools\`, then \`editor call\`.\n`);

  editor
    .command('status')
    .description(`List the open video-editor tabs (project, length, tracks, clips). ${NEEDS_EDITOR}`)
    .option('--json', 'Print the raw JSON', false)
    .action(runStatus);

  editor
    .command('tools')
    .description(`List the editing tools of an open editor tab. ${NEEDS_EDITOR}`)
    .option('--tab <id>', 'Which open editor tab (default: the most recently focused)')
    .option('--json', 'Print the full list with input schemas as JSON', false)
    .action(runTools);

  editor
    .command('call <tool> [args]')
    .description(
      `Run one editing tool in the open editor tab; [args] is a JSON object. Images (view_frames) are saved to files. ${NEEDS_EDITOR}`,
    )
    .option('--args-file <path>', 'Read the args JSON from a file ("-" = stdin)')
    .option('--tab <id>', 'Which open editor tab (default: the most recently focused)')
    .option('--out <path>', 'Where to write returned images (several get -1, -2 before the extension)')
    .option('--json', 'Print { content, images, isError } as JSON', false)
    .addHelpText('after', `\nExamples\n  $ quickdesign editor call get_editor_state\n  $ quickdesign editor call view_frames '{"count":8}' --out ./frames.jpg\n  $ quickdesign editor call cut_ranges --args-file ranges.json\n`)
    .action(runCall);

  editor
    .command('add-media <design-id>')
    .description(`Import a design's media into the editor's media bin; prints its mediaId. ${NEEDS_EDITOR}`)
    .option('--tab <id>', 'Which open editor tab (default: the most recently focused)')
    .action(runAddMedia);

  editor
    .command('save')
    .description(`Render the open project and save it to the library (returns at once). ${NEEDS_EDITOR}`)
    .option('--title <title>', 'Title of the saved design')
    .option('--collection <id>', 'Collection to save into')
    .option('--tab <id>', 'Which open editor tab (default: the most recently focused)')
    .action(runSave);
}
