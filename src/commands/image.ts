/**
 * `quickdesign image generate|status|result|history|models`
 *
 * `generate --wait` drives the full async flow:
 *   POST /api/image-generation/generate-async  →  request_id
 *   GET  /api/image-generation/status/:id      →  poll until completed
 *   GET  /api/image-generation/result/:id      →  fetch hosted URL(s)
 *   (optional) downloadTo(url, outPath)        →  save image bytes
 */
import { Command } from 'commander';
import ora from 'ora';
import { request } from '../client.js';
import { emitJson, fail, note } from '../utils/output.js';
import { pollUntilDone } from '../utils/poll.js';
import { downloadTo } from '../utils/download.js';

interface StartResponse {
  request_id?: string;
  requestId?: string;
  status?: string;
  message?: string;
}

interface StatusResponse {
  status: 'queued' | 'processing' | 'completed' | 'failed' | string;
  progress?: number;
  error?: string;
}

interface ResultResponse {
  images?: Array<{ url?: string; imageUrl?: string }>;
  imageUrl?: string;
  generation_time?: number;
  design_id?: string;
}

export function registerImageCommands(program: Command): void {
  const image = program.command('image').description('AI image generation');

  image
    .command('generate')
    .description('Start an image generation job')
    .requiredOption('-p, --prompt <text>', 'Prompt')
    .option('-m, --model <slug>', 'Model slug (e.g. nano-banana-2, gpt-image-1)', 'nano-banana-2')
    .option('--size <size>', 'Size (e.g. 1024x1024)', '1024x1024')
    .option('--num <n>', 'Number of images', (v) => parseInt(v, 10), 1)
    .option('--image <path-or-url>', 'Optional source image URL (for image-to-image models)')
    .option('--wait', 'Block until the job completes and return result URL(s)', false)
    .option('--timeout <ms>', 'Wait timeout in ms', (v) => parseInt(v, 10), 300_000)
    .option('-o, --output <path>', 'Save the first image to this path (implies --wait)')
    .action(async (opts: {
      prompt: string;
      model?: string;
      size?: string;
      num?: number;
      image?: string;
      wait?: boolean;
      timeout?: number;
      output?: string;
    }) => {
      try {
        const shouldWait = opts.wait === true || Boolean(opts.output);
        const start = await request<StartResponse>('/api/image-generation/generate-async', {
          method: 'POST',
          body: {
            prompt: opts.prompt,
            model: opts.model,
            size: opts.size,
            num_images: opts.num,
            image_url: opts.image?.startsWith('http') ? opts.image : undefined,
          },
        });
        const requestId = start.request_id ?? start.requestId;
        if (!requestId) fail(`No request_id in start response: ${JSON.stringify(start)}`);

        if (!shouldWait) {
          emitJson({ request_id: requestId, status: start.status ?? 'queued' });
          return;
        }

        const spin = ora({ text: `Waiting for image (${requestId})…`, stream: process.stderr }).start();
        const result = await pollUntilDone<ResultResponse>(async () => {
          const s = await request<StatusResponse>(`/api/image-generation/status/${requestId}`, { auth: false });
          if (s.status === 'failed') return { done: false, error: s.error ?? 'Generation failed' };
          if (s.status !== 'completed') return { done: false };
          const r = await request<ResultResponse>(`/api/image-generation/result/${requestId}`, { auth: false });
          return { done: true, result: r };
        }, { intervalMs: 2000, timeoutMs: opts.timeout });
        spin.succeed('Image ready');

        const url = result.imageUrl ?? result.images?.[0]?.url ?? result.images?.[0]?.imageUrl;
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

  image
    .command('status')
    .description('Check status of an image generation job')
    .argument('<requestId>', 'Request ID returned by `generate`')
    .action(async (requestId: string) => {
      try {
        const s = await request<StatusResponse>(`/api/image-generation/status/${requestId}`, { auth: false });
        emitJson(s);
      } catch (err) { fail(err); }
    });

  image
    .command('result')
    .description('Fetch result of a completed image job')
    .argument('<requestId>', 'Request ID')
    .option('-o, --output <path>', 'Save the image to this path')
    .action(async (requestId: string, opts: { output?: string }) => {
      try {
        const r = await request<ResultResponse>(`/api/image-generation/result/${requestId}`, { auth: false });
        const url = r.imageUrl ?? r.images?.[0]?.url ?? r.images?.[0]?.imageUrl;
        if (opts.output && url) {
          await downloadTo(url, opts.output);
          note(`Saved ${opts.output}`);
        }
        emitJson({ ...r, url, outputPath: opts.output });
      } catch (err) { fail(err); }
    });

  image
    .command('wait')
    .description('Resume waiting on a previously-started image job and (optionally) save the result')
    .argument('<requestId>', 'Request ID returned by `generate`')
    .option('--timeout <ms>', 'Wait timeout in ms', (v) => parseInt(v, 10), 600_000)
    .option('--interval <ms>', 'Poll interval in ms', (v) => parseInt(v, 10), 2_000)
    .option('-o, --output <path>', 'Save the first image to this path')
    .action(async (requestId: string, opts: { timeout?: number; interval?: number; output?: string }) => {
      try {
        const spin = ora({ text: `Waiting for image (${requestId})…`, stream: process.stderr }).start();
        const result = await pollUntilDone<ResultResponse>(async () => {
          const s = await request<StatusResponse>(`/api/image-generation/status/${requestId}`, { auth: false });
          if (s.status === 'failed') return { done: false, error: s.error ?? 'Generation failed' };
          if (s.status !== 'completed') {
            spin.text = `Waiting for image (${requestId})… ${s.status}${s.progress != null ? ` · ${s.progress}%` : ''}`;
            return { done: false };
          }
          const r = await request<ResultResponse>(`/api/image-generation/result/${requestId}`, { auth: false });
          return { done: true, result: r };
        }, { intervalMs: opts.interval, timeoutMs: opts.timeout });
        spin.succeed('Image ready');

        const url = result.imageUrl ?? result.images?.[0]?.url ?? result.images?.[0]?.imageUrl;
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

  image
    .command('history')
    .description("List your image generation jobs")
    .option('--limit <n>', 'Limit', (v) => parseInt(v, 10), 20)
    .option('--offset <n>', 'Offset', (v) => parseInt(v, 10), 0)
    .action(async (opts: { limit?: number; offset?: number }) => {
      try {
        const r = await request<unknown>('/api/image-generation/history', {
          query: { limit: opts.limit, offset: opts.offset },
        });
        emitJson(r);
      } catch (err) { fail(err); }
    });

  image
    .command('models')
    .description('List available image models')
    .action(async () => {
      try {
        const r = await request<unknown>('/api/models', { query: { category: 'image' }, auth: false });
        emitJson(r);
      } catch (err) { fail(err); }
    });
}
