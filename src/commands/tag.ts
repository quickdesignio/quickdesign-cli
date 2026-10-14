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
import { confirm, emitJson, fail, note } from '../utils/output.js';
import {
  type ApplyTagsResult,
  type DesignTag,
  type TagColor,
  MAX_APPLY_DESIGNS,
  MAX_TAGS_PER_DESIGN,
  TAG_COLORS,
  collect,
  dot,
  failTagRequest,
  fetchTags,
  parseDesignIds,
  plural,
  resolveTag,
  tagColor,
  tagName,
  uniqueRefs,
  UnexpectedResponse,
  type TagRef,
  unwrap,
} from '../utils/design-tags.js';

interface ApplyBody {
  designIds: number[];
  add?: TagRef[];
  remove?: TagRef[];
  createMissing?: boolean;
}

async function applyTags(body: ApplyBody): Promise<ApplyTagsResult> {
  try {
    const result = unwrap<ApplyTagsResult>(await request<unknown>('/api/design-tags/apply', { method: 'POST', body }));
    if (!result || !Array.isArray(result.added)) throw new UnexpectedResponse();
    return result;
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

function tagRefsFrom(raw: string[] | undefined): TagRef[] {
  const refs = uniqueRefs(raw ?? []);
  if (refs.length === 0) fail('Give at least one --tag <name>', 2);
  return refs;
}

interface ApplyOpts {
  tag?: string[];
  human?: boolean;
}

/** `tag add` and `tag remove`: one POST /api/design-tags/apply, add also creating missing tags. */
async function runApply(designArgs: string[], opts: ApplyOpts, mode: 'add' | 'remove'): Promise<void> {
  const designIds = parseDesignIds(designArgs);
  const refs = tagRefsFrom(opts.tag);
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

async function patchTag(id: string, patch: { name?: string; color?: TagColor }): Promise<DesignTag> {
  try {
    return unwrap<{ tag: DesignTag }>(await request<unknown>(`/api/design-tags/${id}`, { method: 'PATCH', body: patch })).tag;
  } catch (err) {
    failTagRequest(err);
  }
}

async function deleteTag(id: string): Promise<number> {
  try {
    return unwrap<{ removed_from: number }>(await request<unknown>(`/api/design-tags/${id}`, { method: 'DELETE' })).removed_from;
  } catch (err) {
    failTagRequest(err);
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
    .option('--tag <name>', 'Tag name (any case) or id (repeatable)', collect, [] as string[])
    .option('--human', 'Pretty-print')
    .action(async (designArgs: string[], opts: ApplyOpts) => {
      try { await runApply(designArgs, opts, 'add'); } catch (err) { fail(err); }
    });

  tag
    .command('remove')
    .description('Take tags off designs (the tags themselves stay). Spends no credits')
    .argument('<design-ids...>', `Design ids, up to ${MAX_APPLY_DESIGNS}`)
    .option('--tag <name>', 'Tag name (any case) or id (repeatable)', collect, [] as string[])
    .option('--human', 'Pretty-print')
    .action(async (designArgs: string[], opts: ApplyOpts) => {
      try { await runApply(designArgs, opts, 'remove'); } catch (err) { fail(err); }
    });

  tag
    .command('rename')
    .description('Rename a tag and/or change its color, for your whole team')
    .argument('<tag>', 'Tag name (any case) or id, from `tag list`')
    .argument('[new-name]', 'New name')
    .option('--color <color>', `New color: ${TAG_COLORS.join(' | ')}`)
    .option('--human', 'Pretty-print')
    .action(async (ref: string, newName: string | undefined, opts: { color?: string; human?: boolean }) => {
      try {
        const patch: { name?: string; color?: TagColor } = {};
        if (newName !== undefined) patch.name = tagName(newName);
        if (opts.color !== undefined) patch.color = tagColor(opts.color);
        if (patch.name === undefined && patch.color === undefined) fail('Give a new name, --color, or both', 2);
        const current = await resolveTag(ref);
        const updated = await patchTag(current.id, patch);
        if (opts.human) {
          process.stdout.write(`${dot(updated.color)} ${current.name} → ${updated.name}\n`);
          return;
        }
        emitJson({ tag: updated });
      } catch (err) { fail(err); }
    });

  tag
    .command('delete')
    .description('Delete a tag for your whole team — it comes off every design that carries it')
    .argument('<tag>', 'Tag name (any case) or id, from `tag list`')
    .option('--yes', 'Skip the confirmation prompt (required when not on a TTY)', false)
    .option('--human', 'Pretty-print')
    .action(async (ref: string, opts: { yes?: boolean; human?: boolean }) => {
      try {
        // Nobody can answer a prompt from a script or an agent: refuse before touching anything.
        if (!opts.yes && !process.stdin.isTTY) {
          fail('Refusing to delete a tag non-interactively without --yes (it comes off every design that carries it).');
        }
        const target = await resolveTag(ref);
        if (!opts.yes) {
          const ok = await confirm(
            `Delete tag "${target.name}"? It comes off ${plural(target.count, 'design')} for your whole team. [y/N] `,
          );
          if (!ok) {
            note('Aborted — tag left unchanged.');
            return;
          }
        }
        const removedFrom = await deleteTag(target.id);
        if (opts.human) {
          process.stdout.write(`Deleted ${target.name} (removed from ${plural(removedFrom, 'design')})\n`);
          return;
        }
        emitJson({ id: target.id, name: target.name, removed_from: removedFrom });
      } catch (err) { fail(err); }
    });
}
