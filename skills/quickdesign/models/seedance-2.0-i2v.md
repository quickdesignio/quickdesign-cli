---
slug: seedance-2.0-i2v
category: video_generate
provider: fal | kie
status: niche
description: Seedance 2.0 Image-to-Video. Niche model, almost never the right pick for UGC. The default is `seedance-2.5` (reference mode), with `seedance-2.0-r2v` as fallback. This card exists so the agent recognizes when (rarely) i2v is the right call and can document why.
---

## When to use

**Almost never.** `seedance-2.5` is the default for everything UGC, and `seedance-2.0-r2v` is its fallback. Use i2v ONLY when:

- The user has named `seedance-2.0-i2v` explicitly ("use i2v")
- Both `seedance-2.5` and `seedance-2.0-r2v` are unavailable / inactive in the registry (check `quickdesign video models`)

There is **no scenario** where i2v is "simpler" enough to justify silently picking it. Seedance 2.5 (and 2.0 R2V) accept a single `--reference-image` cleanly. From the user's side it works exactly like i2v's `--image`, and it keeps every primitive the skill depends on:

- `@Image1` reference grammar
- Repeatable `--reference-image` for multi-product
- `--reference-audio` voice continuity for multi-segment

i2v silently forfeits all three.

## Capabilities (for reference)

```bash
quickdesign cost seedance-2.0-i2v -d 12 -r 1080p
quickdesign video models | jq '.data[] | select(.slug=="seedance-2.0-i2v")'
```

- Selected by `--provider seedance --image <frame>` **without** `--model`, which is an easy accident. Always pass `--model seedance-2.5` for the default.
- Single `--image` input only: no `image_urls[]` array, no `audio_urls[]`, no `video_urls[]`
- Same duration grid (4–15s), same resolutions, same aspect ratios
- Native audio: yes, but no voice continuity primitive

## How to apply

Don't pick this model autonomously. If considering it, either:
1. Default to `seedance-2.5` instead (see `./seedance-2.5.md`), OR
2. Route through `AskUserQuestion` and let the user explicitly pick i2v.

See `../SKILL.md` cardinal rule #0.
