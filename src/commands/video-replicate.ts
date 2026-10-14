/**
 * `quickdesign video replicate` — Replicate Video v2: re-create a reference ad
 * with your product (Gemini-directed Seedance 2.5). Wraps the BFF's
 * POST /api/replicate-video/generate — the same flow as the app's Replicate
 * Video page, MCP `quickdesign_replicate_video` and POST /api/v1/videos/replicate.
 * The job is a seedance-family ugc_video_jobs row, so `video status|wait seedance`
 * follow it too.
 */
import { Command, Option } from 'commander';
import ora from 'ora';
import { request } from '../client.js';
import { emitJson, fail, note } from '../utils/output.js';
import { pollUntilDone } from '../utils/poll.js';
import { downloadTo } from '../utils/download.js';
import { ensureRemoteUrl, looksLikeLocalPath } from '../utils/upload.js';
import { BffStatusResponse, extractFailureMessage, extractResultUrl } from './video-shared.js';

const START_PATH = '/api/replicate-video/generate';
const STATUS_PATH = '/api/async-seedance-video/status';
/** The BFF downloads and probes the reference (≤200 MB) before it answers 202. */
const START_TIMEOUT_MS = 280_000;
/**
 * Absolute ceiling (kie's Seedance 2.5 takes 30 reference images). The BFF enforces the model's real
 * limit — the registry's max_reference_images minus the model photo and the logo — and names it in a 400.
 */
const MAX_PRODUCTS = 30;
/** Mirrors MAX_NOTES_CHARS in the BFF (services/replicateVideo/types.ts). */
const MAX_NOTES_CHARS = 500;
const FAILED = ['failed', 'timeout', 'cancelled'];

interface ReplicateStartResponse {
  success?: boolean;
  jobId?: string;
  cost?: number;
  duration?: number;
  aspectRatio?: string;
  error?: string;
}

interface ReplicateOpts {
  video: string;
  product: string[];
  modelImage?: string;
  brandKit?: string;
  notes?: string;
  language: 'tr' | 'en';
  resolution: '720p' | '1080p';
  wait?: boolean;
  timeout: number;
  output?: string;
}

export function registerVideoReplicateCommands(video: Command): void {
  video
    .command('replicate')
    .description('Re-create a reference video ad with your product (Gemini-directed Seedance 2.5)')
    .requiredOption(
      '--video <url|path>',
      'Reference video to re-create — analysed only, never sent to the generator (≤200 MB; up to 30 s is re-created; auto-uploaded)',
    )
    .option(
      '--product <url|path>',
      `Product image (repeatable; as many as the video model takes beside --model-image and the brand logo, at most ${MAX_PRODUCTS}; a few clean angles work best; auto-uploaded)`,
      (v: string, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option('--model-image <url|path>', 'Person to cast (omit for one new person unlike the original actor; auto-uploaded)')
    .option('--brand-kit <id>', 'Brand kit UUID — its logo replaces the reference logo; name/offer/voice steer the script')
    .option(
      '--notes <text>',
      `Notes for the AI about your product (≤${MAX_NOTES_CHARS} chars), e.g. "925 silver adjustable ring, show it on the index finger, mention it is handmade" — steers what the product is and what the script stresses, never the swaps or timing`,
    )
    .addOption(new Option('--language <code>', 'Voiceover and on-screen text language').choices(['tr', 'en']).default('en'))
    .addOption(new Option('--resolution <res>', 'Output resolution').choices(['720p', '1080p']).default('720p'))
    .option('--wait', 'Block until the video is ready', false)
    .option('--timeout <ms>', 'Wait timeout in ms', (v) => parseInt(v, 10), 1_800_000)
    .option('-o, --output <path>', 'Save the result video to this path (implies --wait)')
    .action(async (opts: ReplicateOpts) => {
      try {
        const products = opts.product ?? [];
        if (products.length < 1) fail('Pass at least one --product image.', 2);
        if (products.length > MAX_PRODUCTS) {
          fail(`Pass at most ${MAX_PRODUCTS} --product images (got ${products.length}).`, 2);
        }
        const notes = opts.notes?.trim();
        if (notes && notes.length > MAX_NOTES_CHARS) {
          fail(`--notes can be at most ${MAX_NOTES_CHARS} characters (got ${notes.length}).`, 2);
        }

        const locals = [opts.video, ...products, opts.modelImage].filter(
          (s): s is string => typeof s === 'string' && looksLikeLocalPath(s),
        );
        const uploadSpin = ora({ text: 'Uploading local files…', stream: process.stderr });
        if (locals.length > 0) uploadSpin.start();
        let referenceVideoUrl: string;
        let productImageUrls: string[];
        let modelImageUrl: string | undefined;
        try {
          referenceVideoUrl = await ensureRemoteUrl(opts.video);
          productImageUrls = await Promise.all(products.map((p) => ensureRemoteUrl(p)));
          modelImageUrl = opts.modelImage ? await ensureRemoteUrl(opts.modelImage) : undefined;
        } catch (err) {
          if (locals.length > 0) uploadSpin.fail('Upload failed');
          throw err;
        }
        if (locals.length > 0) uploadSpin.succeed(`Uploaded ${locals.length} local file(s)`);

        const startSpin = ora({ text: 'Checking the reference video and charging credits…', stream: process.stderr }).start();
        let start: ReplicateStartResponse;
        try {
          start = await request<ReplicateStartResponse>(START_PATH, {
            method: 'POST',
            body: {
              referenceVideoUrl,
              productImageUrls,
              ...(modelImageUrl ? { modelImageUrl } : {}),
              ...(opts.brandKit ? { brandKitId: opts.brandKit } : {}),
              ...(notes ? { notes } : {}),
              language: opts.language,
              resolution: opts.resolution,
              source: 'cli',
            },
            signal: AbortSignal.timeout(START_TIMEOUT_MS),
          });
        } catch (err) {
          startSpin.fail('Replicate Video did not start');
          throw err;
        }
        if (!start.jobId) {
          startSpin.fail('Replicate Video did not start');
          fail(`No jobId in response: ${JSON.stringify(start)}`);
        }
        const jobId = start.jobId;
        startSpin.succeed(`Started ${jobId} · ${start.cost ?? '?'} credits · ${start.duration ?? '?'} s · ${start.aspectRatio ?? '?'}`);

        const summary = {
          provider: 'seedance',
          request_id: jobId,
          cost: start.cost,
          duration: start.duration,
          aspect_ratio: start.aspectRatio,
        };
        const shouldWait = opts.wait === true || Boolean(opts.output);
        if (!shouldWait) {
          emitJson({ ...summary, status: 'queued' });
          note(`Follow it with: quickdesign video wait seedance ${jobId}`);
          return;
        }

        const spin = ora({ text: `Waiting for Replicate Video (${jobId})…`, stream: process.stderr }).start();
        const status = await pollUntilDone<BffStatusResponse>(
          async () => {
            const s = await request<BffStatusResponse>(`${STATUS_PATH}/${jobId}`);
            const st = s.data?.status ?? '';
            if (FAILED.includes(st)) return { done: false, error: extractFailureMessage(s) };
            if (st !== 'completed') {
              spin.text = `Waiting for Replicate Video (${jobId})… ${st || '?'}`;
              return { done: false };
            }
            return { done: true, result: s };
          },
          { intervalMs: 5000, timeoutMs: opts.timeout },
        );
        spin.succeed('Replicate Video ready');

        const url = extractResultUrl(status);
        if (!url) fail(`Result had no video URL: ${JSON.stringify(status)}`);
        if (opts.output) {
          await downloadTo(url!, opts.output);
          note(`Saved ${opts.output}`);
          emitJson({ ...summary, url, outputPath: opts.output });
        } else {
          emitJson({ ...summary, url });
        }
      } catch (err) {
        fail(err);
      }
    });
}
