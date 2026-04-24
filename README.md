# @quickdesign/cli

[![npm](https://img.shields.io/npm/v/@quickdesign/cli.svg?color=cb3837&label=npm)](https://www.npmjs.com/package/@quickdesign/cli)
[![node](https://img.shields.io/node/v/@quickdesign/cli.svg?color=339933)](https://www.npmjs.com/package/@quickdesign/cli)
[![license](https://img.shields.io/npm/l/@quickdesign/cli.svg?color=blue)](./LICENSE)

Command-line interface for [QuickDesign](https://quickdesign.io) — built so anyone (or any Claude Code agent) can drive the full QuickDesign stack from a terminal:

- **Generate** AI images (Nano Banana, GPT Image) and videos (Sora 2, Kling, **Seedance 2.0** including reference-to-video, UGC) — start, poll, save to disk in one command.
- **Smart Ad Creator** — turn a product URL into a single concept ad, or fan out 16 concepts in parallel (Advantage+).
- **Spy Brands** — query the competitor ad library: per-brand ads, cross-brand winners, this-week trends.
- **Brand DNA** — scrape a website's colors / fonts / logo, or run the full Claude-streamed Brand DNA extraction (voice, audience, offer).
- **Designs** — list, fetch, download, or archive your saved creatives directly from PostgREST.
- **Ship-ready** — JSON to stdout, diagnostics to stderr, exit codes for pipelines, optional `--human` pretty-print.

## Install

```bash
npm install -g @quickdesign/cli
```

Requires Node.js ≥ 18.17.

> **Heads-up:** `quickdesign login` (browser flow) requires the QuickDesign web app's `/cli-auth` route to be deployed. Until then, use `quickdesign login --token <JWT>` (paste a Supabase access token from your logged-in browser session) or set `QUICKDESIGN_TOKEN` in your environment.

## Quickstart

```bash
# One-time browser login (or: --token <JWT> for CI / headless)
quickdesign login

# Verify the session
quickdesign whoami

# --- Spy Brands ---------------------------------------------------------
quickdesign spy brands --search "Kizik" --human
quickdesign spy brand-ads <brand-id> --status active --sort most_impressions --limit 5

# --- Image: studio shot, save to disk -----------------------------------
quickdesign image generate \
  --prompt "studio photo of a silver bracelet on white background" \
  --model nano-banana-2 --wait -o ./bracelet.jpg

# --- Video: Seedance 2.0 r2v with two reference images ------------------
quickdesign video generate --provider seedance \
  --reference-image https://cdn.example.com/bracelet.jpg \
  --reference-image https://cdn.example.com/model.jpg \
  --prompt "@Image2 wearing @Image1, slow catwalk" \
  --aspect-ratio 9:16 --duration 5 --wait -o ./catwalk.mp4

# --- Smart Ad Creator: 16 concepts in parallel --------------------------
quickdesign ad-creator advantage-plus \
  --product-url https://kizik.com/products/bowen-black --wait -o ./ads
ls ./ads/   # one .jpg per completed concept

# --- Brand DNA (Claude-streamed) ----------------------------------------
quickdesign brand dna https://kizik.com

# --- Your designs -------------------------------------------------------
export QUICKDESIGN_SUPABASE_ANON_KEY="<your supabase anon key>"
quickdesign design list --limit 10
quickdesign design download <id> -o ./out.jpg
```

## Authentication

`quickdesign login` opens the default browser, waits for the QuickDesign web app to hand back a token, and writes it to:

```
~/.config/quickdesign/auth.json  (0600)
```

For CI, skip the browser:

```bash
QUICKDESIGN_TOKEN=<supabase-jwt> quickdesign spy brands
# or
quickdesign login --token <supabase-jwt>
# or
cat my-token.txt | quickdesign login --token-stdin
```

Logout / inspect config:

```bash
quickdesign logout
quickdesign auth config show
quickdesign auth config set baseUrl http://localhost:3001   # local dev
```

## Environment variables

| Variable                        | Purpose                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `QUICKDESIGN_BASE_URL`          | Override API base URL (default `https://app.quickdesign.io`)                                        |
| `QUICKDESIGN_TOKEN`             | Override the stored token (takes precedence over `auth.json`)                                       |
| `QUICKDESIGN_SUPABASE_URL`      | Override Supabase REST base (default: prod project). Used only by `design` subcommands.             |
| `QUICKDESIGN_SUPABASE_ANON_KEY` | Supabase anon key. **Required** for `design` subcommands (PostgREST-direct; RLS scopes to user).    |

## Commands (v0.2)

### `auth`

| Command                      | Notes                                              |
| ---------------------------- | -------------------------------------------------- |
| `login`                      | Browser OAuth (fallback flags: `--token`, `--token-stdin`) |
| `logout`                     | Delete the stored token                            |
| `whoami`                     | Show the active user, token expiry, live ping      |
| `auth config show|get|set|path` | Inspect / tweak the config file                 |

### `spy` — Spy Brands

| Command | Notes |
| --- | --- |
| `brands [--search] [--limit]` | List / search brands |
| `brand <brandId>` | Fetch one brand |
| `brand-ads <brandId> [--status] [--sort] [--limit]` | List a brand's ads |
| `best-ads [--limit] [--category-id] [--status]` | Top ads cross-brand |
| `search <query>` | Convenience alias for brand search |
| `for-you` | Personalized feed (auth required) |
| `trending` | Trending feed |

### `image`

| Command | Notes |
| --- | --- |
| `generate --prompt … [--model] [--wait] [-o path]` | Async start + optional poll + optional save |
| `status <requestId>` | One-shot status check |
| `wait <requestId> [--timeout] [-o path]` | Resume polling on a job started earlier and optionally download |
| `result <requestId> [-o path]` | Fetch finished job result |
| `history [--limit]` | List past image jobs |
| `models` | Discover available image models |

### `video` — Sora 2 / Kling / Seedance 2.0 / UGC

| Command | Notes |
| --- | --- |
| `generate --provider <sora2\|kling\|seedance\|ugc> --prompt … [--image \| --reference-image…] [--audio] [--duration] [--aspect-ratio] [--resolution] [--wait] [-o path]` | Start + optional poll + optional save. Seedance 2.0 r2v is activated by `--reference-image` (1+). UGC requires both `--image` and `--audio`. |
| `status <provider> <jobId>` | One-shot status check |
| `wait <provider> <jobId> [--timeout] [-o path]` | Resume polling on a job started earlier (default timeout 30 min) and optionally download |
| `history <provider> [--limit] [--status]` | List jobs for a provider |
| `upscale --video <url> --provider <topaz\|bytedance> [--factor] [--wait] [-o path]` | Kick off a Topaz/ByteDance video upscale |
| `upscale-status <jobId>` | One-shot status check |
| `upscale-wait <jobId> [--timeout] [-o path]` | Resume polling on an upscale job |
| `upscale-history [--limit]` | List upscale jobs |

### `brand`

| Command | Notes |
| --- | --- |
| `scrape <url>` | Sync scrape — returns colors, fonts, logo, description |
| `dna <url> [--output json\|events]` | Full Brand DNA via Claude (SSE). Default prints the final JSON; `--output events` emits NDJSON of every frame (agents) |

### `ad-creator` — Smart Ad Creator

| Command | Notes |
| --- | --- |
| `concepts [--human]` | List available concept slugs |
| `analyze <product-url>` | Extract product name, images, features, audience |
| `generate --product-url --concept <slug> [--brand-kit] [--wait] [-o path]` | Single-concept async job |
| `advantage-plus --product-url [--brand-kit] [--wait] [-o dir]` | Fan out 16 concepts. With `-o <dir>`, every completed concept is saved to `<dir>/<concept>.jpg` |
| `status <requestId>` | One-shot status check |
| `wait <requestId> [--timeout] [-o path]` | Resume polling on a single ad job |
| `batch-status <batchId>` | One-shot batch status |
| `batch-wait <batchId> [--timeout] [-o dir]` | Resume polling on an advantage+ batch + download every completed concept |

### `design`

PostgREST-direct (user JWT + RLS). Requires `QUICKDESIGN_SUPABASE_ANON_KEY`.

| Command | Notes |
| --- | --- |
| `list [--limit] [--offset] [--category] [--assets-only] [--archived]` | Your designs (most recent first) |
| `get <id>` | Full row |
| `delete <id>` | Soft-delete (sets `isArchived = true`) |
| `download <id> -o <path>` | Save the design's image or video to disk |

## Long-running jobs

Video generations and Advantage+ batches commonly take 5–15 minutes. The CLI is polling-only (no inbound webhook into your laptop), so you have three options:

**1. Block in the foreground.** Pass `--wait -o ./out.mp4` and the CLI polls + downloads in one step. `--timeout <ms>` controls the cap (default 15 min for video, 30 min for upscale and batches).

**2. Fire-and-forget, resume later.** Start the job, capture the request id, walk away, then resume:

```bash
# start (returns immediately)
JOB=$(quickdesign video generate --provider seedance \
  --image https://cdn/foo.jpg --prompt "..." | jq -r '.request_id')
echo $JOB > /tmp/myjob.id

# minutes later — same machine, another terminal, or even a cron tick
quickdesign video wait seedance "$JOB" --timeout 1800000 -o ./out.mp4
```

`wait` re-polls the BFF, downloads when ready, and prints the same JSON shape as `--wait` would have.

**3. Background it.** `nohup quickdesign video generate ... --wait -o ./out.mp4 > job.log 2>&1 &` then `tail -f job.log`.

For Advantage+ batches use `ad-creator batch-wait <batchId> -o ./ads` — same idea but downloads every completed concept to the directory.

The job state itself lives in the BFF (`ugc_video_jobs` / `image_generation_jobs` tables) so you can leave a job for hours and pick it up later. Result URLs (R2) don't expire.

## Claude Code skill

The repo ships a skill stub at `skill/SKILL.md`. To enable it globally for your
Claude Code sessions:

```bash
mkdir -p ~/.claude/skills/quickdesign
cp "$(npm root -g)/@quickdesign/cli/skill/SKILL.md" ~/.claude/skills/quickdesign/SKILL.md
```

Claude Code will pick it up on the next session and call `quickdesign …` on your
behalf when a user asks for image generation, ad research, or brand analysis.

## Development

```bash
git clone https://github.com/ottasilver/quickdesign-cli
cd quickdesign-cli
npm install
npm run build
npm link                           # makes `quickdesign` available on PATH

# point at a local BFF
export QUICKDESIGN_BASE_URL=http://localhost:3001
export QUICKDESIGN_TOKEN="<your local supabase jwt>"

quickdesign whoami
quickdesign spy brands --search anything --limit 3 --human
```

## Releasing

Publishes are automated via GitHub Actions (`.github/workflows/publish.yml`). A tag push to `main` triggers `npm publish`.

One-time repo setup (maintainers):

1. Create a [granular access token](https://www.npmjs.com/settings/~/tokens) on npm — scope `@quickdesign`, read+write, bypass-2FA.
2. Add it to the repo as a GitHub secret named `NPM_TOKEN` (Settings → Secrets and variables → Actions).

Cut a release:

```bash
# bump + tag + commit
npm version patch        # or: minor / major
git push --follow-tags   # CI takes over, runs build + publish

# dry-run via Actions UI:
gh workflow run publish.yml -f dry_run=true
```

The workflow also verifies the git tag matches `package.json#version` before publishing, so `v0.1.2` tag + `package.json: 0.1.1` will fail loudly rather than mis-tag the release.

## Roadmap

- **v0.1** ✅ — Auth (browser OAuth + token fallbacks), `spy`, `image`, Claude Code skill
- **v0.2** ✅ — `video` (Sora 2 / Kling / Seedance 2.0 incl. r2v / UGC + upscale), `brand`
  (scraper + SSE DNA), `ad-creator` (single + advantage+), `design` (list / get / delete /
  download — PostgREST-direct)
- **v0.3** — refresh-token handling (no manual re-login at token expiry)
- **v0.4** — local-file sources (`--image ./foo.jpg`) via auto-upload to R2
- **v1.0** — plugins, opt-in telemetry, Homebrew tap

## License

MIT
