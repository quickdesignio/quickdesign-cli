/**
 * Argument helpers for `quickdesign social`: platforms, media refs (library
 * designs, URLs, local files), the schedule flags and captions.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { looksLikeLocalPath, uploadLocalFile } from './upload.js';

export type Platform = 'facebook' | 'instagram';
export interface MediaRef {
  design_id?: number;
  url?: string;
}

const PLATFORMS: Record<string, Platform> = { facebook: 'facebook', fb: 'facebook', instagram: 'instagram', ig: 'instagram' };

export function parsePlatforms(raw: string): Platform[] {
  const out = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => {
      const p = PLATFORMS[s];
      if (!p) throw new Error(`Unknown platform "${s}". Use facebook, instagram or both (fb,ig).`);
      return p;
    });
  if (out.length === 0) throw new Error('Give facebook, instagram or both (fb,ig).');
  return [...new Set(out)];
}

/** A local file is uploaded under a content-hash name, so a retry of the same file reuses the same URL; URLs pass through. */
export async function uploadIfLocal(value: string): Promise<string> {
  if (!looksLikeLocalPath(value)) return value;
  const hash = createHash('sha256').update(readFileSync(value)).digest('hex').slice(0, 32);
  const ext = extname(value).toLowerCase().replace(/^\./, '') || 'bin';
  return uploadLocalFile(value, `social-${hash}.${ext}`);
}

/** `design:<id>` → a library design; an https URL → as is; anything else → a local file, uploaded first. */
export async function buildMediaRefs(values: string[]): Promise<MediaRef[]> {
  if (values.length === 0) throw new Error('Add at least one --media (design:<id>, an https URL or a local file).');
  if (values.length > 10) throw new Error('A post takes at most 10 media items.');
  const refs: MediaRef[] = [];
  for (const raw of values) {
    const value = raw.trim();
    const design = /^design:(\d+)$/i.exec(value);
    if (design) {
      refs.push({ design_id: Number(design[1]) });
    } else if (/^design:/i.test(value)) {
      throw new Error(`Bad --media "${raw}": use design:<numeric id>.`);
    } else {
      refs.push({ url: await uploadIfLocal(value) });
    }
  }
  return refs;
}

export interface ScheduleOpts {
  at?: string;
  date?: string;
  time?: string;
  draft?: boolean;
}

/** Exactly one of --at, --date + --time, --draft (none is fine for an edit that keeps its time). */
export function scheduleFields(o: ScheduleOpts, required: boolean): Record<string, unknown> {
  const forms = [o.at !== undefined, o.date !== undefined || o.time !== undefined, o.draft === true].filter(Boolean).length;
  if (forms > 1) throw new Error('Use only one of --at, --date/--time, or --draft.');
  if (forms === 0) {
    if (required) {
      throw new Error("Say when: --date YYYY-MM-DD --time HH:mm (the Page's time zone), --at <ISO with offset>, or --draft.");
    }
    return {};
  }
  if (o.draft) return { draft: true };
  if (o.at !== undefined) return { scheduled_at: o.at };
  if (!o.date || !o.time) throw new Error('--date and --time go together.');
  return { date: o.date, time: o.time };
}

export function readCaption(o: { caption?: string; captionFile?: string }): string | undefined {
  if (o.caption !== undefined && o.captionFile !== undefined) throw new Error('Use --caption or --caption-file, not both.');
  if (o.captionFile !== undefined) return readFileSync(o.captionFile, 'utf8').replace(/\s+$/, '');
  return o.caption;
}
