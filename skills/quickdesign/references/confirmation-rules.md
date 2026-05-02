---
name: Two confirmation gates — plan summary BEFORE generation, banana edit BEFORE Seedance
description: Two pause points are mandatory in any paid generation pipeline. (1) Emit a plan summary BEFORE any generation and wait for user "go". (2) When the pipeline includes a banana edit step that feeds into Seedance R2V, generate the edit, show it to the user, wait for visual approval, THEN run Seedance. Banana edits are ~12-48cr; Seedance is ~400-600cr — wrong reference auto-chained to Seedance burns 50× the cost.
---

Two pause points are mandatory in any paid generation pipeline. Skipping either burns user credit and trust.

## Gate 1: Plan summary before any generation

After resolving inputs (uploads, prompt, model selection), emit a plan summary in this format:

```
PLAN SUMMARY
============
Type:        Multi-segment UGC video (3 segments + voice continuity)
Model:       Seedance 2.0 R2V + nano-banana-2 (per-segment edits)
References:  ~/path/to/source.png (1 source image)
Style:       Single-ref talking-head (Style A)
Script:      47 words → 24s total → 2 segments

Seg 1: 24 words / 12s — wide opener
Seg 2: 23 words / 12s — close reveal (reuse source ref, no edit)

Voice continuity: --reference-audio from Seg 1 mp3 → Seg 2

Estimated cost:
  Seg 1 R2V (12s, 1080p):  480 cr
  Seg 2 R2V (12s, 1080p):  480 cr
  Total Seedance:          960 cr

OK to proceed, or want to adjust duration / resolution / audio / aspect?
```

Wait for "yes / proceed / go" or a tweak. Don't infer consent from silence.

**Skip the plan gate ONLY when** the user wrote `--yes`, `proceed`, `auto`, `--no-confirm`, or similar in the original request.

**Why this matters:** Generation costs tokens and time. Once started, the user can't easily change duration / resolution / audio-on-off mid-flight. Even when the briefer hands over full parameters, the confirmation pass catches generic settings (duration, resolution, audio on/off, aspect ratio) the user is most likely to want to override.

## Gate 2: Banana edit reference image before Seedance R2V

When the pipeline includes a banana edit step that feeds into Seedance:

1. Generate the banana edit
2. **STOP**. Display the result to the user with a short caption ("Reference for Seg N — does this match what you want?")
3. Wait for explicit user response
4. Only then proceed to Seedance R2V

This is NOT optional. Skip ONLY when:
- The user has *just* (in the same turn) seen a generated reference and said "yapalım" / "go"
- The user has explicitly told the agent in this session "auto-proceed without showing me references"

## Why the banana gate matters

Banana edit: ~12-48cr (cheap, fast — 30-60s). Seedance R2V: ~400-600cr (expensive, slow — 3-5min).

**The cost asymmetry means a wrong banana that's caught early costs ~12-48cr; a wrong banana that goes through Seedance costs 50× more.** The 30-second pause for visual approval is cheap insurance.

Real example from production: a mom-selfie hook segment was banana-edited as third-person framing (mom holding phone, viewer outside watching her). User wanted the actual selfie POV (camera = phone, mom looking directly at viewer). Auto-chaining the banana → Seedance burned ~360cr on the wrong framing because no approval gate stopped the chain.

## How to apply

- After every banana edit destined for Seedance: pause and surface the image. Write one short caption with what you see in it ("mom standing center, phone in selfie pose, mural behind") so the user can verify it matches their intent without having to re-derive your interpretation.
- If the user said "yapalım" / "go" / "proceed" referring to the **plan**, that does NOT cover the reference image — those words approve the next concrete *action* (generate the edit), not the rendered output.
- For multi-segment pipelines: pause at each segment's banana edit. Don't fire all banana edits in parallel and then show 3 references at once — generate one, show, approve, render Seedance for that segment, then move to next segment's banana.
- If the banana edit looks good and the user is paying attention (active session), one short turn for approval is fine. If the session is autonomous / wakeup-driven, leave the Seedance launch for next turn after explicit user signal.

## Exception — talking-head UGC with no banana edit

When the segment uses the original source reference (no edit), Gate 2 doesn't apply because there's nothing rendered to approve — the source is what the user already gave us. Only Gate 1 (plan summary) applies.

## Cost-asymmetry summary

| Action | Cost | If wrong |
|---|---|---|
| Plan summary (Gate 1 emit) | 0 | Catch wrong duration/resolution before any generation — saves 100% |
| Banana edit | 12-48cr | Catch wrong framing/composition — saves 50× downstream |
| Seedance R2V | 400-600cr | Already burnt, must re-run = 2x the cost of original |

Both gates are cheap insurance against expensive mistakes.
