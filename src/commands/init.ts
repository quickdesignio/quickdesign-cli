/**
 * `quickdesign init` — bootstrap a Claude Code session for the QuickDesign CLI.
 *
 * What it does (each step opt-out via flags):
 *   1. Doctor check     — verify ffmpeg / ffprobe present (warn if missing).
 *   2. Skill install    — copy bundled skill (skills/quickdesign/) into
 *                         ~/.claude/skills/quickdesign/. Refuses to overwrite
 *                         existing files unless --force.
 *   3. Auth login       — runs the standard browser OAuth handshake to drop a
 *                         token in the user's config dir, unless --no-auth.
 *
 * Flags:
 *   --force        Overwrite existing skill files.
 *   --skill-only   Only install the skill (skip doctor + auth).
 *   --no-skill     Skip skill install.
 *   --no-auth      Skip browser login (use this in CI / scripted setups).
 *   --no-doctor    Skip ffmpeg / ffprobe check.
 *   --skill-dir    Override target skill dir (default: ~/.claude/skills/quickdesign).
 */
import { Command } from 'commander';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fail, note } from '../utils/output.js';

interface InitOptions {
  force?: boolean;
  skillOnly?: boolean;
  skill?: boolean;        // commander inverts --no-skill into skill: false
  auth?: boolean;         // --no-auth → auth: false
  doctor?: boolean;       // --no-doctor → doctor: false
  skillDir?: string;
}

/** Resolve the bundled skill source dir, relative to the compiled bin location. */
function resolveBundledSkillDir(): string {
  // dist/commands/init.js → ../../skills/quickdesign
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../skills/quickdesign'),  // production: dist/commands/init.js
    path.resolve(here, '../../../skills/quickdesign'), // dev: src/commands/init.ts (unlikely path)
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isDirectory()) return c;
  }
  throw new Error(
    `Could not find bundled skill directory. Looked in:\n  ${candidates.join('\n  ')}`,
  );
}

function defaultSkillTargetDir(): string {
  return path.join(homedir(), '.claude', 'skills', 'quickdesign');
}

/** Recursively list all relative file paths under root. */
function walkFiles(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const abs = path.join(root, entry);
    const rel = prefix ? path.join(prefix, entry) : entry;
    const st = statSync(abs);
    if (st.isDirectory()) {
      out.push(...walkFiles(abs, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

function checkDoctor(): { ffmpeg: boolean; ffprobe: boolean } {
  const has = (bin: string): boolean => {
    try {
      const r = spawnSync(bin, ['-version'], { encoding: 'utf-8', stdio: 'pipe' });
      return r.status === 0;
    } catch {
      return false;
    }
  };
  return { ffmpeg: has('ffmpeg'), ffprobe: has('ffprobe') };
}

function printDoctorReport(report: { ffmpeg: boolean; ffprobe: boolean }): void {
  const tick = (ok: boolean) => (ok ? '✔' : '✗');
  note(`Doctor check:`);
  note(`  ${tick(report.ffmpeg)}  ffmpeg   — ${report.ffmpeg ? 'present' : 'MISSING'}`);
  note(`  ${tick(report.ffprobe)}  ffprobe  — ${report.ffprobe ? 'present' : 'MISSING'}`);
  if (!report.ffmpeg || !report.ffprobe) {
    note('');
    note('  ffmpeg / ffprobe are required for multi-segment video pipelines');
    note('  (audio extraction, concat, duration probing). Install hints:');
    note('    macOS:   brew install ffmpeg');
    note('    Linux:   apt install ffmpeg   (or dnf install ffmpeg)');
    note('    Windows: winget install Gyan.FFmpeg');
    note('');
  }
}

async function installSkill(srcDir: string, dstDir: string, force: boolean): Promise<void> {
  mkdirSync(dstDir, { recursive: true });

  // Detect collisions up-front so we can warn before mutating anything.
  const files = walkFiles(srcDir);
  const collisions: string[] = [];
  for (const rel of files) {
    if (existsSync(path.join(dstDir, rel))) collisions.push(rel);
  }

  if (collisions.length > 0 && !force) {
    note(`Skill target dir already has ${collisions.length} file(s) that would be overwritten:`);
    for (const c of collisions.slice(0, 8)) note(`  - ${c}`);
    if (collisions.length > 8) note(`  ... and ${collisions.length - 8} more`);
    note('');
    note('Re-run with --force to overwrite, or pass --skill-dir <path> to install elsewhere.');
    throw new Error('Skill install aborted (existing files; use --force to overwrite)');
  }

  // node 18+ supports cpSync recursive
  cpSync(srcDir, dstDir, { recursive: true, force: true });

  note(`Skill installed → ${dstDir}`);
  note(`  ${files.length} file(s): SKILL.md + ${files.length - 1} reference doc(s)`);
}

async function runAuthLogin(): Promise<void> {
  // Lazy import keeps `init --no-auth` light.
  const { loginAction } = await import('./auth.js');
  note('Opening browser for QuickDesign login…');
  await loginAction({});
  note('Login complete.');
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Bootstrap Claude Code: install bundled skill into ~/.claude/skills/quickdesign and (optionally) log in')
    .option('--force', 'Overwrite existing skill files', false)
    .option('--skill-only', 'Only install the skill (skip doctor + auth)', false)
    .option('--no-skill', 'Skip skill install')
    .option('--no-auth', 'Skip browser login (CI / scripted setups)')
    .option('--no-doctor', 'Skip ffmpeg / ffprobe check')
    .option('--skill-dir <path>', 'Override target skill dir', defaultSkillTargetDir())
    .action(async (opts: InitOptions) => {
      try {
        const wantSkill = opts.skillOnly || (opts.skill !== false);
        const wantAuth = !opts.skillOnly && opts.auth !== false;
        const wantDoctor = !opts.skillOnly && opts.doctor !== false;

        note('quickdesign init — bootstrapping your Claude Code session');
        note('');

        if (wantDoctor) {
          const report = checkDoctor();
          printDoctorReport(report);
        }

        if (wantSkill) {
          const src = resolveBundledSkillDir();
          const dst = opts.skillDir ?? defaultSkillTargetDir();
          note(`Installing skill from ${src}`);
          await installSkill(src, dst, opts.force === true);
          note('');
        }

        if (wantAuth) {
          await runAuthLogin();
          note('');
        }

        note('Done. Try: quickdesign whoami');
      } catch (err) {
        fail(err);
      }
    });
}
