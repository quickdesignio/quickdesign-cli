/**
 * Upload a local file to QuickDesign storage via the `upload-to-r2` edge
 * function and return the resulting public URL.
 *
 * The Supabase edge function lives behind the production proxy (`my.quickdesign.io`),
 * not the raw `*.supabase.co` host. Auth = the user's stored JWT, plus the
 * Supabase anon key as `apikey` if it has been configured.
 */
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import {
  ensureFreshToken,
  resolveSupabaseUrl,
  resolveSupabaseAnonKey,
} from '../config.js';

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

export async function uploadLocalFile(localPath: string): Promise<string> {
  const stat = statSync(localPath); // throws if missing
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${localPath}`);
  }

  const token = await ensureFreshToken();
  if (!token) {
    throw new Error('Not authenticated. Run `quickdesign auth login` first.');
  }

  const buf = readFileSync(localPath);
  const ext = extname(localPath).toLowerCase().replace(/^\./, '') || 'bin';
  const contentType = CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream';
  const originalName = basename(localPath);
  const remoteName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const form = new FormData();
  form.append('file', new Blob([buf], { type: contentType }), originalName);
  form.append('filename', remoteName);
  form.append('contentType', contentType);

  const base = resolveSupabaseUrl().replace(/\/$/, '');
  const endpoint = `${base}/functions/v1/upload-to-r2`;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const anonKey = resolveSupabaseAnonKey();
  if (anonKey) headers.apikey = anonKey;

  const res = await fetch(endpoint, { method: 'POST', headers, body: form });
  const text = await res.text();
  let parsed: { success?: boolean; publicUrl?: string; error?: string } = {};
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new Error(`Upload failed (HTTP ${res.status}): non-JSON response — ${text.slice(0, 200)}`);
  }
  if (!res.ok || !parsed.success || !parsed.publicUrl) {
    throw new Error(`Upload failed (HTTP ${res.status}): ${parsed.error || text.slice(0, 200)}`);
  }
  return parsed.publicUrl;
}

/**
 * If `input` looks like a local path, upload it and return the public URL.
 * URLs and data URIs pass through unchanged. Throws on upload failure.
 */
export async function ensureRemoteUrl(input: string): Promise<string> {
  if (!looksLikeLocalPath(input)) return input;
  return uploadLocalFile(input);
}
