/**
 * `quickdesign brand scrape|dna`
 *
 * - `scrape`: POST /api/brand-scraper/scrape (sync) — pulls colors, fonts,
 *   logo, description for a given URL. Result persists to `brand_kits`.
 *
 * - `dna`: POST /api/brand-dna/stream-extract (SSE) — Claude-streamed Brand
 *   DNA extraction. The BFF emits four event types — stage_update,
 *   partial_result, complete, error — and we decide what to render based on
 *   `--output` mode.
 */
import { Command } from 'commander';
import ora from 'ora';
import { request, streamSse, ApiError } from '../client.js';
import { emitJson, fail, note } from '../utils/output.js';

type BrandDnaEvent =
  | { type: 'stage_update'; stage: string }
  | { type: 'partial_result'; data: Record<string, unknown> }
  | { type: 'complete'; data: Record<string, unknown> }
  | { type: 'error'; message: string };

export function registerBrandCommands(program: Command): void {
  const brand = program.command('brand').description('Brand scraper + Claude-streamed DNA');

  brand
    .command('scrape')
    .description("Scrape a brand website's colors, fonts, logo, description")
    .argument('<url>', 'Brand website URL')
    .action(async (url: string) => {
      try {
        const r = await request<unknown>('/api/brand-scraper/scrape', {
          method: 'POST',
          body: { url },
        });
        emitJson(r);
      } catch (err) { fail(err); }
    });

  brand
    .command('dna')
    .description('Extract a full Brand DNA profile via Claude (SSE stream)')
    .argument('<url>', 'Brand website URL')
    .option('--output <mode>', 'json (default: only the final result) | events (NDJSON of every frame)', 'json')
    .action(async (url: string, opts: { output?: 'json' | 'events' }) => {
      const mode = opts.output ?? 'json';
      try {
        const spin = mode === 'json'
          ? ora({ text: 'Starting Brand DNA extraction…', stream: process.stderr }).start()
          : undefined;

        let final: Record<string, unknown> | null = null;

        try {
          for await (const frame of streamSse<BrandDnaEvent>('/api/brand-dna/stream-extract', { url })) {
            const ev = frame.data;
            if (!ev || typeof ev !== 'object' || !('type' in ev)) continue;

            if (mode === 'events') {
              process.stdout.write(`${JSON.stringify(ev)}\n`);
            }

            if (ev.type === 'stage_update') {
              if (spin) spin.text = `Brand DNA · ${ev.stage}…`;
            } else if (ev.type === 'complete') {
              final = ev.data;
              break;
            } else if (ev.type === 'error') {
              throw new Error(`Brand DNA failed: ${ev.message}`);
            }
          }
        } catch (err) {
          if (spin) spin.fail('Brand DNA extraction failed');
          throw err;
        }

        if (spin) spin.succeed('Brand DNA ready');

        if (mode === 'json') {
          if (!final) {
            fail('Stream ended before a `complete` event arrived.');
          }
          emitJson(final);
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          note('Hint: Brand DNA requires auth. Run `quickdesign login` first.');
        }
        fail(err);
      }
    });
}
