/**
 * `quickdesign image generate|replicate|status|result|history|models`
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
import { readConfig, parseJwtExpiry, ensureFreshToken } from '../config.js';
import { ensureRemoteUrl, looksLikeLocalPath } from '../utils/upload.js';
import { callMcpTool } from '../utils/mcp.js';

/** The BFF's own caps (quickdesign_replicate_ad / services/public/replicateAdRules.ts). */
const REPLICATE_MAX_PRODUCTS = 5;
const REPLICATE_MAX_NUM = 4;
const REPLICATE_MAX_NOTES = 500;
const REPLICATE_RESOLUTIONS = ['0.5K', '1K', '2K', '4K'];
const REPLICATE_ASPECTS = ['1:1', '9:16', '4:5', '16:9'];
const REPLICATE_UNAVAILABLE = 'This QuickDesign server does not support `image replicate` yet; it needs a newer BFF.';

interface ReplicateStarted {
  request_id?: string;
  request_ids?: string[];
  status?: string;
  model?: string;
  token_cost?: number;
  template_id?: number | null;
  reference_image_url?: string;
  aspect_ratio?: string;
  product_image_count?: number;
  logo_count?: number;
}

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
  // BFF returns BOTH the raw provider URL (kie.ai/aiquickdraw or fal.media,
  // expires in hours/days) and the R2-stored URL on `storage_urls`. Prefer
  // the R2 URL — stable on `library.quickdesign.io`, never expires, and
  // routes via the QuickDesign CDN.
  storage_urls?: string[];
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
    .option('--image <url|path>', 'Source image URL or local path (image-to-image; auto-uploaded). Alias for --reference-image when given alone.')
    .option('--reference-image <url|path>', 'Reference image URL or local path (repeatable; nano-banana-2 supports up to ~5 references). First reference = subject identity, additional refs = props / setting / style anchors.', collect, [])
    .option('--aspect-ratio <ratio>', 'Aspect ratio (1:1 | 9:16 | 16:9 | 4:5)')
    .option('--resolution <res>', 'Resolution (0.5K | 1K | 2K | 4K) — image-edit models only')
    .option('--wait', 'Block until the job completes and return result URL(s)', false)
    .option('--timeout <ms>', 'Wait timeout in ms', (v) => parseInt(v, 10), 300_000)
    .option('-o, --output <path>', 'Save the first image to this path (implies --wait)')
    .action(async (opts: {
      prompt: string;
      model?: string;
      size?: string;
      num?: number;
      image?: string;
      referenceImage?: string[];
      aspectRatio?: string;
      resolution?: string;
      wait?: boolean;
      timeout?: number;
      output?: string;
    }) => {
      try {
        // BFF expects userId in the body (it's not derived from the JWT for this
        // endpoint). Pull it from the stored config; fall back to parsing the
        // current token's `sub` claim if config is missing it.
        let userId: string | undefined = readConfig().userId;
        if (!userId) {
          const token = await ensureFreshToken();
          if (token) userId = parseJwtExpiry(token)?.userId;
        }
        if (!userId) {
          fail('Could not determine userId. Run `quickdesign auth login` again.', 2);
        }

        // Resolve all reference images (--image kept for backwards compat;
        // --reference-image is the canonical multi-ref path). Auto-upload
        // local paths. Order matters: first ref = subject identity, later
        // refs = props / setting / style anchors. Many image-edit models
        // (nano-banana-2 / Gemini 2.5 Flash Image, gpt-image-2-i2i) take an
        // array of image URLs and reason over them in the prompt order.
        const refSources: string[] = [
          ...(opts.image ? [opts.image] : []),
          ...(opts.referenceImage ?? []),
        ];
        const imageUrls = await Promise.all(
          refSources.map((src) => (looksLikeLocalPath(src) ? ensureRemoteUrl(src) : Promise.resolve(src))),
        );

        const shouldWait = opts.wait === true || Boolean(opts.output);
        const start = await request<StartResponse>('/api/image-generation/generate-async', {
          method: 'POST',
          body: {
            prompt: opts.prompt,
            model: opts.model,
            // BFF accepts an `imageUrls` array — multi-image-edit models
            // (nano-banana-2 etc.) consume them as references in order.
            imageUrls,
            n: opts.num,
            userId,
            resolution: opts.resolution,
            aspect_ratio: opts.aspectRatio,
            source: imageUrls.length > 0 ? 'image_edit' : 'text_to_image',
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
          const s = await request<StatusResponse>(`/api/image-generation/status/${requestId}`);
          if (s.status === 'failed') return { done: false, error: s.error ?? 'Generation failed' };
          if (s.status !== 'completed') return { done: false };
          const r = await request<ResultResponse>(`/api/image-generation/result/${requestId}`);
          return { done: true, result: r };
        }, { intervalMs: 2000, timeoutMs: opts.timeout });
        spin.succeed('Image ready');

        // Prefer the stable R2 URL when available; fall back to the
        // provider's temp CDN if storage upload hasn't completed yet.
        const url =
          result.storage_urls?.[0] ??
          result.imageUrl ??
          result.images?.[0]?.url ??
          result.images?.[0]?.imageUrl;
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
    .command('replicate')
    .description(
      'Re-create a reference image ad with your product (the /templates product drop). Reference = a template id or any public ad image; ' +
      'your product photos replace the product in it, layout / copy style / mood stay. One job, `--num` variations (default 2); ' +
      'each result is saved to your library. Burns credits like `image generate` in edit mode — check `quickdesign cost` first',
    )
    .option('--template <id>', 'Image template id (from `quickdesign template list`). Pass this or --reference', (v) => parseInt(v, 10))
    .option('--reference <url|path>', 'Any image ad to re-create: public URL or local path (auto-uploaded), e.g. a Spy ad image. Pass this or --template')
    .option('--product <url|path>', `Product photo URL or local path (auto-uploaded; repeatable, 1-${REPLICATE_MAX_PRODUCTS}). All of them are featured`, collect, [])
    .option('--brand-kit <uuid>', 'Brand kit: its logos go into the ad as-is; name, colors, fonts, voice, offer and tagline steer copy and styling')
    .option('--notes <text>', `Your own instructions (up to ${REPLICATE_MAX_NOTES} chars), e.g. "keep the headline, swap the price to $49". Highest priority`)
    .option('--num <n>', `Variations to make (1-${REPLICATE_MAX_NUM}, default 2)`, (v) => parseInt(v, 10))
    .option('--resolution <res>', `${REPLICATE_RESOLUTIONS.join(' | ')} (default 1K)`)
    .option('--aspect-ratio <ratio>', `${REPLICATE_ASPECTS.join(' | ')} (default: the reference's own format)`)
    .option('-m, --model <slug>', "Image model slug (default: the registry's latest image-edit model)")
    .option('--wait', 'Block until every variation completes and return the result URL(s)', false)
    .option('--timeout <ms>', 'Wait timeout in ms', (v) => parseInt(v, 10), 600_000)
    .option('-o, --output <path>', 'Save the first variation to this path, the others next to it as <name>-2<ext>, … (implies --wait)')
    .action(async (opts: {
      template?: number;
      reference?: string;
      product?: string[];
      brandKit?: string;
      notes?: string;
      num?: number;
      resolution?: string;
      aspectRatio?: string;
      model?: string;
      wait?: boolean;
      timeout?: number;
      output?: string;
    }) => {
      try {
        const hasTemplate = opts.template !== undefined;
        if (hasTemplate === Boolean(opts.reference)) fail('Pass exactly one of --template <id> or --reference <url|path>', 2);
        if (hasTemplate && !(Number.isInteger(opts.template) && (opts.template as number) > 0)) {
          fail('--template must be a positive whole number (a template id from `quickdesign template list`)', 2);
        }
        const products = opts.product ?? [];
        if (products.length === 0) fail('At least one --product photo is required', 2);
        if (products.length > REPLICATE_MAX_PRODUCTS) fail(`At most ${REPLICATE_MAX_PRODUCTS} --product photos, got ${products.length}`, 2);
        if (opts.num !== undefined && !(Number.isInteger(opts.num) && opts.num >= 1 && opts.num <= REPLICATE_MAX_NUM)) {
          fail(`--num must be 1-${REPLICATE_MAX_NUM}`, 2);
        }
        if (opts.resolution !== undefined && !REPLICATE_RESOLUTIONS.includes(opts.resolution)) {
          fail(`--resolution must be one of ${REPLICATE_RESOLUTIONS.join(', ')}`, 2);
        }
        if (opts.aspectRatio !== undefined && !REPLICATE_ASPECTS.includes(opts.aspectRatio)) {
          fail(`--aspect-ratio must be one of ${REPLICATE_ASPECTS.join(', ')}`, 2);
        }
        if (opts.notes !== undefined && opts.notes.trim().length > REPLICATE_MAX_NOTES) {
          fail(`--notes is limited to ${REPLICATE_MAX_NOTES} characters`, 2);
        }

        const toUrl = (src: string) => (looksLikeLocalPath(src) ? ensureRemoteUrl(src) : Promise.resolve(src));
        const [referenceUrl, productUrls] = await Promise.all([
          opts.reference ? toUrl(opts.reference) : Promise.resolve(undefined),
          Promise.all(products.map(toUrl)),
        ]);

        const args: Record<string, unknown> = {
          ...(hasTemplate ? { template_id: opts.template } : { reference_image_url: referenceUrl }),
          product_image_urls: productUrls,
          ...(opts.brandKit ? { brand_kit_id: opts.brandKit } : {}),
          ...(opts.notes?.trim() ? { notes: opts.notes.trim() } : {}),
          ...(opts.num !== undefined ? { num: opts.num } : {}),
          ...(opts.resolution ? { resolution: opts.resolution } : {}),
          ...(opts.aspectRatio ? { aspect_ratio: opts.aspectRatio } : {}),
          ...(opts.model ? { model: opts.model } : {}),
        };
        // The product drop has no REST route of its own; it is the public MCP
        // tool quickdesign_replicate_ad on /api/mcp (same bearer).
        const result = await callMcpTool('quickdesign_replicate_ad', args, {
          timeoutMs: 120_000,
          unavailableMessage: REPLICATE_UNAVAILABLE,
        });
        const textPart = result.content.find((c): c is { type: 'text'; text: string } => c.type === 'text');
        if (result.isError) fail(textPart?.text ?? 'Replicate Ads failed');
        let started: ReplicateStarted;
        try {
          started = JSON.parse(textPart?.text ?? '') as ReplicateStarted;
        } catch {
          fail(`Unexpected reply from the server: ${(textPart?.text ?? '').slice(0, 300)}`);
        }
        const requestId = started!.request_id;
        if (!requestId) fail(`No request_id in the reply: ${JSON.stringify(started!)}`);
        const requestIds = started!.request_ids?.length ? started!.request_ids : [requestId!];

        const shouldWait = opts.wait === true || Boolean(opts.output);
        if (!shouldWait) {
          emitJson({
            request_id: requestId,
            request_ids: requestIds,
            status: started!.status ?? 'queued',
            model: started!.model,
            token_cost: started!.token_cost,
            aspect_ratio: started!.aspect_ratio,
          });
          return;
        }

        const spin = ora({ text: `Waiting for ${requestIds.length} variation(s) (${requestId})…`, stream: process.stderr }).start();
        const pending = new Set(requestIds);
        const results: Array<{ request_id: string; url: string; designId?: string }> = [];
        await pollUntilDone<true>(async () => {
          for (const id of [...pending]) {
            const s = await request<StatusResponse>(`/api/image-generation/status/${id}`);
            if (s.status === 'failed') return { done: false, error: s.error ?? `Variation ${id} failed` };
            if (s.status !== 'completed') continue;
            const r = await request<ResultResponse>(`/api/image-generation/result/${id}`);
            const url = r.storage_urls?.[0] ?? r.imageUrl ?? r.images?.[0]?.url ?? r.images?.[0]?.imageUrl;
            if (!url) return { done: false, error: `Result ${id} had no image URL` };
            results.push({ request_id: id, url, designId: r.design_id });
            pending.delete(id);
          }
          spin.text = `Waiting for ${pending.size} of ${requestIds.length} variation(s) (${requestId})…`;
          return pending.size === 0 ? { done: true, result: true } : { done: false };
        }, { intervalMs: 3000, timeoutMs: opts.timeout });
        spin.succeed(`${results.length} variation(s) ready`);
        // Keep the server's order, not completion order.
        results.sort((a, b) => requestIds.indexOf(a.request_id) - requestIds.indexOf(b.request_id));

        if (opts.output) {
          const dot = opts.output.lastIndexOf('.');
          const slash = Math.max(opts.output.lastIndexOf('/'), opts.output.lastIndexOf('\\'));
          const [base, ext] = dot > slash ? [opts.output.slice(0, dot), opts.output.slice(dot)] : [opts.output, ''];
          const paths = results.map((_, i) => (i === 0 ? opts.output! : `${base}-${i + 1}${ext}`));
          for (let i = 0; i < results.length; i++) {
            await downloadTo(results[i].url, paths[i]);
            note(`Saved ${paths[i]}`);
          }
          emitJson({ request_id: requestId, results: results.map((r, i) => ({ ...r, outputPath: paths[i] })) });
        } else {
          emitJson({ request_id: requestId, results });
        }
      } catch (err) { fail(err); }
    });

  image
    .command('status')
    .description('Check status of an image generation job')
    .argument('<requestId>', 'Request ID returned by `generate`')
    .action(async (requestId: string) => {
      try {
        const s = await request<StatusResponse>(`/api/image-generation/status/${requestId}`);
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
        const r = await request<ResultResponse>(`/api/image-generation/result/${requestId}`);
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
          const s = await request<StatusResponse>(`/api/image-generation/status/${requestId}`);
          if (s.status === 'failed') return { done: false, error: s.error ?? 'Generation failed' };
          if (s.status !== 'completed') {
            spin.text = `Waiting for image (${requestId})… ${s.status}${s.progress != null ? ` · ${s.progress}%` : ''}`;
            return { done: false };
          }
          const r = await request<ResultResponse>(`/api/image-generation/result/${requestId}`);
          return { done: true, result: r };
        }, { intervalMs: opts.interval, timeoutMs: opts.timeout });
        spin.succeed('Image ready');

        // Prefer the stable R2 URL when available; fall back to the
        // provider's temp CDN if storage upload hasn't completed yet.
        const url =
          result.storage_urls?.[0] ??
          result.imageUrl ??
          result.images?.[0]?.url ??
          result.images?.[0]?.imageUrl;
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
    .description('List available image models (active in the registry)')
    .action(async () => {
      try {
        // BFF expects exact category names (`image_edit`, `image_generate`...)
        // — fetch all and filter client-side so callers can use the short
        // `image` / `video` family names.
        const r = await request<{ success?: boolean; data?: Array<{ category?: string }> }>(
          '/api/models',
          { auth: false },
        );
        const data = Array.isArray(r?.data)
          ? r.data.filter((m) => typeof m.category === 'string' && m.category.startsWith('image_'))
          : [];
        emitJson({ success: true, data });
      } catch (err) { fail(err); }
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
