# Deploy Meta — publish ads + analyze your own Meta performance

`quickdesign meta …` wraps the BFF's `/api/deploy-meta/*` routes. Two halves:
**publish** (designs → Meta ads) and **analytics** (your own ad performance).

## Prerequisite — Meta must be connected in the app

Every subcommand needs the user's Meta (Facebook) account connected to
QuickDesign. If you see `No valid Meta access token found`, tell the user to
open **app.quickdesign.io/deploy-meta** and complete the "Connect Meta" step,
then retry. There is no CLI flow for this — it's an app-side OAuth.

## Safety model — everything is created PAUSED

`meta publish` creates the campaign, ad set and every ad with
**status=PAUSED** on Meta. Nothing delivers and no budget is spent until the
campaign is activated. Always tell the user this after publishing.

Activation is possible from the CLI (`meta campaign-status --status active`)
but it is the one command here that SPENDS MONEY. Rules:

- Never activate a campaign the user did not explicitly name in this
  conversation. "Publish these" is NOT permission to activate.
- Before activating, state the campaign name and its budget, and get an
  explicit yes.
- `--status paused` is the safe, reversible answer to "turn it off", "stop
  it", "pause the spend".
- `--status archived` is effectively one-way — Meta will not put an archived
  campaign back into delivery. Only on an explicit "archive/retire" request.

## The flow

```bash
# 1. Discover ids (account currency matters for --budget)
quickdesign meta accounts --human          # → ad_account_id (act_…)
quickdesign meta pages --human             # → page_id (required for publish)
quickdesign meta pixels --account act_X    # optional, recommended for OUTCOME_SALES

# 2. Pick designs from the user's library
quickdesign design list --limit 20

# 3. Publish (new campaign; everything PAUSED)
quickdesign meta publish \
  --account act_X --page 1234567890 \
  --name "Summer Sale UGC" --objective OUTCOME_SALES \
  --budget 50 --pixel 987654 \
  --design 1234 --design 5678 \
  --caption "Feel the difference" --cta SHOP_NOW --url https://shop.example.com \
  --wait --human

# 3b. Or into an existing campaign / ad set
quickdesign meta campaigns --account act_X --human
quickdesign meta adsets --campaign <campaignId> --human
quickdesign meta publish … --campaign-id <id> [--adset-id <id>] …

# 3c. Per-design customization (different captions per ad)
quickdesign meta publish … --designs-json ./ads.json
# ads.json: [{"design_id":1234,"caption":"…","headline":"…","cta_type":"SHOP_NOW","target_url":"…"}, …]

# 4. Track (also: --wait above does this inline)
quickdesign meta publish-status <jobId> --watch --human

# 5. Turn delivery on / off (CAMPAIGN level; ad sets and ads keep their own status)
quickdesign meta campaign-status --account act_X --campaign <campaignId> --status paused --human
quickdesign meta campaign-status --account act_X --campaign <campaignId> --status active --yes --human
```

`campaign-status` prompts for confirmation on `--status active` when stdin is
a TTY; non-interactive callers (agents, scripts, CI) must pass `--yes`, which
the agent should only do after the user has confirmed in conversation.

Job is terminal when `completed_tasks + failed_tasks === total_tasks`.
Per-task statuses: `pending → uploading_media → creating_adset → creating_ad →
completed | failed` (failed tasks carry `error_message`).

## Analytics

```bash
# Account-level timeseries + previous-period comparison (live Meta API, 10-30s)
quickdesign meta insights --account act_X --preset last_30d --human
quickdesign meta insights --account act_X --since 2026-05-01 --until 2026-05-31

# Per-creative report (cached — may lag reality)
quickdesign meta report --account act_X --preset last_30d --human

# Creative grades: which ads to kill / scale
quickdesign meta radar --account act_X --human
quickdesign meta radar --account act_X --compute --human   # re-sync first (~30-90s)
```

Radar categories and what to recommend:

| Category | Meaning | Recommendation |
|---|---|---|
| `winner` | High grade + meaningful spend | Scale budget |
| `high_potential` | High grade, low spend | Push more budget to test |
| `iteration_candidate` | Middling metrics | Iterate on the creative (new hook/visual) |
| `underperformer` | Low grade | Pause/kill, reallocate |

When the report/radar numbers look stale, run `radar --compute` once, then
re-read. Don't run `--compute` repeatedly in a loop — it hits the Meta API
hard and takes ~30-90s per run.

## Comments — moderate FB/IG comments under ads and posts

```bash
# 1. Pull fresh comments (active ads + recently paused ads + recent organic posts) and label them
quickdesign meta comments-sync --account act_X --human

# 2. Triage: attention = negative/spam + unanswered questions (default tab)
quickdesign meta comments --account act_X --human
quickdesign meta comments --account act_X --tab questions --platform instagram --human
quickdesign meta comments --account act_X --tab all --source ad --limit 100   # JSON, paging via --cursor

# 3. Act on one comment (id from step 2)
quickdesign meta comment-action --comment <id> --action hide
quickdesign meta comment-draft  --comment <id> --human                  # 3 AI suggestions, nothing posted
quickdesign meta comment-action --comment <id> --action reply --message "…" --yes
quickdesign meta comment-action --comment <id> --action delete --yes
```

Rules for agents:

- `hide` / `unhide` are reversible — fine to run when the user asks to hide spam or negativity.
- `reply` posts **public** text in the Page / Instagram account's name: show the user the exact text
  and get an explicit OK first. `delete` is permanent: only when the user names that comment.
  Both prompt on a TTY and refuse non-interactively without `--yes`.
- Never bulk-reply or bulk-delete from a list the user has not reviewed.
- A background job syncs every 30 minutes; run `comments-sync` only when the user wants fresh data
  (30-120 s on busy accounts).
- 403 "permission" errors mean the user's Meta connection predates the comment scopes → they must
  **Reconnect** in app.quickdesign.io/deploy-meta → Account Settings.
- Instagram *ad-only* media may be skipped (`skipped: ig_ad_comments_unavailable`) — Meta does not
  expose comments on some dark-post IG ads.

## Gotchas

- `--budget` is in the ad account's currency major unit (see `meta accounts` output).
- `OUTCOME_SALES` without `--pixel` publishes but cripples optimization — recommend a pixel.
- Video designs need a thumbnail; the backend resolves it from the design row automatically.
- Design ids must belong to the logged-in user — others are rejected with 403.
