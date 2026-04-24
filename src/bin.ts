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

Environment
  QUICKDESIGN_BASE_URL   Override API base (default: https://app.quickdesign.io)
  QUICKDESIGN_TOKEN      Override stored token (CI / scripted use)
`);

registerAuthCommands(program);
registerSpyCommands(program);
registerImageCommands(program);

program.parseAsync(process.argv).catch((err: Error) => {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
});
