---
name: Seedance --reference-audio for voice continuity — never TTS+lipsync chain
description: Seedance 2.5 accepts up to 3 `--reference-audio` clips (mp3/wav, keep each 2-15s, ≤15MB) as a reference for the voice character it generates. Only needed when a video has more than one segment — a ≤30s Seedance 2.5 video is one segment and has one voice by construction. For multi-segment videos, extract segment 1's native audio and pass it as `--reference-audio` to subsequent segments. Do NOT orchestrate any TTS + voice-clone + lipsync pipeline for this — it's the wrong tool, costs ~2x more, and lipsync `sync_mode=cut_off` shrinks segments unpredictably.
---

When a multi-segment UGC video needs **voice continuity** across segments (so all speakers sound like one person), use Seedance's native `--reference-audio` parameter (`audio_urls` on the wire) — not a TTS+lipsync chain.

On Seedance 2.5 this only comes up above 30s of speech, or when the arc needs a cut per beat (angle-cut, state change). A single ≤30s segment needs no continuity step at all — see `script-and-duration.md`.

## The right way

1. **Segment 1**: standard Seedance 2.5 (`--model seedance-2.5`) with native audio. Script in prompt as quoted speech, `--generate-audio` on (default). This establishes "the voice".

2. **Audio extraction**:
   ```bash
   ffmpeg -y -i seg1.mp4 -vn -t 15 -acodec libmp3lame -q:a 2 seg1-audio.mp3
   ```
   `-t 15` keeps the clip inside the 2-15s reference window when Seg 1 is a 20-30s segment; 10-15s of clean speech is enough to lock the voice. Auto-uploads via CLI `--reference-audio` if local path.

3. **Segments 2..N**: pass the extracted audio as voice reference. Each segment's prompt has its own quoted speech; Seedance generates native audio for that segment but matches the voice character of the reference:
   ```bash
   quickdesign video generate \
     --provider seedance --model seedance-2.5 \
     --reference-image <same-or-different-image> \
     --reference-audio ~/path/to/seg1-audio.mp3 \
     -p "<scene + 'The person says: \"...\"' + no-music + no-subs + 9:16>" \
     --duration 12 --resolution 720p --aspect-ratio 9:16 \
     --wait -o segN.mp4
   ```

4. **Concat** with `ffmpeg -f concat -safe 0 -i concat.txt -c copy final.mp4` — same codec/resolution/audio params across segments because every segment is a fresh Seedance 2.5 output at the same resolution.

## Why NOT TTS + lipsync

A typical wrong-pipeline run:
- Seg 1: native Seedance (correct)
- Then orchestrated: extract audio → voice-clone → TTS for segs 2/3 → 2 silent Seedance renders → 2 lipsync → concat

Problems:
- Result lengths drift (35s instead of target 45s) because lipsync's `sync_mode=cut_off` truncates the silent video to TTS audio length.
- Cost: ~2x the right way (clone + TTS + lipsync = ~330 wasted credits per video).
- Wall-time: ~12-15 min vs ~6-8 min for the audio_urls approach.
- Multi-step orchestration risk: each step (clone → TTS → silent gen → lipsync) is a separate API call; one transient failure stalls the whole pipeline. `audio_urls` is one parameter on one API call.

## How to apply

- Whenever the user says "voice continuity" / "same voice" / "use this audio as reference" → think `--reference-audio`, not TTS.
- Plan template for multi-segment UGC:
  > "Voice-locked multi-segment: Seg 1 native audio → extract → pass to Segs 2..N as `--reference-audio` (Seedance 2.5 native voice matching). Cost ≈ N× Seedance 2.5 segments (no extra orchestration)."
- Reserve TTS + voice-clone + lipsync for cases where the user explicitly wants a SCRIPTED voice (e.g. dub a custom voice over Seedance video), not for character voice continuity.
- Constraints: `--reference-audio` repeatable, max 3 audio refs per call on `seedance-2.5` (the registry lists 1 for the `seedance-2.0-r2v` fallback), mp3/wav, keep each 2-15s, ≤15MB.
- Flux 3, Gemini Omni and the CLI's Kling path have no audio-reference primitive — multi-segment work on them can't lock the voice. (Sora 2 is retired.)

## What `audio_urls` does and does not do

- **Does**: lock the voice character (timbre, pacing, accent feel) across segments.
- **Does not**: dictate WHAT is said in each segment. Each segment's prompt determines the words via quoted speech.
- **Does not**: replace the need for `--generate-audio` to be on. The reference is a character anchor; the segment still generates its own dialogue audio.
