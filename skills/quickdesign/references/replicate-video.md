# Replicate Video (v2)

Re-create a reference video ad with the user's product: Claude reads the product photos,
Gemini watches the reference and writes a scene-by-scene Seedance 2.5 prompt (same scenes,
camera, lighting and rhythm — the original actor, product and logo are replaced), then
Seedance 2.5 renders it with a new voiceover. The reference video is analysed only.

## Inputs
- `--video <url|path>` — the reference ad (≤200 MB; up to 30 s is re-created).
- `--product <url|path>` — 1–3 product photos (repeatable).
- `--model-image <url|path>` — optional person to cast; without it a new person unlike the original actor is generated.
- `--brand-kit <uuid>` — optional; its logo replaces the reference logo, name/offer/voice steer the script. Always pass the user's kit when they have one.
- `--notes "<text>"` — optional, ≤500 characters: the user's own facts about the product (what it is, material, how it is worn or used, what to stress). Pass it when the user describes their product or a must-have; it steers the product brief and the script, never the swaps, environment or timing. Don't invent notes for the user.
- `--language tr|en` (default en) — voiceover and on-screen text.
- `--resolution 720p|1080p` (default 720p).

## Cost (confirm before running — cardinal rule 5)
Seedance 2.5 per-second price × the reference length clamped to 5–30 s, at the chosen resolution, + 10 credits.
Estimate: `quickdesign cost seedance-2.5 -d <reference seconds> -r 720p` and add 10.
The exact amount is returned as `cost`; a failed job is refunded in full.

## Run
```bash
quickdesign video replicate --video ./ref.mp4 --product ./p1.jpg --product ./p2.jpg \
  --brand-kit <uuid> --notes "925 sterling silver adjustable ring; show it on the index finger; handmade" \
  --language tr -o ./replicated.mp4
```

Without `--wait`/`-o` it prints `request_id`; resume with `quickdesign video wait seedance <request_id> -o out.mp4`.
Preparation takes 1–3 min before generation starts; total is usually 3–6 min.

## Same flow elsewhere
MCP `quickdesign_replicate_video` · REST `POST /api/v1/videos/replicate` · the app's /replicate-video page and video-template drop.
