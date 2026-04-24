---
name: quickdesign
description: |
  Use the QuickDesign CLI to generate AI images and videos (Sora 2 / Kling / Seedance / UGC),
  run Smart Ad Creator workflows, analyze competitor ads from Spy Brands, extract Brand DNA
  from any website, and list/download your saved designs. Trigger when the user asks to
  "generate an image/video", "analyze brand X's ads", "make a Smart Ad from this product URL",
  "extract brand colors from this site", "list my designs", "find trending ads", or similar —
  and when a working `quickdesign` binary is available.
---

# QuickDesign CLI

CLI-backed access to QuickDesign (image + video generation, Smart Ad Creator, Spy Brands ad
intelligence, brand scraping + DNA, designs CRUD). Uses the global `quickdesign` binary if
installed, otherwise `npx @quickdesign/cli`.

## When to use

- User wants to **generate an AI image or video** with a prompt, optional source/reference
  images, and save it to disk (image: Nano Banana / GPT Image; video: Sora 2 / Kling /
  Seedance 2.0 / UGC)
- User wants to **create Smart Ad creatives** from a product URL — either a single concept
  or Advantage+ (16 concepts in parallel)
- User wants to **explore or analyze competitor ads** (Meta Ad Library) — top-impression,
  this-week, brand deep dives
- User wants to **scrape or extract Brand DNA** (colors, fonts, logo, voice, audience) from
  a website
- User wants to **list, inspect, or download their saved designs**
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

### Video generation (Sora 2 / Kling / Seedance 2.0 / UGC)

```bash
# Sora 2 text-to-video
quickdesign video generate --provider sora2 -p "a cat on the beach" --duration 4 --wait -o ./cat.mp4

# Seedance 2.0 i2v (single reference image)
quickdesign video generate --provider seedance \
  --image https://cdn/bracelet.jpg -p "slow rotation on velvet pedestal" \
  --duration 5 --wait -o ./i2v.mp4

# Seedance 2.0 r2v (multiple reference images + optional videos)
quickdesign video generate --provider seedance \
  --reference-image https://cdn/bracelet.jpg \
  --reference-image https://cdn/model.jpg \
  -p "@Image2 wearing @Image1, catwalk studio" \
  --aspect-ratio 9:16 --wait -o ./r2v.mp4

# UGC (requires both audio + image URLs)
quickdesign video generate --provider ugc \
  --image https://cdn/avatar.jpg --audio https://cdn/voiceover.mp3 \
  -p "friendly product demo" --wait -o ./ugc.mp4

# Poll manually or list history
quickdesign video status seedance <jobId>
quickdesign video history seedance --limit 10

# Upscale (Topaz or ByteDance)
quickdesign video upscale --video https://cdn/in.mp4 --provider topaz --factor 2 --wait -o ./hi.mp4
```

### Smart Ad Creator

```bash
# List available concepts
quickdesign ad-creator concepts --human

# Analyze a product page (images, features, audience)
quickdesign ad-creator analyze https://kizik.com/products/bowen-black

# Generate one concept
quickdesign ad-creator generate \
  --product-url https://kizik.com/products/bowen-black \
  --concept static-product --wait -o ./ad.jpg

# Advantage+ — fan out 16 concepts, download each
quickdesign ad-creator advantage-plus \
  --product-url https://kizik.com/products/bowen-black --wait -o ./ads
ls ./ads/   # one .jpg per completed concept
```

### Brand scraper + DNA

```bash
# Sync scrape — colors, fonts, logo, description
quickdesign brand scrape https://kizik.com

# Full Brand DNA (SSE streamed, Claude-backed — adds voice, audience, offer)
quickdesign brand dna https://kizik.com

# Stream every progress event as NDJSON (for agents)
quickdesign brand dna https://kizik.com --output events
```

### Designs (your saved creatives)

Requires `QUICKDESIGN_SUPABASE_ANON_KEY` set (from SPA env or Supabase dashboard).

```bash
quickdesign design list --limit 10
quickdesign design list --assets-only --category product
quickdesign design get <id>
quickdesign design download <id> -o ./out.jpg
quickdesign design delete <id>    # soft-delete (sets isArchived=true)
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

## Escalation patterns

**Competitor-driven creative:**
1. `quickdesign spy brands --search <name>` → find brand id
2. `quickdesign spy brand-ads <brand-id> --status active --sort most_impressions --limit 20` → see winners
3. Extract a source image URL from one ad
4. `quickdesign image generate --prompt … --image <source-url> --wait -o ./draft.jpg` (remix)
   OR `quickdesign video generate --provider seedance --image <source-url> -p "…" --wait -o ./draft.mp4`

**Product → Smart Ad pipeline:**
1. `quickdesign brand dna <product-site>` → pick up brand voice, colors, fonts (optional but improves results)
2. `quickdesign ad-creator analyze <product-url>` → confirm extraction
3. `quickdesign ad-creator advantage-plus --product-url <url> --wait -o ./ads` → 16 concepts in parallel
4. Review `./ads/*.jpg`; the CLI prints a JSON summary with per-concept URLs + design ids

**Video from an existing still:**
1. `quickdesign image generate … -o ./hero.jpg` (or use a design id)
2. Upload to a public URL (R2, Supabase Storage, etc.) — the video endpoints accept URLs only
3. `quickdesign video generate --provider seedance --image <url> -p "…" --wait -o ./out.mp4`
4. Optionally: `quickdesign video upscale --video <url> --provider topaz --factor 2 --wait -o ./hi.mp4`

## Notes for Claude

- When asked "analyze brand X", always: 1) look up the brand id first, 2) pull active ads,
  3) return a short summary grounded in actual ad copy + hooks — don't hallucinate.
- **Sources must be URLs.** For image/video generation with a user-supplied photo, if the
  source is a local file, upload it to a public URL first (Supabase Storage, R2, imgur) and
  pass `--image <url>` / `--reference-image <url>`. Base64 / local paths are not supported.
- Respect `--wait` carefully — image jobs 30–120s, video jobs 1–5min, advantage+ 3–8min.
  The CLI already handles polling; just pick a sensible `--timeout`.
- **Seedance 2.0 modes:** default is i2v (`--image`); switch to r2v by passing one or more
  `--reference-image` flags. In r2v mode, reference the images in the prompt as `@Image1`,
  `@Image2`, etc. (Seedance convention).
- **`design` subcommands need a Supabase anon key** (`QUICKDESIGN_SUPABASE_ANON_KEY`) since
  they hit PostgREST directly. RLS restricts you to your own rows.
