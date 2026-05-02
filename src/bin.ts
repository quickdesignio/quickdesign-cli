#!/usr/bin/env node
/**
 * Entry point — wires the Commander tree together.
 *
 * Keep this file thin; all real logic lives in the command modules so each
 * subcommand can be independently edited / tested.
 */
import { Command } from 'commander';
import { registerAuthCommands } from './commands/auth.js';
import { registerSpyCommands } from './commands/spy.js';
import { registerImageCommands } from './commands/image.js';
import { registerVideoCommands } from './commands/video.js';
import { registerBrandCommands } from './commands/brand.js';
import { registerAdCreatorCommands } from './commands/ad-creator.js';
import { registerDesignCommands } from './commands/design.js';
import { registerInitCommand } from './commands/init.js';
import { registerCostCommand } from './commands/cost.js';
import pkg from '../package.json' with { type: 'json' };

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

Environment
  QUICKDESIGN_BASE_URL             Override API base (default: https://app.quickdesign.io)
  QUICKDESIGN_TOKEN                Override stored token (CI / scripted use)
  QUICKDESIGN_SUPABASE_URL         Override Supabase REST base (for \`design\` subcommands)
  QUICKDESIGN_SUPABASE_ANON_KEY    Supabase anon key (required for \`design\` subcommands)
`);

registerAuthCommands(program);
registerSpyCommands(program);
registerImageCommands(program);
registerVideoCommands(program);
registerBrandCommands(program);
registerAdCreatorCommands(program);
registerDesignCommands(program);
registerInitCommand(program);
registerCostCommand(program);

program.parseAsync(process.argv).catch((err: Error) => {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
});
