---
name: Connecting QuickDesign to claude.ai via MCP — when the user is on the web, not in a terminal
description: QuickDesign exposes a Remote HTTP MCP server at app.quickdesign.io/api/mcp. claude.ai users add it once via Settings → Connectors → "Add custom connector"; the OAuth 2.1 flow walks them through QuickDesign login + consent. After connect, every chat can call quickdesign_* tools without the CLI installed. This doc tells the agent both how to guide a user through that connect flow AND how to recognize when an MCP-driven path is the right answer (vs. the CLI path) for whatever the user is asking.
---

# Connecting QuickDesign to claude.ai via MCP

QuickDesign ships two paths into the same backend:

- **CLI path** — `quickdesign` binary on the user's machine. Works in Claude Code, Claude Desktop, terminals, scripts.
- **MCP path** — Remote HTTP MCP server at `https://app.quickdesign.io/api/mcp`. Works in claude.ai (web), Claude Desktop's connector UI, and any other MCP-aware client. No local binary required.

Both paths surface (mostly) the same tools and hit the same BFF, with the same identity and the same credit pool. The user doesn't have to pick one; they can connect both.

## When the agent should suggest the MCP path

If the user mentions any of the following, the MCP path is likely the right pointer:

- "I'm using claude.ai" / "from the web" / "in the browser"
- "I don't want to install anything" / "I'm not on my dev machine"
- "Can I do this from ChatGPT?" — MCP works there too (most MCP-aware clients support OAuth)
- "I'm in Claude Desktop and don't want to mess with config files" — Desktop's GUI connector works with the same OAuth flow
- The user is asking about brand research / cost lookup / generation but isn't running a terminal

When the user is clearly in Claude Code with the CLI installed, the CLI path is faster and richer (local-file auto-upload, ffmpeg for multi-segment stitching). Don't push MCP on Claude Code users.

## How a user connects claude.ai

This is the canonical flow. The agent should be able to walk a user through it from a fresh state:

1. Open https://claude.ai → click your profile (bottom left) → **Settings** → **Connectors**.
2. Click **Add custom connector**.
3. Paste the URL: `https://app.quickdesign.io/api/mcp`
4. Leave authentication as **OAuth** (default) — the connector auto-discovers our auth via the `/.well-known/oauth-authorization-server` endpoint we serve.
5. Click **Add**. claude.ai opens a popup to `my.quickdesign.io/mcp/authorize` showing the OAuth consent screen.
6. If not already logged in, the user logs in to QuickDesign with their normal email/password (or magic link).
7. Consent screen lists the requested scopes ("Search Spy Brands library, view ads, look up models / costs, list your designs") and asks Allow / Deny.
8. After **Allow**, claude.ai gets a token in the background and the connector goes green.
9. From any new chat, `quickdesign_*` tools are now available.

If anything fails mid-flow, the user should:
- Try once in an Incognito/private window — third-party cookies are sometimes blocked by browser extensions.
- Clear claude.ai's connector entry and re-add it (a stale token from a half-finished setup can stick around).

## What tools are available via MCP

The MCP server exposes the full generation surface now, not just read tools (checked against the BFF tool registry, 2026-10-16):

| Group | MCP tools | Cost |
|---|---|---|
| Spy Brands | `quickdesign_spy_search_brands`, `_spy_get_brand`, `_spy_get_brand_ads`, `_spy_best_ads`, `_spy_trending_ads`, `_spy_add_brand` | 0 |
| Models / cost | `quickdesign_models`, `quickdesign_calculate_cost` | 0 |
| Designs / templates | `quickdesign_design_list`, `quickdesign_template_list`, `quickdesign_template_filters` | 0 |
| Collections / tags | `quickdesign_collection_list`, `_collection_items`, `_collection_add` (`new_collection_name` creates the collection, or reuses the caller's own one of that name), `quickdesign_tag_list`, `_tag_apply`, `_tag_update`, `_tag_delete` | 0 |
| Uploads / product pages | `quickdesign_image_upload` (picker for chat attachments), `quickdesign_product_page_images` | 0 |
| Brand DNA | `quickdesign_brand_scrape` | 0 |
| Image generation | `quickdesign_image_generate`, `_image_status`, `_image_result`, `_image_history` | paid |
| Video generation | `quickdesign_video_generate`, `_video_status`, `_video_history`, `_video_subtitle`, `_video_upscale`, `quickdesign_replicate_video`, `quickdesign_url_to_video` | paid |
| Audio and video editing | see the next section | mixed |
| Ad Creator | `quickdesign_ad_creator_concepts`, `_ad_creator_generate`, `_ad_creator_advantage_plus`, `_ad_creator_status` | paid |
| Flows | `quickdesign_flow_list`, `_flow_get`, `_flow_generate`, `_flow_edit`, `_flow_duplicate`, `_flow_delete` | paid when a flow runs |
| Deploy Meta | `quickdesign_meta_accounts`, `_meta_publish`, `_meta_publish_status`, `_meta_campaigns`, `_meta_campaign_status`, `_meta_insights`, `_meta_report`, `_meta_radar`, `_meta_settings`, `_meta_comments`, `_meta_comments_sync`, `_meta_comment_action`, `_meta_comment_draft` | 0 credits (activating a campaign spends ad budget — see `./deploy-meta.md`) |
| Social planner (organic FB/IG posts) | `quickdesign_social_profiles`, `_social_posts`, `_social_post_validate`, `_social_post_create`, `_social_post_update`, `_social_post_cancel`, `_social_post_publish_now`, `_social_target_action`, `_social_instagram_feed`, `_social_caption` | 0 credits (listed only while the planner is enabled for the account; Ultra / Pro Max / Team; publish_now posts publicly at once — see `./social-planner.md`) |

Every skill rule applies on the MCP path exactly as on the CLI: plan summary + reference-edit gates (`./confirmation-rules.md`), `@Image1` labels, the no-music / no-subtitles lines.

### Audio and video editing (MCP only — no CLI command yet)

These tools take QuickDesign-hosted media (a `design_id` or a library URL) and save their result as a new design. In Claude Code, the CLI has no equivalent: tell the user it is an MCP tool, or do the ffmpeg step locally when that is enough.

| Tool | What it does | Cost |
|---|---|---|
| `quickdesign_video_watch`, `_video_frame`, `_video_transcribe`, `quickdesign_audio_extract` | Look at frames with timestamps, grab one frame, word-level transcript, pull the sound track out as MP3 | 0 |
| `quickdesign_video_trim`, `quickdesign_video_edit` | Cut one range; or cut / reorder / join clips and stills, speed, reformat (9:16 / 4:5 / 1:1 / 16:9), text, and audio tracks with roles (`voice`, `music`, `sfx`) | trim 0; edit 4 cr per started second of the result |
| `quickdesign_voice_list`, `quickdesign_speech_generate`, `quickdesign_video_voiceover` | Voices by family (ElevenLabs stock voices, MiniMax stock + the user's cloned voices); text → speech; re-voice a video in one step | ElevenLabs v4 5 cr, v3 6 cr, MiniMax 6 cr per 1000 characters |
| `quickdesign_audio_isolate` | Speech alone, without music / noise (ElevenLabs), ≤ 300 s | 0 |
| `quickdesign_sfx_generate` | Sound effect from a description, 0.5–22 s, `loop` for ambience | 0 |
| `quickdesign_music_generate`, `_music_status` | 2 music tracks, 10–360 s | fixed per generation (15 cr on the default model) |
| `quickdesign_video_lipsync` | Re-sync the speaker's mouth to new speech (sync-lipsync v3), ≤ 120 s | 10 cr per second of the shorter input (min 10) |
| `quickdesign_video_translate` | Dub into another language in the speaker's OWN cloned voice, lips synced (transcribe → clone → translate → speech → lip-sync), 10–300 s, 30 languages | ≈ 152 cr + 15 cr/s + 15 cr per 1000 translated characters (estimated from the length); charged on completion |

Pick by intent: the same person in another language → `video_translate`; new words or a stock voice → `video_voiceover` (then `video_lipsync` if the face is on screen); clean a noisy voice → `audio_isolate`. Speech with an ElevenLabs voice uses the registry's latest ElevenLabs model unless `model` is passed.

### Model defaults on MCP — follow the registry's `isLatest`

A tool called without `model` runs the model its category flags `isLatest` in `quickdesign_models` (as of 2026-10-16: video `seedance-2.5`, image `nano-banana-2-1`, music `suno-v6`, speech `elevenlabs-tts-v4`); without a flag it keeps its old default. Still pass the model when the skill names one:

- `quickdesign_video_generate`: pass `model: "seedance-2.5"` (`../models/seedance-2.5.md`). A legacy `provider` without `model` still picks that provider's old default.
- `quickdesign_image_generate`: the model-less default is `nano-banana-2-1`, but the skill's edit default is Sunburst, so pass `model: "gpt-image-2-5-sunburst-i2i"` plus `reference_image_urls` (`../models/gpt-image-2-5-sunburst-i2i.md`). Use `nano-banana-2-1` for 4:5 deliverables and prompt-only images.
- MCP routes any active registry slug (`flux-3-t2v` / `flux-3-i2v`, `gemini-omni-video`, `kling-*`) and rejects inputs the model can't take before any credits are spent. Prompt-only Seedance 2.5 works on MCP (it's routed to the right endpoint), and on CLI ≥ 0.11.0.
- Sora 2 is retired (2026-09-23): `sora2-*` slugs come back as an unknown model. Use Seedance 2.5 instead; Flux 3 only if the user asks for it.

## What still needs the CLI

MCP tools take URLs, not local file paths, and there's no local shell behind them. So:

- **Local files** — the CLI auto-uploads local paths; on MCP the user has to supply public URLs (or use designs already in their QuickDesign library).
- **ffmpeg steps** — extracting Seg 1's audio for `--reference-audio` voice continuity and concatenating segments happen on the user's machine. Multi-segment videos (scripts over Seedance 2.5's 30s cap) are therefore CLI territory; a single-segment video up to 30s works end-to-end on MCP.

If a claude.ai user asks for a multi-segment video, confirm what they want, render what fits in one segment via MCP, and offer the CLI (`npm install -g @quickdesign/cli` + `quickdesign init`) or a Claude Code session for the full stitched version.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Connector failed to authorize" | Browser blocked the popup or third-party cookies | Allow popups for claude.ai; try an Incognito window |
| Tools missing after connect | Stale connector cache | Remove + re-add the connector |
| `401 invalid_token` mid-chat | Refresh-token rotation hit a race; claude.ai will auto-refresh next call | Retry the same prompt |
| `403 forbidden` on a tool | Tool requires a paid plan or specific scope | User's account doesn't have the entitlement; same as in the CLI |
| Connector never appears | Custom-connector feature is plan-gated on claude.ai (Pro/Max/Team) | Free-tier users should use the CLI path |

## Privacy / scope notes

Tokens issued via this OAuth flow are scoped to `aud: 'mcp'`, distinct from the user's regular CLI / web JWTs. The user can revoke them anytime from QuickDesign account settings or by removing the connector in claude.ai. Tokens are stored hashed-at-rest server-side; the plaintext lives only in claude.ai's secure storage.

## How this doc fits with the rest of the skill

- The CLI / Claude Code surface is the canonical path for power users — every existing skill rule applies as written.
- This MCP path covers generation too, but without local files or ffmpeg — see "What still needs the CLI" above.
- When the agent is unsure which path the user is on, ask: *"Are you running this in Claude Code (with the CLI installed) or in claude.ai (web)?"* The answer determines which surface the agent calls into.
