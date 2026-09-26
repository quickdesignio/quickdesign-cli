---
name: UGC video pipeline (canonical) — Seedance 2.5 reference-to-video, one segment up to 30s, voice-continuity audio reference above that
description: The official method for producing talking-avatar / UGC promo videos via the QuickDesign CLI. Seedance 2.5 (`--model seedance-2.5`) holds up to 30s of speech in ONE segment, so most ads are a single call. Longer scripts (or arcs that need cuts) go multi-segment; voice continuity is enforced by passing segment 1's extracted audio as `--reference-audio` to all subsequent segments. Two transition styles supported on top of voice-continuity — angle-cut (reference edits via gpt-image-2-5-sunburst-i2i) or framing-progression (same source image, only middle segments get explicit closer framing). Segments are concatenated with ffmpeg `-c copy`.
---

This is **the** method for talking-avatar UGC video production. Use it for any spoken-script video, regardless of total length.

## Model picker

**Default model: `seedance-2.5`** (Seedance 2.5 reference-to-video). Best-fit for this pipeline because it supports all four primitives this method depends on:

1. Reference label syntax (`@Image1`…`@Image4`) — anchors identity + setting consistency without verbose verbatim descriptions. Max **4** reference images per call.
2. Audio reference (`--reference-audio`, up to 3) — locks voice character across multi-segment outputs without TTS chains
3. Discrete duration grid `5 / 8 / 10 / 12 / 15 / 20 / 25 / 30` s — **one segment holds up to 30s** (~60 words @ 2 wps), so most ads need only one call and no continuity step
4. Reasonable price for iteration at the default **720p** (28 cr/s → 12s = 336cr, 30s = 840cr). 1080p is 70 cr/s (**2.5× the cost**) — only on explicit request.

**`--model seedance-2.5` is mandatory on every call.** Without it the CLI silently falls back to `seedance-2.0-r2v` (refs) or `seedance-2.0-i2v` (`--image`).

When a new model that supports the same primitives lands, update this picker to name it and call out where it diverges. Until then this whole doc assumes Seedance 2.5.

**Pre-flight check** (the agent should do this for non-trivial requests):

```bash
quickdesign video models | jq '.data[] | select(.slug | startswith("seedance")) | {slug, durations, resolutions, maxReferenceImages}'
```

If `seedance-2.5` is no longer in the list, fall back to `seedance-2.0-r2v` (see `../models/seedance-2.0-r2v.md` — 15s cap per segment, so re-run the segment math) or pick the closest replacement; the rest of this pipeline still applies.

**Length is NOT a reason to switch models or modes.** A short single-shot script does not justify dropping to `seedance-2.0-i2v` or to 2.5's first-frame mode (`--image`). Passing one `--reference-image` is functionally identical from the user's perspective, and it preserves every primitive this pipeline depends on (`@Image1`, `--reference-audio`, multi-`--reference-image`). `--image` and `--reference-*` are mutually exclusive on 2.5 — never combine them.

**When to deviate from the default:**

| Situation | Use instead | Why |
|---|---|---|
| Needs >4 reference images, a native 4K master, or budget-tight 1080p | `seedance-2.0-r2v` | Up to 9 image refs, 4k, 1080p at 25 cr/s — but 15s cap per segment → more segments + continuity steps |
| User asks for Sora 2 | — | **Retired 2026-09-23** (`sora2-*` inactive). Say so; offer Seedance 2.5 (spoken UGC) or Flux 3 (cinematic single shot) |
| Cinematic single shot / pure text-to-video, no reference grammar needed | `flux-3-t2v` / `flux-3-i2v` | 5–20s, native audio; no `@Image` labels, no `--reference-audio` continuity |
| Cheap image→video or video→video with synced object sounds, 16:9 / 9:16 only | `gemini-omni-video` | 4/6/8/10s, ~29–57cr; max 2 image refs |
| User explicitly opts into i2v | `seedance-2.0-i2v` | Only override the default on explicit user opt-in — never silently |
| Budget-tight, simple loop, no voice / no product fidelity needed | `kling-3-standard` | Cheaper but no `@Image1` refs, no `--reference-audio` — single segments only |
| Already-rendered video needs new caption | `fal-auto-subtitle` | Post-processing only, see `../references/auto-subtitle.md` |
| Generated video is too low-res | `topaz-video-upscale` / `bytedance-video-upscale` | Run after final concat — see `../models/topaz-video-upscale.md` |

For full per-model gotchas / prompt skeletons / failure modes, jump to the model card:
- `../models/seedance-2.5.md` — the default; see this for prompt syntax
- `../models/seedance-2.0-r2v.md` — fallback for >4 refs, 4K, or budget 1080p
- `../models/flux-3.md` — cinematic single shot / text-to-video (the Sora 2 replacement)
- `../models/gemini-omni-video.md` — cheap i2v / v2v with synced sound
- `../models/kling-3-pro.md` — budget alternative for non-spoken b-roll
- `../models/seedance-2.0-i2v.md` — almost never the right pick (here for completeness)

The rest of this doc (segment planning, voice continuity, concat) is model-agnostic. The Seedance-specific bits live in `../models/seedance-2.5.md` so swapping models in the future is a localized edit.

**When more than one model is viable** for the request (e.g. user wants a native 4K master of a 12s spoken ad — 2.5 tops out at 1080p, 2.0 R2V does 4k), don't pick silently — use the `AskUserQuestion` tool to surface the tradeoff with `seedance-2.5` marked `(Recommended)` first (720p/1080p + upscale), and `seedance-2.0-r2v` @ 4k as the alternative. Don't offer `seedance-2.0-i2v` as a default-tier alternative; only surface it if the user named it themselves. See `../references/confirmation-rules.md#use-askuserquestion-for-structured-choice-gates` for the exact pattern.

## Method

1. **Plan the segments.** Count script words. At ~2 wps natural pace, one Seedance 2.5 segment fits up to ~60 words (30s).
   - **≤30s of speech → ONE segment.** Pick the smallest legal duration (`5/8/10/12/15/20/25/30`) that covers `ceil(words / 2)` plus a ~1s tail. No audio extraction, no concat, no Seg-1 gate.
   - **>30s of speech → multi-segment.** Divide the script at sentence/beat boundaries so each segment is ≤30s and lands tight (no padding). The final segment may be shorter (e.g. 8s for a punchy CTA).
   - **Angle-cut (style b) or a state change the reference contradicts** needs a cut per beat, so it stays multi-segment even under 30s total.

   See `../references/script-and-duration.md` for the full math.

2. **Pick a transition style:**

   **(a) Plain talking-head UGC — DEFAULT** for service explainers, creator selfie content, casual reviews. **Single reference image** for every segment. No image edits, no angle changes. For ≤30s this is one call; above that, voice continuity is locked via `--reference-audio` (Seg 1 audio → Segs 2..N). Each segment's prompt describes its own action beat; Seedance produces natural variation (gesture, gaze drift, micro-pose) from the same anchor — enough variety for cuts to feel intentional in casual UGC. Cost: 0 image edits, just N× Seedance 2.5.

   **(b) Angle-cut transitions** — for podcast / editorial / cinematic / multi-shot storytelling. Use when content has deliberate visual beats benefiting from angle changes (wide-front → 3/4 side → close mid-shot front), or when the user explicitly asks for "different angles". Generate angle-shifted reference images via `gpt-image-2-5-sunburst-i2i` for Segs 2..N. Cost: ~18cr per edit at 2K (default) or ~24cr at 4K (when product detail matters).

   **(c) Framing-progression transitions** — opt-in only. Same source for every segment; middle segment gets explicit "Medium close-up framing" line. Use when user wants zoom-in/out feel without image edits.

   ### Decision rule

   - User says "plain UGC" / "talking head" / "service explainer" / casual creator selfie → **(a) single ref**.
   - User says "podcast" / "cinematic" / "editorial" / "different angles" / "ikinci açı" → **(b) angle-cut**.
   - Reference image visually carries scene-narrative weight (editorial pose, prop interaction, dramatic lighting) → **(b) angle-cut** likely better even if user didn't say so explicitly; surface the choice in the plan summary so they can switch.
   - State change required (mouth empty when source has crystal, etc.) → must use per-segment reference edits regardless of style.

   **Don't write camera-motion verbs in any prompt** ("slowly zooms in", "pulls back", "static hold"). Seedance produces natural micro-motion (breathing, head turns, gestures) on its own. See `../references/first-frame-not-camera-motion.md`.

3. **Decide per-segment reference images** based on what each segment NEEDS visually vs. what the source reference shows. See `../references/narrative-arc.md` for the full decision tree. Quick version per segment:
   - **Pure talking-head, no state change** → reuse source reference, 0 edits.
   - **Style (b) angle-cut** → generate angle-shifted reference via `gpt-image-2-5-sunburst-i2i` (~18cr at 2K each).
   - **Significant state change vs. source** (e.g. mouth empty when source shows mouth full, glasses off when source shows them on) → **MUST generate a state-matched reference edit** for that segment. The reference image overrides action-description "mouth is now empty" wording — verified empirically. Without a matched reference, expect visible state breaks at cuts.
   - **Borderline / ambiguous** → ASK the user before burning credit. Surface as a one-line question in the plan summary.

   Reference-edit call (default model — `--model` is mandatory, the CLI's own default is still `nano-banana-2`):
   ```bash
   quickdesign image generate \
     --model gpt-image-2-5-sunburst-i2i \
     --reference-image <source.png> \
     --aspect-ratio 9:16 --resolution 2K \
     -p 'Edit @Image1: <the one change>. Same person, same outfit, same setting, same lighting, same props.' \
     -o <segN-ref.png> --wait
   ```
   Sunburst has **no 4:5 / 5:4** (the BFF silently clamps 4:5 → 3:4). For a 4:5 deliverable use `nano-banana-2` instead — see `../models/nano-banana-2.md`.

   For reference-edit prompts:
   - **Use edit-style verbs, not compose-style.** `Edit @Image1: ...` not `Compose a vertical 9:16 frame...`. The compose form regenerates a fresh AI-look image and loses the avatar's lighting + grain + lo-fi authenticity. See `../references/avatar-edit-not-regenerate.md` for the verb library + setting-lock principle.
   - Pin identity: "Same person, same outfit, same setting, same lighting, same props."
   - State only the change: "Now without the crystal in mouth — mouth is closed and relaxed" / "3/4 side profile from the right" / "looking surprised, eyes wider".
   - Don't re-list scene tokens that the reference already shows — the edit model re-paints them and accumulates drift.
   - Strip quality-upgrade words from the prompt: "photo-realistic" / "studio quality" / "8K" trigger regen. For UGC, "match the lighting and grain of @Image1" is the right anchor.
   - Verify identity preservation before submitting the segment — re-generate the edit if the face drifted.

   **Resolution rule:**
   - **Default `--resolution 2K`** for talking-head / selfie / lifestyle (model is focal point). 1K leaves Seedance little headroom for a clean render.
   - **Use `--resolution 4K`** when the video integrates a **product** (model holding/wearing/showcasing a specific product where label/texture/detail matters).
   - Cost ladder (Sunburst): 1K ≈ 12cr, 2K ≈ 18cr, 4K ≈ 24cr per edit.

4. **Generate Segment 1 first (sequential).** Standard Seedance 2.5 with native audio:
   ```bash
   quickdesign video generate \
     --provider seedance --model seedance-2.5 \
     --reference-image <seg1-ref.png> \
     --aspect-ratio 9:16 --duration <5|8|10|12|15|20|25|30> --resolution 720p \
     --wait -o <seg1.mp4> \
     -p '<prompt using @Image1 reference syntax>'
   ```
   `--resolution 1080p` only when the user asks for it — it's 2.5× the credits (70 vs 28 cr/s).

   **Prompt syntax — use `@Image1` references, not verbatim identity descriptions.** See `../models/seedance-2.5.md` for the full rule + reference grammar. Standard skeleton:
   ```
   @Image1 in the same exact setting throughout.
   <one-sentence action/state for this segment>.
   He/She/The person says: "<verbatim quoted speech>".
   No music score. No subtitles or on-screen text.
   Vertical 9:16 format.
   ```

   `--generate-audio` is on by default. The "in the same exact setting throughout" pin handles location continuity. The two short audio/visual suppression lines stay minimal — don't enumerate ambient sounds you want. See `../references/no-music-no-subtitles.md`.

   **Single-segment plans (≤30s, style a) are done here** — skip to post-processing (subtitle / upscale) if requested.

   **🛑 Seg-1 visual-approval gate (HARD STOP — applies to multi-segment plans).** After Seg 1 renders, do NOT proceed to audio extraction or Segs 2..N. Voice continuity locks Seg 1's audio into every subsequent segment, so a wrong voice / wrong avatar identity / mispronounced word / off-brand framing in Seg 1 multiplies the wasted spend by N. Single-segment plans skip this gate.

   The flow:
   1. Surface Seg 1's video URL in the chat (the `--wait -o <seg1.mp4>` step prints the public URL).
   2. Call `AskUserQuestion` with options:
      - **Looks right — render Segs 2..N** *(Recommended if Seg 1 is clean)*
      - **Re-render Seg 1** (tweak prompt, reference, duration, or quoted speech)
      - **Cancel the multi-segment plan**
   3. Only on "Looks right" → continue to step 5 (audio extract) and step 6 (parallel fan-out).

   This gate does NOT compress in auto mode. The Seg 1 → Seg N spend multiplier is the same regardless of how patient the user is. See SKILL.md cardinal rule #9.

5. **Extract Segment 1's audio** for voice continuity:
   ```bash
   ffmpeg -y -i <seg1.mp4> -vn -t 15 -acodec libmp3lame -q:a 2 <seg1-audio.mp3>
   ```
   `-t 15` keeps the reference inside the documented 2–15s audio-reference window even when Seg 1 is a 20–30s segment; 10–15s of clean speech is plenty to lock the voice. Mandatory whenever there's more than one segment. Single-segment videos skip this step.

6. **Generate Segments 2..N in PARALLEL**, each with `--reference-audio` set to seg1-audio.mp3:
   ```bash
   quickdesign video generate \
     --provider seedance --model seedance-2.5 \
     --reference-image <segN-ref.png>          # angle-cut: edited image; single-ref: same original \
     --reference-audio <seg1-audio.mp3>        # MANDATORY — voice continuity anchor \
     --aspect-ratio 9:16 --duration <5|8|10|12|15|20|25|30> --resolution 720p \
     --wait -o <segN.mp4> \
     -p '<@Image1 + action + dialogue + no-music + no-subs + 9:16>'
   ```
   Each parallel call is one Seedance API hit — no TTS, no voice-clone, no lipsync overlay. Voice match happens natively inside Seedance. Keep every segment at the same resolution as Seg 1.

7. **Concatenate.** Every segment is identical resolution / fps / codec / audio params (e.g. 720×1280 at the 720p default, H.264, AAC), so concat is mux-only — zero quality loss:
   ```bash
   printf "file '<seg1.mp4>'\nfile '<seg2.mp4>'\n…\n" > /tmp/concat.txt
   ffmpeg -y -f concat -safe 0 -i /tmp/concat.txt -c copy <final.mp4>
   ```

   If a segment ended up at a different resolution (e.g. one segment re-rendered at 1080p, or a `seedance-2.0-r2v` fallback segment), use the `concat` filter with re-encode instead.

## Why this beats legacy TTS+lipsync chains

- **Native audio per segment** — Seedance generates dialogue audio matching the quoted speech in the prompt, lip-synced inside the segment. No separate TTS + lipsync.
- **Up to 30s in one call** — most ads never need a continuity step at all on Seedance 2.5.
- **Voice continuity via `--reference-audio`** — above 30s, Seg 1's extracted audio is passed to Segs 2..N, so Seedance natively matches the voice character across all segments. ZCR within ~0.001 of seg 1 baseline in validation (measured on 2.0 R2V).
- **Cost** — a ≤30s single-ref ad is one call: e.g. 30s @ 720p = 840cr. A ~36s 3-act angle-cut promo = 3× 12s Seedance 2.5 @ 720p (1008cr) + 2× Sunburst 2K edits (~36cr) ≈ ~1045cr.
- **Speed** — parallel-friendly: Seg 1 sequential (audio dependency), then Segs 2..N independent and run in parallel. Total wall time ≈ Seg 1 time + longest parallel segment + concat (~6-8 min for 36s output, measured on 2.0 R2V).
- **Visual coherence** — angle/framing changes are intentional cinematography. Cuts feel like director's choice. Voice character stays one person throughout.

## What NOT to do

- Don't propose any TTS + voice-clone + lipsync chain — retired in this skill. Use `--reference-audio` instead.
- **Don't omit `--model seedance-2.5`.** The CLI's implicit default is `seedance-2.0-r2v` — you'd silently get the old model and its 15s cap.
- **Don't combine `--image` with `--reference-*` on 2.5** — first-frame mode and reference mode are mutually exclusive. For UGC always use reference mode.
- **Don't run 2.5 with no image and no reference on CLI ≤ 0.10.0.** There, prompt-only 2.5 is routed to a legacy text-to-video model while billed at 2.5 rates (fixed in 0.11.0). On an older CLI, give it at least one `--reference-image`, or use `flux-3-t2v` for pure text-to-video.
- **Don't pass more than 4 `--reference-image` to 2.5.** If the shot truly needs more anchors, switch to `seedance-2.0-r2v` (up to 9).
- **Don't skip the `--reference-audio` step on multi-segment videos.** It's not optional — Seedance picks a different voice per call without it; cuts sound like 2-3 different people.
- Don't cram more than ~2 words per second of duration into a segment (≈60 words max in a 30s segment) — pacing collapses to chipmunk speed.
- Don't change wardrobe / setting / lighting between segments — only the angle / framing / facial expression. Anything else breaks visual continuity.
- Don't write camera-motion verbs in segment prompts. Describe the **first-frame composition** instead, or omit framing entirely on segments that should match the reference image's natural framing.
- Don't skip the identity check on angle-shifted reference images — the edit model occasionally drifts the face on hard angle changes; regenerate the edit before sending it to Seedance.
- **Don't use a "still life" reference for the closer segment.** If the reference shows the subject already in their final pose (lying down, fully relaxed, hands at sides), Seedance has nowhere to go — produces 11s of frozen output. Action-loaded references (subject mid-gesture) + motion-verb action lines give the closer life.
- **Don't use "last-frame-as-first-frame continuation" between segments.** PNG extraction is a re-encode → degraded color/sharpness; Seedance then renders new video on top → compounded loss. Use an angle-shifted reference edit instead.
