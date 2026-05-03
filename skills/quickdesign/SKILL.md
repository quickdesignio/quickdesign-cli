---
name: quickdesign
description: Use the `quickdesign` CLI to generate AI media — UGC promo videos, image edits, product creatives, video upscales — through Seedance, Kling, Sora2, Nano Banana, and GPT Image. Invoke this skill whenever the user asks for a talking-avatar video, multi-segment ad / promo / explainer, image edit (object swap, angle change, state change), product photoshoot, or video upscale via QuickDesign.
---

# QuickDesign CLI skill

This skill teaches Claude how to plan and execute AI media generation through the `quickdesign` CLI. The CLI wraps QuickDesign's hosted models (Seedance 2.0 R2V/I2V, Kling 3 Std/Pro, Sora 2, Nano Banana 2, GPT Image, video upscale) so a Claude session can produce videos and images directly from Bash without managing API keys, polling, or storage upload.

## When to invoke

Reach for this skill when the user asks for any of:

- **Talking-avatar / UGC video** — "make a 30-second ad where this person says X", "convert this script to a video", "create a creator-selfie clip"
- **Multi-segment promo / explainer** — anything where total speech is >15s (Seedance segment cap) or where the user wants angle cuts / framing progression
- **Image edit / generation** — angle change, state change (object in/out of frame, pose change), product on white background, lifestyle composite, brand-kit-styled creatives
- **Video upscale** — bring a 720p clip to 1080p / 4K
- **Bulk / batch creative production** — "do this for each of these 5 product photos"

Do NOT use for: pure text generation, code edits, search — those have their own tools.

## Cardinal rules (read first, every time)

These rules apply to every Seedance R2V generation. Breaking any of them produces visible defects in the output.

0. **Default model for ANY UGC / talking-avatar / promo / explainer = `seedance-2.0-r2v`, regardless of duration or segment count.** Don't downgrade to `seedance-2.0-i2v` for short / single-shot scripts. R2V handles 4-15s single-shot just as well as multi-segment, and going through R2V from the start preserves every primitive this skill depends on (`@Image1` references, multi-`--reference-image`, `--reference-audio` voice continuity). The CLI accepts a single `--reference-image` for R2V cleanly — there is no "syntactic burden" to going through R2V for a short clip. Only switch off R2V on **explicit user opt-in** (e.g. "use Sora 2 because the audio is cleaner") or if R2V is unavailable in the registry. Never silently pick i2v because the script is "short enough."

1. **Use `@Image1` / `@Audio1` / `@Video1` reference labels in prompts, and pass EVERY relevant photo as a separate reference.** Both `nano-banana-2` (image edit) and Seedance 2.0 R2V (video) accept multiple `--reference-image` flags. If the user uploaded a product from two angles, pass both — describing the second one in prose instead is a regression that produces invented details. Don't re-describe the person, wardrobe, or product in words; that competes with the reference image and causes drift. See `references/seedance-reference-syntax.md` and `references/multi-reference-pattern.md`.

2. **Multi-segment voice continuity = `--reference-audio` from Seg 1's extracted audio.** Generate Seg 1 first → `ffmpeg -vn -acodec libmp3lame` extracts audio → pass that mp3 as `--reference-audio` to Segs 2..N. Without this, every segment picks a different voice. See `references/voice-continuity.md`.

3. **Suppress the layered music bed and burned subtitles — that's it.** Seedance auto-layers a music track under voiceover and burns hallucinated captions when prompts have quoted speech; both kill authentic UGC. Add two short lines: `No layered music.` and `No subtitles or on-screen text.` That's the entire intervention. **Do NOT enumerate ambient sounds** you want to keep ("street noise, café chatter, dish clatter, espresso machine, footsteps") — over-prescribing makes the audio feel scripted; Seedance produces natural ambient on its own. The `no-music-no-subtitles.md` doc exists only as a reference for the rare cases where the user explicitly opts in to music ("with a beat") or subtitles ("altyazılı").

4. **For burned-in captions, always use `quickdesign video subtitle` AFTER generation.** Never let Seedance burn its own captions via the prompt — they hallucinate (partial sentences, paraphrased words, wrong timing). The dedicated subtitle endpoint runs real ASR (ElevenLabs) on the generated audio and renders accurate karaoke-style captions with customizable styling. See `references/auto-subtitle.md`.

5. **Confirmation gates — always pause for user approval before spending credits.** Two pause points:
   - Plan summary BEFORE any generation (Type / Model / Duration / Cost) → wait for "go".
   - Banana edit reference image BEFORE feeding it into Seedance R2V → show the edit, wait for visual approval. Banana costs ~12cr; Seedance costs ~400-500cr. A wrong reference auto-chained to Seedance burns 50× the cost. See `references/confirmation-rules.md`.

6. **For *choice* gates use the `AskUserQuestion` tool, not free-form prose.** Whenever the gate is "pick one of N alternatives" — model picker, transition style (single-ref / angle-cut / framing-progression), resolution, banana edit approve / regenerate / cancel — call `AskUserQuestion` with a structured option list. Put your recommendation FIRST and append `(Recommended)` to the label per the tool's own convention. The user gets a clickable picker showing each option's tradeoff (cost / quality / capability) at a glance. Reserve plain prose pauses for open-ended review ("does this banana look right?") and the plan summary itself. See `references/confirmation-rules.md#use-askuserquestion-for-structured-choice-gates`.

## Quick start — common commands

```bash
# Auth (one-time, browser flow)
quickdesign auth login

# Image edit — angle change / state change
quickdesign image generate \
  --model nano-banana-2 \
  --image ~/path/to/source.png \
  --aspect-ratio 9:16 --resolution 2K \
  -p "Same person and setting from the reference. CHANGE: ..." \
  -o ~/output.png --wait

# Single Seedance R2V (≤15s spoken script)
quickdesign video generate \
  --provider seedance \
  --reference-image ~/path/to/source.png \
  --aspect-ratio 9:16 --duration 12 --resolution 1080p \
  -o ~/output.mp4 --wait \
  -p '@Image1 in the same setting. <action>. He/She says: "..." No layered music. No subtitles or on-screen text. Vertical 9:16 format.'

# Auto-subtitle (karaoke style, post-generation)
quickdesign video subtitle ./final.mp4 \
  --style tiktok --language en \
  -o ./final-subbed.mp4 --wait

# Multi-segment Seedance R2V with voice continuity
# Step 1: Generate Seg 1 (sequential, native audio)
quickdesign video generate --provider seedance --reference-image seg1.png \
  --duration 12 --aspect-ratio 9:16 --resolution 1080p \
  -p '...' -o seg1.mp4 --wait

# Step 2: Extract Seg 1 audio
ffmpeg -y -i seg1.mp4 -vn -acodec libmp3lame -q:a 2 seg1-audio.mp3

# Step 3: Segs 2..N in parallel, each with --reference-audio
quickdesign video generate --provider seedance \
  --reference-image seg2.png \
  --reference-audio seg1-audio.mp3 \
  --duration 12 --aspect-ratio 9:16 --resolution 1080p \
  -p '...' -o seg2.mp4 --wait &
# (repeat for segN, then `wait`)

# Step 4: Concatenate (mux-only, no quality loss)
printf "file 'seg1.mp4'\nfile 'seg2.mp4'\nfile 'seg3.mp4'\n" > /tmp/concat.txt
ffmpeg -y -f concat -safe 0 -i /tmp/concat.txt -c copy final.mp4
```

## Available models — discover at runtime

The model registry is DB-driven and changes over time (new providers, retired versions, repriced tiers). **Don't hardcode "Seedance 2.0 R2V is the only option" into your plan** — query the registry first when the user asks for something nonstandard or you're picking between alternatives.

```bash
# Active video models (generate / upscale / post-processing)
quickdesign video models

# Active image-edit models (nano-banana, gpt-image, seedream, etc.)
quickdesign image models
```

Output is JSON — each model has `slug`, `category`, `provider`, `costConfig`, `durations`, `aspectRatios`, `resolutions`. Filter / pick by need:

- **UGC / talking-avatar / promo / explainer — ANY duration, single OR multi-segment** (this skill's universal default) → `seedance-2.0-r2v`. Don't downgrade to i2v just because the script is short — R2V handles 4-15s single-shot just as well as multi-segment, with strictly more capability (`@Image1`/`@Audio1`/`@Video1` reference labels, voice continuity via `--reference-audio`, repeatable `--reference-image` for multi-product). The CLI passes a single `--reference-image` cleanly to R2V — there is no syntactic burden to "going through R2V" for a short clip.
- **Cinematic single-shot, audio quality matters** → `sora2-i2v` if active (4/8/12s, native audio mix is cleaner — but you give up reference grammar AND voice-continuity strategy across segments)
- **Budget-constrained or simple loop, no voice / no product reference fidelity needed** → `kling-2.1-standard` / `kling-3-standard`
- **`seedance-2.0-i2v`** — niche only. Use ONLY when the user has explicitly opted into i2v, OR R2V is unavailable in the registry. Default to R2V for everything else; i2v has no advantage over R2V in normal UGC work and quietly forfeits the reference-grammar / multi-ref / voice-continuity primitives this skill depends on.

When this skill's docs reference "Seedance" it's because Seedance R2V is currently the best-fit for the entire UGC pipeline (single AND multi-segment, short AND long scripts, with or without product references). When a new model lands that supports the same primitives, the picker section in `references/ugc-video-pipeline.md` will name it; until then default = Seedance 2.0 R2V, regardless of duration or segment count.

## Reference index — read on demand

These files cover the deep knowledge for each topic. Read the relevant one(s) when planning a generation.

- `references/ugc-video-pipeline.md` — **The canonical multi-segment Seedance R2V pipeline.** Style picker (single-ref / angle-cut / framing-progression), per-segment reference decisions, voice continuity, concat. Read for any UGC / promo / talking-avatar request.

- `references/seedance-reference-syntax.md` — `@Image1` / `@Audio1` / `@Video1` reference label syntax. Wrong vs right prompt examples, what stays in prompt vs what becomes a reference.

- `references/multi-reference-pattern.md` — When and how to pass MULTIPLE reference images (avatar + product side + product top). CLI invocation for both `image generate` and `video generate`, common mistakes, pre-generation checklist. Read whenever the user uploads more than one photo of the same subject.

- `references/voice-continuity.md` — `audio_urls` reference parameter for multi-segment voice character lock. Why TTS+lipsync chains are not the answer.

- `references/no-music-no-subtitles.md` — Default no-music + no-subtitles rules. Setting-aware ambient phrasing for cafe/bar/gym (these settings auto-add music). Subtitle hallucination explained — why merged into one anti-overlay line.

- `references/narrative-arc.md` — Plan a 3-beat arc (open → reveal → close) before drafting prompts. Decision tree for when to generate per-segment reference image edits vs reuse the source.

- `references/brand-and-moderation.md` — Don't name third-party brands in prompts (triggers copyright moderation). Soften aggressive verbs ("crunches" → "fragments slowly"). Reroute object-in-mouth edits from nano-banana-2 to gpt-image-2-i2i.

- `references/first-frame-not-camera-motion.md` — Each segment's prompt describes its starting framing (wide / medium / close), not camera motion (zoom-in, pull-back). Seedance handles micro-motion natively.

- `references/script-and-duration.md` — Wrap user script verbatim as quoted speech. Duration math: ~2 words/second. Use gender-neutral `The person says: "..."` unless reference image makes it explicit.

- `references/confirmation-rules.md` — Plan-summary gate + banana-edit-approval gate. The two pause points before spending credits.

- `references/auto-subtitle.md` — Burned-in karaoke captions via `quickdesign video subtitle`. Style presets (tiktok / minimal / karaoke / reels-pop). Use AFTER generation — never let Seedance burn its own hallucinated captions.

## How a typical multi-segment UGC request flows

1. **Read the script** the user provided (or generate a short one if the user gave only a brief).
2. **Count words** → divide by 2 → segment count = `ceil(seconds / 15)`.
3. **Pick transition style** — single-ref for plain talking-head (default), angle-cut for podcast/cinematic/explicit "ikinci açı", framing-progression as opt-in.
4. **Per segment, decide reference**: source image / banana edit / borderline-ask-user. (See `narrative-arc.md` decision tree.)
5. **Emit plan summary** — Type, Model, Duration per segment, Cost estimate. **WAIT for user "go".**
6. **Generate Seg 1**, extract audio.
7. **For each subsequent segment that needs a banana edit**: generate the edit, **show the user, wait for approval**, then run Seedance R2V for that segment.
8. **Run Seedance Segs 2..N in parallel** with `--reference-audio` set to Seg 1's audio.
9. **Concat** with `ffmpeg -c copy`.
10. **Frame-extract** (`ffmpeg -ss <t> -frames:v 1`) at segment boundaries, hand back to user with QA notes per segment.

## Duration & cost — Seedance 2.0 supports every integer second 4-15

Valid Seedance 2.0 (R2V / I2V / T2V) durations: `4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15` (plus `"auto"`). No rounding to 5/10/15 — pick the tightest value that fits the segment's script.

**Cost scales linearly ~40cr/s at 1080p R2V** (validated empirically):

| Duration | Cost | Use for |
|---|---|---|
| 4-6s | 160-240cr | Pure visual beats, no speech, or 8-12 word lines |
| 8s | 320cr | ~16-word hook line |
| 11s | 440cr | ~22-word segment |
| 12s | 480cr | ~24-word segment |
| 13s | 520cr | ~26-word segment |
| 15s | 600cr | Cap, ~30-word max segment |

Other operations:
| Operation | Cost (cr) |
|---|---|
| Nano-banana-2 image edit @ 1K | ~12 |
| Nano-banana-2 image edit @ 2K | ~24 |
| Nano-banana-2 image edit @ 4K | ~48 |

Tight duration picking matters: 11s instead of 15s saves 160cr per segment. A 3-segment ad with tight durations (avg ~12s) vs rounded-to-15s saves ~360cr per video.

A typical 36-44s 3-segment UGC ad with banana edits lands at ~1,500-2,000 credits — varies based on tight vs padded durations and number of per-segment edits.

**Duration picking algorithm (per segment):**
1. Count words in this segment's script.
2. `raw = words / 2` (≈2 wps natural pace)
3. `tight = ceil(raw)`
4. If `tight < 4` → bump to 4 (Seedance lower bound).
5. If `tight > 15` → this segment doesn't fit; split into two segments at sentence boundary.
6. Use `tight` as the duration. Don't pad unless: (a) action includes a meaningful gesture AFTER the speech (~+1s), or (b) closer needs visual breath for CTA.

**Plan summary template** (always show the math):
> "Script: 47 words → ~24s total speech → 2 segments. Seg 1: 24 words / 12s (480cr). Seg 2: 23 words / 12s (480cr). Total Seedance: 960cr. OK?"

## Common mistakes the agent must avoid

- ❌ Re-describing the person/setting verbatim in the prompt → identity drift across segments. Use `@Image1`.
- ❌ Skipping `--reference-audio` on multi-segment → 3 different voices across cuts.
- ❌ Forgetting the "no subtitles" line when the prompt has quoted speech → Seedance burns hallucinated captions onto every frame; can't be removed in post.
- ❌ Naming brands in prompts ("Tom Ford", "Nike") → copyright moderation reject.
- ❌ Aggressive verbs ("crunches", "smashes", "rips") → moderation reject (catch-all "copyright" message).
- ❌ Camera motion verbs ("slowly zooms in", "static hold") → ignored or randomized; competes with scene description.
- ❌ Auto-chaining banana edit → Seedance without showing the user the edit first → wrong reference burns 500cr.
- ❌ Object-in-mouth edits via nano-banana-2 → reject. Use gpt-image-2-i2i.
- ❌ Treating `audio_urls` as voice clone API — it's a Seedance-native reference, not a separate clone step.

## Output artifacts

For multi-segment UGC pipelines, save artifacts in a per-job directory so the user can replay / re-render any segment:

```
~/Downloads/<job-name>/
  seg1.mp4
  seg1-audio.mp3
  seg2.mp4
  seg3.mp4
  final.mp4
  references/
    seg2-edit.png
    seg3-edit.png
```

Surface the file paths in the final reply so the user can find them without searching.
