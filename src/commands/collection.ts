/**
 * `quickdesign collection list|get|add`
 *
 * Your collections and what is in them, served by the BFF (`/api/collections`):
 * your own collections plus the ones team mates share with the team — the
 * same set the app shows. `add` files designs into one of them with the app's
 * rules (your own, team mates' and template designs).
 */
import { Command } from 'commander';
import kleur from 'kleur';
import { request, ApiError } from '../client.js';
import { emitJson, fail } from '../utils/output.js';

interface CollectionRow {
  id: string;
  name: string;
  description: string | null;
  owner: 'you' | 'team';
  shared_with_team: boolean;
  item_count: number;
  created_at: string | null;
  updated_at: string | null;
}

interface CollectionItemRow {
  item_id: string;
  source: 'design' | 'spy_ad';
  design_id: number | null;
  type: 'image' | 'video';
  title: string | null;
  image_url: string | null;
  thumbnail_url: string | null;
  video_url: string | null;
  added_at: string | null;
}

interface AddResult {
  collection_id: string;
  added: number[];
  already_in_collection: number[];
  /** Unknown designs and designs you may not add look the same. */
  not_found: number[];
}

interface Envelope<T> { success: boolean; data: T }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The BFF's cap (same as the MCP tool quickdesign_collection_add). */
const MAX_ADD = 50;

/** A collection id, or the exact name (any case) of one collection you can see. */
async function resolveCollection(ref: string): Promise<string> {
  if (UUID.test(ref)) return ref;
  const wanted = ref.trim().toLowerCase();
  const matches: CollectionRow[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = (await request<Envelope<{ total: number; collections: CollectionRow[] }>>('/api/collections', {
      query: { limit: 100, offset },
    })).data;
    matches.push(...page.collections.filter((c) => c.name.trim().toLowerCase() === wanted));
    if (page.collections.length === 0 || offset + page.collections.length >= page.total) break;
  }
  if (matches.length === 0) fail(`No collection named "${ref}" — see \`quickdesign collection list\``, 2);
  if (matches.length > 1) {
    fail(`${matches.length} collections are named "${ref}"; pass the id instead: ${matches.map((c) => c.id).join(', ')}`, 2);
  }
  return matches[0]!.id;
}

function parseDesignIds(args: string[]): number[] {
  const ids = args.map((a) => {
    const n = /^\d+$/.test(a) ? Number(a) : NaN;
    if (!Number.isSafeInteger(n) || n <= 0) fail(`Design id must be a positive whole number, got "${a}"`, 2);
    return n;
  });
  if (ids.length > MAX_ADD) fail(`At most ${MAX_ADD} design ids per call, got ${ids.length}`, 2);
  return ids;
}

function pageFooter(shown: number, offset: number, total: number, noun: string): void {
  const from = offset + 1;
  const range = shown ? ` (${from}–${from + shown - 1} of ${total})` : '';
  const more = offset + shown < total ? ` · next page: --offset ${offset + shown}` : '';
  process.stdout.write(kleur.dim(`\n${shown} ${noun}${range}${more}\n`));
}

export function registerCollectionCommands(program: Command): void {
  const collection = program
    .command('collection')
    .description('Browse your collections (yours + shared by your team) and what is in them');

  collection
    .command('list')
    .description('List your collections, most recently updated first')
    .option('--limit <n>', 'Limit (1-100)', (v) => parseInt(v, 10), 50)
    .option('--offset <n>', 'Offset', (v) => parseInt(v, 10), 0)
    .option('--human', 'Pretty-print')
    .action(async (opts: { limit?: number; offset?: number; human?: boolean }) => {
      try {
        const offset = opts.offset ?? 0;
        const res = await request<Envelope<{ total: number; collections: CollectionRow[] }>>('/api/collections', {
          query: { limit: opts.limit ?? 50, offset },
        });
        if (!opts.human) {
          emitJson(res.data);
          return;
        }
        for (const c of res.data.collections) {
          const tags = [c.owner === 'team' ? 'team' : null, c.shared_with_team && c.owner === 'you' ? 'shared' : null]
            .filter(Boolean)
            .join(' ');
          process.stdout.write(
            `${kleur.bold(c.id)}  ${c.name.slice(0, 40).padEnd(40)}  ${`${c.item_count} items`.padEnd(10)}  ${kleur.dim(tags)}\n`,
          );
        }
        pageFooter(res.data.collections.length, offset, res.data.total, 'collection(s)');
      } catch (err) { fail(err); }
    });

  collection
    .command('get')
    .description('Show one collection and its items (designs and saved spy ads), newest added first')
    .argument('<id>', 'Collection id (from `collection list`)')
    .option('--limit <n>', 'Items per page (1-100)', (v) => parseInt(v, 10), 50)
    .option('--offset <n>', 'Item offset', (v) => parseInt(v, 10), 0)
    .option('--human', 'Pretty-print')
    .action(async (id: string, opts: { limit?: number; offset?: number; human?: boolean }) => {
      try {
        if (!UUID.test(id)) fail(`Collection id must be a UUID, got "${id}" — see \`quickdesign collection list\``, 2);
        const offset = opts.offset ?? 0;
        let data: { collection: CollectionRow; total: number; items: CollectionItemRow[] };
        try {
          data = (await request<Envelope<typeof data>>(`/api/collections/${id}`, {
            query: { limit: opts.limit ?? 50, offset },
          })).data;
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) fail(`No collection with id ${id}`, 2);
          throw err;
        }
        if (!opts.human) {
          emitJson(data);
          return;
        }
        const c = data.collection;
        process.stdout.write(`${kleur.bold(c.name)}  ${kleur.dim(`${c.item_count} items${c.owner === 'team' ? ' · team' : ''}`)}\n`);
        if (c.description) process.stdout.write(`${kleur.dim(c.description)}\n`);
        process.stdout.write('\n');
        for (const it of data.items) {
          const ref = it.design_id != null ? String(it.design_id) : 'spy ad';
          process.stdout.write(`${kleur.bold(ref.padEnd(8))}  ${it.type.padEnd(5)}  ${(it.title ?? '(untitled)').slice(0, 48)}\n`);
          process.stdout.write(`          ${kleur.dim(it.video_url ?? it.image_url ?? it.thumbnail_url ?? '')}\n`);
        }
        pageFooter(data.items.length, offset, data.total, 'item(s)');
      } catch (err) { fail(err); }
    });
  collection
    .command('add')
    .description('Add designs to a collection (yours, or one a team mate shares). Spends no credits')
    .argument('<collection>', 'Collection id, or its exact name (from `collection list`)')
    .argument('<design-ids...>', `Design ids (from \`design list\`, \`collection get\` or a job's result_design_id), up to ${MAX_ADD}`)
    .option('--human', 'Pretty-print')
    .action(async (ref: string, designArgs: string[], opts: { human?: boolean }) => {
      try {
        const designIds = parseDesignIds(designArgs);
        const id = await resolveCollection(ref);
        let data: AddResult;
        try {
          data = (await request<Envelope<AddResult>>(`/api/collections/${id}/items`, {
            method: 'POST',
            body: { design_ids: designIds },
          })).data;
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) {
            if ((err.body as { code?: string } | null)?.code === 'COLLECTION_NOT_FOUND') fail(`No collection with id ${id}`, 2);
            // A BFF from before this command has no POST /api/collections/:id/items.
            fail('This QuickDesign server does not support `collection add` yet; it needs a newer BFF.');
          }
          throw err;
        }
        if (data.not_found.length > 0) {
          process.stderr.write(kleur.yellow(`not found or not yours to add: ${data.not_found.join(', ')}\n`));
        }
        if (!opts.human) {
          emitJson(data);
          return;
        }
        const line = (label: string, ids: number[]) =>
          process.stdout.write(`${label} ${ids.length}${ids.length ? `: ${ids.join(', ')}` : ''}\n`);
        line(kleur.green('Added'), data.added);
        line('Already there', data.already_in_collection);
        line(data.not_found.length ? kleur.yellow('Not found') : 'Not found', data.not_found);
      } catch (err) { fail(err); }
    });
}
