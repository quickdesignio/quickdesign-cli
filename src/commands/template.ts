/**
 * `quickdesign template list|filters`
 *
 * The template library — the same approved set as app.quickdesign.io/templates,
 * never other users' generations. Wraps /api/templates (session auth; same
 * shape as the public /api/v1/templates). Category and tag filters accept an
 * id or a name (`--tag Trending`); `template filters` lists both.
 *
 * A template's `image_url` works as a `--reference-image` for
 * `image generate` when the user wants "this layout / style for my product".
 */
import { Command } from 'commander';
import kleur from 'kleur';
import { request } from '../client.js';
import { emitJson, fail } from '../utils/output.js';

interface Named {
  id: number;
  name: string;
}

interface TemplateRow {
  id: number;
  title: string | null;
  type: 'image' | 'video';
  image_url: string | null;
  thumbnail_url: string | null;
  video_url: string | null;
  width: number | null;
  height: number | null;
  category: Named | null;
  tags: Named[];
  brand: string | null;
  created_at: string | null;
}

interface ListResponse<T> {
  data: T[];
  has_more: boolean;
  next_offset: number | null;
  total?: number;
}

const strip = <T extends { object?: string }>(row: T): Omit<T, 'object'> => {
  const { object: _object, ...rest } = row;
  return rest;
};

export function registerTemplateCommands(program: Command): void {
  const template = program.command('template').description('Browse the template library (app.quickdesign.io/templates)');

  template
    .command('list')
    .description('List templates, newest first')
    .option('--category <idOrName>', 'Category id or name (see `template filters`)')
    .option('--tag <idOrName>', 'Tag id or name, e.g. Trending (see `template filters`)')
    .option('-q, --query <text>', 'Match on the template title (2+ characters)')
    .option('--limit <n>', 'Limit (1-100)', (v) => parseInt(v, 10), 24)
    .option('--offset <n>', 'Offset', (v) => parseInt(v, 10), 0)
    .option('--human', 'Pretty-print')
    .action(async (opts: {
      category?: string;
      tag?: string;
      query?: string;
      limit?: number;
      offset?: number;
      human?: boolean;
    }) => {
      try {
        const res = await request<ListResponse<TemplateRow & { object?: string }>>('/api/templates', {
          query: { category: opts.category, tag: opts.tag, q: opts.query, limit: opts.limit, offset: opts.offset },
        });
        const rows = res.data.map(strip);
        if (!opts.human) {
          emitJson({ total: res.total, has_more: res.has_more, next_offset: res.next_offset, templates: rows });
          return;
        }
        for (const t of rows) {
          const meta = [t.type, t.category?.name, t.tags.map((g) => `#${g.name}`).join(' ')].filter(Boolean).join('  ');
          process.stdout.write(
            `${kleur.bold(String(t.id).padEnd(8))}  ${(t.title ?? '(untitled)').slice(0, 48).padEnd(48)}  ${kleur.dim(meta)}\n`,
          );
          process.stdout.write(`          ${kleur.dim(t.video_url ?? t.image_url ?? '')}\n`);
        }
        const from = (opts.offset ?? 0) + 1;
        const range = rows.length ? ` (${from}–${from + rows.length - 1} of ${res.total ?? '?'})` : '';
        process.stdout.write(kleur.dim(`\n${rows.length} template(s)${range}`));
        process.stdout.write(kleur.dim(res.has_more ? ` · next page: --offset ${res.next_offset}\n` : '\n'));
      } catch (err) { fail(err); }
    });

  template
    .command('filters')
    .description('List template categories and tags (use their name or id with `template list`)')
    .option('--human', 'Pretty-print')
    .action(async (opts: { human?: boolean }) => {
      try {
        const [categories, tags] = await Promise.all([
          request<ListResponse<Named & { object?: string }>>('/api/templates/categories'),
          request<ListResponse<Named & { object?: string }>>('/api/templates/tags'),
        ]);
        const out = { categories: categories.data.map(strip), tags: tags.data.map(strip) };
        if (!opts.human) {
          emitJson(out);
          return;
        }
        process.stdout.write(kleur.bold('Categories\n'));
        out.categories.forEach((c) => process.stdout.write(`  ${String(c.id).padEnd(6)}  ${c.name}\n`));
        process.stdout.write(kleur.bold('\nTags\n'));
        out.tags.forEach((t) => process.stdout.write(`  ${String(t.id).padEnd(6)}  ${t.name}\n`));
      } catch (err) { fail(err); }
    });
}
