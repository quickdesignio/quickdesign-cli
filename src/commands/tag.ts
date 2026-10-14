/**
 * `quickdesign tag list|add|remove|rename|delete`
 *
 * Your team's own design tags ("winner", "revize", "black friday"): one set
 * per team (or just you without a team) — the same tags the app shows on
 * cards. Served by the BFF at /api/design-tags. These are not the template
 * library's tags; see `template filters` for those.
 */
import { Command } from 'commander';
import kleur from 'kleur';
import { request } from '../client.js';
import { emitJson, fail, note } from '../utils/output.js';
import {
  type ApplyTagsResult,
  MAX_APPLY_DESIGNS,
  MAX_TAGS_PER_DESIGN,
  collect,
  dot,
  failTagRequest,
  fetchTags,
  parseDesignIds,
  plural,
  uniqueNames,
  unwrap,
} from '../utils/design-tags.js';

interface ApplyBody {
  designIds: number[];
  add?: Array<{ name: string }>;
  remove?: Array<{ name: string }>;
  createMissing?: boolean;
}

async function applyTags(body: ApplyBody): Promise<ApplyTagsResult> {
  try {
    return unwrap<ApplyTagsResult>(await request<unknown>('/api/design-tags/apply', { method: 'POST', body }));
  } catch (err) {
    failTagRequest(err);
  }
}

/** What the BFF could not do goes to stderr, so stdout stays the JSON result. */
function warnApply(result: ApplyTagsResult): void {
  if (result.not_found.designs.length > 0) {
    process.stderr.write(kleur.yellow(`designs not found or not yours to tag: ${result.not_found.designs.join(', ')}\n`));
  }
  if (result.not_found.tags.length > 0) {
    process.stderr.write(kleur.yellow(`tags not found: ${result.not_found.tags.join(', ')}\n`));
  }
  if (result.limit_reached.length > 0) {
    process.stderr.write(
      kleur.yellow(`already have ${MAX_TAGS_PER_DESIGN} tags, skipped: ${result.limit_reached.join(', ')}\n`),
    );
  }
  if (result.created_tags.length > 0) {
    note(`created ${result.created_tags.length === 1 ? 'tag' : 'tags'}: ${result.created_tags.map((t) => t.name).join(', ')}`);
  }
}

function tagNamesFrom(raw: string[] | undefined): string[] {
  const names = uniqueNames(raw ?? []);
  if (names.length === 0) fail('Give at least one --tag <name>', 2);
  return names;
}

interface ApplyOpts {
  tag?: string[];
  human?: boolean;
}

/** `tag add` and `tag remove`: one POST /api/design-tags/apply, add also creating missing tags. */
async function runApply(designArgs: string[], opts: ApplyOpts, mode: 'add' | 'remove'): Promise<void> {
  const designIds = parseDesignIds(designArgs);
  const refs = tagNamesFrom(opts.tag).map((name) => ({ name }));
  const result = await applyTags(
    mode === 'add' ? { designIds, add: refs, createMissing: true } : { designIds, remove: refs },
  );
  warnApply(result);
  if (!opts.human) {
    emitJson(result);
    return;
  }
  if (mode === 'add') {
    process.stdout.write(`${kleur.green('Added')} ${result.added.length}\n`);
    process.stdout.write(`Already there ${result.already.length}\n`);
  } else {
    process.stdout.write(`${kleur.green('Removed')} ${result.removed.length}\n`);
  }
}

export function registerTagCommands(program: Command): void {
  const tag = program
    .command('tag')
    .description("Your team's own design tags (winner, revize, …) — not the template library's tags");

  tag
    .command('list')
    .description('List your tags with how many designs carry each, most recently used first')
    .option('--human', 'Pretty-print')
    .action(async (opts: { human?: boolean }) => {
      try {
        const tags = await fetchTags();
        if (!opts.human) {
          emitJson({ tags });
          return;
        }
        if (tags.length === 0) {
          note('No tags yet — add one with `quickdesign tag add <design-id> --tag <name>`');
          return;
        }
        for (const t of tags) {
          process.stdout.write(
            `${dot(t.color)} ${t.name.padEnd(32)}  ${plural(t.count, 'design').padEnd(12)}  ${kleur.dim(t.id)}\n`,
          );
        }
      } catch (err) { fail(err); }
    });

  tag
    .command('add')
    .description('Tag designs; tags that do not exist yet are created. Spends no credits')
    .argument('<design-ids...>', `Design ids (from \`design list\`, \`collection get\` or a job's result_design_id), up to ${MAX_APPLY_DESIGNS}`)
    .option('--tag <name>', 'Tag name, any case (repeatable)', collect, [] as string[])
    .option('--human', 'Pretty-print')
    .action(async (designArgs: string[], opts: ApplyOpts) => {
      try { await runApply(designArgs, opts, 'add'); } catch (err) { fail(err); }
    });

  tag
    .command('remove')
    .description('Take tags off designs (the tags themselves stay). Spends no credits')
    .argument('<design-ids...>', `Design ids, up to ${MAX_APPLY_DESIGNS}`)
    .option('--tag <name>', 'Tag name, any case (repeatable)', collect, [] as string[])
    .option('--human', 'Pretty-print')
    .action(async (designArgs: string[], opts: ApplyOpts) => {
      try { await runApply(designArgs, opts, 'remove'); } catch (err) { fail(err); }
    });
}
