---
slug: kling-3-pro
category: video_generate
provider: fal
status: budget
description: Kling 3 family (Pro / Standard) plus Kling 2.6 Pro and O1 Edit. Cinematic motion models with no reference grammar in the CLI, no audio-continuity primitive, and weaker speech than Seedance. `kling-3-standard` (the CLI default for `--provider kling`) is the budget pick for simple loops, b-roll and non-spoken clips. `kling-3-pro` is the quality tier. Use when the user asks for Kling or when a non-spoken loop needs to be cheap.
---

## When to use

- Budget-tight job, simple animation, no spoken voiceover
- Non-UGC b-roll: product rotation, atmospheric loop, abstract motion
- User explicitly named Kling
- Voice continuity / multi-product reference fidelity is NOT required

Don't use for spoken-script UGC. Kling's speech is weaker than Seedance's native voice and there's no `--reference-audio` continuity. For talking-avatar work, always start at Seedance 2.5.

## Hard facts (live)

```bash
quickdesign cost kling-3-pro -d 5
quickdesign video models | jq '.data[] | select(.slug=="kling-3-pro")'
```

- **CLI**: `quickdesign video generate --provider kling --image first.png --model kling-3-pro ...`. Without `--model`, the CLI uses `kling-3-standard`. `--image` is required, because the CLI Kling path doesn't do text-to-video and doesn't forward `--reference-*`.
- **Duration grid**: `kling-3-pro` takes 3..15s (101 cr at 3s, 336 cr at 10s, 504 cr at 15s). `kling-3-standard` takes 3/5/10/15s (30/50/95/140 cr).
- **Cost**: `duration_lookup`, a discrete cost per duration. Check with `quickdesign cost <slug> -d <n>` before submitting.
- **Reference grammar**: NONE in the CLI. Single `--image` input only.
- **Audio**: yes via `generate_audio`, but voice character generally weaker than Seedance for speech.

## Compact prompt skeleton

```
<scene description>. <action / motion verbs OK here, unlike Seedance>.
<aspect ratio> format.
```

Camera-motion verbs ("slowly zooms in", "pans left", "tracking shot") work better here than in Seedance — Kling produces cleaner cinematic motion when explicitly directed.

## Sibling models in the Kling family

- `kling-3-standard`: cheaper, simpler animation, and the CLI default. Use it for loops where Pro's quality bump isn't worth the cost (a 10s clip is 95 cr vs 336 cr).
- `kling-2.6-pro`: older, 5s / 10s only (64 / 100 cr). Kept for users with existing workflows. Default to `kling-3-*` for new work.
- `kling-o1-edit`: video-to-video edit, 64 cr flat, niche use.
- `kling-2.1-*` are no longer in the registry.

Compare via `quickdesign cost --category video | grep kling`.

## Gotchas

1. **No `audio_urls` continuity** — every segment generates a fresh voice. Multi-segment Kling is voice-incoherent unless you use TTS + lipsync external pipeline.
2. **No `@Image1` reference grammar** — descriptive prompts carry more weight than with Seedance R2V. Be more verbal.
3. **Subtitle / music defaults are less aggressive** than Seedance, but still add `No music score.` + `No subtitles.` to be safe.

## Cross-references

- For talking-script UGC use Seedance 2.5 instead → `./seedance-2.5.md`
- Cinematic single shot / text-to-video → `./flux-3.md`
- Cheap image→video with synced sound effects → `./gemini-omni-video.md`
- Voice continuity strategies → `../references/voice-continuity.md`
