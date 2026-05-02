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

## Use `AskUserQuestion` for structured choice gates

When the gate is a *choice between alternatives* (model, style, aspect ratio, "regenerate vs proceed"), do not pose it as a free-form prose question — call the `AskUserQuestion` tool. The user gets a clickable picker with each option's tradeoff visible at a glance, and the answer comes back in a structured envelope you can route from. Free-form text replies are reserved for open-ended approval ("does this banana edit look right?" → user types yes / no / change X).

**Required convention from the tool itself:** if you have a recommendation, put it **first** and append `(Recommended)` to the option label. The tool docs are explicit about this — agents who skip the suffix lose the affordance that nudges users away from low-quality choices.

Each question:
- 1 short header (≤12 chars, e.g. `Model`, `Style`, `Approve`)
- 1 clear question sentence
- 2-4 options, each with a `description` that names the tradeoff (cost / quality / time / capability)
- `multiSelect: false` for picker gates; `true` only when "select all that apply" actually makes sense (e.g. enabling features)

The UI auto-adds an "Other" option for free-text input — never include it yourself.

### Gate-by-gate canonical patterns

**Model picker** (when more than one model in the registry is viable for the request — see `ugc-video-pipeline.md#model-picker`):

```
question: "Which video model should I use for the 3 talking-head segments?"
header:   "Model"
options:
  1. label: "Seedance 2.0 R2V (Recommended)"
     description: "Reference labels + audio_urls voice lock + 4-15s grid. ~480cr/12s. Default for multi-segment UGC."
  2. label: "Sora 2 i2v"
     description: "Cleaner native audio, but no audio_urls so voice will drift between segments. 4/8/12s only. ~700cr/12s."
  3. label: "Kling 2.1 Standard"
     description: "Cheapest path. 5 or 10s only — your script needs splitting. No reference grammar."
```

**Transition style** (when the user hasn't named one):

```
question: "How should the segments cut together?"
header:   "Style"
options:
  1. label: "Single reference (Recommended)"
     description: "Same source image for every segment. Cheapest, default for plain UGC. Seedance produces natural variation."
  2. label: "Angle-cut"
     description: "Banana edit per segment for new angles (cinematic / podcast / 'second angle'). +12-48cr per edit."
  3. label: "Framing progression"
     description: "Wide → medium → close. Banana edit only for the macro middle segment. Use for product reveals."
```

**Banana edit approval** (Gate 2 — after generating the edit and showing the image):

```
question: "Use this banana edit as the Seg 2 reference?"
header:   "Approve"
options:
  1. label: "Looks good — proceed (Recommended)"
     description: "Run Seedance R2V with this edit. ~480cr."
  2. label: "Regenerate with tweaks"
     description: "Tell me what to change in the prompt and I'll re-edit. ~12cr per retry."
  3. label: "Cancel this segment"
     description: "Skip the edit and reuse the original source reference instead. 0 extra cost."
```

**Resolution / cost confirm** (when the briefer didn't specify and the multiplier is ≥2x):

```
question: "Render at which resolution?"
header:   "Resolution"
options:
  1. label: "1080p (Recommended)"
     description: "Standard for UGC reels. ~480cr/12s segment."
  2. label: "720p"
     description: "Cheaper, ~360cr. Quality loss visible on large screens but fine for social-only."
  3. label: "Auto"
     description: "Let Seedance pick based on the reference image's aspect. Usually 1080p."
```

### When NOT to use `AskUserQuestion`

- Open-ended approval where the user might want to type custom feedback ("does this banana look right?") — the free-form `Other` field is fine but the actual *content* is more nuanced than 4 buttons. Use a normal prose pause instead.
- Yes/no with no meaningful tradeoff — just ask.
- Mid-flight progress updates ("Seg 2 done, moving to Seg 3") — these are status, not decisions.
- Plan summary itself — Gate 1 is intentionally a long structured prose dump because the user needs to see *all* parameters at once, not just a 4-option subset.

### Mental model

`AskUserQuestion` is for *forks in the road*. Plain prose pauses are for *open-ended review*. Both are confirmation gates; they're just different shapes.
