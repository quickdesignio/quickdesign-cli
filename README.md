# @quickdesign/cli

Command-line interface for [QuickDesign](https://quickdesign.io) — generate images and videos, mine competitor ads from the Spy Brands database, and automate brand workflows from your terminal, a CI pipeline, or a Claude Code agent.

## Install

```bash
npm install -g @quickdesign/cli
```

Requires Node.js ≥ 18.17.

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

| Variable              | Purpose                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `QUICKDESIGN_BASE_URL`| Override API base URL (default `https://app.quickdesign.io`)          |
| `QUICKDESIGN_TOKEN`   | Override the stored token (takes precedence over `auth.json`)         |

## Commands (v0.1)

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
git clone https://github.com/quickdesign/cli
cd cli
npm install
npm run build
npm link                           # makes `quickdesign` available on PATH

# point at a local BFF
export QUICKDESIGN_BASE_URL=http://localhost:3001
export QUICKDESIGN_TOKEN="<your local supabase jwt>"

quickdesign whoami
quickdesign spy brands --search anything --limit 3 --human
```

## Roadmap

- **v0.2** — `video generate` across Sora 2 / Kling / Seedance / UGC, `ad-creator` commands, streaming SSE support
- **v0.3** — refresh-token handling (no manual re-login at token expiry)
- **v0.4** — `design list|get|update` for iterating on saved assets
- **v1.0** — plugins, opt-in telemetry, Homebrew tap

## License

MIT
