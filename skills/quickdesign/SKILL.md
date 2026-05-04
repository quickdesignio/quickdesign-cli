---
name: quickdesign
description: Use the `quickdesign` CLI to generate AI media — UGC promo videos, image edits, product creatives, video upscales — through Seedance, Kling, Sora2, Nano Banana, and GPT Image. Invoke this skill whenever the user asks for a talking-avatar video, multi-segment ad / promo / explainer, image edit (object swap, angle change, state change), product photoshoot, or video upscale via QuickDesign.
---

# QuickDesign CLI skill

This skill teaches Claude how to plan and execute AI media generation through the `quickdesign` CLI. The CLI wraps QuickDesign's hosted models (Seedance 2.0 R2V/I2V, Kling, Sora 2, Nano Banana, GPT Image, video upscale) so a Claude session can produce videos and images directly from Bash without managing API keys, polling, or storage upload.

## When to invoke

- **Talking-avatar / UGC video** — "make a 30-second ad where this person says X", "convert this script to a video", "create a creator-selfie clip"
- **Multi-segment promo / explainer** — anything where total speech is >15s (single Seedance segment cap) or where the user wants angle cuts / framing progression
- **Image edit / generation** — angle change, state change, product on white background, lifestyle composite, brand-kit-styled creatives, multi-product reference composition
- **Video upscale** — bring 720p / 1080p output to 1080p / 4K
- **Bulk / batch creative production** — "do this for each of these 5 product photos"

Do NOT use for: pure text generation, code edits, search — those have their own tools.

## Cardinal rules (read first, every time)

These apply to every generation. Breaking any of them produces visible defects.

0. **Default video model = `seedance-2.0-r2v` for ANY UGC / talking-avatar / promo / explainer / multi-scene work, regardless of duration or segment count.** Don't downgrade to `seedance-2.0-i2v` because the script is "short enough" — R2V handles 4-15s single-shot just as well as multi-segment, and going through R2V from the start preserves every primitive this skill depends on (`@Image1` references, multi-`--reference-image`, `--reference-audio` voice continuity). Switch off R2V only on **explicit user opt-in** ("use Sora 2") or if R2V is unavailable in the registry. See `models/seedance-2.0-r2v.md`.

1. **Use `@Image1` / `@Audio1` / `@Video1` reference labels in prompts, and pass EVERY relevant photo as a separate reference.** Both `nano-banana-2` (image edit) and Seedance 2.0 R2V (video) accept multiple `--reference-image` flags. If the user uploaded a product from two angles, pass both — describing the second one in prose is a regression. Don't re-describe the person, wardrobe, or product in words; that competes with the reference image and causes drift. See `references/multi-reference-pattern.md` and the per-model card under `models/`.

2. **Multi-segment voice continuity = `--reference-audio` from Seg 1's extracted audio.** Generate Seg 1 first → `ffmpeg -vn -acodec libmp3lame` extracts audio → pass that mp3 as `--reference-audio` to Segs 2..N. Without this, every segment picks a different voice. See `references/voice-continuity.md`.

3. **Suppress the layered music bed and burned subtitles — minimal directive only.** Add two short lines to the prompt: `No music score.` and `No subtitles or on-screen text.` That's it. Do NOT enumerate ambient sounds you want to keep ("street noise, café chatter, espresso machine") — Seedance produces natural ambient on its own; over-prescribing makes audio feel scripted. See `references/no-music-no-subtitles.md`.

4. **For burned-in captions, use `quickdesign video subtitle` AFTER generation.** Never let the video model burn its own captions via the prompt — they hallucinate. The dedicated subtitle endpoint runs real ASR (ElevenLabs) and renders accurate karaoke-style captions. See `references/auto-subtitle.md`.

5. **Confirmation gates — pause before spending credits, even in auto mode.** Auto mode reduces friction for **low-cost reversible work** (file edits, research, planning). Paid AI generation is neither low-cost nor reversible — auto mode does NOT bypass these gates. Always:
   - **Plan summary BEFORE any video generation** (Type / Model / Duration / Cost / Script). Surface it, then either wait for explicit "go" (normal mode) OR proceed immediately while keeping the plan visible above the bash call so the user can kill the task before the spend completes (auto mode). The plan must arrive BEFORE the bash invocation, never after.
   - **Banana edit reference BEFORE feeding it into Seedance R2V** → show the edit, wait for visual approval. Banana ~12cr, Seedance ~250-500cr; a wrong reference auto-chained burns 50× the cost. This gate does NOT compress in auto mode.
   - See `references/confirmation-rules.md` for full auto-mode interplay.

6. **For *choice* gates use the `AskUserQuestion` tool, not free-form prose.** Model picker, transition style, resolution, banana edit approve / regenerate / cancel — call `AskUserQuestion` with a structured option list and put your recommendation FIRST with `(Recommended)`. See `references/confirmation-rules.md`.

7. **When avatar is supplied AND setting doesn't change, EDIT the avatar — don't regenerate.** Compose-style banana prompts ("Compose a vertical 9:16 UGC selfie frame...", "Generate a creator-selfie scene...") cause the model to render a fresh AI-look image inspired by the avatar — losing the source's lighting, grain, and lo-fi authenticity. The result feels synthetic instead of like a real creator's edited selfie. Use edit-style verbs (`Edit @Image1: add ...`, `Take @Image1 as-is and only change ...`, `Keep every pixel of @Image1 except [region]`), don't re-list scene tokens that the reference already shows, and strip quality-upgrade words ("photo-realistic", "studio quality", "8K") from the prompt — they trigger regen. See `references/avatar-edit-not-regenerate.md`.

8. **For spoken UGC, never start generation without a script.** "UGC" / "talking-avatar" / "creator selfie" / "ad" all imply someone speaking on camera. If the user didn't supply quoted speech, you have two valid moves: (a) ask them for the script in one short message, OR (b) draft a 4-12s script that fits the brief, surface it inside the plan summary, then proceed. Generating UGC with a generic action prompt and no quoted speech produces silent video or model-babbled phonemes — wasted credits + a useless deliverable. The script is part of the plan summary, not separate from it. See `references/script-and-duration.md` for word-count → duration math.

## Decision tree — which doc to open first

**By job type:**

| Request | Start here |
|---|---|
| UGC / talking-avatar / promo / explainer / multi-segment ad | `pipelines/ugc-video.md` → `models/seedance-2.0-r2v.md` |
| Image edit (angle, state, multi-product composition) | `models/nano-banana-2.md` → `references/multi-reference-pattern.md` |
| Cinematic single-shot, audio-quality-driven (4/8/12s) | `models/sora2-i2v.md` (only on explicit user opt-in) |
| Budget loop / non-spoken b-roll | `models/kling-3-pro.md` |
| Final video too low-res | `models/topaz-video-upscale.md` (run after concat) |
| Add captions to existing video | `references/auto-subtitle.md` |

**By job phase:**

| Phase | Read |
|---|---|
| Plan: script / duration math, narrative beats | `references/script-and-duration.md`, `references/narrative-arc.md` |
| Pre-flight: which model is alive in the registry | `quickdesign video models`, `quickdesign cost --category video` |
| Per-segment reference choice | `references/multi-reference-pattern.md`, `references/narrative-arc.md` |
| Generation: prompt skeleton + gotchas for the model you picked | `models/<slug>.md` |
| Quality gates: banana anatomy check, plan-summary approval | `references/confirmation-rules.md` |
| Post-processing: subtitle, upscale | `references/auto-subtitle.md`, `models/topaz-video-upscale.md` |

## Discover at runtime

The model registry is DB-driven and changes over time (new providers, retired versions, repriced tiers). **Don't hardcode model assumptions** — query the registry first when picking between alternatives.

```bash
quickdesign video models                            # active video models
quickdesign image models                            # active image-edit models
quickdesign cost                                    # all models, grouped by category
quickdesign cost --category video
quickdesign cost <slug> -d <duration> -r <resolution>   # exact compute for one model + params
```

When a new model lands that's better-fit than the current default, drop a new file in `models/<slug>.md` (copy the format from any existing card) and update the cardinal rule #0 / decision tree if the model becomes the new universal default.

## Quick start — common commands

```bash
# Auth (one-time, browser flow)
quickdesign auth login

# Image edit — angle change / state change / multi-ref product composition
quickdesign image generate \
  --model nano-banana-2 \
  --reference-image ~/path/to/avatar.jpg \
  --reference-image ~/path/to/product.jpg \
  --aspect-ratio 9:16 --resolution 2K \
  -p "@Image1 holds a product matching @Image2 exactly. ..." \
  -o ~/output.png --wait

# Single Seedance R2V (≤15s spoken script — still R2V, not i2v)
quickdesign video generate \
  --provider seedance \
  --reference-image ~/path/to/source.png \
  --aspect-ratio 9:16 --duration 12 --resolution 1080p \
  -o ~/output.mp4 --wait \
  -p '@Image1 in the same setting. <action>. He/She says: "..." No music score. No subtitles or on-screen text. Vertical 9:16 format.'

# Multi-segment Seedance R2V with voice continuity
# 1) Generate Seg 1 (sequential, native audio)
quickdesign video generate --provider seedance --reference-image seg1.png \
  --duration 12 --aspect-ratio 9:16 --resolution 1080p \
  -p '...' -o seg1.mp4 --wait
# 2) Extract Seg 1 audio
ffmpeg -y -i seg1.mp4 -vn -acodec libmp3lame -q:a 2 seg1-audio.mp3
# 3) Segs 2..N in parallel, each with --reference-audio
quickdesign video generate --provider seedance \
  --reference-image seg2.png --reference-audio seg1-audio.mp3 \
  --duration 12 --aspect-ratio 9:16 --resolution 1080p \
  -p '...' -o seg2.mp4 --wait &
# 4) Concat (mux-only, no quality loss)
printf "file 'seg1.mp4'\nfile 'seg2.mp4'\n" > /tmp/concat.txt
ffmpeg -y -f concat -safe 0 -i /tmp/concat.txt -c copy final.mp4

# Auto-subtitle (karaoke style, post-generation)
quickdesign video subtitle ./final.mp4 \
  --style tiktok --language en \
  -o ./final-subbed.mp4 --wait
```

## File index

```
SKILL.md                           ← you are here: cardinal rules + decision tree + nav
references/                        ← model-agnostic concepts (read for principles)
   confirmation-rules.md           ← gates, AskUserQuestion convention, anatomy self-check
   multi-reference-pattern.md      ← @Image1/@Image2/@Image3 multi-ref usage
   avatar-edit-not-regenerate.md   ← edit-style verbs, don't compose-regen the avatar
   voice-continuity.md             ← --reference-audio across multi-segment
   no-music-no-subtitles.md        ← minimal music + subtitle suppression
   auto-subtitle.md                ← post-generation captions (real ASR, not model-burned)
   narrative-arc.md                ← per-segment reference decision tree
   script-and-duration.md          ← word count → segment math, gender-neutral defaults
   first-frame-not-camera-motion.md ← why "static hold" / "slowly zooms" cause defects
   brand-and-moderation.md         ← brand-kit conventions, content moderation
pipelines/                         ← multi-step workflows (model-agnostic where possible)
   ugc-video.md                    ← canonical multi-segment talking-avatar method
models/                            ← per-model reference cards (gotchas + prompt skeletons)
   seedance-2.0-r2v.md             ← DEFAULT for UGC / promo / talking-avatar
   seedance-2.0-i2v.md             ← niche; explicit user opt-in only
   nano-banana-2.md                ← default for image edit + multi-ref product composition
   sora2-i2v.md                    ← cinematic single-shot, opt-in
   kling-3-pro.md                  ← budget alternative for non-spoken b-roll
   topaz-video-upscale.md          ← post-pipeline upscale
```

When the user asks for something specific, jump directly to the relevant file in `models/` or `pipelines/`. The cardinal rules above are the only thing that should always be in active context.
