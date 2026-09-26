---
slug: gpt-image-2-5-sunburst-i2i
category: image_edit
provider: kie
status: primary
description: GPT Image 2.5 Sunburst (image-to-image, via kie.ai). Default for image edit / multi-ref product composition / angle change / state change, and the default pre-stage that builds reference frames for Seedance. Up to 10 reference images, 1K/2K/4K, 13 aspect ratios but NO 4:5 / 5:4. Needs at least one reference image and an explicit `--model`.
---

## When to use

- Avatar holding or wearing a product with pixel-faithful product detail (multi-ref: avatar + product angles + scene)
- Angle change, state change (glasses off, mouth closed, different outfit)
- Building the reference frame(s) before Seedance 2.5. A reference edit costs about 18 cr, a Seedance 2.5 segment 336–840 cr, so a wrong reference chained into video wastes 20–45× the edit cost.
- Product on white, lifestyle composite, brand-kit-styled creative
- Edits with an object **in the mouth / between the teeth**. Nano Banana (Gemini moderation) rejects these. Sunburst uses OpenAI moderation and lets editorial shots through.

Use something else when:
- **The deliverable is 4:5 or 5:4** (Meta feed). Sunburst doesn't support those ratios, so use `nano-banana-2` (or `nano-banana-pro` for higher fidelity). See `./nano-banana-2.md`.
- **There's no reference image at all** (pure text-to-image). The i2i model returns a 400. Use `gpt-image-2-t2i`, or `gpt-image-2-5-sunburst-t2i` if `quickdesign image models` lists it as active.
- **You're iterating on cheap drafts in bulk**. `nano-banana-2` at 1K (4 cr) or `nano-banana-lite-edit` (6 cr, 1K only) cost less.

## Hard facts (live)

```bash
quickdesign cost gpt-image-2-5-sunburst-i2i -r 2K --num 1
quickdesign image models | jq '.data[] | select(.slug | startswith("gpt-image-2-5"))'
```

- **`--model gpt-image-2-5-sunburst-i2i` is mandatory.** The CLI's built-in default is still `nano-banana-2`.
- **References**: 1–10 `--reference-image`, reasoned over in submission order (`@Image1`, `@Image2`, …). jpeg/png/webp, ≤ 30 MB each.
- **Resolutions**: `1K` / `2K` / `4K` (no `0.5K`). Cost = 6 × {1K:2, 2K:3, 4K:4} = **12 / 18 / 24 cr** per image. Default to `2K`. Use `4K` only when fine product detail (engraving, label text, stitching) has to survive into the video.
- **Aspect ratios**: `auto`, `1:1`, `3:2`, `2:3`, `16:9`, `9:16`, `4:3`, `3:4`, `21:9`, `27:16`, `16:27`, `9:8`, `8:9`.
  - **No `4:5` / `5:4`.** The BFF doesn't fail on them: it silently clamps 4:5 → 3:4 and 5:4 → 4:3. Don't let that happen unnoticed on a feed ad.
  - `27:16`, `16:27`, `9:8`, `8:9` render at **1K only**. Higher resolutions get clamped down (and billed at 1K).
- Match the aspect ratio to the downstream video (`9:16` for Reels/TikTok/Shorts).

## Multi-reference call

```bash
quickdesign image generate \
  --model gpt-image-2-5-sunburst-i2i \
  --reference-image avatar.jpg \         # @Image1 — identity
  --reference-image product-side.jpg \   # @Image2 — product hero
  --reference-image product-top.jpg \    # @Image3 — product detail
  --aspect-ratio 9:16 --resolution 2K \
  -p "Edit @Image1: she now holds a product matching @Image2 exactly. Replicate the stitching / sole color visible in @Image3. Keep face, hair, outfit and lighting unchanged from @Image1." \
  -o ./edit.png --wait
```

The model also understands "the first image / the second image". Stick with `@ImageN` so the labels line up with the Seedance prompt that uses the same files.

## Compact prompt skeleton (edit-style)

```
Edit @Image1: <the one change — pose / held product / state>.
The product matches @Image2 exactly: <key texture / color / exact brand text in quotes>.
Keep face, hair, makeup, outfit, setting and lighting unchanged from @Image1.
Exactly five fingers per hand, hands and wrists clearly connected to forearms.
```

Only use compose-style prompts ("Compose a 9:16 frame from these references…") when there is no avatar photo to preserve. See `../references/avatar-edit-not-regenerate.md`.

## Gotchas / failure modes

These are general image-edit failure modes. Check every output for them before it goes into Seedance.

1. **Compose-mode regenerates the avatar instead of editing it.** "Compose / generate a scene…" produces a fresh, synthetic-looking person inspired by `@Image1`. Use edit verbs (`Edit @Image1: …`, `Take @Image1 as-is and only change …`), don't re-list scene tokens the reference already shows, and drop "photo-realistic / studio quality / 8K".
2. **Hands and wrists on held props.** Watch for six fingers, severed wrists or props phasing through fingers. Add contact verbs ("palm wrapped around the heel") and the anatomy clause. A two-hand grip is more reliable than one hand. One or two silent regens (12–24 cr) cost less than paging the user. See `../references/confirmation-rules.md`.
3. **Fine print / engraving drift.** Name the exact text in quotes (`preserve the engraved 'OTTA 925' on the clasp exactly as in @Image2`). "Preserve branding" is too vague.
4. **Silent aspect clamp.** Asking for 4:5 returns 3:4 with no error. If the brief says 4:5, switch models instead of cropping afterwards.
5. **Brand names still trip copyright moderation** on the OpenAI path. Describe third-party products generically. See `../references/brand-and-moderation.md`.

## Sibling / alternative image models

| Slug | When | Cost (per image) |
|---|---|---|
| `nano-banana-2` | 4:5 / 5:4, cheap iteration, 0.5K drafts, auto T2I with no image | 3 / 4 / 6 / 8 cr (0.5K–4K) |
| `nano-banana-pro` | Higher-fidelity Gemini, up to 8 refs, 4:5, native T2I | 8 / 16 / 32 cr (1K–4K) |
| `nano-banana-lite-edit` / `-lite-t2i` | Bulk drafts, 1K only | 6 / 8 cr |
| `gpt-image-2-t2i` | Text-to-image with no reference | 12 / 18 / 24 cr |
| `gpt-image-2-i2i` | Previous GPT Image edit model (supports 4:5 at default res) | 12 cr flat |
| `seedream-v4.5` | Alternative edit model | 9 / 12 / 18 / 24 cr (0.5K–4K) |

Always confirm with `quickdesign cost --category image` because the registry reprices.

## Cross-references

- Edit vs compose verbs → `../references/avatar-edit-not-regenerate.md`
- Multi-product reference pattern → `../references/multi-reference-pattern.md`
- Anatomy self-check + approval gate → `../references/confirmation-rules.md`
- Nano Banana family (4:5, budget, Pro, Lite) → `./nano-banana-2.md`
- Feeds into → `./seedance-2.5.md`, `../pipelines/ugc-video.md`
