/**
 * `quickdesign design list|get|delete|download`
 *
 * Your own designs, served by the BFF (`/api/designs`) — the same rows and
 * columns CLI ≤ 0.16 read from Supabase PostgREST with a Supabase session,
 * which the CLI's own OAuth session cannot do.
 */
import { Command } from 'commander';
import { request, ApiError } from '../client.js';
import { emitJson, fail, note } from '../utils/output.js';
import { downloadTo } from '../utils/download.js';

type DesignRow = Record<string, unknown> & {
  id: number;
  image?: string | null;
  video_url?: string | null;
  thumbnail_url?: string | null;
};

interface Envelope<T> { success: boolean; data: T }

/** `--select a,b` keeps only those columns (the server returns a fixed set). */
function project(rows: DesignRow[], select?: string): Array<Record<string, unknown>> {
  const cols = (select ?? '').split(',').map((c) => c.trim()).filter(Boolean);
  if (cols.length === 0) return rows;
  return rows.map((row) => Object.fromEntries(cols.filter((c) => c in row).map((c) => [c, row[c]])));
}

function designId(raw: string): number {
  if (!/^\d+$/.test(raw)) fail(`Design id must be a number, got "${raw}"`, 2);
  return Number(raw);
}

/** 404 → exit 2 with a plain message; anything else propagates. */
async function onDesign<T>(id: number, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) fail(`No design with id ${id}`, 2);
    throw err;
  }
}

const getDesign = (id: number): Promise<DesignRow> =>
  onDesign(id, async () => (await request<Envelope<DesignRow>>(`/api/designs/${id}`)).data);

export function registerDesignCommands(program: Command): void {
  const design = program.command('design').description('Browse / manage designs (your creatives & assets)');

  design
    .command('list')
    .description('List your designs (most recent first)')
    .option('--limit <n>', 'Limit (1-200)', (v) => parseInt(v, 10), 50)
    .option('--offset <n>', 'Offset', (v) => parseInt(v, 10), 0)
    .option('--category <id>', 'Filter by category id (numeric)')
    .option('--archived', 'Include archived rows (default: only non-archived)', false)
    .option('--assets-only', 'Only rows with is_asset = true', false)
    .option('--select <cols>', 'Comma-separated columns to keep in the output')
    .action(async (opts: {
      limit?: number;
      offset?: number;
      category?: string;
      archived?: boolean;
      assetsOnly?: boolean;
      select?: string;
    }) => {
      try {
        const res = await request<Envelope<DesignRow[]>>('/api/designs', {
          query: {
            limit: opts.limit ?? 50,
            offset: opts.offset ?? 0,
            category: opts.category,
            include_archived: opts.archived ? 'true' : undefined,
            assets_only: opts.assetsOnly ? 'true' : undefined,
          },
        });
        emitJson(project(res.data, opts.select));
      } catch (err) { fail(err); }
    });

  design
    .command('get')
    .description('Fetch one design by id')
    .argument('<id>', 'Design id')
    .action(async (id: string) => {
      try {
        emitJson(await getDesign(designId(id)));
      } catch (err) { fail(err); }
    });

  design
    .command('delete')
    .description('Soft-delete a design (sets isArchived = true)')
    .argument('<id>', 'Design id')
    .action(async (id: string) => {
      try {
        const n = designId(id);
        await onDesign(n, () => request<unknown>(`/api/designs/${n}`, { method: 'DELETE' }));
        note(`Archived design ${n}`);
        emitJson({ id: n, archived: true });
      } catch (err) { fail(err); }
    });

  design
    .command('download')
    .description("Download a design's image or video to disk")
    .argument('<id>', 'Design id')
    .option('-o, --output <path>', 'Destination path (required)')
    .action(async (id: string, opts: { output?: string }) => {
      try {
        if (!opts.output) fail('--output <path> is required', 2);
        const row = await getDesign(designId(id));
        const url = row.video_url ?? row.image ?? row.thumbnail_url;
        if (!url) fail(`Design ${id} has no image or video URL`, 2);
        await downloadTo(url!, opts.output!);
        note(`Saved ${opts.output}`);
        emitJson({ id: row.id, url, outputPath: opts.output });
      } catch (err) { fail(err); }
    });
}
