---
slug: gemini-omni-flash-1.2-i2v
category: video_generate
provider: fal
status: opt-in
description: Gemini Omni Flash 1.2 (Google, via fal.ai) — one family, five registry rows. Frames (`-i2v`: start image, optional end frame) and References (`-r2v`: text, up to 10 images + 3 clips) generate 3–15 s with native audio at 360p–4K, 16:9 / 9:16, for 3 / 8 / 12 / 23 cr per second. Two clip tools: `-edit` (change an existing clip ≤ 15 s from a sentence) and `-extend` (append 3–10 s to any clip). Plus `gemini-omni-flash-1.2-upscale` (`video upscale --provider gemini`). Unrelated to the kie-served `gemini-omni-video`.
---

## When to use

**The generator variants only when the user names Gemini Omni Flash** (or picks it when you ask). The default for every video job is the latest Seedance (`seedance-2.5`, `../SKILL.md` cardinal rule #0); the points below are for answering the user's questions, never a reason to switch on your own.

- Cheap drafts: 360p is 3 cr/s (an 8 s draft = 24 cr against 336 cr on Seedance 2.5 at 720p) — useful only when the user asks for throwaway motion tests
- Native 4K from a 15 s single-shot clip (23 cr/s)
- Start **and end** frame on the same clip (`--image` + `--end-image`, ≤ 10 s)

**The two clip tools are the only route for their jobs**, so use them when the user asks for exactly that (they are not a swap for a Seedance regen):

- `gemini-omni-flash-1.2-edit` — "change the shirt to red in this clip", "remove the text on the wall": re-renders a clip of up to 15 s from an instruction, keeping its length and framing. Billed on the clip's length. Not for removing a person from a crowd (see `../references/fix-a-shot.md`: regenerate the shot instead).
- `gemini-omni-flash-1.2-extend` — "make this 8 s longer": conditions on the last 10 s of any clip and appends 3–10 s with audio. Only the new seconds are billed.

Don't use for spoken UGC with a locked voice (no `--reference-audio`), for ratios other than 16:9 / 9:16, or for anything longer than 15 s per clip.

## Hard facts (live)

```bash
quickdesign cost gemini-omni-flash-1.2-r2v -d 8 -r 1080p
quickdesign cost gemini-omni-flash-1.2-upscale -d 12 -r 1080p
quickdesign video models | jq '.data[] | select(.slug | startswith("gemini-omni-flash"))'
```

| Row | Inputs | Duration | Billed on |
|---|---|---|---|
| `gemini-omni-flash-1.2-i2v` | `--image` (+ `--end-image`, then ≤ 10 s) | 3–15 s | output seconds |
| `gemini-omni-flash-1.2-r2v` | prompt only, or ≤ 10 `--reference-image` + ≤ 3 `--reference-video` (each ≤ 15 s) | 3–15 s | output seconds (references free) |
| `gemini-omni-flash-1.2-edit` | one `--reference-video` ≤ 15 s; no duration, no aspect ratio | = the clip | the clip's length (server-measured) |
| `gemini-omni-flash-1.2-extend` | one `--reference-video` (any length); no aspect ratio | 3–10 s appended | the appended seconds |
| `gemini-omni-flash-1.2-upscale` | `video upscale --provider gemini`, clip ≤ 15 s | — | 4 / 8 / 15 cr/s to 720p / 1080p / 4k (5 cr minimum) |

- **Resolutions / cost**: `360p` 3 cr/s · `720p` 8 cr/s · `1080p` 12 cr/s · `4k` 23 cr/s. 8 s @ 720p = 64 cr; 15 s @ 1080p = 180 cr; 10 s @ 4k = 230 cr.
- **Aspect ratios**: `16:9`, `9:16` (edit / extend keep the source's).
- **Audio**: native, always on.
- References are **not** billed (unlike Seedance 2.0 r2v and Kling 4.0).
- The server refuses an input the row does not list (a last frame on r2v, a 20 s clip on edit, 12 s on extend) **before** the charge.

## CLI

All five ride the Seedance route (`--provider seedance`); the slug picks the variant.

```bash
# Frames: start image (+ optional end frame, ≤ 10 s)
quickdesign video generate --provider seedance --model gemini-omni-flash-1.2-i2v \
  --image start.jpg --end-image end.jpg --duration 8 --resolution 1080p --aspect-ratio 9:16 \
  -p '<action + the sounds each beat should make>. No subtitles or on-screen text.' -o clip.mp4 --wait

# References (text-to-video when no reference is given)
quickdesign video generate --provider seedance --model gemini-omni-flash-1.2-r2v \
  --reference-image product.jpg --reference-video motion.mp4 --duration 10 --resolution 720p --aspect-ratio 16:9 \
  -p 'A product shot like @Video1, featuring @Image1 …' -o clip.mp4 --wait

# Edit an existing clip (≤ 15 s; no --duration / --aspect-ratio)
quickdesign video generate --provider seedance --model gemini-omni-flash-1.2-edit \
  --reference-video clip.mp4 --resolution 1080p -p 'Change her shirt to red; keep everything else.' -o edited.mp4 --wait

# Extend a clip by 3–10 s
quickdesign video generate --provider seedance --model gemini-omni-flash-1.2-extend \
  --reference-video clip.mp4 --duration 6 --resolution 1080p -p 'She turns and walks out of frame.' -o longer.mp4 --wait

# Upscale a clip ≤ 15 s (target must be above the source)
quickdesign video upscale --provider gemini --video <public url> --duration-seconds 12 \
  --target-resolution 1080p --source-height 720 -o up.mp4 --wait
```

`--reference-video` takes a local file (auto-uploaded) or a URL; `video upscale --video` needs a public URL (`design create` first). Durations are whole seconds.

## Gotchas

1. **Google moderation** (same family as Nano Banana / Gemini Omni Video): objects in the mouth and third-party brand names get rejected. See `../references/brand-and-moderation.md`.
2. **Edit re-renders the whole clip.** Expect small drifts outside the requested change; check faces and product text. For "remove this person" jobs, regenerate the shot (`../references/fix-a-shot.md`).
3. **Extend only sees the last 10 s.** Describe what continues from the final frame, not the whole clip.
4. **Only two aspect ratios.** A 1:1 or 4:5 request has to go to another model.
5. `-i2v` and `-r2v` are one family in the app's pickers ("Gemini Omni Flash 1.2", Frames / References); on the CLI you name the slug.

## Cross-references

- Spoken UGC default → `./seedance-2.5.md`
- Sound-effect clips on kie's Gemini Omni Video (4–10 s, flat v2v price) → `./gemini-omni-video.md`
- Topaz / ByteDance upscalers (any length) → `./topaz-video-upscale.md`
