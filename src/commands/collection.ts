/**
 * `quickdesign collection list|get`
 *
 * Your collections and what is in them, served by the BFF (`/api/collections`):
 * your own collections plus the ones team mates share with the team — the
 * same set the app shows.
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

interface Envelope<T> { success: boolean; data: T }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
}
