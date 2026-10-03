/**
 * `quickdesign video from-url` — URL to Video: a product page → an original
 * video ad on a reference-to-video model (default Seedance 2.5). Reads the
 * page with POST /api/smart-ad-creator/analyze-product (free), then starts
 * POST /api/url-video/generate — the same flow as the app's URL to Video,
 * MCP `quickdesign_url_to_video` and POST /api/v1/videos/from-url. The job is
 * a seedance-family ugc_video_jobs row, so `video status|wait seedance`
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

const ANALYZE_PATH = '/api/smart-ad-creator/analyze-product';
const START_PATH = '/api/url-video/generate';
const STATUS_PATH = '/api/async-seedance-video/status';
/** The analysis is agentic (page fetches + LLM). */
const ANALYZE_TIMEOUT_MS = 150_000;
/** The BFF downloads every photo before it answers 202. */
const START_TIMEOUT_MS = 120_000;
const MAX_PRODUCTS = 3;
const MAX_BENEFITS = 5;
const FAILED = ['failed', 'timeout', 'cancelled'];

interface AnalyzeResponse {
  productName?: unknown;
  description?: unknown;
  targetAudience?: unknown;
  keyFeatures?: unknown;
  productImages?: unknown;
  businessType?: unknown;
}

interface StartResponse {
  success?: boolean;
  jobId?: string;
  cost?: number;
  model?: string;
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
  error?: string;
}

interface FromUrlOpts {
  image: string[];
  benefit: string[];
  model: string;
  duration?: number;
  ratio?: string;
  resolution?: string;
  language: 'tr' | 'en';
  brandKit?: string;
  offer?: string;
  cta?: string;
  direction?: string;
  wait?: boolean;
  timeout: number;
  output?: string;
}

interface ProductFacts {
  name: string;
  description?: string;
  benefits: string[];
  audience?: string;
  businessType: 'product' | 'saas';
}

const collect = (value: string, previous: string[]): string[] => [...previous, value];
const clip = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

/** Same rules as the BFF's public core: the app's clamps, best-scored unique http(s) photos. */
function productFromAnalysis(a: AnalyzeResponse, maxPhotos: number): { product: ProductFacts | null; photos: string[] } {
  const name = clip(a.productName, 100);
  const benefits = (Array.isArray(a.keyFeatures) ? a.keyFeatures : [])
    .filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
    .slice(0, MAX_BENEFITS)
    .map((f) => f.trim().slice(0, 100));
  const ranked = (Array.isArray(a.productImages) ? a.productImages : [])
    .map((img: unknown, i: number) => {
      if (typeof img === 'string') return { url: img, score: -i };
      const o = (img ?? {}) as { url?: unknown; score?: unknown };
      return { url: o.url, score: typeof o.score === 'number' ? o.score : -i };
    })
    .filter((img): img is { url: string; score: number } => typeof img.url === 'string' && /^https?:\/\//i.test(img.url))
    .sort((x, y) => y.score - x.score)
    .map((img) => img.url);
  return {
    product: name
      ? {
          name,
          description: clip(a.description, 700),
          benefits,
          audience: clip(a.targetAudience, 1000),
          businessType: a.businessType === 'saas' ? 'saas' : 'product',
        }
      : null,
    photos: Array.from(new Set(ranked)).slice(0, maxPhotos),
  };
}

export function registerVideoFromUrlCommands(video: Command): void {
  video
    .command('from-url')
    .description('Turn a product page into a video ad (Claude-directed; Seedance 2.5 by default)')
    .argument('<url>', 'Product or landing page URL')
    .option('--image <url|path>', `Product photo (repeatable, 1–${MAX_PRODUCTS}; default: the best photos on the page; auto-uploaded)`, collect, [] as string[])
    .option('--benefit <text>', `Product benefit (repeatable, up to ${MAX_BENEFITS}; replaces the ones found on the page)`, collect, [] as string[])
    .option('--model <slug>', 'Reference-to-video model (see `video models`)', 'seedance-2.5')
    .option('--duration <seconds>', "Length in seconds, one of the model's durations (default 15)", (v) => parseInt(v, 10))
    .option('--ratio <ratio>', 'Aspect ratio (default 9:16)')
    .option('--resolution <res>', 'Resolution (default 720p)')
    .addOption(new Option('--language <code>', 'Voiceover and on-screen text language').choices(['tr', 'en']).default('en'))
    .option('--brand-kit <id>', 'Brand kit UUID — its logo closes the video; name, voice and offer steer the script')
    .option('--offer <text>', 'A real offer to mention, word for word')
    .option('--cta <text>', 'Call to action for the end card, word for word')
    .option('--direction <text>', 'Creative direction: tone, style, things to avoid')
    .option('--wait', 'Block until the video is ready', false)
    .option('--timeout <ms>', 'Wait timeout in ms', (v) => parseInt(v, 10), 1_800_000)
    .option('-o, --output <path>', 'Save the result video to this path (implies --wait)')
    .action(async (url: string, opts: FromUrlOpts) => {
      try {
        if (opts.image.length > MAX_PRODUCTS) fail(`Pass at most ${MAX_PRODUCTS} --image photos (got ${opts.image.length}).`, 2);
        if (opts.benefit.length > MAX_BENEFITS) fail(`Pass at most ${MAX_BENEFITS} --benefit values.`, 2);

        const analyzeSpin = ora({ text: 'Reading the product page…', stream: process.stderr }).start();
        let analysis: AnalyzeResponse;
        try {
          analysis = await request<AnalyzeResponse>(ANALYZE_PATH, {
            method: 'POST',
            body: { url },
            signal: AbortSignal.timeout(ANALYZE_TIMEOUT_MS),
          });
        } catch (err) {
          analyzeSpin.fail('Could not read the product page');
          throw err;
        }
        const found = productFromAnalysis(analysis, MAX_PRODUCTS);
        if (!found.product) {
          analyzeSpin.fail('Could not read the product page');
          fail(`No product found on ${url}.`, 2);
        }
        const product = found.product!;
        analyzeSpin.succeed(`Found ${product.name}`);

        const locals = opts.image.filter((s) => looksLikeLocalPath(s));
        const uploadSpin = ora({ text: 'Uploading local files…', stream: process.stderr });
        if (locals.length > 0) uploadSpin.start();
        let productImageUrls: string[];
        try {
          productImageUrls = opts.image.length > 0 ? await Promise.all(opts.image.map((p) => ensureRemoteUrl(p))) : found.photos;
        } catch (err) {
          if (locals.length > 0) uploadSpin.fail('Upload failed');
          throw err;
        }
        if (locals.length > 0) uploadSpin.succeed(`Uploaded ${locals.length} local file(s)`);
        if (productImageUrls.length === 0) fail(`No product photos were found on ${url} — pass --image.`, 2);

        const startSpin = ora({ text: 'Checking the photos and charging credits…', stream: process.stderr }).start();
        let start: StartResponse;
        try {
          start = await request<StartResponse>(START_PATH, {
            method: 'POST',
            body: {
              sourceUrl: url,
              product: opts.benefit.length > 0 ? { ...product, benefits: opts.benefit } : product,
              productImageUrls,
              model: opts.model,
              ...(opts.duration ? { duration: opts.duration } : {}),
              ...(opts.ratio ? { aspectRatio: opts.ratio } : {}),
              ...(opts.resolution ? { resolution: opts.resolution } : {}),
              language: opts.language,
              ...(opts.brandKit ? { brandKitId: opts.brandKit } : {}),
              ...(opts.offer ? { offer: opts.offer } : {}),
              ...(opts.cta ? { cta: opts.cta } : {}),
              ...(opts.direction ? { direction: opts.direction } : {}),
              source: 'cli',
            },
            signal: AbortSignal.timeout(START_TIMEOUT_MS),
          });
        } catch (err) {
          startSpin.fail('URL to Video did not start');
          throw err;
        }
        if (!start.jobId) {
          startSpin.fail('URL to Video did not start');
          fail(`No jobId in response: ${JSON.stringify(start)}`);
        }
        const jobId = start.jobId!;
        startSpin.succeed(
          `Started ${jobId} · ${start.cost ?? '?'} credits · ${start.model ?? opts.model} · ${start.duration ?? '?'} s · ${start.aspectRatio ?? '?'} · ${start.resolution ?? '?'}`,
        );

        const summary = {
          provider: 'seedance',
          request_id: jobId,
          cost: start.cost,
          model: start.model,
          duration: start.duration,
          aspect_ratio: start.aspectRatio,
          resolution: start.resolution,
        };
        const shouldWait = opts.wait === true || Boolean(opts.output);
        if (!shouldWait) {
          emitJson({ ...summary, status: 'queued' });
          note(`Follow it with: quickdesign video wait seedance ${jobId}`);
          return;
        }

        const spin = ora({ text: `Waiting for URL to Video (${jobId})…`, stream: process.stderr }).start();
        const status = await pollUntilDone<BffStatusResponse>(
          async () => {
            const s = await request<BffStatusResponse>(`${STATUS_PATH}/${jobId}`);
            const st = s.data?.status ?? '';
            if (FAILED.includes(st)) return { done: false, error: extractFailureMessage(s) };
            if (st !== 'completed') {
              spin.text = `Waiting for URL to Video (${jobId})… ${st || '?'}`;
              return { done: false };
            }
            return { done: true, result: s };
          },
          { intervalMs: 5000, timeoutMs: opts.timeout },
        );
        spin.succeed('URL to Video ready');

        const resultUrl = extractResultUrl(status);
        if (!resultUrl) fail(`Result had no video URL: ${JSON.stringify(status)}`);
        if (opts.output) {
          await downloadTo(resultUrl!, opts.output);
          note(`Saved ${opts.output}`);
          emitJson({ ...summary, url: resultUrl, outputPath: opts.output });
        } else {
          emitJson({ ...summary, url: resultUrl });
        }
      } catch (err) {
        fail(err);
      }
    });
}
