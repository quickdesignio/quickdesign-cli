---
slug: flux-3-t2v, flux-3-i2v
category: video_generate
provider: fal
status: opt-in
description: FLUX.3 video (Black Forest Labs, via fal.ai). Cinematic single shot with native synchronized audio, 5–20s, 720p/1080p. Text-to-video (`flux-3-t2v`) and image-to-video (`flux-3-i2v`). No @Image reference grammar and no voice continuity. Replaces Sora 2 (retired 2026-09-23) as the "cinematic single shot" and pure text-to-video option.
---

## When to use

- **Pure text-to-video** with no reference image, especially on CLI ≤ 0.10.0, where prompt-only Seedance 2.5 is misrouted (see `./seedance-2.5.md` gotcha #1).
- A cinematic single shot where camera direction matters (tracking shot, crane, slow push-in). Unlike Seedance, Flux follows explicit camera verbs.
- The user asks for "Sora" or "Sora quality". Sora 2 is retired, so say that and offer Flux 3 for cinematic single shots or Seedance 2.5 for spoken UGC.

Don't use for multi-segment spoken UGC. There is no `--reference-audio`, so every call generates a fresh voice. Don't use for product-fidelity work either, because without `@Image` labels the reference is only a first frame, not an identity anchor.

## Hard facts (live)

```bash
quickdesign cost flux-3-i2v -d 10 -r 1080p
quickdesign video models | jq '.data[] | select(.slug | startswith("flux-3"))'
```

- **Durations**: any integer 5–20 s.
- **Resolutions**: `720p` (16 cr/s), `1080p` (27 cr/s). 10s@1080p = 270 cr.
- **Aspect ratios**: `auto`, `21:9`, `2:1`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16`.
- **Native audio**: yes (`--no-generate-audio` to disable).
- `flux-3-i2v` accepts a last frame in the app (first→last interpolation). The CLI doesn't expose it.

## CLI

Flux rides the Seedance route, so it uses `--provider seedance` with an explicit `--model`:

```bash
# text-to-video
quickdesign video generate --provider seedance --model flux-3-t2v \
  --duration 8 --resolution 1080p --aspect-ratio 16:9 \
  -p '<subject + setting + lighting + camera move>. No music score. No subtitles or on-screen text.' \
  -o shot.mp4 --wait

# image-to-video (animate one first frame)
quickdesign video generate --provider seedance --model flux-3-i2v \
  --image first-frame.png --duration 8 --resolution 1080p \
  -p '...' -o shot.mp4 --wait
```

Use `--image` (first frame) for i2v, not `--reference-image`.

## Prompting

- No `@Image1` to lean on, so describe subject, setting, lighting and mood in the prompt. Keep it tight.
- Camera verbs are fine here ("slow dolly-in", "handheld tracking shot").
- Quoted speech works, but there is no voice lock across calls.
- Keep `No music score.` and `No subtitles or on-screen text.`

## Cross-references

- Spoken UGC / identity-anchored video → `./seedance-2.5.md`
- Cheap image→video with synced sound effects → `./gemini-omni-video.md`
- Budget non-spoken b-roll → `./kling-3-pro.md`
