---
name: quickdesign
description: |
  Use the QuickDesign CLI to generate AI images, analyze competitor ads from the Spy Brands
  database, and automate brand workflows. Trigger when the user asks to "generate an image",
  "analyze brand X's ads", "find trending ads", "scrape this brand's website", or similar —
  and when a working `quickdesign` binary is available.
---

# QuickDesign CLI

CLI-backed access to QuickDesign (image/video generation, Spy Brands ad intelligence, brand
scraping). Uses the global `quickdesign` binary if installed, otherwise `npx @quickdesign/cli`.

## When to use

- User wants to **generate / edit an AI image** with a prompt, optional source image, and save
  it to disk
- User wants to **explore or analyze ads** from competitor brands on Facebook / Instagram
  (Meta Ad Library) — top-impression ads, this-week ads, brand deep dives
- User wants to **search the brand catalog** by name or category
- Automating any of the above in a script, agent loop, or CI job

**Don't use** for live chat / Canvas editor interactions, admin-only brand management, or
anything that needs an interactive web UI.

## Setup (one-time)

```bash
# Install
npm install -g @quickdesign/cli

# Authenticate (opens browser)
quickdesign login

# Sanity check
quickdesign whoami
```

## How to invoke

Pass JSON output through `jq` / `grep` or let it pipe into other tools. Every data-returning
command defaults to JSON; most ship a `--human` pretty-printer.

### Spy Brands (read-only, no auth strictly required for most)

```bash
# Find a brand
quickdesign spy brands --search "Kizik" --human

# That brand's active ads, sorted by impressions
quickdesign spy brand-ads <brand-uuid> --status active --sort most_impressions --limit 20

# Cross-brand winners
quickdesign spy best-ads --limit 30 | jq '.[0:5]'

# Trending / for-you (auth required)
quickdesign spy trending --limit 10
quickdesign spy for-you --limit 10
```

### Image generation

```bash
# Blocking — returns a URL and saves file
quickdesign image generate \
  --prompt "studio photo of a silver bracelet on matte black" \
  --model nano-banana-2 \
  --wait -o ./out.jpg

# Non-blocking — returns a request_id you can poll later
quickdesign image generate -p "…"
quickdesign image status <request_id>
quickdesign image result <request_id> -o ./out.jpg

# Discover models
quickdesign image models
```

## Output conventions

- Default: **JSON to stdout**. Diagnostic messages go to **stderr**, so piping stays clean.
- `--human` on list commands switches to a readable TTY table.
- `-o <path>` on generate/result saves the binary and also emits the saved path in the JSON.
- Exit codes: `0` ok, `1` API/network error, `2` user / config error.

## Auth

Tokens live in `~/.config/quickdesign/auth.json` (0600). Override with `QUICKDESIGN_TOKEN` in
the environment — useful for CI.

If a command exits with `401 TOKEN_EXPIRED`, re-run `quickdesign login`.

## Escalation pattern

1. `quickdesign spy brands --search <name>` to find the right brand id
2. `quickdesign spy brand-ads <brand-id> --status active --limit 50` to review creative
3. If user wants to replicate / remix a creative: `quickdesign image generate --prompt …
   --image <source-url> --wait -o ./draft.jpg`
4. Iterate; the result JSON includes a `designId` you can reference later

## Notes for Claude

- When asked "analyze brand X", always: 1) look up the brand id first, 2) pull active ads,
  3) return a short summary grounded in actual ad copy + hooks — don't hallucinate.
- For image generation with a user-supplied photo, if the source is a local file, upload it
  to a public URL first (Supabase Storage, R2, imgur) and pass `--image <url>`. Base64 /
  local paths are not supported at the API boundary.
- Respect `--wait` carefully — image jobs can take 30-120s; the CLI already handles polling.
