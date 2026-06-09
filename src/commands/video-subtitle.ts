/**
 * `quickdesign video subtitle|subtitle-status|subtitle-history`
 *
 * Karaoke-style auto subtitles via /api/async-auto-subtitle/*
 * (fal-ai/workflow-utilities/auto-subtitle under the hood).
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
import {
  BffStartResponse,
  BffStatusResponse,
  extractFailureMessage,
  extractRequestId,
  extractResultUrl,
} from './video-shared.js';

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

export function registerVideoSubtitleCommands(video: Command): void {
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
}
