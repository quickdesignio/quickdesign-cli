/**
 * `quickdesign design list|get|delete|download`
 *
 * Hits Supabase PostgREST directly (not the BFF). `designs` has RLS keyed on
 * `createdBy = auth.uid()`, so using the user's JWT is safe and matches the
 * frontend's own pattern — see
 * `src/components/AssetSelectionModal/utils/supabaseQuery.ts` in the SPA repo.
 *
 * Requires `QUICKDESIGN_SUPABASE_ANON_KEY` (env) or `supabaseAnonKey` in the
 * CLI config. Get the anon key from the SPA env (REACT_APP_SUPABASE_ANON_KEY)
 * or the Supabase dashboard → Project Settings → API.
 */
import { Command } from 'commander';
import { readConfig } from '../config.js';
import { requestSupabase } from '../client.js';
import { emitJson, fail, note } from '../utils/output.js';
import { downloadTo } from '../utils/download.js';

interface DesignRow {
  id: number;
  createdBy: string;
  image?: string | null;
  video_url?: string | null;
  thumbnail_url?: string | null;
  date?: string;
  category?: string | null;
  subjectLine?: string | null;
  isApproved?: boolean;
  isArchived?: boolean;
  is_asset?: boolean;
  file_name?: string | null;
  file_type?: string | null;
  width?: number | null;
  height?: number | null;
  brand_kit_id?: string | null;
  project_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

function resolveUserId(): string {
  const uid = readConfig().userId;
  if (!uid) {
    fail('No userId in config. Run `quickdesign login` first.', 2);
  }
  return uid!;
}

export function registerDesignCommands(program: Command): void {
  const design = program.command('design').description('Browse / manage designs (your creatives & assets)');

  design
    .command('list')
    .description('List your designs (most recent first)')
    .option('--limit <n>', 'Limit', (v) => parseInt(v, 10), 50)
    .option('--offset <n>', 'Offset', (v) => parseInt(v, 10), 0)
    .option('--category <str>', 'Filter by category')
    .option('--archived', 'Include archived rows (default: only non-archived)', false)
    .option('--assets-only', 'Only rows with is_asset = true', false)
    .option('--select <cols>', 'Override the PostgREST select= list', 'id,image,video_url,thumbnail_url,date,category,subjectLine,isArchived,is_asset,file_name,file_type,width,height,brand_kit_id')
    .action(async (opts: {
      limit?: number;
      offset?: number;
      category?: string;
      archived?: boolean;
      assetsOnly?: boolean;
      select?: string;
    }) => {
      try {
        const userId = resolveUserId();
        const query: Record<string, string> = {
          createdBy: `eq.${userId}`,
          select: opts.select ?? '*',
          order: 'date.desc',
          limit: String(opts.limit ?? 50),
          offset: String(opts.offset ?? 0),
        };
        if (!opts.archived) query.isArchived = 'eq.false';
        if (opts.assetsOnly) query.is_asset = 'eq.true';
        if (opts.category) query.category = `eq.${opts.category}`;

        const rows = await requestSupabase<DesignRow[]>('/rest/v1/designs', { query });
        emitJson(rows);
      } catch (err) { fail(err); }
    });

  design
    .command('get')
    .description('Fetch one design by id')
    .argument('<id>', 'Design id')
    .action(async (id: string) => {
      try {
        const userId = resolveUserId();
        const rows = await requestSupabase<DesignRow[]>('/rest/v1/designs', {
          query: { id: `eq.${id}`, createdBy: `eq.${userId}`, select: '*' },
        });
        if (!rows.length) fail(`No design with id ${id}`, 2);
        emitJson(rows[0]);
      } catch (err) { fail(err); }
    });

  design
    .command('delete')
    .description('Soft-delete a design (sets isArchived = true)')
    .argument('<id>', 'Design id')
    .action(async (id: string) => {
      try {
        const userId = resolveUserId();
        await requestSupabase<unknown>('/rest/v1/designs', {
          method: 'PATCH',
          query: { id: `eq.${id}`, createdBy: `eq.${userId}` },
          headers: { Prefer: 'return=minimal' },
          body: { isArchived: true },
        });
        note(`Archived design ${id}`);
        emitJson({ id, archived: true });
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
        const userId = resolveUserId();
        const rows = await requestSupabase<DesignRow[]>('/rest/v1/designs', {
          query: {
            id: `eq.${id}`,
            createdBy: `eq.${userId}`,
            select: 'id,image,video_url,thumbnail_url,file_type',
          },
        });
        if (!rows.length) fail(`No design with id ${id}`, 2);
        const row = rows[0]!;
        const url = row.video_url ?? row.image ?? row.thumbnail_url;
        if (!url) fail(`Design ${id} has no image or video URL`, 2);
        await downloadTo(url!, opts.output!);
        note(`Saved ${opts.output}`);
        emitJson({ id: row.id, url, outputPath: opts.output });
      } catch (err) { fail(err); }
    });
}
