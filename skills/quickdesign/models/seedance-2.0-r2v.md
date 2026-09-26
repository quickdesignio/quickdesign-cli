---
slug: seedance-2.0-r2v
category: video_generate
provider: fal | kie
status: fallback
description: Seedance 2.0 Reference-to-Video. Former default, now the FALLBACK to `seedance-2.5`. Pick it when a shot needs more than 4 reference images (takes up to 9), native 4K, or the lowest cost per second (1080p = 25 cr/s vs 2.5's 70). Same labeled reference grammar (@Image1 / @Audio1 / @Video1) and --reference-audio voice continuity, but a hard 15s cap per segment. It's also what the CLI silently picks when `--provider seedance` gets reference flags without `--model`.
---

## When to use

The default is now `seedance-2.5` (`./seedance-2.5.md`). Use 2.0 R2V instead when:

- **More than 4 reference images** are needed in one shot (2.0 R2V takes up to 9; 2.5 takes 4)
- **Native 4K** output is required (2.5 tops out at 1080p)
- **Budget** is the driver: 12s@1080p = 300 cr here vs 840 cr on 2.5 at 1080p (336 cr at 720p)
- The user **explicitly asks** for Seedance 2.0

It's still R2V, not i2v. Don't drop to `seedance-2.0-i2v` because the task looks "simple". See `../SKILL.md` cardinal rule #0.

## Hard facts (live)

```bash
quickdesign cost seedance-2.0-r2v -d 12 -r 1080p   # exact compute
quickdesign video models | jq '.data[] | select(.slug=="seedance-2.0-r2v")'
```

Known behavior:
- **Selecting it**: `--provider seedance --model seedance-2.0-r2v` (explicit is better; omitting `--model` with reference flags also lands here).
- **Duration grid**: integer `4..15` seconds (plus `auto`). **15s cap per segment**, so scripts longer than that need multi-segment + `--reference-audio`. Pick the tightest value that fits the segment script.
- **Resolutions**: `480p` (5 cr/s), `720p` (11 cr/s), `1080p` (25 cr/s), `4k` (50 cr/s). Default to `1080p` when you pick 2.0 for quality/budget; `720p` is cheaper but soft on faces.
- **Aspect ratios**: `9:16`, `16:9`, `1:1`, `4:3`, `3:4`, `21:9`, `auto`.
- **Reference caps (registry)**: 9 images, 3 videos, 1 audio.
- **Native audio**: on by default. Voice character is generated unless `--reference-audio` locks it to a prior segment.

## Reference grammar

Seedance reads the inputs as positional labels:

| Flag | Reference label |
|---|---|
| `--reference-image <url\|path>` (repeatable) | `@Image1`, `@Image2`, ... |
| `--reference-audio <url\|path>` (registry caps 2.0 R2V at 1) | `@Audio1` |
| `--reference-video <url\|path>` (repeatable) | `@Video1`, `@Video2`, ... |

**Don't re-describe what the references already show.** Verbose verbatim re-descriptions dilute the reference anchor → cross-segment drift in face / hair / wardrobe / setting / smaller props.

❌ Wrong:
```
A young man with messy brown hair, a short beard, wearing a black t-shirt,
in a casual indoor home setting with a ceiling fan, warm interior lighting.
He says: "..."
```

✅ Right:
```
@Image1 in the same setting. Hands at his sides. He says: "..."
No music score. No subtitles or on-screen text.
```

## What stays in the prompt vs what becomes a reference

| Concept | How to express |
|---|---|
| Identity (face, hair, body type) | `@Image1` — never re-describe |
| Wardrobe / accessories | `@Image1` — re-describing causes drift |
| Setting (room, background) | `@Image1` — only "same setting" pin |
| Lighting / mood | `@Image1` — describing competes with visual |
| Product detail (stitching, label, engraving) | `@Image2`, `@Image3` (multi-ref) — never describe in prose; see `../references/multi-reference-pattern.md` |
| **Action** (gesture, gaze, posture change) | Words — NEW per segment |
| **Dialogue / voiceover** | Words, in `"quoted speech"` form |
| **Camera framing change** (wider/closer) | Words OR a per-segment edited reference |
| **Voice character continuity** | `--reference-audio` from Seg 1; reference as `@Audio1` if you want explicit |

## Compact prompt skeleton

```
@Image1 in the same exact setting throughout.
<one-sentence action/state for this segment>.
He/She/The person says: "<verbatim quoted speech for this segment>".
No music score. No subtitles or on-screen text.
Vertical 9:16 format.
```

For multi-product UGC, the skeleton expands:

```
@Image1 in the same setting. The held product matches @Image2 / @Image3 exactly.
<action>. He/She says: "<script>".
No music score. No subtitles or on-screen text.
Vertical 9:16 format.
```

## Gotchas / failure modes

1. **Auto-layered music bed under voiceover.** Seedance defaults to layering a music track when prompts contain quoted speech. Add `No music score.` to suppress. Don't enumerate ambient sounds you want to keep — over-prescribing makes audio feel scripted. See `../references/no-music-no-subtitles.md`.

2. **Burned hallucinated subtitles.** When a prompt has quoted speech, Seedance burns captions into pixels. They hallucinate (partial sentences, paraphrased words, wrong timing). Always add `No subtitles or on-screen text.` Use `quickdesign video subtitle` post-generation if you actually want captions — the dedicated endpoint runs real ASR. See `../references/auto-subtitle.md`.

3. **Multi-segment voice drift.** Without `--reference-audio` from Seg 1's extracted audio, every segment generates a fresh voice character. Always lock with audio_urls. See `../references/voice-continuity.md`.

4. **Camera-motion verbs cause defects.** Don't write "slowly zooms in", "pans across", "static hold". Seedance produces natural micro-motion (breathing, gestures, head turns) on its own — explicit verbs override that with mechanical-feeling motion. See `../references/first-frame-not-camera-motion.md`.

5. **Fine print / engravings drop.** When the product has visible text (brand wordmark, hallmarks like "925", model number, care label), Seedance has no obligation to preserve it pixel-faithfully across motion. For ads where label fidelity matters: ensure the source reference edit (or first-frame reference) preserves the text legibly first; mention the specific text by name in the prompt; check the rendered first/last frame.

6. **Input video is billed too.** With `--reference-video`, 2.0 R2V bills input seconds + output seconds. Check `quickdesign cost` before chaining long reference clips.

## Cross-references

- Current default (≤4 refs, up to 30s per segment) → `./seedance-2.5.md`
- Multi-product / multi-angle reference usage → `../references/multi-reference-pattern.md`
- Voice continuity across segments → `../references/voice-continuity.md`
- Music + subtitle suppression (minimal directive) → `../references/no-music-no-subtitles.md`
- Why "first frame" matters more than camera-motion verbs → `../references/first-frame-not-camera-motion.md`
- Confirmation gates before paid generation → `../references/confirmation-rules.md`
- Multi-segment UGC method → `../pipelines/ugc-video.md`
