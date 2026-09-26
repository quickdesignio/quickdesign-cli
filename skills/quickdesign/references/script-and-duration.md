---
name: Script preservation, gender-neutral default, duration math (Seedance 2.5 — 5/8/10/12/15/20/25/30s)
description: When the user supplies a script, include it verbatim as quoted speech in the prompt — don't paraphrase. Use gender-neutral subject (`The person`) unless reference image clearly shows otherwise. Seedance 2.5 accepts the discrete durations 5, 8, 10, 12, 15, 20, 25, 30s — compute the tight fit (~2 wps) and round up to the next legal value. Up to 30s of speech is ONE segment. Cost scales linearly per second (720p 28 cr/s default), so tight picking saves real credit.
---

When the user supplies a script (TTS-style narration text) and `--generate-audio` is on, keep the script verbatim inside the prompt as quoted speech.

## Gender-neutral default pattern

```
@Image1 in the same setting. Standing at the kitchen counter.
The person says: "<full script verbatim>".
No music score. No subtitles or on-screen text.
Vertical 9:16 format.
```

If the reference image OR the user's brief makes the gender unambiguous ("woman in glasses", "my female avatar"), use `She says: "..."` / `He says: "..."`. **Default to `The person says: "..."` when uncertain** — never assume male.

**Don't infer gender from filenames or first-name guesses.** A file called "alex_intro.png" might be male or female; the safer default is `The person`.

## Why these rules exist

1. **Don't strip the script** — Seedance / Kling / Flux 3 with native audio generate dialogue audio matching quoted speech in the prompt. Paraphrasing into "speaking enthusiastically" produces ambient sounds or wrong content.
2. **Don't assume gender** — Reference images are user-supplied; could be male, female, neutral, or even non-human. Hardcoding `He says` is a real bug when the reference is a woman.

## Seedance 2.5 supported durations

**Discrete values only:** `5, 8, 10, 12, 15, 20, 25, 30` seconds. Lower bound is 5, upper bound is **30 — one segment can hold a whole ≤30s ad.** There is no 6/7/9/11/13s etc.: compute the tight fit, then round UP to the next legal value.

(Fallback `seedance-2.0-r2v` accepts every integer 4–15 plus `"auto"`, with a 15s cap per segment — if you're on the fallback, use the tight integer and split above 15s. Seedance 1.x legacy only accepts 5 or 10 — don't use it.)

## Cost is linear per second (Seedance 2.5)

Registry rates: `480p` 13 cr/s · **`720p` 28 cr/s (default)** · `1080p` 70 cr/s (2.5× the 720p cost). Always confirm with `quickdesign cost seedance-2.5 -d <s> -r <res>`.

| Duration | 720p (cr) | 1080p (cr) |
|---|---|---|
| 5s | 140 | 350 |
| 8s | 224 | 560 |
| 10s | 280 | 700 |
| 12s | 336 | 840 |
| 15s | 420 | 1050 |
| 20s | 560 | 1400 |
| 25s | 700 | 1750 |
| 30s | 840 | 2100 |

So **tight duration picking still saves real credit**: a 22-word line needs 11s → 12s (336cr); reflexively picking 15s costs 420cr, and "just make it 30s" costs 840cr.

## Duration picking algorithm (per segment)

1. Count words in this segment's script.
2. `raw = words / 2` (≈2 wps natural pace; 2.5 wps is faster but still natural)
3. `tight = ceil(raw)`
4. If `tight > 30` → this segment doesn't fit; split at a sentence boundary (see below).
5. Use the smallest legal value ≥ `tight` from `5, 8, 10, 12, 15, 20, 25, 30` (anything under 5 → 5).

**Add 1-2s padding only when:**
- The action description includes a meaningful gesture/beat AFTER the speech (e.g. "she says X, then turns to camera with a smile" — the turn needs ~1s)
- The closer segment needs visual breath to land the CTA (add 1s for the smile/wave/product hold to register)

Padding that pushes `tight` past a legal value bumps you to the next one — check whether it's worth it. Don't pad just to "be safe" — Seedance fits the audio to the requested duration and extra time becomes dead air or stretched mouth movement. If rounding up to the grid already leaves >2s of slack (e.g. 21s of speech → 25s), give the tail a concrete beat (smile, product hold, turn to camera) or tighten the script to fit the lower value.

## Multi-segment splitting

If the total speech fits in 30s (≈60 words at 2 wps), it's **one segment** — no split, no voice-continuity step.

If the total speech requires >30s:

```
total_seconds = ceil(total_words / 2)
segment_count = ceil(total_seconds / 30)
```

Distribute words to segments at sentence/beat boundaries — never mid-sentence. Each segment's duration follows the tight-pick algorithm above; aim the split so each segment lands on or just under a legal value.

Example: 60-word script → 30s total speech → **one 30s segment** (840cr @ 720p).

Example: 90-word script → 45s total speech → 2 segments. Split at sentence boundary into:
- Seg 1: 40 words / 20s (560cr)
- Seg 2: 50 words / 25s (700cr)

Total: 20s + 25s = 45s, 1260cr @ 720p. Vs naive "30s + 30s": 1680cr. Saves 420cr. Multi-segment plans also need the Seg 1 approval gate and `--reference-audio` continuity (see `voice-continuity.md`).

Arcs that need a cut per beat (angle-cut, or a state change the reference contradicts) stay multi-segment even under 30s — see `narrative-arc.md`.

## Plan summary template

Always include the duration math when surfacing the plan:

> "Script: 47 words → ~24s total speech → 1 segment, Seedance 2.5 @ 25s / 720p: 700cr. OK to proceed, or want to adjust duration / pacing / resolution (1080p = 1750cr)?"

Multi-segment variant:

> "Script: 90 words → ~45s total speech → 2 segments. Seg 1: 40 words / 20s (560cr). Seg 2: 50 words / 25s (700cr). Total Seedance 2.5 @ 720p: 1260cr. Seg 1 renders first for your approval, then Seg 2 with Seg 1's voice locked. OK to proceed?"

User can override (`"do it as 3 shorter segments"` / `"pad each to 15s"` / `"1080p"`) before any credit is spent.

## How to apply

1. If user gives a paragraph of speech-style text, ask once: "Should the character SPEAK this (audio on, dialogue-matched), or use it as direction only?" Skip the question on regen requests where intent is obvious.
2. Count script words per segment. Compute `ceil(words / 2)` seconds → round up to the next legal Seedance 2.5 value (`5/8/10/12/15/20/25/30`). ≤30s total → one segment.
3. Use **`The person says: "..."`** unless the reference image / brief explicitly identifies gender. Don't infer gender from filenames or first-name guesses.
4. Wrap script verbatim inside the scene description; keep camera / lighting / framing context around the quote.
5. For pure action prompts (no spoken content), strip is fine — but check first.
6. Always show the duration + cost math (at 720p, with the 1080p figure if relevant) in the plan summary so user can override before credits are spent.
