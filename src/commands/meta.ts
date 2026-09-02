/**
 * `quickdesign meta …`  —  Deploy Meta: publish ads + analyze your own
 * Meta ad performance. Wraps the BFF's /api/deploy-meta/* routes.
 *
 * Prerequisite: connect your Meta (Facebook) account inside the QuickDesign
 * app first (app.quickdesign.io/deploy-meta → Connect Meta). Without it every
 * subcommand fails with "No valid Meta access token found".
 *
 * Publish safety: campaigns, ad sets and ads are ALL created status=PAUSED on
 * Meta — nothing delivers or spends budget until you activate them in Ads
 * Manager.
 */
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import kleur from 'kleur';
import { request } from '../client.js';
import { confirm, emitJson, fail, note } from '../utils/output.js';
import { pollUntilDone } from '../utils/poll.js';

interface Envelope<T = unknown> {
  success?: boolean;
  data?: T;
  error?: string;
  [key: string]: unknown;
}

interface PublishTaskRow {
  id: string;
  status: string;
  design_id?: number;
  design_title?: string;
  ad_id?: string | null;
  adset_id?: string | null;
  error_message?: string | null;
  task_order?: number;
}

interface PublishJobRow {
  id: string;
  status: string;
  campaign_name?: string;
  total_tasks: number;
  completed_tasks: number;
  failed_tasks: number;
  campaign_id?: string | null;
  created_at?: string;
}

const fmtNum = (n: unknown): string =>
  typeof n === 'number' ? (Number.isInteger(n) ? String(n) : n.toFixed(2)) : String(n ?? '-');

function printInsightsTotals(label: string, totals: Record<string, unknown> | undefined): void {
  if (!totals) return;
  process.stdout.write(`${kleur.bold(label)}\n`);
  const keys = ['spend', 'impressions', 'clicks', 'ctr', 'cpm', 'roas', 'purchases', 'cpa', 'aov'];
  for (const k of keys) {
    if (totals[k] !== undefined) {
      process.stdout.write(`  ${k.padEnd(12)} ${fmtNum(totals[k])}\n`);
    }
  }
}

export function registerMetaCommands(program: Command): void {
  const meta = program
    .command('meta')
    .description('Deploy Meta — publish ads + analyze your own Meta performance');

  // ─── discovery ────────────────────────────────────────────────────────────

  meta
    .command('accounts')
    .description('List your Meta ad accounts')
    .option('--human', 'Pretty-print')
    .action(async (opts: { human?: boolean }) => {
      try {
        const res = await request<Envelope<Array<{ id: string; name?: string; currency?: string }>>>(
          '/api/deploy-meta/accounts',
        );
        const rows = res.data ?? [];
        if (opts.human) {
          rows.forEach((a) =>
            process.stdout.write(`${kleur.bold((a.name ?? '?').padEnd(36))} ${a.id}  ${a.currency ?? ''}\n`),
          );
          note(`${rows.length} account(s)`);
        } else emitJson(rows);
      } catch (err) { fail(err); }
    });

  meta
    .command('pages')
    .description('List your Facebook pages (page_id needed for publish)')
    .option('--human', 'Pretty-print')
    .action(async (opts: { human?: boolean }) => {
      try {
        const res = await request<Envelope<Array<{ id: string; name?: string }>>>('/api/deploy-meta/pages');
        const rows = res.data ?? [];
        if (opts.human) {
          rows.forEach((p) => process.stdout.write(`${kleur.bold((p.name ?? '?').padEnd(36))} ${p.id}\n`));
          note(`${rows.length} page(s)`);
        } else emitJson(rows);
      } catch (err) { fail(err); }
    });

  meta
    .command('pixels')
    .description('List conversion pixels for an ad account')
    .requiredOption('--account <id>', 'Meta ad account id')
    .action(async (opts: { account: string }) => {
      try {
        const res = await request<Envelope>('/api/deploy-meta/pixels', {
          query: { ad_account_id: opts.account },
        });
        emitJson(res.data ?? res);
      } catch (err) { fail(err); }
    });

  meta
    .command('campaigns')
    .description('List campaigns in an ad account')
    .requiredOption('--account <id>', 'Meta ad account id')
    .option('--search <q>', 'Name filter')
    .option('--limit <n>', 'Limit', (v) => parseInt(v, 10))
    .option('--offset <n>', 'Offset', (v) => parseInt(v, 10))
    .option('--human', 'Pretty-print')
    .action(async (opts: { account: string; search?: string; limit?: number; offset?: number; human?: boolean }) => {
      try {
        const res = await request<Envelope<Array<{ id: string; name?: string; status?: string; objective?: string }>>>(
          '/api/deploy-meta/campaigns',
          { query: { ad_account_id: opts.account, search: opts.search, limit: opts.limit, offset: opts.offset } },
        );
        const rows = res.data ?? [];
        if (opts.human) {
          rows.forEach((c) =>
            process.stdout.write(
              `${kleur.bold((c.name ?? '?').slice(0, 44).padEnd(46))} ${c.id}  ${c.status ?? ''}  ${kleur.dim(c.objective ?? '')}\n`,
            ),
          );
          note(`${rows.length} campaign(s)`);
        } else emitJson(rows);
      } catch (err) { fail(err); }
    });

  meta
    .command('adsets')
    .description("List a campaign's ad sets")
    .requiredOption('--campaign <id>', 'Campaign id')
    .option('--account <id>', 'Meta ad account id')
    .option('--human', 'Pretty-print')
    .action(async (opts: { campaign: string; account?: string; human?: boolean }) => {
      try {
        const res = await request<Envelope<Array<{ id: string; name?: string; status?: string }>>>(
          '/api/deploy-meta/adsets',
          { query: { campaign_id: opts.campaign, ad_account_id: opts.account } },
        );
        const rows = res.data ?? [];
        if (opts.human) {
          rows.forEach((a) =>
            process.stdout.write(`${kleur.bold((a.name ?? '?').slice(0, 44).padEnd(46))} ${a.id}  ${a.status ?? ''}\n`),
          );
          note(`${rows.length} ad set(s)`);
        } else emitJson(rows);
      } catch (err) { fail(err); }
    });

  // ─── delivery control ─────────────────────────────────────────────────────

  meta
    .command('campaign-status')
    .description('Turn a campaign on (ACTIVE — starts spending), off (PAUSED) or archive it')
    .requiredOption('--campaign <id>', 'Campaign id')
    .requiredOption('--account <id>', 'Meta ad account id')
    .requiredOption('--status <s>', 'active | paused | archived')
    .option('--yes', 'Skip the confirmation prompt for --status active', false)
    .option('--human', 'Pretty-print')
    .action(async (opts: { campaign: string; account: string; status: string; yes?: boolean; human?: boolean }) => {
      const status = opts.status.trim().toUpperCase();
      if (!['ACTIVE', 'PAUSED', 'ARCHIVED'].includes(status)) {
        fail(new Error(`Invalid --status "${opts.status}". Use active | paused | archived.`));
        return;
      }
      // ACTIVE is the only irreversible-by-accident direction: it starts
      // delivery and spends budget. Interactive callers get a confirmation;
      // scripts and agents pass --yes (or run non-TTY, where we refuse rather
      // than block on a prompt nobody can answer).
      if (status === 'ACTIVE' && !opts.yes) {
        if (!process.stdin.isTTY) {
          fail(new Error('Refusing to activate a campaign non-interactively without --yes (this starts ad spend).'));
          return;
        }
        const answer = await confirm(
          `Activate campaign ${opts.campaign}? This starts delivery and spends its budget. [y/N] `,
        );
        if (!answer) {
          note('Aborted — campaign left unchanged.');
          return;
        }
      }
      try {
        const res = await request<{ success?: boolean; campaign_id?: string; status?: string }>(
          '/api/deploy-meta/campaign-status',
          {
            method: 'POST',
            body: { campaign_id: opts.campaign, ad_account_id: opts.account, status },
          },
        );
        if (opts.human) {
          note(`Campaign ${res.campaign_id ?? opts.campaign} → ${res.status ?? status}`);
        } else emitJson(res);
      } catch (err) { fail(err); }
    });

  // ─── analytics ────────────────────────────────────────────────────────────

  meta
    .command('insights')
    .description('Account performance timeseries (spend, ROAS, CTR…) with previous-period comparison')
    .requiredOption('--account <id>', 'Meta ad account id')
    .option('--preset <p>', 'Date preset: last_7d | last_14d | last_30d | last_90d')
    .option('--since <date>', 'Custom range start (YYYY-MM-DD)')
    .option('--until <date>', 'Custom range end (YYYY-MM-DD)')
    .option('--human', 'Pretty-print totals')
    .action(async (opts: { account: string; preset?: string; since?: string; until?: string; human?: boolean }) => {
      try {
        note('Fetching from the Meta API — can take 10-30s…');
        const res = await request<{
          totals?: Record<string, unknown>;
          previous_totals?: Record<string, unknown>;
          daily?: unknown[];
        }>('/api/deploy-meta/insights', {
          query: {
            ad_account_id: opts.account,
            date_preset: opts.preset,
            time_range_since: opts.since,
            time_range_until: opts.until,
          },
        });
        if (opts.human) {
          printInsightsTotals('Current period', res.totals);
          printInsightsTotals('Previous period', res.previous_totals);
          note(`${res.daily?.length ?? 0} day(s) of data — use JSON output for the full timeseries`);
        } else emitJson(res);
      } catch (err) { fail(err); }
    });

  meta
    .command('report')
    .description('Per-creative performance report (cached metrics)')
    .requiredOption('--account <id>', 'Meta ad account id')
    .option('--preset <p>', 'Date preset: last_7d | last_14d | last_30d | last_90d')
    .option('--human', 'Pretty-print')
    .action(async (opts: { account: string; preset?: string; human?: boolean }) => {
      try {
        const res = await request<{
          creatives?: Array<Record<string, unknown>>;
          metrics?: Array<Record<string, unknown>>;
        }>('/api/deploy-meta/report', {
          query: { ad_account_id: opts.account, date_preset: opts.preset },
        });
        if (opts.human) {
          const metrics = res.metrics ?? [];
          metrics.slice(0, 50).forEach((m) =>
            process.stdout.write(
              `${kleur.bold(String(m.ad_name ?? m.ad_id ?? '?').slice(0, 40).padEnd(42))} spend=${fmtNum(m.spend)}  roas=${fmtNum(m.roas)}  ctr=${fmtNum(m.ctr)}\n`,
            ),
          );
          note(`${metrics.length} creative metric row(s). Stale? Run: quickdesign meta radar --account ${opts.account} --compute`);
        } else emitJson(res);
      } catch (err) { fail(err); }
    });

  meta
    .command('radar')
    .description('Creative grades: winners / high potential / iteration candidates / underperformers')
    .requiredOption('--account <id>', 'Meta ad account id')
    .option('--compute', 'Re-sync metrics from Meta and recompute grades first (~30-90s)', false)
    .option('--category <c>', 'Filter: winner | high_potential | iteration_candidate | underperformer')
    .option('--human', 'Pretty-print')
    .action(async (opts: { account: string; compute?: boolean; category?: string; human?: boolean }) => {
      try {
        if (opts.compute) {
          note('Syncing metrics from Meta and recomputing grades — this can take a minute…');
          await request('/api/deploy-meta/grades/compute', {
            method: 'POST',
            body: { ad_account_id: opts.account, sync: true },
          });
        }
        const res = await request<Envelope<Array<Record<string, unknown>>>>('/api/deploy-meta/grades', {
          query: { ad_account_id: opts.account, category: opts.category },
        });
        const rows = res.data ?? [];
        if (opts.human) {
          rows.forEach((g) =>
            process.stdout.write(
              `${kleur.bold(String(g.grade ?? '?').padEnd(3))} ${String(g.category ?? '').padEnd(20)} ${String(g.ad_name ?? g.creative_id ?? '?').slice(0, 40).padEnd(42)} score=${fmtNum(g.conversion_score)}\n`,
            ),
          );
          note(`${rows.length} graded creative(s)`);
        } else emitJson(rows);
      } catch (err) { fail(err); }
    });

  meta
    .command('settings')
    .description('Read Deploy Meta settings for an ad account')
    .requiredOption('--account <id>', 'Meta ad account id')
    .action(async (opts: { account: string }) => {
      try {
        const res = await request<Envelope>('/api/deploy-meta/settings', {
          query: { ad_account_id: opts.account },
        });
        emitJson(res.data ?? res);
      } catch (err) { fail(err); }
    });

  // ─── comments (FB/IG moderation) ─────────────────────────────────────────

  meta
    .command('comments')
    .description('Synced Facebook/Instagram comments under your ads and posts, with AI labels')
    .requiredOption('--account <id>', 'Meta ad account id')
    .option('--tab <t>', 'attention (default) | questions | all | hidden')
    .option('--platform <p>', 'facebook | instagram')
    .option('--source <s>', 'ad | organic')
    .option('--cursor <c>', 'next_cursor from the previous page (opaque)')
    .option('--limit <n>', 'Page size (max 200)', (v) => parseInt(v, 10))
    .option('--human', 'Pretty-print')
    .action(async (opts: { account: string; tab?: string; platform?: string; source?: string; cursor?: string; limit?: number; human?: boolean }) => {
      try {
        const res = await request<Envelope<Array<Record<string, unknown>>> & { next_cursor?: string | null; counts?: Record<string, number> }>(
          '/api/deploy-meta/comments',
          {
            query: {
              ad_account_id: opts.account,
              tab: opts.tab,
              platform: opts.platform,
              source: opts.source,
              cursor: opts.cursor,
              limit: opts.limit,
            },
          },
        );
        const rows = res.data ?? [];
        if (opts.human) {
          rows.forEach((c) => {
            const flags = [
              c.platform === 'instagram' ? 'IG' : 'FB',
              c.ad_id ? 'ad' : 'organic',
              c.is_hidden ? 'hidden' : '',
              c.replied_at ? 'replied' : '',
            ].filter(Boolean).join(',');
            process.stdout.write(
              `${kleur.bold(String(c.ai_label ?? '-').padEnd(9))} ${flags.padEnd(22)} ${String(c.author_name ?? '?').slice(0, 18).padEnd(19)} ${String(c.message ?? '').replace(/\s+/g, ' ').slice(0, 70)}\n` +
                `${''.padEnd(10)}${kleur.dim(`id=${String(c.comment_id)}${c.post_permalink ? `  ${String(c.post_permalink)}` : ''}`)}\n`,
            );
          });
          const counts = res.counts ?? {};
          note(
            `${rows.length} comment(s) — attention ${counts.attention ?? 0}, questions ${counts.questions ?? 0}, all ${counts.all ?? 0}, hidden ${counts.hidden ?? 0}` +
              (res.next_cursor ? `  (more: --cursor '${res.next_cursor}')` : ''),
          );
        } else emitJson(res);
      } catch (err) { fail(err); }
    });

  meta
    .command('comments-sync')
    .description('Pull fresh comments from Meta and label new ones with AI (30-120s on busy accounts)')
    .requiredOption('--account <id>', 'Meta ad account id')
    .option('--days <n>', 'Look-back window for paused ads / organic posts (default 14)', (v) => parseInt(v, 10))
    .option('--human', 'Pretty-print')
    .action(async (opts: { account: string; days?: number; human?: boolean }) => {
      try {
        note('Syncing comments from Meta — this can take a minute…');
        const res = await request<Envelope<Record<string, unknown>>>('/api/deploy-meta/comments/sync', {
          method: 'POST',
          body: { ad_account_id: opts.account, days: opts.days },
          signal: AbortSignal.timeout(180_000),
        });
        const d = res.data ?? {};
        if (opts.human) {
          const cls = (d.classification ?? {}) as Record<string, unknown>;
          note(
            `fetched ${fmtNum(d.fetched)}, upserted ${fmtNum(d.upserted)}, new ${(d.new_comment_ids as unknown[] | undefined)?.length ?? 0}, ` +
              `classified ${fmtNum(cls.classified)}, failed ${fmtNum(cls.failed)}${cls.deferred ? `, deferred ${fmtNum(cls.deferred)}` : ''}`,
          );
          const skipped = (d.skipped ?? []) as Array<{ reason: string; count: number }>;
          skipped.forEach((sk) => note(`skipped ${sk.reason} ×${sk.count}`));
        } else emitJson(res);
      } catch (err) { fail(err); }
    });

  meta
    .command('comment-action')
    .description('hide | unhide | reply | delete one comment (reply/delete prompt unless --yes)')
    .requiredOption('--comment <id>', 'Meta comment id (from `meta comments`)')
    .requiredOption('--action <a>', 'hide | unhide | reply | delete')
    .option('--message <text>', 'Reply text (required for --action reply)')
    .option('--yes', 'Skip the confirmation prompt for reply / delete', false)
    .option('--human', 'Pretty-print')
    .action(async (opts: { comment: string; action: string; message?: string; yes?: boolean; human?: boolean }) => {
      const action = opts.action.trim().toLowerCase();
      if (!['hide', 'unhide', 'reply', 'delete'].includes(action)) {
        fail(new Error(`Invalid --action "${opts.action}". Use hide | unhide | reply | delete.`));
        return;
      }
      if (action === 'reply' && !opts.message?.trim()) {
        fail(new Error('--message is required for --action reply.'));
        return;
      }
      // reply publishes text in the Page / IG account's name; delete is
      // permanent. Same guard shape as campaign-status --status active.
      if ((action === 'reply' || action === 'delete') && !opts.yes) {
        if (!process.stdin.isTTY) {
          fail(new Error(`Refusing to ${action} non-interactively without --yes.`));
          return;
        }
        const q = action === 'reply'
          ? `Post this public reply on comment ${opts.comment}?\n  "${opts.message}"\n[y/N] `
          : `Delete comment ${opts.comment} permanently? This cannot be undone. [y/N] `;
        const answer = await confirm(q);
        if (!answer) {
          note('Aborted — comment left unchanged.');
          return;
        }
      }
      try {
        const res = await request<Envelope<Record<string, unknown>>>(
          `/api/deploy-meta/comments/${encodeURIComponent(opts.comment)}/action`,
          { method: 'POST', body: { action, message: opts.message } },
        );
        if (opts.human) {
          const d = res.data ?? {};
          note(`${action} → ok${d.warning ? ` (${String(d.warning)})` : ''}`);
        } else emitJson(res);
      } catch (err) { fail(err); }
    });

  meta
    .command('comment-draft')
    .description('AI reply suggestions for one comment (nothing is posted)')
    .requiredOption('--comment <id>', 'Meta comment id')
    .option('--human', 'Pretty-print')
    .action(async (opts: { comment: string; human?: boolean }) => {
      try {
        const res = await request<Envelope<{ drafts?: string[] }>>(
          `/api/deploy-meta/comments/${encodeURIComponent(opts.comment)}/ai-draft`,
          { method: 'POST', body: {}, signal: AbortSignal.timeout(90_000) },
        );
        const drafts = res.data?.drafts ?? [];
        if (opts.human) {
          drafts.forEach((d, i) => process.stdout.write(`${kleur.bold(String(i + 1))}. ${d}\n`));
          if (drafts.length === 0) note('No drafts returned.');
        } else emitJson(res);
      } catch (err) { fail(err); }
    });

  // ─── publish ──────────────────────────────────────────────────────────────

  meta
    .command('publish')
    .description('Publish designs to Meta as PAUSED ads (activate in Ads Manager)')
    .requiredOption('--account <id>', 'Meta ad account id')
    .requiredOption('--page <id>', 'Facebook page id (see: quickdesign meta pages)')
    .requiredOption('--name <name>', 'Campaign name')
    .requiredOption('--objective <obj>', 'OUTCOME_LEADS | OUTCOME_SALES | OUTCOME_ENGAGEMENT | OUTCOME_AWARENESS | OUTCOME_TRAFFIC | OUTCOME_APP_PROMOTION')
    .requiredOption('--budget <amount>', 'Budget amount (account currency)', parseFloat)
    .option('--budget-type <t>', 'daily_budget | lifetime_budget', 'daily_budget')
    .option('--pixel <id>', 'Conversion pixel id')
    .option('--campaign-id <id>', 'Add ads into this existing campaign')
    .option('--adset-id <id>', 'Add ads into this existing ad set')
    .option('--design <id>', 'Design id to publish (repeatable)', (v: string, acc: number[]) => {
      acc.push(parseInt(v, 10));
      return acc;
    }, [] as number[])
    .option('--designs-json <file>', "Full per-design customization JSON array (file path or '-' for stdin)")
    .option('--caption <text>', 'Primary text (applied to all --design ads)')
    .option('--headline <text>', 'Headline (applied to all --design ads)')
    .option('--description <text>', 'Description (applied to all --design ads)')
    .option('--cta <type>', 'CTA type, e.g. SHOP_NOW, LEARN_MORE (applied to all)')
    .option('--url <url>', 'Landing page URL (applied to all)')
    .option('--wait', 'Block until all ads are created', false)
    .option('--human', 'Pretty-print progress')
    .action(async (opts: {
      account: string; page: string; name: string; objective: string; budget: number;
      budgetType: string; pixel?: string; campaignId?: string; adsetId?: string;
      design: number[]; designsJson?: string;
      caption?: string; headline?: string; description?: string; cta?: string; url?: string;
      wait?: boolean; human?: boolean;
    }) => {
      try {
        let designs: Array<Record<string, unknown>>;
        if (opts.designsJson) {
          const raw = opts.designsJson === '-'
            ? readFileSync(0, 'utf8')
            : readFileSync(opts.designsJson, 'utf8');
          designs = JSON.parse(raw);
          if (!Array.isArray(designs) || designs.length === 0) {
            fail(new Error('--designs-json must be a non-empty JSON array'));
          }
        } else if (opts.design.length > 0) {
          designs = opts.design.map((id) => ({
            design_id: id,
            caption: opts.caption,
            headline: opts.headline,
            description: opts.description,
            cta_type: opts.cta,
            target_url: opts.url,
          }));
        } else {
          fail(new Error('Provide at least one --design <id> or --designs-json <file>'));
          return;
        }

        const res = await request<{ job_id: string; total_tasks: number }>('/api/deploy-meta/publish', {
          method: 'POST',
          body: {
            ad_account_id: opts.account,
            page_id: opts.page,
            name: opts.name,
            objective: opts.objective,
            budget_amount: opts.budget,
            budget_type: opts.budgetType,
            pixel_id: opts.pixel,
            existing_campaign_id: opts.campaignId,
            existing_adset_id: opts.adsetId,
            designs,
          },
        });

        if (!opts.wait) {
          emitJson(res);
          note(`Track with: quickdesign meta publish-status ${res.job_id}`);
          note('All Meta objects are created PAUSED — activate in Ads Manager.');
          return;
        }

        note(`Job ${res.job_id} queued (${res.total_tasks} task(s)) — waiting…`);
        const final = await pollUntilDone<{ job: PublishJobRow; tasks: PublishTaskRow[] }>(
          async () => {
            const s = await request<{ job: PublishJobRow; tasks: PublishTaskRow[] }>(
              `/api/deploy-meta/publish/${res.job_id}`,
            );
            const { job, tasks } = s;
            const done = (job.completed_tasks ?? 0) + (job.failed_tasks ?? 0) >= job.total_tasks;
            if (opts.human) {
              const line = tasks
                .map((t) => `${t.design_id ?? '?'}:${t.status}`)
                .join('  ');
              process.stderr.write(`\r${kleur.dim(line.slice(0, 120).padEnd(120))}`);
            }
            return done ? { done: true, result: s } : { done: false };
          },
          { intervalMs: 4000, timeoutMs: 20 * 60_000 },
        );
        if (opts.human) process.stderr.write('\n');

        if (opts.human) {
          final.tasks.forEach((t) => {
            const mark = t.status === 'completed' ? kleur.green('✔') : kleur.red('✖');
            process.stdout.write(
              `${mark} design ${String(t.design_id ?? '?').padEnd(8)} ${t.status.padEnd(11)} ${t.ad_id ? `ad=${t.ad_id}` : ''} ${t.error_message ? kleur.red(t.error_message.slice(0, 80)) : ''}\n`,
            );
          });
          note(`Job ${final.job.status}: ${final.job.completed_tasks}/${final.job.total_tasks} completed, ${final.job.failed_tasks} failed`);
          note('All ads created PAUSED — activate them in Meta Ads Manager.');
        } else {
          emitJson(final);
        }
      } catch (err) { fail(err); }
    });

  meta
    .command('publish-status <jobId>')
    .description('Show a publish job + per-design task statuses')
    .option('--watch', 'Poll until terminal', false)
    .option('--human', 'Pretty-print')
    .action(async (jobId: string, opts: { watch?: boolean; human?: boolean }) => {
      try {
        const fetchOnce = (): Promise<{ job: PublishJobRow; tasks: PublishTaskRow[] }> =>
          request<{ job: PublishJobRow; tasks: PublishTaskRow[] }>(`/api/deploy-meta/publish/${jobId}`);

        let snapshot = await fetchOnce();
        if (opts.watch) {
          snapshot = await pollUntilDone(
            async () => {
              const s = await fetchOnce();
              const done = (s.job.completed_tasks ?? 0) + (s.job.failed_tasks ?? 0) >= s.job.total_tasks;
              return done ? { done: true, result: s } : { done: false };
            },
            { intervalMs: 4000, timeoutMs: 20 * 60_000 },
          );
        }

        if (opts.human) {
          const { job, tasks } = snapshot;
          process.stdout.write(`${kleur.bold(job.campaign_name ?? job.id)}  ${job.status}\n`);
          tasks.forEach((t) => {
            const mark = t.status === 'completed' ? kleur.green('✔') : t.status === 'failed' ? kleur.red('✖') : kleur.yellow('…');
            process.stdout.write(
              `${mark} design ${String(t.design_id ?? '?').padEnd(8)} ${t.status.padEnd(16)} ${t.ad_id ? `ad=${t.ad_id}` : ''} ${t.error_message ? kleur.red(t.error_message.slice(0, 80)) : ''}\n`,
            );
          });
          note(`${job.completed_tasks}/${job.total_tasks} completed, ${job.failed_tasks} failed — ads are PAUSED until activated in Ads Manager`);
        } else {
          emitJson(snapshot);
        }
      } catch (err) { fail(err); }
    });
}
