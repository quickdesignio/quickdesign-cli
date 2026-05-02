/**
 * `quickdesign cost` — pulls the live `ai_models` registry and either lists
 * cost configs for every active model (no args / --category filter) or
 * computes the exact credit cost for a specific model + params.
 *
 *   quickdesign cost                                          # all models
 *   quickdesign cost --category video                         # filter
 *   quickdesign cost seedance-2.0-r2v -d 12 -r 1080p          # compute
 *   quickdesign cost nano-banana-2 -r 2K --num 2              # compute (image)
 *   quickdesign cost fal-auto-subtitle -d 24                  # compute (sub)
 *   quickdesign cost topaz-video-upscale -d 30 -r 4k          # compute (upscale)
 *   quickdesign cost --json                                   # machine readable
 *
 * Cost-config shapes mirror the BFF's `modelRegistry.service.ts` formulas:
 *   - fixed:           { type, cost }
 *   - base_multiplier: { type, base, per_image, multipliers: {0.5K..4K} }
 *   - duration_linear: { type, per_5s, min? }
 *   - duration_lookup: { type, costs: { '<seconds>': <credits> } }
 *   - per_second:      { type, rates: { '<res>': <rate> }, pro_multiplier?, fps_60_multiplier? }
 */
import { Command } from 'commander';
import { request } from '../client.js';
import { emitJson, fail, note } from '../utils/output.js';

interface RegistryModel {
  slug: string;
  name?: string;
  category?: string;
  subCategory?: string | null;
  provider?: string;
  costConfig?: CostConfig;
  durations?: string[] | null;
  aspectRatios?: string[] | null;
  resolutions?: string[] | null;
}

type CostConfig =
  | { type: 'fixed'; cost: number }
  | { type: 'base_multiplier'; base: number; per_image?: boolean; multipliers: Record<string, number> }
  | { type: 'duration_linear'; per_5s: number; min?: number }
  | { type: 'duration_lookup'; costs: Record<string, number> }
  | {
      type: 'per_second';
      rates: Record<string, number>;
      pro_multiplier?: number;
      fps_60_multiplier?: number;
    };

interface ComputeOpts {
  duration?: number;
  resolution?: string;
  num?: number;
  fps60?: boolean;
  pro?: boolean;
}

interface ComputeResult {
  ok: boolean;
  cost?: number;
  error?: string;
  breakdown?: string;
}

export function computeCost(cfg: CostConfig, opts: ComputeOpts): ComputeResult {
  switch (cfg.type) {
    case 'fixed':
      return { ok: true, cost: cfg.cost, breakdown: `flat ${cfg.cost}cr` };

    case 'base_multiplier': {
      const { base, multipliers } = cfg;
      const res = opts.resolution;
      if (!res) return { ok: false, error: 'resolution required (e.g. --resolution 2K)' };
      // Multipliers are stored case-sensitively but users pass mixed cases.
      // Match case-insensitively to be friendly.
      const key = Object.keys(multipliers).find((k) => k.toLowerCase() === res.toLowerCase());
      if (!key) {
        return {
          ok: false,
          error: `resolution '${res}' not in cost multipliers; valid: ${Object.keys(multipliers).join(', ')}`,
        };
      }
      const mult = multipliers[key]!;
      const num = Math.max(1, opts.num ?? 1);
      const total = Math.ceil(base * mult * num);
      return {
        ok: true,
        cost: total,
        breakdown: `base=${base} × ${key}×${mult} × num=${num} = ${total}cr`,
      };
    }

    case 'duration_linear': {
      const dur = opts.duration;
      if (dur === undefined) return { ok: false, error: 'duration required (e.g. --duration 12)' };
      if (dur <= 0) return { ok: false, error: 'duration must be > 0' };
      const linear = (dur / 5) * cfg.per_5s;
      const minCost = cfg.min ?? 0;
      const total = Math.ceil(Math.max(linear, minCost));
      return {
        ok: true,
        cost: total,
        breakdown:
          minCost > 0
            ? `(${dur}s / 5) × ${cfg.per_5s} = ${linear.toFixed(1)}cr → max(min=${minCost}, ${linear.toFixed(1)}) = ${total}cr`
            : `(${dur}s / 5) × ${cfg.per_5s} = ${total}cr`,
      };
    }

    case 'duration_lookup': {
      const dur = opts.duration;
      if (dur === undefined) return { ok: false, error: 'duration required (e.g. --duration 12)' };
      const key = String(Math.round(dur));
      const cost = cfg.costs[key];
      if (cost === undefined) {
        return {
          ok: false,
          error: `duration ${dur}s not in lookup; valid: ${Object.keys(cfg.costs).map((d) => d + 's').join(', ')}`,
        };
      }
      return { ok: true, cost, breakdown: `lookup[${dur}s] = ${cost}cr` };
    }

    case 'per_second': {
      const dur = opts.duration;
      const res = opts.resolution;
      if (dur === undefined) return { ok: false, error: 'duration required (e.g. --duration 12)' };
      if (!res) {
        return {
          ok: false,
          error: `resolution required (e.g. --resolution 1080p); valid: ${Object.keys(cfg.rates).join(', ')}`,
        };
      }
      const key = Object.keys(cfg.rates).find((k) => k.toLowerCase() === res.toLowerCase());
      if (!key) {
        return {
          ok: false,
          error: `resolution '${res}' not in rates; valid: ${Object.keys(cfg.rates).join(', ')}`,
        };
      }
      const rate = cfg.rates[key]!;
      let total = rate * dur;
      const parts = [`${rate}/s × ${dur}s = ${total.toFixed(2)}`];
      if (opts.pro && cfg.pro_multiplier) {
        total *= cfg.pro_multiplier;
        parts.push(`× pro=${cfg.pro_multiplier}`);
      }
      if (opts.fps60 && cfg.fps_60_multiplier) {
        total *= cfg.fps_60_multiplier;
        parts.push(`× fps60=${cfg.fps_60_multiplier}`);
      }
      const cost = Math.ceil(total);
      parts.push(`= ${cost}cr`);
      return { ok: true, cost, breakdown: parts.join(' ') };
    }

    default:
      return { ok: false, error: `unknown cost type: ${(cfg as { type: string }).type}` };
  }
}

function summarizeCostConfig(cfg: CostConfig | undefined): string {
  if (!cfg) return '(no cost config)';
  switch (cfg.type) {
    case 'fixed':
      return `fixed ${cfg.cost}cr`;
    case 'base_multiplier': {
      const mults = Object.entries(cfg.multipliers)
        .sort()
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      const perImage = cfg.per_image ? ' × num' : '';
      return `${cfg.base} × ${mults}${perImage}`;
    }
    case 'duration_linear': {
      const minPart = cfg.min ? ` (min ${cfg.min}cr)` : '';
      return `${cfg.per_5s}cr per 5s${minPart}`;
    }
    case 'duration_lookup':
      return Object.entries(cfg.costs)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([d, c]) => `${d}s=${c}`)
        .join(' ');
    case 'per_second': {
      const rates = Object.entries(cfg.rates)
        .map(([k, v]) => `${k}=${v}/s`)
        .join(' ');
      const extras: string[] = [];
      if (cfg.pro_multiplier) extras.push(`pro×${cfg.pro_multiplier}`);
      if (cfg.fps_60_multiplier) extras.push(`fps60×${cfg.fps_60_multiplier}`);
      return rates + (extras.length ? ' [' + extras.join(',') + ']' : '');
    }
    default:
      return JSON.stringify(cfg);
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

export function registerCostCommand(program: Command): void {
  program
    .command('cost')
    .description('Show pricing for AI models (live from the registry)')
    .argument('[model-slug]', 'Compute cost for one specific model (omit to list all)')
    .option('-c, --category <name>', 'Filter list by category prefix (image | video | video_upscale | video_post_processing)')
    .option('-d, --duration <n>', 'Duration in seconds (per_second / duration_lookup / duration_linear models)', (v) => parseFloat(v))
    .option('-r, --resolution <r>', 'Resolution key (e.g. 0.5K | 1K | 2K | 4K | 720p | 1080p | 4k)')
    .option('--num <n>', 'Number of images (base_multiplier with per_image=true)', (v) => parseInt(v, 10), 1)
    .option('--fps60', 'Apply 60fps multiplier where available (some upscalers)', false)
    .option('--pro', 'Apply pro-tier multiplier where available (some upscalers)', false)
    .option('--json', 'Emit JSON instead of human table', false)
    .action(async (modelSlug: string | undefined, opts: {
      category?: string;
      duration?: number;
      resolution?: string;
      num?: number;
      fps60?: boolean;
      pro?: boolean;
      json?: boolean;
    }) => {
      try {
        const r = await request<{ data?: RegistryModel[] }>('/api/models', { auth: false });
        const all = Array.isArray(r?.data) ? r.data : [];

        // Compute mode — one model, with params.
        if (modelSlug) {
          const m = all.find((x) => x.slug === modelSlug);
          if (!m) fail(`Model '${modelSlug}' not found in registry. Try \`quickdesign cost\` to list.`, 2);
          const result = computeCost(m!.costConfig as CostConfig, {
            duration: opts.duration,
            resolution: opts.resolution,
            num: opts.num,
            fps60: opts.fps60,
            pro: opts.pro,
          });
          if (!result.ok) fail(result.error ?? 'compute failed', 2);
          if (opts.json) {
            emitJson({
              slug: m!.slug,
              category: m!.category,
              cost_credits: result.cost,
              breakdown: result.breakdown,
              params: {
                duration: opts.duration,
                resolution: opts.resolution,
                num: opts.num,
                fps60: opts.fps60 || undefined,
                pro: opts.pro || undefined,
              },
            });
          } else {
            note(`${m!.slug}  (${m!.category})`);
            note(`  cost     : ${result.cost} credits`);
            note(`  formula  : ${result.breakdown}`);
            if (m!.durations?.length) note(`  durations: ${m!.durations.join(', ')}`);
            if (m!.resolutions?.length) note(`  res keys : ${m!.resolutions.join(', ')}`);
          }
          return;
        }

        // List mode.
        const filtered = opts.category
          ? all.filter((m) => typeof m.category === 'string' && m.category.startsWith(opts.category!))
          : all;

        if (opts.json) {
          emitJson({
            success: true,
            data: filtered.map((m) => ({
              slug: m.slug,
              category: m.category,
              provider: m.provider,
              costConfig: m.costConfig,
            })),
          });
          return;
        }

        if (filtered.length === 0) {
          note('No models matched.');
          return;
        }

        // Group by category for readability.
        const byCategory = new Map<string, RegistryModel[]>();
        for (const m of filtered) {
          const key = m.category ?? 'unknown';
          if (!byCategory.has(key)) byCategory.set(key, []);
          byCategory.get(key)!.push(m);
        }
        const sortedCategories = Array.from(byCategory.keys()).sort();

        for (const cat of sortedCategories) {
          process.stderr.write(`\n  ── ${cat} ────────────────────────────────────\n`);
          for (const m of byCategory.get(cat)!) {
            const slug = pad(m.slug, 28);
            const summary = summarizeCostConfig(m.costConfig);
            process.stderr.write(`  ${slug}  ${summary}\n`);
          }
        }
        process.stderr.write(
          `\n  Compute exact cost: \`quickdesign cost <slug> [-d <secs>] [-r <res>] [--num <n>]\`\n` +
          `  JSON output      : add \`--json\`\n` +
          `  Source           : live ai_models table via /api/models (5-min cached on BFF)\n` +
          `  Note             : a few seedance / kling / sora2 controllers fall back to a legacy flat\n` +
          `                     rate when the registry cache is cold — your actual job's token_cost\n` +
          `                     can be higher than what's shown here. Compare with \`quickdesign video\n` +
          `                     status <provider> <jobId>\` to see the real charge per job.\n\n`,
        );
      } catch (err) { fail(err); }
    });
}
