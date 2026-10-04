/**
 * `quickdesign social …` — the Social planner: organic Facebook Page and
 * Instagram posts (not ads; that is `meta`). Wraps the BFF's
 * /api/social/agent/* routes, the same ones the MCP tools and /api/v1/social
 * use.
 *
 * Prerequisites, all in the app (app.quickdesign.io/social/planner): connect
 * Meta, turn the Pages on for planning, and an Ultra / Pro Max / Team plan.
 *
 * Safety: `create` only schedules or saves a draft; `publish-now` posts at
 * once and asks first (refuses without a TTY unless --yes). A create is
 * idempotent by --client-request-id; `edit` needs --expected-updated-at.
 */
import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import kleur from 'kleur';
import { ApiError, request } from '../client.js';
import { confirm, emitJson, fail, note } from '../utils/output.js';
import { buildMediaRefs, parsePlatforms, readCaption, scheduleFields, uploadIfLocal } from '../utils/social-args.js';

const AGENT = '/api/social/agent';

interface Envelope<T> {
  success?: boolean;
  data?: T;
  replayed?: boolean;
}
interface Issue {
  platform: string | null;
  message: string;
}
interface Profile {
  id: string;
  platform: string;
  page_id: string;
  name: string;
  username: string | null;
  timezone: string;
  publish_ready: boolean;
  blocked_reason: string | null;
}
interface Target {
  id: string;
  platform: string;
  status: string;
  error_message: string | null;
  permalink: string | null;
}
interface Post {
  id: string;
  post_type: string;
  status: string;
  scheduled_local: string | null;
  timezone: string;
  updated_at: string;
  targets: Target[];
}
interface Validation {
  ok: boolean;
  blocking: Issue[];
  warnings: Issue[];
  post_type: string;
  scheduled_local: string | null;
  timezone: string;
}
interface PostOpts {
  to?: string;
  type?: string;
  media: string[];
  caption?: string;
  captionFile?: string;
  fbCaption?: string;
  igCaption?: string;
  at?: string;
  date?: string;
  time?: string;
  draft?: boolean;
  human?: boolean;
}

const collect = (value: string, previous: string[]): string[] => [...previous, value];
const enc = encodeURIComponent;

function printPost(p: Post): void {
  const when = p.scheduled_local ? `${p.scheduled_local.replace('T', ' ')} ${kleur.dim(p.timezone)}` : kleur.dim('draft');
  const targets = p.targets.map((t) => `${t.platform}:${t.status}`).join(' ');
  process.stdout.write(`${when}  ${kleur.bold(p.status.padEnd(16))} ${p.post_type.padEnd(8)} ${targets}  ${kleur.dim(p.id)}\n`);
  for (const t of p.targets) {
    if (t.error_message) process.stdout.write(`    ${kleur.red(t.platform)} ${t.error_message}  ${kleur.dim(`target ${t.id}`)}\n`);
    if (t.permalink) process.stdout.write(`    ${t.platform} ${t.permalink}\n`);
  }
}

/** Shows the router's details (validation issues, code) and, when a create's result is unknown, how to retry safely. */
function failWith(err: unknown, retryKey?: string): never {
  if (err instanceof ApiError) {
    const body = (err.body ?? {}) as { code?: string; validation?: { blocking?: Issue[] } };
    for (const i of body.validation?.blocking ?? []) process.stderr.write(`  - ${i.platform ?? 'post'}: ${i.message}\n`);
    if (body.code) note(`code: ${body.code}`);
  }
  if (retryKey && (!(err instanceof ApiError) || err.status >= 500)) {
    note(`The result is unknown. Retry with --client-request-id ${retryKey} so the post is created only once.`);
  }
  return fail(err);
}

function withPostOptions(cmd: Command): Command {
  return cmd
    .option('--type <type>', 'image | carousel | reel | story (default: inferred from the media; story must be asked for)')
    .option('--media <ref>', 'design:<id>, an https URL, or a local file (repeatable, in post order, 1-10)', collect, [] as string[])
    .option('--caption <text>', 'Shared caption')
    .option('--caption-file <path>', 'Read the shared caption from a file')
    .option('--fb-caption <text>', 'Facebook-only caption')
    .option('--ig-caption <text>', 'Instagram-only caption')
    .option('--at <iso>', 'Publish time, ISO-8601 with an offset, e.g. 2026-10-10T19:00:00+03:00')
    .option('--date <YYYY-MM-DD>', "Publish date in the Page's time zone (with --time)")
    .option('--time <HH:mm>', "Publish time in the Page's time zone (with --date)")
    .option('--draft', 'Save as a draft (no publish time)')
    .option('--human', 'Pretty-print');
}

async function postFields(o: PostOpts, scheduleRequired: boolean): Promise<Record<string, unknown>> {
  const overrides: Record<string, string> = {};
  if (o.fbCaption !== undefined) overrides.facebook = o.fbCaption;
  if (o.igCaption !== undefined) overrides.instagram = o.igCaption;
  const caption = readCaption(o);
  const schedule = scheduleFields(o, scheduleRequired);
  const hasLocal = o.media.some((m) => !/^design:/i.test(m) && !/^https?:\/\//i.test(m));
  if (hasLocal) note('Uploading local media…');
  return {
    ...(o.to ? { platforms: parsePlatforms(o.to) } : {}),
    ...(o.type ? { post_type: o.type } : {}),
    ...(caption !== undefined ? { caption } : {}),
    ...(Object.keys(overrides).length ? { caption_overrides: overrides } : {}),
    ...schedule,
    ...(o.media.length ? { media: await buildMediaRefs(o.media) } : {}),
  };
}

async function postAction(path: string, o: { human?: boolean }, body: unknown = {}): Promise<void> {
  try {
    const p = (await request<Envelope<Post>>(`${AGENT}${path}`, { method: 'POST', body })).data!;
    if (!o.human) return emitJson(p);
    printPost(p);
  } catch (err) {
    failWith(err);
  }
}

export function registerSocialCommands(program: Command): void {
  const social = program
    .command('social')
    .description('Social planner — schedule organic Facebook Page + Instagram posts');

  social
    .command('profiles')
    .description('Connected Pages and Instagram accounts: start here (page_id, time zone, ready or why not)')
    .option('--human', 'Pretty-print')
    .action(async (o: { human?: boolean }) => {
      try {
        const rows = (await request<Envelope<Profile[]>>(`${AGENT}/profiles`)).data ?? [];
        if (!o.human) return emitJson(rows);
        for (const p of rows) {
          const name = p.username ? `@${p.username}` : p.name;
          const state = p.publish_ready ? kleur.green('ready') : kleur.yellow(p.blocked_reason ?? 'blocked');
          process.stdout.write(
            `${p.platform.padEnd(10)} ${kleur.bold(name.padEnd(28))} page ${p.page_id}  ${p.timezone}  ${state}  ${kleur.dim(p.id)}\n`,
          );
        }
        note(`${rows.length} profile(s)`);
      } catch (err) {
        failWith(err);
      }
    });

  social
    .command('posts')
    .description('Scheduled posts in a window (default: today + 14 days), or --drafts / --attention')
    .option('--from <date|iso>', "Start: YYYY-MM-DD (the Page's time zone with --page, else UTC) or ISO with an offset")
    .option('--to <date|iso>', 'End (a date includes that day); at most 62 days')
    .option('--page <page_id>', 'Only this Page')
    .option('--drafts', 'Drafts instead of the calendar')
    .option('--attention', 'Posts that failed or need a check, from any date')
    .option('--human', 'Pretty-print')
    .action(async (o: { from?: string; to?: string; page?: string; drafts?: boolean; attention?: boolean; human?: boolean }) => {
      if (o.drafts && o.attention) return fail(new Error('Use --drafts or --attention, not both.'));
      let path = '/posts';
      let query: Record<string, string | undefined> = { from: o.from, to: o.to, page_id: o.page };
      if (o.drafts) {
        path = '/posts/drafts';
        query = { page_id: o.page };
      } else if (o.attention) {
        path = '/posts/attention';
        query = {};
      }
      try {
        const rows = (await request<Envelope<Post[]>>(`${AGENT}${path}`, { query })).data ?? [];
        if (!o.human) return emitJson(rows);
        rows.forEach(printPost);
        note(`${rows.length} post(s)`);
      } catch (err) {
        failWith(err);
      }
    });

  social
    .command('get <post-id>')
    .description('One post (its updated_at is what `edit` needs)')
    .option('--human', 'Pretty-print')
    .action(async (id: string, o: { human?: boolean }) => {
      try {
        const p = (await request<Envelope<Post>>(`${AGENT}/posts/${enc(id)}`)).data!;
        if (!o.human) return emitJson(p);
        printPost(p);
        note(`updated_at ${p.updated_at}`);
      } catch (err) {
        failWith(err);
      }
    });

  withPostOptions(
    social
      .command('create')
      .description('Schedule a post or save a draft (never publishes immediately)')
      .requiredOption('--page <page_id>', 'Facebook Page id (from `social profiles`)')
      .requiredOption('--to <platforms>', 'facebook, instagram or both: fb,ig'),
  )
    .option('--client-request-id <uuid>', 'Reuse it when retrying, so the post is created only once (default: a new id)')
    .option('--validate-only', 'Check the post without saving it')
    .action(async (o: PostOpts & { page: string; clientRequestId?: string; validateOnly?: boolean }) => {
      const key = o.clientRequestId ?? randomUUID();
      let body: Record<string, unknown>;
      try {
        if (o.media.length === 0) throw new Error('Add at least one --media (design:<id>, an https URL or a local file).');
        body = { page_id: o.page, ...(await postFields(o, true)) };
      } catch (err) {
        return fail(err);
      }
      if (o.validateOnly) {
        try {
          const v = (await request<Envelope<Validation>>(`${AGENT}/posts/validate`, { method: 'POST', body })).data!;
          if (!o.human) return emitJson(v);
          const when = v.scheduled_local ? `${v.scheduled_local.replace('T', ' ')} ${v.timezone}` : 'draft';
          process.stdout.write(`${v.ok ? kleur.green('OK') : kleur.red('Blocked')}  ${v.post_type}  ${when}\n`);
          for (const i of v.blocking) process.stdout.write(`  ${kleur.red(`x ${i.platform ?? 'post'}: ${i.message}`)}\n`);
          for (const i of v.warnings) process.stdout.write(`  ${kleur.yellow(`! ${i.platform ?? 'post'}: ${i.message}`)}\n`);
        } catch (err) {
          failWith(err);
        }
        return;
      }
      try {
        const res = await request<Envelope<Post>>(`${AGENT}/posts`, { method: 'POST', body: { ...body, client_request_id: key } });
        if (!o.human) return emitJson({ ...res.data, replayed: res.replayed === true, client_request_id: key });
        if (res.replayed) note('Already created by an earlier attempt with this --client-request-id.');
        printPost(res.data!);
      } catch (err) {
        failWith(err, key);
      }
    });

  withPostOptions(
    social
      .command('edit <post-id>')
      .description('Change a scheduled post or draft: only the fields you pass (--media replaces all media)')
      .requiredOption('--expected-updated-at <iso>', 'updated_at from `social get` (the edit fails if the post changed since)')
      .option('--to <platforms>', 'facebook, instagram or both: fb,ig'),
  ).action(async (id: string, o: PostOpts & { expectedUpdatedAt: string }) => {
    let body: Record<string, unknown>;
    try {
      body = { expected_updated_at: o.expectedUpdatedAt, ...(await postFields(o, false)) };
    } catch (err) {
      return fail(err);
    }
    try {
      const p = (await request<Envelope<Post>>(`${AGENT}/posts/${enc(id)}`, { method: 'PATCH', body })).data!;
      if (!o.human) return emitJson(p);
      printPost(p);
    } catch (err) {
      failWith(err);
    }
  });

  social
    .command('cancel <post-id>')
    .description('Cancel a scheduled post or draft so it never publishes')
    .option('--human', 'Pretty-print')
    .action(async (id: string, o: { human?: boolean }) => postAction(`/posts/${enc(id)}/cancel`, o));

  social
    .command('publish-now <post-id>')
    .description('Publish a post immediately to the live Page / Instagram account (prompts unless --yes)')
    .option('--yes', 'Skip the confirmation prompt', false)
    .option('--human', 'Pretty-print')
    .action(async (id: string, o: { yes?: boolean; human?: boolean }) => {
      // Publishing is public and cannot be undone from QuickDesign. Interactive
      // callers confirm; scripts and agents pass --yes after asking the user,
      // and without a TTY we refuse rather than wait on a prompt nobody sees.
      if (!o.yes) {
        if (!process.stdin.isTTY) {
          return fail(new Error('Refusing to publish non-interactively without --yes (this posts publicly right away).'));
        }
        if (!(await confirm(`Publish post ${id} now? It goes live on the Page / Instagram right away. [y/N] `))) {
          note('Aborted — nothing was published.');
          return;
        }
      }
      await postAction(`/posts/${enc(id)}/publish-now`, o, { confirm: true });
    });

  social
    .command('retry <target-id>')
    .description('Retry a FAILED platform of a post (targets[].id); posts that need attention are resolved in the app')
    .option('--human', 'Pretty-print')
    .action(async (id: string, o: { human?: boolean }) => postAction(`/targets/${enc(id)}/retry`, o));

  social
    .command('mark-published <target-id>')
    .description('Record that a needs-attention platform IS live (after checking the profile)')
    .option('--human', 'Pretty-print')
    .action(async (id: string, o: { human?: boolean }) => postAction(`/targets/${enc(id)}/mark-published`, o));

  social
    .command('feed <profile-id>')
    .description("An Instagram account's last 30 posts")
    .option('--human', 'Pretty-print')
    .action(async (id: string, o: { human?: boolean }) => {
      try {
        const rows =
          (
            await request<Envelope<Array<{ id: string; media_type: string; permalink: string | null; timestamp: string }>>>(
              `${AGENT}/profiles/${enc(id)}/instagram-media`,
            )
          ).data ?? [];
        if (!o.human) return emitJson(rows);
        rows.forEach((r) => process.stdout.write(`${r.timestamp}  ${r.media_type.padEnd(15)} ${r.permalink ?? ''}\n`));
        note(`${rows.length} post(s)`);
      } catch (err) {
        failWith(err);
      }
    });

  social
    .command('caption')
    .description('Write or improve a caption with AI (nothing is saved)')
    .option('--improve <text>', 'Polish this caption')
    .option('--write', 'Write a caption for --image')
    .option('--image <url|path>', 'Image to write about (local files are uploaded)')
    .option('--hint <text>', 'Optional direction for --write')
    .option('--platform <p>', 'facebook | instagram (fb | ig)')
    .option('--page <page_id>', 'Use the brand kit linked to this Page')
    .option('--human', 'Print only the text')
    .action(
      async (o: { improve?: string; write?: boolean; image?: string; hint?: string; platform?: string; page?: string; human?: boolean }) => {
        if ((o.improve !== undefined) === !!o.write) return fail(new Error('Use --improve <text> or --write --image <url|path>.'));
        try {
          const platform = o.platform ? parsePlatforms(o.platform)[0] : undefined;
          const body =
            o.improve !== undefined
              ? { mode: 'improve', text: o.improve, platform, page_id: o.page }
              : { mode: 'write', text: o.hint, image_url: o.image ? await uploadIfLocal(o.image) : undefined, platform, page_id: o.page };
          const res = (await request<Envelope<{ text: string }>>(`${AGENT}/captions`, { method: 'POST', body })).data!;
          if (o.human) process.stdout.write(`${res.text}\n`);
          else emitJson(res);
        } catch (err) {
          failWith(err);
        }
      },
    );
}
