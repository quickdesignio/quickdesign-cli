---
name: Two confirmation gates — plan summary BEFORE generation, reference edit BEFORE Seedance
description: Two pause points are mandatory in any paid generation pipeline. (1) Emit a plan summary BEFORE any generation and wait for user "go". (2) When the pipeline includes a reference-edit step (image edit — default `gpt-image-2-5-sunburst-i2i`) that feeds into Seedance, generate the edit, show it to the user, wait for visual approval, THEN run Seedance. Reference edits are ~12-24cr; a Seedance 2.5 segment is ~336-840cr — a wrong reference auto-chained to Seedance burns ~20-45× the cost.
---

Two pause points are mandatory in any paid generation pipeline. Skipping either burns user credit and trust.

## Gate 1: Plan summary before any generation

After resolving inputs (uploads, prompt, model selection), emit a plan summary in this format:

```
PLAN SUMMARY
============
Type:        Multi-segment UGC video (2 segments + voice continuity)
Model:       Seedance 2.5 (720p) + gpt-image-2-5-sunburst-i2i (per-segment edits)
References:  ~/path/to/source.png (1 source image)
Style:       Single-ref talking-head (Style A)
Script:      95 words → ~40s total → 2 segments (Seedance 2.5 caps at 30s/segment)

Seg 1: 48 words / 20s — wide opener
Seg 2: 47 words / 20s — close reveal (reuse source ref, no edit)

Voice continuity: --reference-audio from Seg 1 mp3 → Seg 2

Estimated cost:
  Seg 1 Seedance 2.5 (20s, 720p):  560 cr
  Seg 2 Seedance 2.5 (20s, 720p):  560 cr
  Total Seedance:                  1120 cr

OK to proceed, or want to adjust duration / resolution / audio / aspect?
```

Wait for "yes / proceed / go" or a tweak. Don't infer consent from silence.

**Skip the explicit-wait ONLY when** the user wrote `--yes`, `proceed`, `auto`, `--no-confirm`, or similar in the original request — OR Claude Code is running in auto mode (see below).

### Auto mode — gate STILL fires, just doesn't block

Claude Code's auto mode says "minimize interruptions, prefer action over planning". Auto mode optimizes for **low-cost reversible work** (file edits, research, planning); it does NOT bypass paid-generation gates. The skill takes precedence on cost-bearing actions.

In auto mode, Gate 1 compresses to:
1. **Emit the full plan summary as text** (same format as above) — BEFORE the bash call, not after
2. **Then immediately invoke the bash generation** in the same turn
3. The user reads the plan while the job runs (~1-3min for a Seedance segment) and can interrupt by killing the background task if the plan was wrong

What auto mode does NOT permit:
- ❌ Surfacing the plan AFTER the bash call has already started (user can't intervene before the spend)
- ❌ Skipping the plan entirely because "the brief was clear enough"
- ❌ Compressing the script (rule #8 — UGC without script is a guaranteed regression). If the user didn't supply quoted speech, draft one and put it in the plan summary so the user can read+correct it during the generation window.

In normal (non-auto) mode, Gate 1 stays as written — emit plan, wait for "go", then proceed.

**Why this matters:** Generation costs tokens and time. Once started, the user can't easily change duration / resolution / audio-on-off mid-flight. Even when the briefer hands over full parameters, the confirmation pass catches generic settings (duration, resolution, audio on/off, aspect ratio) the user is most likely to want to override. Auto mode trades the explicit "go" wait for keeping the plan visible-but-fast — it does NOT trade the plan itself.

## Gate 2: Reference-edit image before Seedance

When the pipeline includes a reference-edit step (image edit) that feeds into Seedance:

1. Generate the reference edit
2. **STOP**. Display the result to the user with a short caption ("Reference for Seg N — does this match what you want?")
3. Wait for explicit user response
4. Only then proceed to Seedance

This is NOT optional. Skip ONLY when:
- The user has *just* (in the same turn) seen a generated reference and said "yapalım" / "go"
- The user has explicitly told the agent in this session "auto-proceed without showing me references"

## Why the reference-edit gate matters

Reference edit (Sunburst): ~12-24cr (cheap, fast — 30-60s). Seedance 2.5 segment: ~336-840cr (expensive, slow — 3-5min).

**The cost asymmetry means a wrong reference that's caught early costs ~18cr; a wrong reference that goes through Seedance costs ~20-45× more.** The 30-second pause for visual approval is cheap insurance.

Real example from production: a mom-selfie hook segment was edited as third-person framing (mom holding phone, viewer outside watching her). User wanted the actual selfie POV (camera = phone, mom looking directly at viewer). Auto-chaining the edit → Seedance burned ~360cr on the wrong framing because no approval gate stopped the chain.

## How to apply

- **Hallucination self-check BEFORE asking the user.** Image-edit models (Sunburst and Nano Banana alike) routinely produce anatomical glitches: severed wrists, floating hands, six-fingered grips, double earrings on one ear, mismatched eyes, distorted mouths, props phasing through hands. The agent must mentally inspect the rendered image with the Read tool and verify the obvious anomalies before surfacing it for approval. If anything is clearly broken, **regenerate immediately without asking** (~12-24cr) — only show the user when the agent is reasonably confident the image is clean. Don't waste the user's attention on obviously-broken outputs.

  **Quick checklist (~5s scan):**
  - Hands: 5 fingers each, all visible if not occluded, wrists clearly connected to forearms, fingers curled naturally around any held object, no doubled or floating hands
  - Eyes: matching pair, both pupils intact, no extra eyes, eyebrows symmetric
  - Ears: 2 only, symmetric, jewelry matches if any
  - Mouth: natural shape, lips not distorted, teeth not broken
  - Held / contact objects: natural grip, contact points logical (palm under sole, finger over edge — not phasing through)
  - General: no extra arms, doubled features, floating limbs, surreal artifacts (unless explicitly requested)

  Reference-edit retries are cheap (~18cr at 2K) — the user's attention is not. Use 1-2 silent regens to fix obvious anatomy before paging the user. If the third generation still has issues, surface BOTH problem versions so the user can decide which path to tweak rather than guessing.

  **Tweak strategies that fix common issues without major prompt rewrites:**
  - Severed wrist on a held object → switch to a TWO-HAND pose ("both hands cradling the X"). Image-edit models handle two-hand grips far more reliably than partially-occluded single hands.
  - Floating prop → add explicit contact verbs ("palm wrapped around the heel, fingers gripping the toe").
  - Six fingers / extra hand → add a guard clause: "exactly five fingers per hand, no extra digits, anatomically correct hands and wrists."

- After every reference edit destined for Seedance: pause and surface the image. Write one short caption with what you see in it ("mom standing center, phone in selfie pose, mural behind") so the user can verify it matches their intent without having to re-derive your interpretation.

- **Always include the file path AND/OR the public URL of the rendered image in the approval message.** The user opens it natively (Finder / Preview / browser) — they don't see the inline render the agent saw via the Read tool. Prefer R2 / `library.quickdesign.io` / `ext.quickdesign.io` URLs over provider temp URLs (`tempfile.aiquickdraw.com`, `fal.media`) — they're stable, never expire, and route via the QuickDesign CDN. The CLI's `storage_urls[0]` carries the R2 URL when storage upload has completed; fall back to the provider URL only when it hasn't yet. Both forms when available:
  ```
  Path : /Users/enes/Downloads/funtle-seg1-edit.png
  URL  : https://tempfile.aiquickdraw.com/vnp/220afa84...jpeg
  ```
  Drop the URL line if not yet uploaded; drop the path line if the image only exists remotely. **Never** ask for approval with only a verbal description — the user must be able to physically view the file before saying yes/no/regenerate. This is a hard requirement; the reference-edit gate exists *because* visual mismatches cost ~20-45× downstream.
- If the user said "yapalım" / "go" / "proceed" referring to the **plan**, that does NOT cover the reference image — those words approve the next concrete *action* (generate the edit), not the rendered output.
- For multi-segment pipelines: pause at each segment's reference edit. Don't fire all edits in parallel and then show 3 references at once — generate one, show, approve, render Seedance for that segment, then move to next segment's edit.
- If the reference edit looks good and the user is paying attention (active session), one short turn for approval is fine. If the session is autonomous / wakeup-driven, leave the Seedance launch for next turn after explicit user signal.

## Exception — talking-head UGC with no reference edit

When the segment uses the original source reference (no edit), Gate 2 doesn't apply because there's nothing rendered to approve — the source is what the user already gave us. Only Gate 1 (plan summary) applies.

**But:** "no reference edit" is a real choice that should be surfaced in the plan summary, not assumed. For UGC where the avatar holds / wears / interacts with a product:
- **Reference-edit pre-stage** = the avatar+product composition is rendered as one image first (Sunburst), then fed as a single `@Image1` to Seedance 2.5. Higher cost (~12-24cr extra), but the agent + user both see the composition before paying for the 12s video; lower drift mid-render.
- **Direct multi-ref** = avatar + product passed as separate `--reference-image` flags (Seedance 2.5 takes up to 4), Seedance composes the interaction during generation. Cheaper, but the composition is unseen until the video lands; if Seedance doesn't have the avatar holding the product naturally, the segment is wasted.

Neither is universally "right". For first-time UGC with a new avatar and a new product, reference-edit pre-stage is the safer default; for repeat work where the avatar's identity is known to render cleanly, direct multi-ref is fine. **State which path you're taking in the plan summary** so the user can flip it before generation.

## Cost-asymmetry summary

| Action | Cost | If wrong |
|---|---|---|
| Plan summary (Gate 1 emit) | 0 | Catch wrong duration/resolution before any generation — saves 100% |
| Reference edit (Sunburst 1K/2K/4K) | 12-24cr | Catch wrong framing/composition — saves ~20-45× downstream |
| Seedance 2.5 segment (12-30s @ 720p, or 12s @ 1080p) | 336-840cr | Already burnt, must re-run = 2x the cost of original |

Both gates are cheap insurance against expensive mistakes.

## Use `AskUserQuestion` for structured choice gates

When the gate is a *choice between alternatives* (model, style, aspect ratio, "regenerate vs proceed"), do not pose it as a free-form prose question — call the `AskUserQuestion` tool. The user gets a clickable picker with each option's tradeoff visible at a glance, and the answer comes back in a structured envelope you can route from. Free-form text replies are reserved for open-ended approval ("does this reference edit look right?" → user types yes / no / change X).

**Required convention from the tool itself:** if you have a recommendation, put it **first** and append `(Recommended)` to the option label. The tool docs are explicit about this — agents who skip the suffix lose the affordance that nudges users away from low-quality choices.

Each question:
- 1 short header (≤12 chars, e.g. `Model`, `Style`, `Approve`)
- 1 clear question sentence
- 2-4 options, each with a `description` that names the tradeoff (cost / quality / time / capability)
- `multiSelect: false` for picker gates; `true` only when "select all that apply" actually makes sense (e.g. enabling features)

The UI auto-adds an "Other" option for free-text input — never include it yourself.

### Gate-by-gate canonical patterns

**Model picker** (when more than one model in the registry is viable for the request — see `../pipelines/ugc-video.md#model-picker`):

```
question: "Which video model should I use for the 3 talking-head segments?"
header:   "Model"
options:
  1. label: "Seedance 2.5 (Recommended)"
     description: "Reference labels + --reference-audio voice lock, up to 30s per segment (5/8/10/12/15/20/25/30). ~336cr/12s at 720p. Default for UGC."
  2. label: "Seedance 2.0 R2V"
     description: "Cheaper at 1080p (~300cr/12s), 4K option, up to 9 reference images. 15s cap per segment."
  3. label: "Kling 3 Standard"
     description: "Cheapest path for non-spoken b-roll. 3/5/10/15s, single --image, no reference grammar or voice lock. ~95cr/10s."
```

Sora 2 is retired (2026-09-23) — never offer it. If the user asks for "cinematic single shot" or names Sora, offer Flux 3 (`../models/flux-3.md`) instead.

**Transition style** (when the user hasn't named one):

```
question: "How should the segments cut together?"
header:   "Style"
options:
  1. label: "Single reference (Recommended)"
     description: "Same source image for every segment. Cheapest, default for plain UGC. Seedance produces natural variation."
  2. label: "Angle-cut"
     description: "Reference edit per segment for new angles (cinematic / podcast / 'second angle'). +12-24cr per edit."
  3. label: "Framing progression"
     description: "Wide → medium → close. Reference edit only for the macro middle segment. Use for product reveals."
```

**Reference-edit approval** (Gate 2 — after generating the edit and showing the image):

```
question: "Use this edit as the Seg 2 reference?"
header:   "Approve"
options:
  1. label: "Looks good — proceed (Recommended)"
     description: "Run Seedance 2.5 with this edit. ~336cr (12s, 720p)."
  2. label: "Regenerate with tweaks"
     description: "Tell me what to change in the prompt and I'll re-edit. ~18cr per retry."
  3. label: "Cancel this segment"
     description: "Skip the edit and reuse the original source reference instead. 0 extra cost."
```

**Resolution / cost confirm** (when the briefer didn't specify and the multiplier is ≥2x):

```
question: "Render at which resolution?"
header:   "Resolution"
options:
  1. label: "720p (Recommended)"
     description: "Seedance 2.5 default for UGC reels. ~336cr/12s segment."
  2. label: "1080p"
     description: "Sharper faces on large screens, but 2.5× the cost: ~840cr/12s. (Seedance 2.0 R2V does 1080p for ~300cr if 2.5 isn't required.)"
  3. label: "480p"
     description: "Drafts / previews only. ~156cr/12s."
```

Seedance 2.5 has no 4K and no `auto` resolution — if the user needs a 4K master, either render Seedance 2.0 R2V at 4k or upscale the final concat (`../models/topaz-video-upscale.md`).

### When NOT to use `AskUserQuestion`

- Open-ended approval where the user might want to type custom feedback ("does this edit look right?") — the free-form `Other` field is fine but the actual *content* is more nuanced than 4 buttons. Use a normal prose pause instead.
- Yes/no with no meaningful tradeoff — just ask.
- Mid-flight progress updates ("Seg 2 done, moving to Seg 3") — these are status, not decisions.
- Plan summary itself — Gate 1 is intentionally a long structured prose dump because the user needs to see *all* parameters at once, not just a 4-option subset.

### Mental model

`AskUserQuestion` is for *forks in the road*. Plain prose pauses are for *open-ended review*. Both are confirmation gates; they're just different shapes.
