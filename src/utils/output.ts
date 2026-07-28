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

/**
 * Yes/no prompt for the few actions that spend money (currently: activating a
 * Meta campaign). The prompt goes to stderr so `--json` stdout stays
 * parseable. Only `y` / `yes` counts as yes — anything else, including EOF,
 * is a no.
 *
 * Callers decide what to do when there is no TTY (pass `--yes` or refuse);
 * this helper does not guess.
 */
export async function confirm(question: string): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } catch {
    return false;
  } finally {
    rl.close();
  }
}
