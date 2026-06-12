/**
 * Download a remote file to disk. Used by `image generate -o` and similar.
 */
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

export async function downloadTo(url: string, outPath: string): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true });
  // 10 min total budget (signal aborts mid-body too) — generous even for
  // upscaled MP4s, and matches pollUntilDone's default deadline.
  const res = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  if (!res.body) throw new Error('Empty response body');
  const stream = createWriteStream(outPath);
  await finished(Readable.fromWeb(res.body as import('stream/web').ReadableStream).pipe(stream));
}
