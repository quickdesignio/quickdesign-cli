---
slug: kling-4.0
category: video_generate
provider: kie
status: opt-in
description: Kuaishou Kling 4.0 via kie.ai — reference-to-video with up to 10 reference images and 5 reference videos, native audio, 3–30 s, 720p / 1080p. The only active Kling model (the fal Kling 2.1 / 2.6 / 3 / O1 Edit rows are retired). Use only when the user asks for Kling.
---

## When to use

**Only when the user names Kling** (or picks it when you ask). The default for every video job is the latest Seedance (`seedance-2.5`, `../SKILL.md` cardinal rule #0). The points below describe what this model is good at, so you can answer the user's questions about it. They are never a reason to switch on your own.

- User explicitly named Kling
- Cinematic motion / camera direction with reference images and clips
- Long single clips (up to 30 s) with native audio

Don't use for voice-continuity work across segments: there is no `--reference-audio` on Kling 4.0. For talking-avatar work, always start at Seedance 2.5.

## Hard facts (live)

```bash
quickdesign cost kling-4.0 -d 10 --resolution 720p
quickdesign video models | jq '.data[] | select(.slug=="kling-4.0")'
```

- **CLI**: `quickdesign video generate --provider seedance --model kling-4.0 ...` (`--provider kling` is the same thing: it is an alias that sets `--model kling-4.0`). The job is polled as provider `seedance`.
- **Inputs**: prompt only (text-to-video), `--image` and/or `--reference-image` (max 10, all are references — there is no first/last-frame mode on this endpoint), `--reference-video` (max 5, each 2–30 s). `--reference-audio` is refused before any credit is spent.
- **Mentions**: Kling binds references as `@image_1`, `@video_1`. Writing `@Image1` / `@Video1` is fine — the BFF rewrites the Seedance spelling for you. A mention of an undeclared slot is a 422 (refunded).
- **Duration**: integer 3–30 s; the picker offers 3/5/8/10/12/15/20/25/30. **Resolution**: 720p (default) or 1080p. **Aspect**: `auto` (default with references), 16:9, 9:16, 1:1, 21:9.
- **Cost**: `per_second` — 13 cr/s at 720p, 19 cr/s at 1080p. With a reference video the rate drops to 8 / 12 cr/s but the input seconds are billed too: `max(input, output) + output` (so 2× output when the clips are shorter than the output). Example: 10 s 720p = 130 cr; with a 5 s reference clip = 20 s × 8 = 160 cr. `quickdesign cost` shows the no-video price.
- **Audio**: always generated (there is no `generate_audio` flag); `--no-generate-audio` is ignored.

## Compact prompt skeleton

```
<scene description with @image_1 / @video_1 mentions>. <camera and motion verbs>.
<aspect ratio> format. No music score. No subtitles.
```

Camera-motion verbs ("slowly zooms in", "pans left", "tracking shot") work well here — Kling produces clean cinematic motion when explicitly directed.

## Retired siblings

`kling-3-pro`, `kling-3-standard`, `kling-2.6-pro`, `kling-2.1-*` and `kling-o1-edit` are inactive in the registry (2026-11-06). The BFF answers them with a 400 that names `kling-4.0`; `video status` / `history` for old jobs still work.

## Cross-references

- For talking-script UGC use Seedance 2.5 instead → `./seedance-2.5.md`
- Cinematic single shot / text-to-video → `./flux-3.md`
- Fixing one bad shot → `../references/fix-a-shot.md`
