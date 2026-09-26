---
slug: seedance-2.5
category: video_generate
provider: kie
status: primary
description: Seedance 2.5 (ByteDance, via kie.ai). Universal default for UGC / talking-avatar / promo / explainer work. One segment holds up to 30s, so most ad scripts fit in a single call with no voice-continuity step. Same labeled reference grammar as 2.0 R2V (@Image1 / @Video1 / @Audio1), up to 4 reference images, 3 reference videos, 3 reference audios. Must be selected with an explicit `--model seedance-2.5`.
---

## When to use

**Default for any spoken-script video**: UGC, talking avatar, promo, explainer, multi-scene ad. The 30s ceiling means scripts of up to 30s of speech render as one continuous take (~60 words at the ~2 words/s convention in `../references/script-and-duration.md`), which keeps the voice, identity and setting consistent without stitching segments together.

Switch off 2.5 only when:
- The shot needs **more than 4 reference images**. Use `seedance-2.0-r2v`, which takes up to 9 (`./seedance-2.0-r2v.md`).
- The delivery needs **native 4K**. 2.5 tops out at 1080p. Use `seedance-2.0-r2v` at 4k, or upscale afterwards (`./topaz-video-upscale.md`).
- **Budget is the driver**: 2.0 R2V at 1080p (25 cr/s) costs less than 2.5 at 720p (28 cr/s).
- The user **explicitly names another model**.
- It's **pure text-to-video with no reference at all**. See gotcha #1 and use `./flux-3.md`.

## Hard facts (live)

```bash
quickdesign cost seedance-2.5 -d 15 -r 720p      # exact compute
quickdesign video models | jq '.data[] | select(.slug=="seedance-2.5")'
```

- **`--model seedance-2.5` is mandatory.** `--provider seedance` without `--model` silently picks a 2.0 variant (`seedance-2.0-r2v` with refs, `-i2v` with `--image`, `-t2v` with neither).
- **Durations** (discrete): `5, 8, 10, 12, 15, 20, 25, 30` seconds. Pick the smallest one that fits the script plus a ~1s tail.
- **Resolutions**: `480p` (13 cr/s), `720p` (28 cr/s), `1080p` (70 cr/s). **No 4K.** Default to **720p**. 1080p costs 2.5× as much, so only use it when the user asks for it or the channel needs it.
  - 12s@720p = 336 cr · 15s@720p = 420 cr · 30s@720p = 840 cr · 12s@1080p = 840 cr
- **Aspect ratios**: `9:16`, `16:9`, `1:1`, `4:3`, `3:4`, `21:9`, `adaptive` (`auto` is mapped to `adaptive`).
- **Reference caps**: 4 images · 3 videos (each 2–30s, total ≤ 30s) · 3 audios.
- **Reference image size**: 300–6000 px on each side. The BFF rejects anything outside that range before billing, with a message naming the file.
- **Native audio**: on by default. Pass `--no-generate-audio` for silent b-roll.

## Two modes — never mix them

| Mode | Flags | Use for |
|---|---|---|
| **Reference** (default) | `--reference-image` (≤4), `--reference-video` (≤3), `--reference-audio` (≤3) | UGC, product + avatar + scene, voice continuity |
| **First frame** | `--image <frame>` | Animating one exact still pixel-for-pixel. The aspect ratio is forced to `adaptive` (follows the image). |

Frame mode and reference mode are mutually exclusive on the provider side, so don't pass `--image` together with `--reference-*`. A single `--reference-image` is still reference mode and is the right way to animate one image while keeping `@Image1` grammar.

## Reference grammar

Same as 2.0 R2V. The BFF normalizes `@image1` / `@IMG1` spellings to the canonical form.

| Flag | Prompt label |
|---|---|
| `--reference-image` (repeatable, max 4) | `@Image1` … `@Image4` |
| `--reference-video` (repeatable, max 3) | `@Video1` … `@Video3` |
| `--reference-audio` (repeatable, max 3) | `@Audio1` … `@Audio3` |

**Don't re-describe what the references already show.** Prose describes only what's new: action, quoted speech, and the framing change if the user asked for one. See `../references/multi-reference-pattern.md`.

## Canonical call

```bash
quickdesign video generate --provider seedance --model seedance-2.5 \
  --reference-image product.jpg \
  --reference-image avatar.jpg \
  --reference-image scene.jpg \
  --aspect-ratio 9:16 --duration 15 --resolution 720p \
  -p '@Image2 in @Image3, holds @Image1 toward camera. She says: "..." No music score. No subtitles or on-screen text.' \
  -o seg1.mp4 --wait
```

## Compact prompt skeleton

```
@Image1 in the same exact setting throughout.
<one-sentence action/state>.
He/She/The person says: "<verbatim quoted speech>".
No music score. No subtitles or on-screen text.
Vertical 9:16 format.
```

With 20–30s scripts, you can describe 2–3 beats in order inside one prompt ("First … then … finally …") instead of splitting into segments. Keep each beat to one sentence of action plus its quoted line.

## Scripts longer than 30s

Split at sentence boundaries into ≤30s segments, render Seg 1 **alone**, get approval, then extract its audio and pass it as `--reference-audio` to Segs 2..N:

```bash
ffmpeg -y -i seg1.mp4 -vn -acodec libmp3lame -q:a 2 seg1-audio.mp3
quickdesign video generate --provider seedance --model seedance-2.5 \
  --reference-image seg2.png --reference-audio seg1-audio.mp3 \
  --aspect-ratio 9:16 --duration 20 --resolution 720p -p '...' -o seg2.mp4 --wait
```

See `../references/voice-continuity.md` and `../pipelines/ugc-video.md`.

## Gotchas / failure modes

1. **Prompt-only (no `--image`, no `--reference-*`) through the CLI is broken for 2.5.** The CLI sends reference-free jobs to `/start-text-to-video`, which doesn't serve 2.5. It falls back to the legacy Seedance 1.0 text-to-video model but still bills at 2.5 rates. Always give 2.5 at least one reference. For pure text-to-video, use `flux-3-t2v` (`./flux-3.md`).
2. **More than 4 reference images.** The registry caps 2.5 at 4. For product-front + product-side + product-detail + avatar + scene (5 or more), either merge the product angles into one reference edit first (`./gpt-image-2-5-sunburst-i2i.md`) or switch to `seedance-2.0-r2v`.
3. **Auto-layered music bed and hallucinated burned subtitles.** Same as 2.0. Keep `No music score.` and `No subtitles or on-screen text.` See `../references/no-music-no-subtitles.md`. For captions, use `quickdesign video subtitle` after generation.
4. **Camera-motion verbs cause defects.** Don't write "slowly zooms in" or "static hold". See `../references/first-frame-not-camera-motion.md`.
5. **Fine print drops across motion.** Make sure the reference edit preserves the label or engraving legibly, and name the exact text in the prompt.
6. **Duration outside the grid.** Stick to the discrete list. Don't send 13 or 18.

## Cross-references

- Fallback for >4 refs / 4K / budget → `./seedance-2.0-r2v.md`
- Reference-edit pre-stage → `./gpt-image-2-5-sunburst-i2i.md`
- Multi-reference usage → `../references/multi-reference-pattern.md`
- Voice continuity (>30s scripts) → `../references/voice-continuity.md`
- Confirmation gates → `../references/confirmation-rules.md`
- Full UGC method → `../pipelines/ugc-video.md`
