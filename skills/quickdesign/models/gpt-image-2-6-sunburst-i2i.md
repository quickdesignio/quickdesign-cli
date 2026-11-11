---
slug: gpt-image-2-6-sunburst-i2i
category: image_edit
provider: kie
status: opt-in
description: GPT Image 2.6 Sunburst (image-to-image, via kie.ai; `gpt-image-2-6-sunburst-t2i` for text-to-image). Same price as 2.5 (12 / 18 / 24 cr at 1K / 2K / 4K), up to 16 reference images, 16 aspect ratios INCLUDING 4:5 / 5:4, and every ratio renders at every resolution. Added 2026-11-10 next to 2.5; 2.5 stays the default edit model until the user says otherwise.
---

## When to use

**When the user names GPT Image 2.6 / "the new Sunburst"**, or offer it (ask first) when:

- The deliverable is **4:5 or 5:4** (Meta feed) and the user wants the Sunburst look. 2.5 silently clamps those to 3:4 / 4:3; 2.6 renders them, at 2K and 4K too. `nano-banana-2-1` remains the cheap 4:5 route (2–4 cr).
- More than 10 references are needed (2.6 takes 16).
- A tall / wide ratio (`27:16`-style) had to stay at 1K on 2.5: 2.6 has `21:9`, `9:21`, `3:1`, `1:3`, `2:1`, `1:2` at every resolution.

Everything in `./gpt-image-2-5-sunburst-i2i.md` (edit-verbs, `@ImageN` labels, hands / engraving / moderation gotchas) applies unchanged. The default for image edit is still 2.5 (`../SKILL.md` cardinal rule #0) — do not move a job to 2.6 on your own.

## Hard facts (live)

```bash
quickdesign cost gpt-image-2-6-sunburst-i2i -r 2K --num 1
quickdesign image models | jq '.data[] | select(.slug | startswith("gpt-image-2-6"))'
```

- **Slugs**: `gpt-image-2-6-sunburst-i2i` (needs ≥ 1 reference) and `gpt-image-2-6-sunburst-t2i` (no reference). The server switches i2i → t2i by itself when no image is attached (MCP / CLI / v1 callers), so a prompt-only call with the i2i slug no longer 400s.
- **References**: 1–16 `--reference-image`, in submission order (`@Image1`, …). jpeg / png / webp.
- **Resolutions**: `1K` / `2K` / `4K` (a `0.5K` request is clamped to 1K). Cost = 6 × {1K:2, 2K:3, 4K:4} = **12 / 18 / 24 cr** per image — the 2.5 curve copied over, because kie bills 2.6 per token and publishes no per-image price; the registry row may be repriced once real spend is visible.
- **Aspect ratios** (every one at every resolution): `auto`, `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `5:4`, `4:5`, `16:9`, `9:16`, `2:1`, `1:2`, `21:9`, `9:21`, `3:1`, `1:3`. An out-of-enum ratio (e.g. `4:1`) is clamped to the nearest legal one before the charge.
- `quality` is not sent (kie's default `medium` applies); output is png.

## Call

```bash
quickdesign image generate \
  --model gpt-image-2-6-sunburst-i2i \
  --reference-image avatar.jpg --reference-image product.jpg \
  --aspect-ratio 4:5 --resolution 2K \
  -p "Edit @Image1: she now holds the product in @Image2 exactly. Keep face, hair, outfit, setting and lighting unchanged from @Image1." \
  -o ./feed.png --wait
```

## Gotchas

1. Same OpenAI moderation path as 2.5: third-party brand names still trip it (`../references/brand-and-moderation.md`).
2. Same anatomy / engraving failure modes as 2.5 — check every output before it goes into Seedance.
3. kie ids for 2.6 are slash-form (`gpt-image-2-6/sunburst-image-to-image`); that is the server's concern — the CLI only ever takes the slug above.

## Cross-references

- Default edit model, prompt skeletons, failure modes → `./gpt-image-2-5-sunburst-i2i.md`
- 4:5 on a budget → `./nano-banana-2.md`
- Multi-product reference pattern → `../references/multi-reference-pattern.md`
