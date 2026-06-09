/**
 * `quickdesign video generate|status|wait|history|models`
 *
 * Wraps four BFF provider families:
 *   sora2    → /api/async-sora2-video/*
 *   kling    → /api/async-kling-video/*
 *   seedance → /api/async-seedance-video/*   (also exposes Seedance 2.0 r2v)
 *   ugc      → /api/async-ugc-video/*
 *
 * Subtitle subcommands live in video-subtitle.ts, upscale in video-upscale.ts;
 * shared response shapes/extractors in video-shared.ts.
 *
 * Unlike image generation, video endpoints don't expose a separate `/result/:id`
 * route — the result URLs are embedded in the status response. So our poll loop
 * looks for `status === 'completed'` on the status call and pulls the URL from
 * there.
 */
import { Command } from 'commander';
import ora from 'ora';
import { request } from '../client.js';
import { emitJson, fail, note } from '../utils/output.js';
import { pollUntilDone } from '../utils/poll.js';
import { downloadTo } from '../utils/download.js';
import { ensureRemoteUrl, looksLikeLocalPath } from '../utils/upload.js';
import {
  BffStartResponse,
  BffStatusResponse,
  extractFailureMessage,
  extractRequestId,
  extractResultUrl,
} from './video-shared.js';
import { registerVideoSubtitleCommands } from './video-subtitle.js';
import { registerVideoUpscaleCommands } from './video-upscale.js';

type Provider = 'sora2' | 'kling' | 'seedance' | 'ugc';
const PROVIDERS: readonly Provider[] = ['sora2', 'kling', 'seedance', 'ugc'];

function providerRoutes(provider: Provider): {
  i2v?: string; t2v?: string; start?: string; status: string; history: string;
} {
  switch (provider) {
    case 'sora2':
      return {
        i2v: '/api/async-sora2-video/start-image-to-video',
        t2v: '/api/async-sora2-video/start-text-to-video',
        status: '/api/async-sora2-video/status',
        history: '/api/async-sora2-video/history',
      };
    case 'kling':
      return {
        i2v: '/api/async-kling-video/start-image-to-video',
        status: '/api/async-kling-video/status',
        history: '/api/async-kling-video/history',
      };
    case 'seedance':
      return {
        i2v: '/api/async-seedance-video/start-image-to-video',
        t2v: '/api/async-seedance-video/start-text-to-video',
        status: '/api/async-seedance-video/status',
        history: '/api/async-seedance-video/history',
      };
    case 'ugc':
      return {
        start: '/api/async-ugc-video/start',
        status: '/api/async-ugc-video/status',
        history: '/api/async-ugc-video/history',
      };
  }
}

function buildSeedanceBody(opts: VideoGenerateOpts): Record<string, unknown> {
  const refImages = toArray(opts.referenceImage);
  const refVideos = toArray(opts.referenceVideo);
  const refAudios = toArray(opts.referenceAudio);
  const hasRefs = refImages.length > 0 || refVideos.length > 0;

  // Seedance 2.0 route selection:
  //   refs  → r2v  (start-image-to-video accepts image_urls[] / video_urls[] / audio_urls[])
  //   image → i2v  (single imageUrl)
  //   none  → t2v  (start-text-to-video)
  if (hasRefs) {
    return {
      prompt: opts.prompt,
      model: opts.model ?? 'seedance-2.0-r2v',
      imageUrl: opts.image,
      image_urls: refImages.length ? refImages : undefined,
      video_urls: refVideos.length ? refVideos : undefined,
      // Voice continuity across multi-segment videos: pass extracted audio
      // from segment 1 as audio_urls reference here, Seedance R2V matches
      // the voice character natively. Beats TTS+lipsync for cost+quality.
      audio_urls: refAudios.length ? refAudios : undefined,
      duration: opts.duration,
      aspect_ratio: opts.aspectRatio,
      resolution: opts.resolution,
      generate_audio: opts.generateAudio,
    };
  }
  if (opts.image) {
    return {
      prompt: opts.prompt,
      imageUrl: opts.image,
      model: opts.model ?? 'seedance-2.0-i2v',
      duration: opts.duration,
      aspect_ratio: opts.aspectRatio,
      resolution: opts.resolution,
      generate_audio: opts.generateAudio,
    };
  }
  return {
    prompt: opts.prompt,
    model: opts.model ?? 'seedance-2.0-t2v',
    duration: opts.duration,
    aspect_ratio: opts.aspectRatio,
  };
}

function toArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function needsT2v(provider: Provider, hasImage: boolean, hasRefs: boolean): boolean {
  if (hasImage || hasRefs) return false;
  return provider === 'sora2' || provider === 'seedance';
}

interface VideoGenerateOpts {
  provider: Provider;
  prompt: string;
  image?: string;
  audio?: string;
  referenceImage?: string | string[];
  referenceVideo?: string | string[];
  referenceAudio?: string | string[];
  model?: string;
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
  generateAudio?: boolean;
  wait?: boolean;
  timeout?: number;
  output?: string;
}

export function registerVideoCommands(program: Command): void {
  const video = program.command('video').description('AI video generation (Sora 2, Kling, Seedance, UGC)');

  video
    .command('generate')
    .description('Start a video generation job')
    .requiredOption('--provider <name>', `Provider: ${PROVIDERS.join(' | ')}`)
    .requiredOption('-p, --prompt <text>', 'Prompt')
    .option('--image <url|path>', 'Source image URL or local path (image-to-video modes; auto-uploaded)')
    .option('--audio <url|path>', 'Audio URL or local path (ugc only, required; auto-uploaded)')
    .option('--reference-image <url|path>', 'Reference image URL or local path (Seedance 2.0 r2v; repeatable; auto-uploaded)', collect, [] as string[])
    .option('--reference-video <url|path>', 'Reference video URL or local path (Seedance 2.0 r2v; repeatable; auto-uploaded)', collect, [] as string[])
    .option('--reference-audio <url|path>', 'Reference audio URL or local path (Seedance 2.0 r2v voice continuity; repeatable max 3, mp3/wav 2-15s ≤15MB; auto-uploaded)', collect, [] as string[])
    .option('--model <slug>', 'Override model slug (provider-specific)')
    .option('--duration <n>', 'Duration in seconds', (v) => parseInt(v, 10))
    .option('--aspect-ratio <ratio>', 'Aspect ratio (9:16 | 16:9 | 1:1 | ...)')
    .option('--resolution <res>', 'Resolution (480p | 720p | 1080p | auto)')
    // Audio defaults to on for Seedance/Kling/UGC. --no-generate-audio disables.
    .option('--no-generate-audio', 'Disable audio generation (Seedance/Kling)')
    .option('--wait', 'Block until the job completes', false)
    .option('--timeout <ms>', 'Wait timeout in ms', (v) => parseInt(v, 10), 900_000)
    .option('-o, --output <path>', 'Save the result video to this path (implies --wait)')
    .action(async (opts: VideoGenerateOpts) => {
      try {
        if (!PROVIDERS.includes(opts.provider)) {
          fail(`Unknown provider: ${opts.provider}. Expected one of ${PROVIDERS.join(', ')}.`, 2);
        }

        // Auto-upload local file paths and replace with the resulting public URL.
        // URLs and data: URIs pass through. Done up-front so each builder below
        // sees only URLs.
        const uploadSpin = ora({ text: 'Resolving inputs…', stream: process.stderr });
        const filesToUpload = [
          opts.image,
          opts.audio,
          ...toArray(opts.referenceImage),
          ...toArray(opts.referenceVideo),
          ...toArray(opts.referenceAudio),
        ].filter((s): s is string => typeof s === 'string' && s.length > 0 && looksLikeLocalPath(s));
        if (filesToUpload.length > 0) uploadSpin.start();
        try {
          if (opts.image) opts.image = await ensureRemoteUrl(opts.image);
          if (opts.audio) opts.audio = await ensureRemoteUrl(opts.audio);
          opts.referenceImage = await Promise.all(
            toArray(opts.referenceImage).map((s) => ensureRemoteUrl(s))
          );
          opts.referenceVideo = await Promise.all(
            toArray(opts.referenceVideo).map((s) => ensureRemoteUrl(s))
          );
          opts.referenceAudio = await Promise.all(
            toArray(opts.referenceAudio).map((s) => ensureRemoteUrl(s))
          );
        } finally {
          if (filesToUpload.length > 0) {
            uploadSpin.succeed(`Uploaded ${filesToUpload.length} local file(s)`);
          }
        }

        const routes = providerRoutes(opts.provider);
        const hasImage = Boolean(opts.image);
        const hasRefs = toArray(opts.referenceImage).length > 0 || toArray(opts.referenceVideo).length > 0;

        let url: string;
        let body: Record<string, unknown>;

        if (opts.provider === 'ugc') {
          if (!opts.image || !opts.audio) {
            fail('UGC requires both --image and --audio URLs.', 2);
          }
          url = routes.start!;
          body = {
            prompt: opts.prompt,
            imageUrl: opts.image,
            audioUrl: opts.audio,
            aspect_ratio: opts.aspectRatio,
            model: opts.model,
          };
        } else if (opts.provider === 'seedance') {
          url = needsT2v(opts.provider, hasImage, hasRefs) ? routes.t2v! : routes.i2v!;
          body = buildSeedanceBody(opts);
        } else if (opts.provider === 'sora2') {
          url = needsT2v(opts.provider, hasImage, hasRefs) ? routes.t2v! : routes.i2v!;
          body = {
            prompt: opts.prompt,
            imageUrl: opts.image,
            duration: opts.duration?.toString(),
            aspect_ratio: opts.aspectRatio,
            resolution: opts.resolution,
          };
        } else {
          // kling — only i2v exposed in this CLI version
          if (!hasImage) fail('Kling requires --image. (Text-to-video not supported by this endpoint.)', 2);
          url = routes.i2v!;
          body = {
            prompt: opts.prompt,
            imageUrl: opts.image,
            model: opts.model ?? 'kling-3-standard',
            aspect_ratio: opts.aspectRatio,
            duration: opts.duration?.toString(),
            generate_audio: opts.generateAudio,
          };
        }

        const shouldWait = opts.wait === true || Boolean(opts.output);

        const start = await request<BffStartResponse>(url, { method: 'POST', body });
        const requestId = extractRequestId(start);
        if (!requestId) {
          fail(`No jobId/request_id in response: ${JSON.stringify(start)}`);
        }

        if (!shouldWait) {
          emitJson({
            provider: opts.provider,
            request_id: requestId,
            status: start.data?.status ?? 'queued',
            estimated_completion_at: start.data?.estimated_completion_at,
            token_cost: start.data?.token_cost,
          });
          return;
        }

        const spin = ora({ text: `Waiting for ${opts.provider} video (${requestId})…`, stream: process.stderr }).start();
        const status = await pollUntilDone<BffStatusResponse>(async () => {
          const s = await request<BffStatusResponse>(`${routes.status}/${requestId}`);
          if (s.data?.status === 'failed') return { done: false, error: extractFailureMessage(s) };
          if (s.data?.status !== 'completed') {
            spin.text = `Waiting for ${opts.provider} (${requestId})… ${s.data?.status ?? '?'}${s.data?.pipeline_stage ? ` · ${s.data.pipeline_stage}` : ''}`;
            return { done: false };
          }
          return { done: true, result: s };
        }, { intervalMs: 3000, timeoutMs: opts.timeout });
        spin.succeed(`${opts.provider} video ready`);

        const videoUrl = extractResultUrl(status);
        if (!videoUrl) fail(`Result had no video URL: ${JSON.stringify(status)}`);

        if (opts.output) {
          await downloadTo(videoUrl!, opts.output);
          note(`Saved ${opts.output}`);
          emitJson({ provider: opts.provider, request_id: requestId, url: videoUrl, outputPath: opts.output });
        } else {
          emitJson({ provider: opts.provider, request_id: requestId, url: videoUrl });
        }
      } catch (err) { fail(err); }
    });

  video
    .command('status')
    .description('Check a video job status')
    .argument('<provider>', `One of: ${PROVIDERS.join(' | ')}`)
    .argument('<jobId>', 'Job id returned by `generate`')
    .action(async (provider: Provider, jobId: string) => {
      try {
        if (!PROVIDERS.includes(provider)) fail(`Unknown provider: ${provider}`, 2);
        const s = await request<BffStatusResponse>(`${providerRoutes(provider).status}/${jobId}`);
        emitJson(s);
      } catch (err) { fail(err); }
    });

  video
    .command('wait')
    .description('Resume waiting on a previously-started video job and (optionally) save the result')
    .argument('<provider>', `One of: ${PROVIDERS.join(' | ')}`)
    .argument('<jobId>', 'Job id returned by `generate`')
    .option('--timeout <ms>', 'Wait timeout in ms', (v) => parseInt(v, 10), 1_800_000)
    .option('--interval <ms>', 'Poll interval in ms', (v) => parseInt(v, 10), 5_000)
    .option('-o, --output <path>', 'Save the result video to this path')
    .action(async (provider: Provider, jobId: string, opts: { timeout?: number; interval?: number; output?: string }) => {
      try {
        if (!PROVIDERS.includes(provider)) fail(`Unknown provider: ${provider}`, 2);
        const routes = providerRoutes(provider);

        const spin = ora({ text: `Waiting for ${provider} (${jobId})…`, stream: process.stderr }).start();
        const status = await pollUntilDone<BffStatusResponse>(async () => {
          const s = await request<BffStatusResponse>(`${routes.status}/${jobId}`);
          if (s.data?.status === 'failed') return { done: false, error: extractFailureMessage(s) };
          if (s.data?.status !== 'completed') {
            spin.text = `Waiting for ${provider} (${jobId})… ${s.data?.status ?? '?'}${s.data?.pipeline_stage ? ` · ${s.data.pipeline_stage}` : ''}`;
            return { done: false };
          }
          return { done: true, result: s };
        }, { intervalMs: opts.interval, timeoutMs: opts.timeout });
        spin.succeed(`${provider} video ready`);

        const videoUrl = extractResultUrl(status);
        if (!videoUrl) fail(`Result had no video URL: ${JSON.stringify(status)}`);

        if (opts.output) {
          await downloadTo(videoUrl!, opts.output);
          note(`Saved ${opts.output}`);
          emitJson({ provider, request_id: jobId, url: videoUrl, outputPath: opts.output });
        } else {
          emitJson({ provider, request_id: jobId, url: videoUrl });
        }
      } catch (err) { fail(err); }
    });

  video
    .command('history')
    .description("List your video generation jobs for a provider")
    .argument('<provider>', `One of: ${PROVIDERS.join(' | ')}`)
    .option('--limit <n>', 'Limit', (v) => parseInt(v, 10), 20)
    .option('--page <n>', 'Page', (v) => parseInt(v, 10), 1)
    .option('--status <s>', 'Filter by status')
    .action(async (provider: Provider, opts: { limit?: number; page?: number; status?: string }) => {
      try {
        if (!PROVIDERS.includes(provider)) fail(`Unknown provider: ${provider}`, 2);
        const r = await request<unknown>(providerRoutes(provider).history, {
          query: { limit: opts.limit, page: opts.page, status: opts.status },
        });
        emitJson(r);
      } catch (err) { fail(err); }
    });

  registerVideoSubtitleCommands(video);
  registerVideoUpscaleCommands(video);

  video
    .command('models')
    .description('List active video models (generate / upscale / post-processing) with cost / durations / aspect ratios')
    .action(async () => {
      try {
        // BFF expects exact category names — fetch all + filter client-side
        // so the agent gets every video_* model in one call (generate +
        // upscale + post-processing).
        const r = await request<{ success?: boolean; data?: Array<{ category?: string }> }>(
          '/api/models',
          { auth: false },
        );
        const data = Array.isArray(r?.data)
          ? r.data.filter((m) => typeof m.category === 'string' && m.category.startsWith('video_'))
          : [];
        emitJson({ success: true, data });
      } catch (err) { fail(err); }
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
