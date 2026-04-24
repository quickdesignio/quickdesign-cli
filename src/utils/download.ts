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
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  if (!res.body) throw new Error('Empty response body');
  const stream = createWriteStream(outPath);
  await finished(Readable.fromWeb(res.body as import('stream/web').ReadableStream).pipe(stream));
}
