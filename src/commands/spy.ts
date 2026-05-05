/**
 * `quickdesign spy …`  —  read-only wrappers around /api/spy-brands/*.
 * Defaults to JSON output; `--human` prints a concise table.
 */
import { Command } from 'commander';
import kleur from 'kleur';
import { request } from '../client.js';
import { emitJson, fail } from '../utils/output.js';

interface BrandRow {
  id: string;
  name: string;
  slug?: string;
  logo_url?: string | null;
  website_url?: string;
  ad_count?: number;
  ads_last_fetched_at?: string | null;
}

interface AdRow {
  id: string;
  page_name?: string;
  ad_creative_bodies?: string[];
  ad_creative_link_titles?: string[];
  ad_creative_link_captions?: string[];
  ad_delivery_start_time?: string;
  ad_delivery_stop_time?: string;
  creative_preview?: { creative_url?: string; type?: string; landing_url?: string };
  call_to_action?: { type?: string };
  impressions_text?: string;
}

export function registerSpyCommands(program: Command): void {
  const spy = program.command('spy').description('Spy Brands — browse competitor ads');

  spy
    .command('brands')
    .description('List or search brands')
    .option('--search <q>', 'Text search across brand name/slug/description')
    .option('--limit <n>', 'Limit', (v) => parseInt(v, 10), 50)
    .option('--human', 'Pretty-print')
    .action(async (opts: { search?: string; limit?: number; human?: boolean }) => {
      try {
        const res = await request<{ data: BrandRow[] }>('/api/spy-brands/brands', {
          query: { search: opts.search, limit: opts.limit },
          auth: false,
        });
        const rows = (res.data ?? []).slice(0, opts.limit);
        if (opts.human) {
          rows.forEach((b) => process.stdout.write(
            `${kleur.bold(b.name.padEnd(32))}  ${kleur.dim(b.id)}  ads=${b.ad_count ?? '?'}  ${b.website_url ?? ''}\n`,
          ));
          process.stdout.write(kleur.dim(`\n${rows.length} brand(s)\n`));
        } else {
          emitJson(rows);
        }
      } catch (err) { fail(err); }
    });

  spy
    .command('brand')
    .description('Fetch a single brand by id')
    .argument('<brandId>', 'Brand UUID')
    .action(async (brandId: string) => {
      try {
        const res = await request<{ data: BrandRow }>(`/api/spy-brands/brand/${encodeURIComponent(brandId)}`, { auth: false });
        emitJson(res.data ?? res);
      } catch (err) { fail(err); }
    });

  spy
    .command('brand-ads')
    .description("List a brand's ads")
    .argument('<brandId>', 'Brand UUID')
    .option('--status <s>', 'active | inactive | all', 'active')
    .option('--sort <s>', 'newest | oldest | most_impressions', 'newest')
    .option('--limit <n>', 'Limit per page', (v) => parseInt(v, 10), 24)
    .option('--offset <n>', 'Offset', (v) => parseInt(v, 10), 0)
    .option('--human', 'Pretty-print')
    .action(async (
      brandId: string,
      opts: { status?: string; sort?: string; limit?: number; offset?: number; human?: boolean },
    ) => {
      try {
        const res = await request<{ data: AdRow[]; totalCount?: number; mediaMix?: unknown }>(
          `/api/spy-brands/brand/${encodeURIComponent(brandId)}/ads`,
          {
            auth: false,
            query: {
              status: opts.status,
              sort: opts.sort,
              limit: opts.limit,
              offset: opts.offset,
            },
          },
        );
        const rows = res.data ?? [];
        if (opts.human) {
          process.stdout.write(kleur.dim(`Total ${res.totalCount ?? rows.length}, showing ${rows.length}\n\n`));
          rows.forEach((a) => process.stdout.write(
            `${kleur.bold(a.id)}  ${a.creative_preview?.type ?? '-'}\n` +
            `  ${(a.ad_creative_link_titles?.[0] ?? '').slice(0, 80)}\n` +
            `  ${kleur.dim((a.ad_creative_bodies?.[0] ?? '').slice(0, 110))}\n` +
            `  ${kleur.cyan(a.creative_preview?.creative_url ?? '')}\n\n`,
          ));
        } else {
          emitJson({ totalCount: res.totalCount, data: rows });
        }
      } catch (err) { fail(err); }
    });

  spy
    .command('best-ads')
    .description('Top ads across all brands (impression-ranked when available)')
    .option('--limit <n>', 'Limit', (v) => parseInt(v, 10), 50)
    .option('--offset <n>', 'Offset', (v) => parseInt(v, 10), 0)
    .option('--category-id <id>', 'Filter by category id')
    .option('--status <s>', 'active | inactive', 'active')
    .action(async (opts: { limit?: number; offset?: number; categoryId?: string; status?: string }) => {
      try {
        const res = await request<{ data: AdRow[] }>('/api/spy-brands/best-ads', {
          auth: false,
          query: {
            limit: opts.limit,
            offset: opts.offset,
            category_ids: opts.categoryId,
            status: opts.status,
          },
        });
        emitJson(res.data ?? []);
      } catch (err) { fail(err); }
    });

  spy
    .command('search')
    .description('Search brands by name (same as `spy brands --search`)')
    .argument('<query>', 'Query string')
    .option('--limit <n>', 'Limit', (v) => parseInt(v, 10), 20)
    .action(async (query: string, opts: { limit?: number }) => {
      try {
        const res = await request<{ data: BrandRow[] }>('/api/spy-brands/brands', {
          auth: false,
          query: { search: query, limit: opts.limit },
        });
        emitJson(res.data ?? []);
      } catch (err) { fail(err); }
    });

  spy
    .command('for-you')
    .description('Personalized ads feed (requires login)')
    .option('--limit <n>', 'Limit', (v) => parseInt(v, 10), 20)
    .option('--offset <n>', 'Offset', (v) => parseInt(v, 10), 0)
    .action(async (opts: { limit?: number; offset?: number }) => {
      try {
        const res = await request<{ data: AdRow[] }>('/api/spy-brands/for-you', {
          query: { limit: opts.limit, offset: opts.offset },
        });
        emitJson(res.data ?? []);
      } catch (err) { fail(err); }
    });

  spy
    .command('trending')
    .description('Trending ads feed')
    .option('--limit <n>', 'Limit', (v) => parseInt(v, 10), 20)
    .option('--offset <n>', 'Offset', (v) => parseInt(v, 10), 0)
    .action(async (opts: { limit?: number; offset?: number }) => {
      try {
        const res = await request<{ data: AdRow[] }>('/api/spy-brands/trending', {
          query: { limit: opts.limit, offset: opts.offset },
        });
        emitJson(res.data ?? []);
      } catch (err) { fail(err); }
    });

  spy
    .command('add')
    .description(
      'Register a brand into the Spy Brands library by Facebook page URL or ID. ' +
      'BFF resolves the page, dedup-checks, LLM-suggests a category, generates a ' +
      'slug, inserts the row, and triggers an initial Meta Ad Library scrape (~10s).',
    )
    .argument(
      '<facebook-input>',
      'Facebook page URL (e.g. https://facebook.com/myflufie), Ad Library URL with view_all_page_id, or numeric page ID',
    )
    .option('--category <slug-or-uuid>', 'Override the LLM-suggested category. Pass a category UUID or label.')
    .option('--human', 'Pretty-print the result instead of raw JSON')
    .action(async (
      facebookInput: string,
      opts: { category?: string; human?: boolean },
    ) => {
      try {
        process.stderr.write(
          'Registering brand and fetching first ads (~10s — Meta Ad Library scrape blocks the response)…\n',
        );
        const res = await request<{
          success: boolean;
          data: BrandRow & { ad_count?: number };
          suggestedCategory?: string | null;
        }>('/api/spy-brands/admin/add-brand', {
          method: 'POST',
          body: { facebook_input: facebookInput, category_id: opts.category },
        });
        if (opts.human) {
          const b = res.data;
          const lines = [
            `${kleur.bold(b.name)}  ${kleur.dim(b.id)}`,
            `  slug      : ${b.slug}`,
            `  ad_count  : ${b.ad_count ?? 0}`,
            `  website   : ${b.website_url || '(none)'}`,
            res.suggestedCategory ? `  category  : ${res.suggestedCategory} (LLM-suggested)` : null,
            '',
            `Next step: ${kleur.cyan(`quickdesign spy brand-ads ${b.id} --status active --human`)}`,
            '',
          ].filter(Boolean) as string[];
          process.stdout.write(lines.join('\n'));
        } else {
          emitJson(res);
        }
      } catch (err) {
        // The BFF returns 409 when the brand is already indexed and includes
        // the existing brandId in the body — surface it so the caller can
        // short-circuit to `spy brand-ads <existingId>` without re-asking.
        const statusCode = (err as { status?: number })?.status;
        const body = (err as { body?: unknown })?.body as
          | { error?: string; brandId?: string }
          | undefined;
        if (statusCode === 409 && body?.brandId) {
          process.stderr.write(
            `Brand already exists (id=${body.brandId}). ` +
              `Run \`quickdesign spy brand-ads ${body.brandId}\` to see its ads.\n`,
          );
          emitJson({ success: false, alreadyExists: true, brandId: body.brandId, error: body.error });
          process.exit(0);
        }
        fail(err);
      }
    });
}
