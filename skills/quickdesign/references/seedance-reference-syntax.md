---
name: Seedance @Image1 / @Audio1 / @Video1 reference label syntax
description: Seedance 2.0 R2V supports labeled reference syntax. The first --reference-image is `@Image1`, second is `@Image2`, etc. Same for `@Video1..N` and `@Audio1..N`. When a prompt re-describes identity/setting verbatim, Seedance treats those words as a fresh scene description and reinterprets the visual — leading to drift across segments. Reference the labels directly so the model uses the source image as canonical truth.
---

Seedance 2.0 R2V uses positional label references for the inputs you pass via the API:

- `--reference-image <url|path>` (repeatable) → `@Image1`, `@Image2`, ...
- `--reference-audio <url|path>` (repeatable, max 3) → `@Audio1`, `@Audio2`, `@Audio3`
- `--reference-video <url|path>` (repeatable) → `@Video1`, `@Video2`, ...

Unlabeled prompt text describing the same person/scene fights with the reference and produces drift.

## Wrong vs right

❌ **Verbatim re-description** (causes drift across segments):
```
A young man with messy brown hair, a short beard, wearing a black t-shirt,
in a casual indoor home setting with a ceiling fan above, warm interior
lighting at night. He says: "..."
```
Seedance treats the description as scene-direction, reinterprets each segment freely, and drift accumulates across cuts.

✅ **Reference syntax** (canonical):
```
@Image1 in the same setting. Hands at his sides. He says: "..."
No background music or score — only his speaking voice and natural ambient sound.
No subtitles, no captions, no on-screen text overlays of any kind.
```
Seedance uses `@Image1` as the canonical visual truth — identity, wardrobe, setting, lighting all locked from the source. Only the action / state / dialogue are described.

## What stays in the prompt vs what becomes a reference

| Concept | How to express |
|---|---|
| Identity (face, hair, beard, body type) | `@Image1` — never re-describe |
| Wardrobe (specific shirt, jewelry, glasses) | `@Image1` — re-describing is what causes drift |
| Setting (room, background, props in scene) | `@Image1` — only mention "same setting" or scene tokens |
| Lighting / mood | `@Image1` — describing in words competes with the visual |
| **Action** (gesture, gaze direction, posture change) | Words. Seedance needs prompt direction for what's NEW per segment. |
| **Dialogue / voiceover content** | Words, in quoted speech form. |
| **Camera framing change** (wider/closer) | Words OR a per-segment edited reference. |
| **Voice character continuity** | `@Audio1` (the voice from the audio reference) |

## Standard multi-segment prompt template

For single-ref UGC pipeline:

```
@Image1 in the same setting. <action description for this segment>.
He/She/The person says: "<segment script>".
No background music or score — only the speaking voice and natural ambient sound.
No subtitles, no captions, no on-screen text overlays of any kind.
Vertical 9:16 format.
```

That's it. No "A young person with X hair wearing Y in a Z setting…" verbatim block. The reference image is the single source of truth.

For multi-image angle-cut style, each segment's edited reference becomes its own `@Image1` — same pattern, different per-segment image.

## Why this matters

Seedance's reference image is meant to be a strong anchor; verbose verbatim re-descriptions actively dilute it. Empirically, when prompts describe the person verbatim:
- Cross-segment drift in face / hair / wardrobe details
- Setting reinterpretation (Paris street swapped to office in seg 2)
- Smaller props (a cap logo) sometimes restyle

## How to apply

1. **Default**: every Seedance R2V prompt that ships with `--reference-image` uses `@Image1` instead of describing the person/setting/wardrobe in words. Multi-ref → `@Image1, @Image2, @Image3` matching the order of `--reference-image` flags.
2. **Audio reference**: when `--reference-audio` is set, you can mention `@Audio1` if you want the model to lean on that voice (often implicit; including it doesn't hurt).
3. **Action lines, dialogue, framing change, segment beat** stay as words — these are NEW info per segment that the reference image can't carry.
4. **`No background music or score`** + **`No subtitles or on-screen text`** lines stay in every prompt (separate `no-music-no-subtitles.md` rule).
5. **`in the same setting`** style pin stays — anchors location continuity across segments without re-listing scene tokens.

## Compact prompt skeleton (use as starting template)

```
@Image1 in the same exact setting throughout.
<one-sentence action/state for this segment>.
He/She/The person says: "<verbatim quoted speech for this segment>".
No background music or score — only the spoken voice and natural ambient sound.
No subtitles, no captions, no on-screen text overlays of any kind.
Vertical 9:16 format.
```
