---
slug: gemini-omni-video
category: video_generate
provider: kie
status: opt-in
description: Gemini Omni Video (Google, via kie.ai). Low-cost image-to-video AND video-to-video with synchronized per-object sound (each visual beat gets a matching sound cue). 4/6/8/10s, 16:9 or 9:16 only, 720p/1080p/4k. Up to 2 reference images or 1 reference video. Google moderation.
---

## When to use

- Short interactive product shots where the **sound effects** matter: a lid clicking, liquid pouring, a zipper, packaging being torn open
- Cheap motion tests before committing to a Seedance 2.5 render. An 8s clip costs 48 cr, against 336 cr or more for Seedance.
- **Video-to-video**: restyling or re-sounding an existing clip (flat 152 cr, or 228 cr at 4k)

Don't use for spoken-script UGC with a locked voice (no `--reference-audio`), for aspect ratios other than 16:9 / 9:16, or for anything longer than 10s.

## Hard facts (live)

```bash
quickdesign cost gemini-omni-video -d 8 -r 1080p
quickdesign video models | jq '.data[] | select(.slug=="gemini-omni-video")'
```

- **Durations**: `4`, `6`, `8`, `10` s only.
- **Aspect ratios**: `16:9`, `9:16` only.
- **Resolutions**: `720p`, `1080p`, `4k`.
- **Cost (image→video)**: 29 / 38 / 48 / 57 cr at 720p or 1080p (4/6/8/10 s); 67 / 76 / 86 / 95 cr at 4k.
- **Cost (video→video)**: flat 152 cr (228 cr at 4k), regardless of duration.
- **Inputs**: up to 2 reference images, or 1 reference video.

## CLI

Gemini Omni also rides the Seedance route. Pass inputs as references, not `--image`:

```bash
# image → video
quickdesign video generate --provider seedance --model gemini-omni-video \
  --reference-image product.jpg --duration 8 --resolution 1080p --aspect-ratio 9:16 \
  -p '<action + the sounds each beat should make>. No music score. No subtitles or on-screen text.' \
  -o clip.mp4 --wait

# video → video
quickdesign video generate --provider seedance --model gemini-omni-video \
  --reference-video source.mp4 --aspect-ratio 9:16 -p '...' -o restyled.mp4 --wait
```

## Gotchas

1. **Google moderation** (same family as Nano Banana). Objects in the mouth / between the teeth and third-party brand names get rejected. See `../references/brand-and-moderation.md`.
2. **The Seedance 300–6000 px reference check doesn't apply here**, but keep references reasonably sized anyway.
3. **Only two aspect ratios.** A 1:1 or 4:5 request has to go to a different model.

## Cross-references

- Spoken UGC default → `./seedance-2.5.md`
- Cinematic single shot / text-to-video → `./flux-3.md`
