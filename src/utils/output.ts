/**
 * Output formatting helpers. All commands default to `--json` (machine-readable),
 * with `--human` switching to a prettier TTY format.
 */
import kleur from 'kleur';

export function emitJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export function fail(err: unknown, exit = 1): never {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${kleur.red('error')} ${msg}\n`);
  process.exit(exit);
}

export function note(msg: string): void {
  process.stderr.write(`${kleur.dim(msg)}\n`);
}

export function banner(title: string, detail?: string): void {
  process.stderr.write(`\n${kleur.bold().cyan(title)}${detail ? `  ${kleur.dim(detail)}` : ''}\n`);
}
