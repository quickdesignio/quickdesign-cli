/**
 * `quickdesign video generate|status|history|upscale|upscale-status|upscale-history`
 *
 * Wraps four BFF provider families:
 *   sora2    → /api/async-sora2-video/*
 *   kling    → /api/async-kling-video/*
 *   seedance → /api/async-seedance-video/*   (also exposes Seedance 2.0 r2v)
 *   ugc      → /api/async-ugc-video/*
 *
 * Plus upscale: /api/async-video-upscale/*
 *
 * Unlike image generation, video endpoints don't expose a separate `/result/:id`
 * route — the result URLs are embedded in the status response. So our poll loop
 * looks for `status === 'completed'` on the status call and pulls the URL from
 * there.
 */
import { Command } from 'commander';
import ora from 'ora';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { request } from '../client.js';
import { emitJson, fail, note } from '../utils/output.js';
import { pollUntilDone } from '../utils/poll.js';
import { downloadTo } from '../utils/download.js';
import { ensureRemoteUrl, looksLikeLocalPath } from '../utils/upload.js';

/**
 * Subtitle style presets — `quickdesign video subtitle --style <preset>`.
 * Override any field with the corresponding `--<flag>` (e.g. `--font Poppins`).
 */
const SUBTITLE_STYLES = {
  default: {
    font_name: 'Montserrat',
    font_size: 65,
    font_weight: 'bold',
    font_color: 'white',
    highlight_color: 'yellow',
    stroke_width: 2,
    stroke_color: 'black',
    background_color: 'none',
    position: 'bottom',
    y_offset: 60,
    words_per_subtitle: 5,
    enable_animation: true,
  },
  tiktok: {
    font_name: 'Montserrat',
    font_size: 100,
    font_weight: 'bold',
    font_color: 'white',
    highlight_color: 'purple',
    stroke_width: 3,
    stroke_color: 'black',
    background_color: 'none',
    position: 'bottom',
    y_offset: 75,
    words_per_subtitle: 1,
    enable_animation: true,
  },
  minimal: {
    font_name: 'Inter',
    font_size: 60,
    font_weight: 'normal',
    font_color: 'white',
    highlight_color: 'white',
    stroke_width: 1,
    stroke_color: 'black',
    background_color: 'none',
    position: 'bottom',
    y_offset: 50,
    words_per_subtitle: 8,
    enable_animation: false,
  },
  karaoke: {
    font_name: 'Montserrat',
    font_size: 80,
    font_weight: 'bold',
    font_color: 'white',
    highlight_color: 'yellow',
    stroke_width: 2,
    stroke_color: 'black',
    background_color: 'none',
    position: 'center',
    y_offset: 0,
    words_per_subtitle: 3,
    enable_animation: true,
  },
  'reels-pop': {
    font_name: 'Bebas Neue',
    font_size: 110,
    font_weight: 'black',
    font_color: 'yellow',
    highlight_color: 'red',
    stroke_width: 4,
    stroke_color: 'black',
    background_color: 'none',
    position: 'center',
    y_offset: -50,
    words_per_subtitle: 1,
    enable_animation: true,
  },
} as const;

/** Best-effort local duration detection via ffprobe. Silently returns undefined on failure. */
function detectDurationSeconds(videoPath: string): number | undefined {
  if (!existsSync(videoPath)) return undefined;
  try {
    const r = spawnSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ], { encoding: 'utf-8' });
    if (r.status === 0) {
      const d = parseFloat((r.stdout || '').trim());
      if (Number.isFinite(d) && d > 0) return d;
    }
  } catch {
    /* ffprobe not installed or failed */
  }
  return undefined;
}

type Provider = 'sora2' | 'kling' | 'seedance' | 'ugc';
const PROVIDERS: readonly Provider[] = ['sora2', 'kling', 'seedance', 'ugc'];

interface BffStartResponse {
  success?: boolean;
  data?: {
    jobId?: string;
    request_id?: string;
    status?: string;
    estimated_completion_at?: string;
    estimated_duration_minutes?: number;
    token_cost?: number;
  };
  request_id?: string;
  jobId?: string;
  requestId?: string;
  error?: string;
}

interface BffStatusResponse {
  success?: boolean;
  data?: {
    status: 'queued' | 'processing' | 'completed' | 'failed' | string;
    progress?: number;
    /** Legacy / image-generation surface uses `error`. */
    error?: string;
    /** Seedance / UGC / video status endpoints surface the failure under
     *  `error_message`. Read both — caller picks whichever is set. */
    error_message?: string;
    video_url?: string;
    videoUrl?: string;
    output_url?: string;
    /** Seedance/UGC status endpoints return the final URL under this key. */
    result_video_url?: string;
    result?: {
      video_url?: string;
      videoUrl?: string;
      output_url?: string;
      result_video_url?: string;
    };
    merge_video_url?: string;
    segment_videos?: string[];
    pipeline_stage?: string;
  };
}

/** Pull the most informative failure string from a status response. */
function extractFailureMessage(s: BffStatusResponse): string {
  return s.data?.error_message
    || s.data?.error
    || 'Generation failed';
}

function extractRequestId(r: BffStartResponse): string | undefined {
  return r.data?.jobId ?? r.data?.request_id ?? r.jobId ?? r.request_id ?? r.requestId;
}

function extractResultUrl(s: BffStatusResponse): string | undefined {
  const d = s.data;
  if (!d) return undefined;
  return (
    d.result_video_url
    ?? d.video_url
    ?? d.videoUrl
    ?? d.output_url
    ?? d.result?.result_video_url
    ?? d.result?.video_url
    ?? d.result?.videoUrl
    ?? d.result?.output_url
    ?? d.merge_video_url
    ?? d.segment_videos?.[d.segment_videos.length - 1]
  );
}

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

  // ---- subtitle (auto-subtitle, karaoke style) -------------------------

  video
    .command('subtitle')
    .description('Add karaoke-style auto subtitles to a video (fal-ai/workflow-utilities/auto-subtitle)')
    .argument('<video>', 'Source video URL or local path (auto-uploaded)')
    .option('--style <preset>', 'Style preset: default | tiktok | minimal | karaoke | reels-pop', 'default')
    .option('--language <code>', 'Language code (e.g. en, tr, es, fr, de) or 3-letter ISO', 'en')
    .option('--duration-seconds <n>', 'Source duration in seconds (auto-detected via ffprobe for local files)', (v) => parseFloat(v))
    // Style override flags — applied on top of preset
    .option('--font <name>', 'Google Font name (e.g. Montserrat, Inter, Poppins, Bebas Neue)')
    .option('--font-size <n>', 'Font size in px', (v) => parseInt(v, 10))
    .option('--font-weight <w>', 'normal | bold | black')
    .option('--color <c>', 'Subtitle text color')
    .option('--highlight-color <c>', 'Currently-spoken word highlight color')
    .option('--stroke-width <n>', 'Text outline width in px', (v) => parseInt(v, 10))
    .option('--stroke-color <c>', 'Text outline color')
    .option('--background-color <c>', 'Background behind text (or "none" / "transparent")')
    .option('--background-opacity <n>', 'Background opacity 0.0–1.0', (v) => parseFloat(v))
    .option('--position <p>', 'top | center | bottom')
    .option('--y-offset <n>', 'Vertical pixel offset (positive = down, negative = up)', (v) => parseInt(v, 10))
    .option('--words-per-line <n>', '1 = single-word, 3 = phrase, 8-12 = full sentence', (v) => parseInt(v, 10))
    .option('--no-animation', 'Disable bounce-in animation effect')
    .option('--wait', 'Block until the job completes', false)
    .option('--timeout <ms>', 'Wait timeout in ms', (v) => parseInt(v, 10), 600_000)
    .option('-o, --output <path>', 'Save the subtitled video to this path (implies --wait)')
    .action(async (videoArg: string, opts: {
      style?: string;
      language?: string;
      durationSeconds?: number;
      font?: string;
      fontSize?: number;
      fontWeight?: string;
      color?: string;
      highlightColor?: string;
      strokeWidth?: number;
      strokeColor?: string;
      backgroundColor?: string;
      backgroundOpacity?: number;
      position?: string;
      yOffset?: number;
      wordsPerLine?: number;
      animation?: boolean;
      wait?: boolean;
      timeout?: number;
      output?: string;
    }) => {
      try {
        const styleName = (opts.style ?? 'default').toLowerCase();
        const preset = SUBTITLE_STYLES[styleName as keyof typeof SUBTITLE_STYLES];
        if (!preset) {
          fail(`Unknown style: ${opts.style}. One of: ${Object.keys(SUBTITLE_STYLES).join(' | ')}`, 2);
        }

        const shouldWait = opts.wait === true || Boolean(opts.output);

        // Resolve duration: user-supplied > auto-detect (local file) > error.
        let duration = opts.durationSeconds;
        if (duration === undefined && looksLikeLocalPath(videoArg)) {
          duration = detectDurationSeconds(videoArg);
        }
        if (!duration || duration <= 0) {
          fail('--duration-seconds is required (auto-detect failed; pass it explicitly when source is a remote URL or ffprobe is unavailable)', 2);
        }

        // Resolve video URL (auto-upload local file to QuickDesign storage).
        const videoUrl = await ensureRemoteUrl(videoArg);

        // Merge preset with explicit overrides.
        const body: Record<string, unknown> = {
          video_url: videoUrl,
          duration_seconds: duration,
          language: opts.language,
          font_name: opts.font ?? preset.font_name,
          font_size: opts.fontSize ?? preset.font_size,
          font_weight: opts.fontWeight ?? preset.font_weight,
          font_color: opts.color ?? preset.font_color,
          highlight_color: opts.highlightColor ?? preset.highlight_color,
          stroke_width: opts.strokeWidth ?? preset.stroke_width,
          stroke_color: opts.strokeColor ?? preset.stroke_color,
          background_color: opts.backgroundColor ?? preset.background_color,
          background_opacity: opts.backgroundOpacity,
          position: opts.position ?? preset.position,
          y_offset: opts.yOffset ?? preset.y_offset,
          words_per_subtitle: opts.wordsPerLine ?? preset.words_per_subtitle,
          enable_animation: opts.animation === false ? false : preset.enable_animation,
        };

        const start = await request<BffStartResponse>('/api/async-auto-subtitle/start', {
          method: 'POST',
          body,
        });
        const requestId = extractRequestId(start);
        if (!requestId) fail(`No jobId in response: ${JSON.stringify(start)}`);

        if (!shouldWait) {
          emitJson({
            request_id: requestId,
            style: styleName,
            status: start.data?.status ?? 'queued',
            token_cost: start.data?.token_cost,
          });
          return;
        }

        const spin = ora({ text: `Waiting for auto-subtitle (${requestId})…`, stream: process.stderr }).start();
        const status = await pollUntilDone<BffStatusResponse>(async () => {
          const s = await request<BffStatusResponse>(`/api/async-auto-subtitle/status/${requestId}`);
          if (s.data?.status === 'failed') return { done: false, error: extractFailureMessage(s) };
          if (s.data?.status !== 'completed') {
            spin.text = `Waiting for auto-subtitle (${requestId})… ${s.data?.status ?? '?'}`;
            return { done: false };
          }
          return { done: true, result: s };
        }, { intervalMs: 5000, timeoutMs: opts.timeout });
        spin.succeed('Subtitled video ready');

        const resultUrl = extractResultUrl(status);
        if (!resultUrl) fail(`Result had no video URL: ${JSON.stringify(status)}`);

        if (opts.output) {
          await downloadTo(resultUrl!, opts.output);
          note(`Saved ${opts.output}`);
          emitJson({ request_id: requestId, style: styleName, url: resultUrl, outputPath: opts.output });
        } else {
          emitJson({ request_id: requestId, style: styleName, url: resultUrl });
        }
      } catch (err) { fail(err); }
    });

  video
    .command('subtitle-status')
    .description('Check auto-subtitle job status')
    .argument('<jobId>', 'Job id returned by `subtitle`')
    .action(async (jobId: string) => {
      try {
        const s = await request<BffStatusResponse>(`/api/async-auto-subtitle/status/${jobId}`);
        emitJson(s);
      } catch (err) { fail(err); }
    });

  video
    .command('subtitle-history')
    .description("List your auto-subtitle jobs")
    .option('--limit <n>', 'Limit', (v) => parseInt(v, 10), 20)
    .action(async (opts: { limit?: number }) => {
      try {
        const r = await request<unknown>('/api/async-auto-subtitle/history', {
          query: { limit: opts.limit },
        });
        emitJson(r);
      } catch (err) { fail(err); }
    });

  // ---- upscale ----------------------------------------------------------

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
