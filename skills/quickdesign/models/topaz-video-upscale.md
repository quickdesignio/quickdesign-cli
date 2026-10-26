---
slug: topaz-video-upscale
category: video_upscale
provider: fal
status: post-pipeline
description: Topaz video upscale. Run AFTER final concat to bump 720p / 1080p generation output to 1080p / 4K. Per-second pricing (5 cr minimum) with a 60fps multiplier. Don't run upscale per-segment — generate at native target resolution, then concat, then upscale once.
---

## When to use

- Final concatenated video is too low-res for the delivery channel (1080p reel posted to a platform that prefers 4K masters)
- Source footage is older / lower res and you want to clean it up before publish
- Text-heavy / detail-heavy frames need extra crispness

Don't use as a substitute for generating at the right resolution in the first place. Seedance 2.5 tops out at 1080p, so a 4K master means either 2.5 (720p/1080p) + Topaz, or `seedance-2.0-r2v` at native `4k`. Compare both with `quickdesign cost` before choosing.

## Hard facts (live)

```bash
quickdesign cost topaz-video-upscale -d 24 -r 4k     # estimate only
quickdesign video models | jq '.data[] | select(.slug=="topaz-video-upscale")'
```

- **Cost**: per second of source video, with a **minimum of 5 cr**. The CLI has no `--resolution` flag and never sends an output resolution, so the server prices a Topaz job at its default tier (2 cr/s as of 2026-10-26; `fal.videoUpscale.service.ts`). `--target-fps 60` doubles the charge. `quickdesign cost …` is an estimate; the real charge comes back as `token_cost` in the start response (omit `--wait` / `-o` to see it).
- **60fps multiplier**: use `--target-fps 60` ONLY if downstream playback is genuinely 60fps; most social platforms are 30fps and the bump is wasted.
- **Sibling**: `--provider bytedance` has a different cost ladder (`--target-resolution`, no `--factor`). Compare via `quickdesign cost --category video_upscale`.
- **Inputs**: `--video` takes a public URL (the CLI does not upload for you) and `--duration-seconds` is REQUIRED (the server answers 400 without it). `--factor 1-4` is Topaz only.

## Pipeline placement

Always **run after the final concat**, not per-segment:

```bash
# generate segments at native resolution
quickdesign video generate ... -o seg1.mp4
quickdesign video generate ... -o seg2.mp4

# concat (mux-only, no quality loss)
ffmpeg -f concat -safe 0 -i concat.txt -c copy final.mp4

# upscale ONCE: the upscaler needs a public URL, so save the file as a design first
quickdesign design create ./final.mp4 --title "Final"     # prints the design row; its `video_url` is the public URL
quickdesign video upscale --video <video_url> --provider topaz --factor 2 \
  --duration-seconds 24 -o ./final-up.mp4 --wait     # 24 = the video length in seconds (ffprobe)
```

If a wait times out the job keeps running: resume with `quickdesign video upscale-wait <jobId> -o …`, or check it with `video upscale-status <jobId>`.

Per-segment upscaling wastes ~Ncr × duration and can introduce inter-segment quality mismatches.

## Gotchas

1. **Doesn't help with motion blur / shake** — purely a resolution upscale. Pre-existing motion artifacts stay.
2. **Doesn't add detail** — invents plausible textures from neighborhood context. Faces hold up reasonably; fine product detail (engraving, label text) can soften.
3. **60fps inflation rarely worth the 2× cost** for short-form social. Stay at native 24/30fps unless the platform requires otherwise.

## Cross-references

- UGC final concat step → `../pipelines/ugc-video.md` (final concat section)
- Subtitle post-processing (run BEFORE upscale or after, doesn't matter) → `../references/auto-subtitle.md`
