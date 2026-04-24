/**
 * `quickdesign ad-creator concepts|analyze|generate|advantage-plus|status|batch-status`
 *
 * Wraps /api/smart-ad-creator/*.
 *
 * `generate` mirrors the image async pattern (start → poll status → fetch
 * result → optional download). `advantage-plus` is the fan-out variant: one
 * request kicks off up to 16 concept jobs, returns `{ batch_id, jobs[] }`,
 * and `--wait` polls the batch-status endpoint and downloads each completed
 * job's first image to `<output-dir>/<concept>.jpg`.
 */
import { Command } from 'commander';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import ora from 'ora';
import { request } from '../client.js';
import { emitJson, fail, note } from '../utils/output.js';
import { pollUntilDone } from '../utils/poll.js';
import { downloadTo } from '../utils/download.js';

interface StartResponse {
  success?: boolean;
  request_id?: string;
  requestId?: string;
  status?: string;
  token_cost?: number;
  remaining_balance?: number;
}

interface AdvantagePlusStart {
  success?: boolean;
  batch_id: string;
  jobs: Array<{ request_id: string; concept: string; status: string }>;
  failed_jobs?: Array<{ concept: string; error?: string }>;
  total_token_cost?: number;
  remaining_balance?: number;
}

interface StatusResponse {
  success?: boolean;
  status: 'queued' | 'processing' | 'completed' | 'failed' | string;
  request_id?: string;
  progress?: number;
  images?: Array<{ url?: string; imageUrl?: string; storage_url?: string }>;
  imageUrl?: string;
  designs?: unknown;
  error?: string;
}

interface ResultResponse {
  images?: Array<{ url?: string; imageUrl?: string; storage_url?: string }>;
  imageUrl?: string;
  design_id?: string;
}

interface BatchStatusResponse {
  batch_id: string;
  total: number;
  completed: number;
  failed: number;
  jobs: Array<{
    request_id: string;
    concept: string;
    status: string;
    images?: Array<{ url?: string; imageUrl?: string; storage_url?: string }>;
    imageUrl?: string;
    error?: string;
  }>;
}

function firstUrl(r: StatusResponse | ResultResponse): string | undefined {
  const img = r.images?.[0];
  return r.imageUrl ?? img?.url ?? img?.imageUrl ?? img?.storage_url;
}

export function registerAdCreatorCommands(program: Command): void {
  const ad = program.command('ad-creator').description('Smart Ad Creator — product → ad creatives');

  ad
    .command('concepts')
    .description('List available ad concepts')
    .option('--human', 'Pretty-print for a TTY', false)
    .action(async (opts: { human?: boolean }) => {
      try {
        const r = await request<{ concepts?: Array<{ key: string; label: string }> }>(
          '/api/smart-ad-creator/concepts',
          { auth: false },
        );
        if (opts.human) {
          for (const c of r.concepts ?? []) {
            process.stdout.write(`${c.key.padEnd(36)}  ${c.label}\n`);
          }
          process.stdout.write(`\n${r.concepts?.length ?? 0} concept(s)\n`);
        } else {
          emitJson(r);
        }
      } catch (err) { fail(err); }
    });

  ad
    .command('analyze')
    .description('Analyze a product URL — extract name, images, features, target audience')
    .argument('<url>', 'Product URL')
    .action(async (url: string) => {
      try {
        const r = await request<unknown>('/api/smart-ad-creator/analyze-product', {
          method: 'POST',
          body: { url },
        });
        emitJson(r);
      } catch (err) { fail(err); }
    });

  ad
    .command('generate')
    .description('Generate a single-concept ad creative')
    .requiredOption('--product-url <url>', 'Product page URL')
    .requiredOption('--concept <slug>', 'Concept slug (see `ad-creator concepts`)')
    .option('--brand-kit <id>', 'Brand kit UUID (optional)')
    .option('--business-type <type>', 'Business type (e.g. dtc, saas)')
    .option('--wait', 'Block until the job completes', false)
    .option('--timeout <ms>', 'Wait timeout in ms', (v) => parseInt(v, 10), 600_000)
    .option('-o, --output <path>', 'Save the image to this path (implies --wait)')
    .action(async (opts: {
      productUrl: string;
      concept: string;
      brandKit?: string;
      businessType?: string;
      wait?: boolean;
      timeout?: number;
      output?: string;
    }) => {
      try {
        const shouldWait = opts.wait === true || Boolean(opts.output);
        const start = await request<StartResponse>('/api/smart-ad-creator/generate-async', {
          method: 'POST',
          body: {
            productUrl: opts.productUrl,
            concept: opts.concept,
            brand_kit_id: opts.brandKit,
            businessType: opts.businessType,
          },
        });
        const requestId = start.request_id ?? start.requestId;
        if (!requestId) fail(`No request_id in start response: ${JSON.stringify(start)}`);

        if (!shouldWait) {
          emitJson({
            request_id: requestId,
            status: start.status ?? 'queued',
            token_cost: start.token_cost,
            remaining_balance: start.remaining_balance,
          });
          return;
        }

        const spin = ora({ text: `Waiting for ad creative (${requestId})…`, stream: process.stderr }).start();
        const result = await pollUntilDone<ResultResponse>(async () => {
          const s = await request<StatusResponse>(`/api/smart-ad-creator/status/${requestId}`);
          if (s.status === 'failed') return { done: false, error: s.error ?? 'Generation failed' };
          if (s.status !== 'completed') {
            spin.text = `Waiting for ad creative (${requestId})… ${s.status}${s.progress != null ? ` · ${s.progress}%` : ''}`;
            return { done: false };
          }
          const r = await request<ResultResponse>(`/api/smart-ad-creator/result/${requestId}`);
          return { done: true, result: r };
        }, { intervalMs: 3000, timeoutMs: opts.timeout });
        spin.succeed('Ad creative ready');

        const url = firstUrl(result);
        if (!url) fail(`Result had no image URL: ${JSON.stringify(result)}`);

        if (opts.output) {
          await downloadTo(url!, opts.output);
          note(`Saved ${opts.output}`);
          emitJson({ request_id: requestId, url, outputPath: opts.output, designId: result.design_id });
        } else {
          emitJson({ request_id: requestId, url, designId: result.design_id });
        }
      } catch (err) { fail(err); }
    });

  ad
    .command('advantage-plus')
    .description('Fan out 16 concepts in parallel (batch job)')
    .requiredOption('--product-url <url>', 'Product page URL')
    .option('--brand-kit <id>', 'Brand kit UUID')
    .option('--business-type <type>', 'Business type')
    .option('--wait', 'Block until all batch jobs complete', false)
    .option('--timeout <ms>', 'Wait timeout in ms', (v) => parseInt(v, 10), 900_000)
    .option('-o, --output <dir>', 'Save each completed image to <dir>/<concept>.jpg (implies --wait)')
    .action(async (opts: {
      productUrl: string;
      brandKit?: string;
      businessType?: string;
      wait?: boolean;
      timeout?: number;
      output?: string;
    }) => {
      try {
        const shouldWait = opts.wait === true || Boolean(opts.output);
        const start = await request<AdvantagePlusStart>('/api/smart-ad-creator/generate-advantage-plus', {
          method: 'POST',
          body: {
            productUrl: opts.productUrl,
            brand_kit_id: opts.brandKit,
            businessType: opts.businessType,
          },
        });

        if (!start.batch_id) fail(`No batch_id in response: ${JSON.stringify(start)}`);

        if (!shouldWait) {
          emitJson({
            batch_id: start.batch_id,
            jobs: start.jobs,
            failed_jobs: start.failed_jobs,
            total_token_cost: start.total_token_cost,
            remaining_balance: start.remaining_balance,
          });
          return;
        }

        const spin = ora({ text: `Waiting for advantage+ batch ${start.batch_id}…`, stream: process.stderr }).start();
        const final = await pollUntilDone<BatchStatusResponse>(async () => {
          const s = await request<BatchStatusResponse>(
            `/api/smart-ad-creator/advantage-plus/status/${start.batch_id}`,
          );
          const doneCount = (s.completed ?? 0) + (s.failed ?? 0);
          spin.text = `Advantage+ ${start.batch_id}: ${s.completed}/${s.total} done (${s.failed} failed)`;
          if (doneCount >= s.total) return { done: true, result: s };
          return { done: false };
        }, { intervalMs: 5000, timeoutMs: opts.timeout });

        const outDir = opts.output;
        if (outDir) {
          await mkdir(outDir, { recursive: true });
          await Promise.all(
            final.jobs
              .filter((j) => j.status === 'completed')
              .map(async (j) => {
                const url = j.imageUrl ?? j.images?.[0]?.url ?? j.images?.[0]?.imageUrl ?? j.images?.[0]?.storage_url;
                if (!url) return;
                const path = join(outDir, `${j.concept.replace(/[^a-z0-9._-]+/gi, '_')}.jpg`);
                try {
                  await downloadTo(url, path);
                } catch (err) {
                  note(`  skipped ${j.concept}: ${err instanceof Error ? err.message : String(err)}`);
                }
              }),
          );
          spin.succeed(`Advantage+ finished — saved to ${outDir}`);
        } else {
          spin.succeed(`Advantage+ finished — ${final.completed}/${final.total} completed`);
        }

        emitJson({
          batch_id: final.batch_id,
          total: final.total,
          completed: final.completed,
          failed: final.failed,
          outputDir: outDir,
          jobs: final.jobs.map((j) => ({
            concept: j.concept,
            status: j.status,
            url: j.imageUrl ?? j.images?.[0]?.url ?? j.images?.[0]?.imageUrl ?? j.images?.[0]?.storage_url,
            error: j.error,
          })),
        });
      } catch (err) { fail(err); }
    });

  ad
    .command('status')
    .description('Check a single ad-creator job status')
    .argument('<requestId>', 'Request ID')
    .action(async (requestId: string) => {
      try {
        const r = await request<StatusResponse>(`/api/smart-ad-creator/status/${requestId}`);
        emitJson(r);
      } catch (err) { fail(err); }
    });

  ad
    .command('batch-status')
    .description('Check an advantage+ batch status')
    .argument('<batchId>', 'Batch ID')
    .action(async (batchId: string) => {
      try {
        const r = await request<BatchStatusResponse>(
          `/api/smart-ad-creator/advantage-plus/status/${batchId}`,
        );
        emitJson(r);
      } catch (err) { fail(err); }
    });
}
