# URL to Video

Turn a product or landing page into an original video ad. The page is analysed for free
(name, description, benefits, photos); Claude writes a shot-by-shot ad and a script in the
chosen language; a reference-to-video model (default Seedance 2.5) renders it with the product
photos as references and a generated voiceover. There is no reference video: for "copy this
ad with my product" use `references/replicate-video.md`.

## Inputs
- `<url>` — the product or landing page.
- `--image <url|path>` — 1–3 product photos (repeatable). Default: the best photos on the page.
- `--benefit <text>` — up to 5 benefits (repeatable); they replace the ones found on the page.
- `--model <slug>` (default seedance-2.5) — any `reference_to_video` model from `quickdesign video models`.
- `--duration`, `--ratio`, `--resolution` — must be values the model lists (defaults 15 s, 9:16, 720p).
- `--language tr|en` (default en), `--brand-kit <uuid>` (its logo closes the video), `--offer`, `--cta`, `--direction`.

## Cost (confirm before running — cardinal rule 5)
The model's per-second price × duration at the resolution, + 10 credits.
Estimate: `quickdesign cost seedance-2.5 -d 15 -r 720p` and add 10.
The exact amount is returned as `cost`; a failed job is refunded in full. A page without
product photos stops before anything is charged.

## Run
```bash
quickdesign video from-url https://shop.example/products/snake-chain \
  --brand-kit <uuid> --language tr -o ./ad.mp4
```

Without `--wait`/`-o` it prints `request_id`; resume with `quickdesign video wait seedance <request_id> -o out.mp4`.
Preparation takes about a minute before generation starts; total is usually 3–5 min.

## Same flow elsewhere
MCP `quickdesign_url_to_video` · REST `POST /api/v1/videos/from-url` · the app's URL to Video.
