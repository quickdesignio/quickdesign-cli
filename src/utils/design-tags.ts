/**
 * Shared bits of the team design-tag commands (`tag …`, `design list --tag`).
 *
 * Tags belong to your workspace — your team, or just you when you have no
 * team — and live on the BFF at /api/design-tags. They are NOT the template
 * library's tags (`template list --tag`, `template filters`), which are the
 * app's public taxonomy.
 */
import kleur from 'kleur';
import { request, ApiError } from '../client.js';
import { fail } from './output.js';

export const TAG_COLORS = ['green', 'yellow', 'orange', 'red', 'purple', 'blue', 'teal', 'gray'] as const;
export type TagColor = (typeof TAG_COLORS)[number];
/** The BFF's limits (services/public/designTags.ts). */
export const MAX_TAG_NAME_LENGTH = 32;
export const MAX_APPLY_DESIGNS = 50;
export const MAX_TAGS_PER_DESIGN = 20;

export interface DesignTag {
  id: string;
  name: string;
  color: TagColor;
}

export interface DesignTagWithStats extends DesignTag {
  count: number;
  last_used_at: string | null;
}

export interface TagLinkRef {
  design_id: number;
  tag_id: string;
}

export interface ApplyTagsResult {
  added: TagLinkRef[];
  removed: TagLinkRef[];
  already: TagLinkRef[];
  created_tags: DesignTag[];
  /** tags: the ids or names exactly as sent. Unknown designs and designs you may not tag look the same. */
  not_found: { designs: number[]; tags: string[] };
  /** Design ids that already carry MAX_TAGS_PER_DESIGN tags. */
  limit_reached: number[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** /api/design-tags answers bare bodies (no `{ success, data }` envelope); this types one. */
export function unwrap<T>(body: unknown): T {
  return body as T;
}

/** The message for a tag your workspace doesn't have. */
export function unknownTag(ref: string): string {
  return `No tag named "${ref}" — see \`quickdesign tag list\``;
}

/** commander collector for a repeatable option. */
export function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** A 200 whose body lacks what the contract promises. */
export class UnexpectedResponse extends Error {
  constructor() {
    super('Unexpected response from the server');
  }
}

/** Exit with a plain message for an /api/design-tags failure. */
export function failTagRequest(err: unknown): never {
  if (err instanceof ApiError) {
    const code = (err.body as { code?: unknown } | null)?.code;
    if (err.status === 503 && code === 'design_tags_unavailable') {
      fail("Tags aren't available on this QuickDesign server yet (its database migration hasn't been applied).");
    }
    // A tag that is gone answers 404 not_found; a BFF without the routes answers 404 with no code.
    if (err.status === 404 && code !== 'not_found') {
      fail('This QuickDesign server does not support tags yet; it needs a newer BFF.');
    }
    if (code === 'not_found' || code === 'tag_name_taken' || code === 'tag_limit' || code === 'invalid') {
      fail(err.message, 2);
    }
  }
  fail(err);
}

/** Your workspace's tags, most recently used first (the BFF's order). */
export async function fetchTags(): Promise<DesignTagWithStats[]> {
  try {
    const tags = unwrap<{ tags?: unknown }>(await request<unknown>('/api/design-tags'))?.tags;
    if (!Array.isArray(tags)) throw new UnexpectedResponse();
    return tags as DesignTagWithStats[];
  } catch (err) {
    failTagRequest(err);
  }
}

/** A tag by id, or by name in any case. */
export function findTag(tags: DesignTagWithStats[], ref: string): DesignTagWithStats | undefined {
  const wanted = ref.trim();
  if (UUID.test(wanted)) return tags.find((t) => t.id.toLowerCase() === wanted.toLowerCase());
  const key = wanted.toLowerCase();
  return tags.find((t) => t.name.toLowerCase() === key);
}

/** One tag of your workspace by name or id, or exit 2. */
export async function resolveTag(ref: string): Promise<DesignTagWithStats> {
  const tag = findTag(await fetchTags(), ref);
  if (!tag) fail(unknownTag(ref), 2);
  return tag;
}

/** A trimmed tag name, or exit 2 when it is empty or longer than the BFF allows. */
export function tagName(raw: string): string {
  const name = raw.trim();
  if (!name) fail('Tag name must not be empty', 2);
  if (name.includes(',')) fail('Tag name must not contain a comma', 2);
  if ([...name].length > MAX_TAG_NAME_LENGTH) {
    fail(`Tag name must be at most ${MAX_TAG_NAME_LENGTH} characters, got "${name}"`, 2);
  }
  return name;
}

export type TagRef = { id: string } | { name: string };

/** `--tag` values as refs: a uuid is an id, anything else a validated name; case-insensitive duplicates dropped. */
export function uniqueRefs(raw: string[]): TagRef[] {
  const seen = new Set<string>();
  const out: TagRef[] = [];
  for (const r of raw) {
    const v = r.trim();
    const ref: TagRef = UUID.test(v) ? { id: v } : { name: tagName(r) };
    const key = 'id' in ref ? ref.id.toLowerCase() : `n:${ref.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

export function tagColor(raw: string): TagColor {
  const color = raw.trim().toLowerCase();
  if (!(TAG_COLORS as readonly string[]).includes(color)) {
    fail(`Color must be one of ${TAG_COLORS.join(', ')}, got "${raw}"`, 2);
  }
  return color as TagColor;
}

export function parseDesignIds(args: string[]): number[] {
  const ids = new Set(
    args.map((a) => {
      const n = /^\d+$/.test(a) ? Number(a) : NaN;
      if (!Number.isSafeInteger(n) || n <= 0) fail(`Design id must be a positive whole number, got "${a}"`, 2);
      return n;
    }),
  );
  if (ids.size > MAX_APPLY_DESIGNS) fail(`At most ${MAX_APPLY_DESIGNS} design ids per call, got ${ids.size}`, 2);
  return [...ids];
}

/**
 * The canonical names of these tags (given by name in any case, or by id), or
 * exit 2 naming the first one your workspace doesn't have. Used by filters,
 * so a typo never turns into an empty — or, on an older BFF, unfiltered — list.
 * Refs are not run through tagName(): an id is longer than a name may be.
 */
export async function resolveFilterNames(raw: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const r of raw) {
    const ref = r.trim();
    if (!ref) fail('Tag name must not be empty', 2);
    const key = ref.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  if (refs.length === 0) return [];
  const tags = await fetchTags();
  const names = refs.map((ref) => {
    const tag = findTag(tags, ref);
    if (!tag) fail(unknownTag(ref), 2);
    return tag.name;
  });
  return [...new Set(names)];
}

const PAINT: Record<TagColor, (s: string) => string> = {
  green: (s) => kleur.green(s),
  yellow: (s) => kleur.yellow(s),
  orange: (s) => kleur.yellow(s),
  red: (s) => kleur.red(s),
  purple: (s) => kleur.magenta(s),
  blue: (s) => kleur.blue(s),
  teal: (s) => kleur.cyan(s),
  gray: (s) => kleur.gray(s),
};

/** A colored ● for `--human` output. */
export function dot(color: TagColor): string {
  return (PAINT[color] ?? ((s: string) => s))('●');
}

export const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;
