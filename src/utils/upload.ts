/**
 * Upload a local file to QuickDesign storage and return its public URL.
 *
 * Goes through the BFF (`POST /api/uploads`), which stores it under your
 * account on the asset bucket. CLI ≤ 0.16 called the `upload-to-r2` edge
 * function with a Supabase session, which the CLI's own session cannot do.
 */
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { ensureFreshToken } from '../config.js';
import { ApiError, request } from '../client.js';

/** The server's cap. Checked locally so a huge file fails before it is read. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
};

export function looksLikeLocalPath(input: string): boolean {
  if (!input) return false;
  if (/^https?:\/\//i.test(input)) return false;
  if (/^data:/i.test(input)) return false;
  return true;
}

export async function uploadLocalFile(localPath: string, remoteName?: string): Promise<string> {
  const stat = statSync(localPath); // throws if missing
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${localPath}`);
  }
  if (stat.size > MAX_UPLOAD_BYTES) {
    throw new Error(`${basename(localPath)} is ${(stat.size / 1048576).toFixed(1)} MB; uploads are limited to 200 MB.`);
  }
  if (!(await ensureFreshToken())) {
    throw new Error('Not logged in. Run `quickdesign login` first.');
  }

  const buf = readFileSync(localPath);
  const ext = extname(localPath).toLowerCase().replace(/^\./, '') || 'bin';
  const contentType = CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream';
  // A caller may pin the name (social uses a content hash so a retry reuses the URL).
  const name = remoteName ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const form = new FormData();
  form.append('file', new Blob([buf], { type: contentType }), basename(localPath));
  form.append('filename', name);

  let res: { success?: boolean; publicUrl?: string };
  try {
    // 5 min budget — reference videos can be large.
    res = await request<{ success?: boolean; publicUrl?: string }>('/api/uploads', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(300_000),
    });
  } catch (err) {
    // nginx may answer 413 with an HTML page before the BFF sees the request.
    if (err instanceof ApiError && err.status === 413) {
      throw new Error(`${basename(localPath)} is too large; uploads are limited to 200 MB.`);
    }
    throw err;
  }
  if (!res.publicUrl) throw new Error('Upload failed: the server returned no URL.');
  return res.publicUrl;
}

/**
 * If `input` looks like a local path, upload it and return the public URL.
 * URLs and data URIs pass through unchanged. Throws on upload failure.
 */
export async function ensureRemoteUrl(input: string): Promise<string> {
  if (!looksLikeLocalPath(input)) return input;
  return uploadLocalFile(input);
}
