/**
 * Polling helper for async jobs. Caller supplies a fetch function that returns
 * { done, result?, error? } and we spin until done=true or timeout.
 */
export interface PollResult<T> {
  done: boolean;
  result?: T;
  error?: string;
}

export async function pollUntilDone<T>(
  fetchStatus: () => Promise<PollResult<T>>,
  opts: {
    intervalMs?: number;       // default 2000
    timeoutMs?: number;        // default 10 * 60_000 = 10 min
    onTick?: (attempt: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const interval = opts.intervalMs ?? 2000;
  const timeout = opts.timeoutMs ?? 10 * 60_000;
  const start = Date.now();
  let attempt = 0;

  while (true) {
    if (opts.signal?.aborted) throw new Error('aborted');
    attempt++;
    opts.onTick?.(attempt);

    const s = await fetchStatus();
    if (s.error) throw new Error(s.error);
    if (s.done && s.result !== undefined) return s.result;

    if (Date.now() - start >= timeout) {
      throw new Error(`Timed out after ${Math.round(timeout / 1000)}s waiting for job to finish`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
