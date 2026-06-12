#!/usr/bin/env node
/**
 * Entry point — wires the Commander tree together.
 *
 * Keep this file thin; all real logic lives in the command modules so each
 * subcommand can be independently edited / tested.
 */
import { Command } from 'commander';
import { readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { registerAuthCommands } from './commands/auth.js';
import { registerSpyCommands } from './commands/spy.js';
import { registerImageCommands } from './commands/image.js';
import { registerVideoCommands } from './commands/video.js';
import { registerBrandCommands } from './commands/brand.js';
import { registerAdCreatorCommands } from './commands/ad-creator.js';
import { registerDesignCommands } from './commands/design.js';
import { registerMetaCommands } from './commands/meta.js';
import { registerInitCommand } from './commands/init.js';
import { registerCostCommand } from './commands/cost.js';
import pkg from '../package.json' with { type: 'json' };

/**
 * Stale-skill check. The skill bundle ships INSIDE the npm package (under
 * `skills/quickdesign/`) but is only copied to the user's `~/.claude/` dir
 * when they explicitly run `quickdesign init --skill-only --force`. So a
 * plain `npm install -g @quickdesign/cli@latest` upgrades the CLI but leaves
 * the user's installed skill stale — which is the silent failure mode that
 * keeps producing wrong-default behavior across sessions.
 *
 * To make it loud-but-non-blocking, `npm run stamp-skill-version` writes the
 * current package.json version to `skills/quickdesign/.version`. `init` copies
 * that file with the skill, so `~/.claude/skills/quickdesign/.version` records
 * the version the user installed. On every CLI startup we compare; if older,
 * we print one stderr line. We never auto-overwrite — that could clobber
 * user edits.
 */
function checkSkillStaleness(currentVersion: string): void {
  try {
    const installed = readFileSync(
      path.join(homedir(), '.claude', 'skills', 'quickdesign', '.version'),
      'utf-8',
    ).trim();
    if (!installed || installed === currentVersion) return;
    if (!isOlderSemver(installed, currentVersion)) return; // user's local is newer or equal
    process.stderr.write(
      `note: quickdesign skill at ~/.claude/skills/quickdesign is v${installed}; ` +
        `CLI is v${currentVersion}. Run \`quickdesign init --skill-only --force\` ` +
        `to refresh.\n`,
    );
  } catch {
    // Skill not installed yet, .version missing (older install), or any IO
    // error. Never block the CLI on this — silent return is fine.
  }
}

/**
 * Duplicate-skill check. Claude Code loads EVERY directory under
 * ~/.claude/skills as a skill, keyed by the dir name but triggered by the
 * frontmatter description. A manual backup like `quickdesign.bak.<ts>` whose
 * SKILL.md still says `name: quickdesign` therefore shows up as a second,
 * stale quickdesign skill that sessions can wrongly pick. Warn (one stderr
 * line), never delete — same loud-but-non-blocking policy as the staleness
 * check above.
 */
function checkDuplicateSkills(): void {
  try {
    const skillsRoot = path.join(homedir(), '.claude', 'skills');
    for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'quickdesign' || !entry.name.startsWith('quickdesign')) continue;
      let head = '';
      try {
        head = readFileSync(path.join(skillsRoot, entry.name, 'SKILL.md'), 'utf-8').slice(0, 500);
      } catch {
        continue; // no SKILL.md → not loaded as a skill
      }
      if (/^name:\s*quickdesign\s*$/m.test(head)) {
        process.stderr.write(
          `note: duplicate quickdesign skill at ~/.claude/skills/${entry.name} — ` +
            `Claude Code loads it as a second, stale skill. Remove it: ` +
            `rm -rf ~/.claude/skills/${entry.name}\n`,
        );
      }
    }
  } catch {
    // Skills dir missing or unreadable — nothing to warn about.
  }
}

function isOlderSemver(a: string, b: string): boolean {
  const [a1 = 0, a2 = 0, a3 = 0] = a.split('.').map((s) => parseInt(s, 10) || 0);
  const [b1 = 0, b2 = 0, b3 = 0] = b.split('.').map((s) => parseInt(s, 10) || 0);
  if (a1 !== b1) return a1 < b1;
  if (a2 !== b2) return a2 < b2;
  return a3 < b3;
}

const program = new Command();

program
  .name('quickdesign')
  .description('QuickDesign CLI — image + video generation, spy brands, brand analysis')
  .version((pkg as { version: string }).version ?? '0.0.0')
  .configureHelp({ sortSubcommands: true });

program
  .addHelpText('after', `
Examples
  $ quickdesign login
  $ quickdesign whoami
  $ quickdesign spy brands --search Ottasilver --human
  $ quickdesign spy brand-ads <id> --status active --sort most_impressions
  $ quickdesign image generate -p "studio photo of a silver bracelet" --wait -o ./out.jpg
  $ quickdesign video generate --provider sora2 -p "a cat on the beach" --duration 4 --wait -o ./cat.mp4
  $ quickdesign video generate --provider seedance \\
      --reference-image https://cdn/bracelet.jpg --reference-image https://cdn/model.jpg \\
      -p "@Image2 wearing @Image1" --wait -o ./r2v.mp4
  $ quickdesign brand dna https://kizik.com
  $ quickdesign ad-creator advantage-plus --product-url https://kizik.com/products/bowen --wait -o ./ads
  $ quickdesign design list --limit 10
  $ quickdesign meta accounts --human
  $ quickdesign meta radar --account act_123 --compute --human
  $ quickdesign meta publish --account act_123 --page 456 --name "Summer Sale" \\
      --objective OUTCOME_SALES --budget 50 --design 1234 --design 5678 --wait --human

Environment
  QUICKDESIGN_BASE_URL             Override API base (default: https://app.quickdesign.io)
  QUICKDESIGN_TOKEN                Override stored token (CI / scripted use)
  QUICKDESIGN_SUPABASE_URL         Override Supabase REST base (for \`design\` subcommands)
  QUICKDESIGN_SUPABASE_ANON_KEY    Supabase API key — accepts both the legacy anon JWT and the
                                   new sb_publishable_... key. Also settable via
                                   \`quickdesign auth config set supabase_anon_key <key>\`.
`);

registerAuthCommands(program);
registerSpyCommands(program);
registerImageCommands(program);
registerVideoCommands(program);
registerBrandCommands(program);
registerAdCreatorCommands(program);
registerDesignCommands(program);
registerMetaCommands(program);
registerInitCommand(program);
registerCostCommand(program);

checkSkillStaleness((pkg as { version: string }).version ?? '0.0.0');
checkDuplicateSkills();

program.parseAsync(process.argv).catch((err: Error) => {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
});
