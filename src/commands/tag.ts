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
import { emitJson, fail, note } from '../utils/output.js';
import { dot, fetchTags, plural } from '../utils/design-tags.js';

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
}
