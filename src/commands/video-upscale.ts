/**
 * `quickdesign video upscale|upscale-status|upscale-wait|upscale-history`
 *
 * Video upscaling via /api/async-video-upscale/* (topaz | bytedance).
 */
import { Command } from 'commander';
import ora from 'ora';
import { request } from '../client.js';
import { emitJson, fail, note } from '../utils/output.js';
import { pollUntilDone } from '../utils/poll.js';
import { downloadTo } from '../utils/download.js';
import {
  BffStartResponse,
  BffStatusResponse,
  extractRequestId,
  extractResultUrl,
} from './video-shared.js';

export function registerVideoUpscaleCommands(video: Command): void {
  video
    .command('upscale')
    .description('Start a video upscale job')
    .requiredOption('--video <url>', 'Source video URL')
    .option('--provider <name>', 'topaz | bytedance', 'topaz')
    .option('--duration-seconds <n>', 'Source duration in seconds', (v) => parseFloat(v))
    .option('--factor <n>', 'Upscale factor (topaz: 1–4)', (v) => parseFloat(v))
    .option('--target-resolution <res>', '(bytedance) target resolution')
    .option('--target-fps <fps>', '(topaz | bytedance) target FPS')
    .option('--wait', 'Block until the job completes', false)
    .option('--timeout <ms>', 'Wait timeout in ms', (v) => parseInt(v, 10), 900_000)
    .option('-o, --output <path>', 'Save the upscaled video to this path (implies --wait)')
    .action(async (opts: {
      video: string;
      provider?: 'topaz' | 'bytedance';
      durationSeconds?: number;
      factor?: number;
      targetResolution?: string;
      targetFps?: string;
      wait?: boolean;
      timeout?: number;
      output?: string;
    }) => {
      try {
        const provider = opts.provider ?? 'topaz';
        if (!['topaz', 'bytedance'].includes(provider)) fail(`Unknown upscale provider: ${provider}`, 2);

        const shouldWait = opts.wait === true || Boolean(opts.output);

        const body: Record<string, unknown> = {
          provider,
          video_url: opts.video,
          duration_seconds: opts.durationSeconds,
          upscale_factor: opts.factor,
          target_resolution: opts.targetResolution,
          target_fps: opts.targetFps,
        };

        const start = await request<BffStartResponse>('/api/async-video-upscale/start-upscale', {
          method: 'POST',
          body,
        });
        const requestId = extractRequestId(start);
        if (!requestId) fail(`No jobId in response: ${JSON.stringify(start)}`);

        if (!shouldWait) {
          emitJson({
            request_id: requestId,
            provider,
            status: start.data?.status ?? 'queued',
            token_cost: start.data?.token_cost,
          });
          return;
        }

        const spin = ora({ text: `Waiting for upscale (${requestId})…`, stream: process.stderr }).start();
        const status = await pollUntilDone<BffStatusResponse>(async () => {
          const s = await request<BffStatusResponse>(`/api/async-video-upscale/status/${requestId}`);
          if (s.data?.status === 'failed') return { done: false, error: s.data.error ?? 'Upscale failed' };
          if (s.data?.status !== 'completed') {
            spin.text = `Waiting for upscale (${requestId})… ${s.data?.status ?? '?'}`;
            return { done: false };
          }
          return { done: true, result: s };
        }, { intervalMs: 5000, timeoutMs: opts.timeout });
        spin.succeed('Upscale ready');

        const videoUrl = extractResultUrl(status);
        if (!videoUrl) fail(`Result had no video URL: ${JSON.stringify(status)}`);

        if (opts.output) {
          await downloadTo(videoUrl!, opts.output);
          note(`Saved ${opts.output}`);
          emitJson({ request_id: requestId, url: videoUrl, outputPath: opts.output });
        } else {
          emitJson({ request_id: requestId, url: videoUrl });
        }
      } catch (err) { fail(err); }
    });

  video
    .command('upscale-status')
    .description('Check upscale job status')
    .argument('<jobId>', 'Job id')
    .action(async (jobId: string) => {
      try {
        const s = await request<BffStatusResponse>(`/api/async-video-upscale/status/${jobId}`);
        emitJson(s);
      } catch (err) { fail(err); }
    });

  video
    .command('upscale-wait')
    .description('Resume waiting on a previously-started upscale job and (optionally) save the result')
    .argument('<jobId>', 'Job id returned by `upscale`')
    .option('--timeout <ms>', 'Wait timeout in ms', (v) => parseInt(v, 10), 1_800_000)
    .option('--interval <ms>', 'Poll interval in ms', (v) => parseInt(v, 10), 5_000)
    .option('-o, --output <path>', 'Save the upscaled video to this path')
    .action(async (jobId: string, opts: { timeout?: number; interval?: number; output?: string }) => {
      try {
        const spin = ora({ text: `Waiting for upscale (${jobId})…`, stream: process.stderr }).start();
        const status = await pollUntilDone<BffStatusResponse>(async () => {
          const s = await request<BffStatusResponse>(`/api/async-video-upscale/status/${jobId}`);
          if (s.data?.status === 'failed') return { done: false, error: s.data.error ?? 'Upscale failed' };
          if (s.data?.status !== 'completed') {
            spin.text = `Waiting for upscale (${jobId})… ${s.data?.status ?? '?'}`;
            return { done: false };
          }
          return { done: true, result: s };
        }, { intervalMs: opts.interval, timeoutMs: opts.timeout });
        spin.succeed('Upscale ready');

        const videoUrl = extractResultUrl(status);
        if (!videoUrl) fail(`Result had no video URL: ${JSON.stringify(status)}`);

        if (opts.output) {
          await downloadTo(videoUrl!, opts.output);
          note(`Saved ${opts.output}`);
          emitJson({ request_id: jobId, url: videoUrl, outputPath: opts.output });
        } else {
          emitJson({ request_id: jobId, url: videoUrl });
        }
      } catch (err) { fail(err); }
    });

  video
    .command('upscale-history')
    .description('List your upscale jobs')
    .option('--limit <n>', 'Limit', (v) => parseInt(v, 10), 20)
    .option('--page <n>', 'Page', (v) => parseInt(v, 10), 1)
    .option('--provider <name>', 'Filter by provider (topaz | bytedance)')
    .action(async (opts: { limit?: number; page?: number; provider?: string }) => {
      try {
        const r = await request<unknown>('/api/async-video-upscale/history', {
          query: { limit: opts.limit, page: opts.page, provider: opts.provider },
        });
        emitJson(r);
      } catch (err) { fail(err); }
    });
}
