# @quickdesign/cli

[![npm](https://img.shields.io/npm/v/@quickdesign/cli.svg?color=cb3837&label=npm)](https://www.npmjs.com/package/@quickdesign/cli)
[![node](https://img.shields.io/node/v/@quickdesign/cli.svg?color=339933)](https://www.npmjs.com/package/@quickdesign/cli)
[![license](https://img.shields.io/npm/l/@quickdesign/cli.svg?color=blue)](./LICENSE)

Command-line interface for [QuickDesign](https://quickdesign.io) — generate images and videos, mine competitor ads from the Spy Brands database, and automate brand workflows from your terminal, a CI pipeline, or a Claude Code agent.

## Install

```bash
npm install -g @quickdesign/cli
```

Requires Node.js ≥ 18.17.

> **Heads-up:** `quickdesign login` (browser flow) requires the QuickDesign web app's `/cli-auth` route to be deployed. Until then, use `quickdesign login --token <JWT>` (paste a Supabase access token from your logged-in browser session) or set `QUICKDESIGN_TOKEN` in your environment.

## Quickstart

```bash
# One-time browser login
quickdesign login

# Verify the session
quickdesign whoami

# Search competitors and pull a brand's ads
quickdesign spy brands --search "Kizik" --human
quickdesign spy brand-ads <brand-id> --status active --limit 5 --human

# Generate an image (blocks until ready, saves to disk)
quickdesign image generate \
  --prompt "studio photo of a silver bracelet on white background" \
  --model nano-banana-2 \
  --wait -o ./bracelet.jpg
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
| `status <requestId>` | Poll job status |
| `result <requestId> [-o path]` | Fetch finished job result |
| `history [--limit]` | List past image jobs |
| `models` | Discover available image models |

### `video` — Sora 2 / Kling / Seedance 2.0 / UGC

| Command | Notes |
| --- | --- |
| `generate --provider <sora2\|kling\|seedance\|ugc> --prompt … [--image \| --reference-image…] [--audio] [--duration] [--aspect-ratio] [--resolution] [--wait] [-o path]` | Start + optional poll + optional save. Seedance 2.0 r2v is activated by `--reference-image` (1+). UGC requires both `--image` and `--audio`. |
| `status <provider> <jobId>` | Poll job status |
| `history <provider> [--limit] [--status]` | List jobs for a provider |
| `upscale --video <url> --provider <topaz\|bytedance> [--factor] [--wait] [-o path]` | Kick off a Topaz/ByteDance video upscale |
| `upscale-status <jobId>` | Poll an upscale job |
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
| `status <requestId>` | Poll a single ad-creator job |
| `batch-status <batchId>` | Poll an advantage+ batch |

### `design`

PostgREST-direct (user JWT + RLS). Requires `QUICKDESIGN_SUPABASE_ANON_KEY`.

| Command | Notes |
| --- | --- |
| `list [--limit] [--offset] [--category] [--assets-only] [--archived]` | Your designs (most recent first) |
| `get <id>` | Full row |
| `delete <id>` | Soft-delete (sets `isArchived = true`) |
| `download <id> -o <path>` | Save the design's image or video to disk |

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
