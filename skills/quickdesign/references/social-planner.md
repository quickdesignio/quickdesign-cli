---
name: Social planner — schedule organic Facebook Page + Instagram posts
description: `quickdesign social …` plans organic posts (not ads) on the user's Facebook Page and Instagram account. It lists profiles, schedules or drafts posts from library designs / URLs / local files, edits them with a precondition, cancels, publishes now (guarded) and handles failures. Read before any `social` command.
---

# Social planner (`quickdesign social`)

Organic posts on the user's own Facebook Page and Instagram professional account: the in-app planner at app.quickdesign.io/social/planner. Not ads (that is `meta`, see `deploy-meta.md`).

## Prerequisites (all in the app)

- Meta connected, and the Page (with its Instagram account) turned on in the planner.
- An Ultra, Pro Max or Team plan (`social_plan` otherwise: the user upgrades). During the rollout only enabled accounts can use it (`social_disabled` otherwise).
- Until Meta approves QuickDesign's publishing permissions, only accounts with a role on the QuickDesign Meta app can publish. Other accounts' posts fail with a permission error. Say so if a publish fails with `permission`.

## Rules

1. **Start with `quickdesign social profiles`.**
   - Use its `page_id` and `timezone`.
   - A profile with `publish_ready: false` cannot post:
     - `reconnect_required`: the user reconnects Meta in the app;
     - `not_enabled`: the user turns it on in the planner;
     - `missing_permission`: the user grants the publishing permission (reconnect).
2. **Time is the Page's time.**
   - Prefer `--date YYYY-MM-DD --time HH:mm`, which is read in the Page's time zone, for `create` and `edit` alike. `--at` must carry an offset.
   - Tell the user the result's `scheduled_local` and `timezone`, plus UTC if they are in another zone.
   - `timezone_invalid`: the Page's time zone is broken; the user fixes it in the planner settings.
3. **Confirm before creating:** the Page, platforms, media, caption and time. `create` never publishes on its own right away, but a time within the next minute or two publishes at the next worker run.
4. **One `--client-request-id` per intended post.**
   - It must be a UUID. The CLI prints the id it used in the JSON output, and in the error when a result is unknown.
   - If a create times out or fails with an unknown result, re-run the SAME command with that `--client-request-id`. A fresh id could post twice.
   - A different post under a used id fails with `idempotency_conflict`.
5. **Edits need `--expected-updated-at`.**
   - Take it from `social get <id>` (the `updated_at` field, verbatim).
   - On `stale_post`, read the post again, tell the user what changed, then retry.
   - Only the flags you pass change; `--media` replaces all media.
   - The type stays unless `--type` is passed: pass `--type` when `--media` changes the kind (e.g. 1 image → 3 items = `carousel`).
   - A canceled post cannot be edited or published (`post_canceled`): create a new one.
6. **`publish-now` only on an explicit request for that post** ("publish it now"). It goes live at once and cannot be undone from QuickDesign. It prompts on a TTY; without a TTY it refuses unless `--yes`. Pass `--yes` only after the user said yes in this conversation.
7. **Failures:** `social posts --attention` lists them.
   - `failed`: fix the post with `edit` (only when no other platform of the post is already live), or run `social retry <target-id>`. A retry publishes that platform right away, so ask the user first and pass `--yes` only after they agreed.
   - `needs_attention`: the post MAY ALREADY BE LIVE.
     - Never retry it from the CLI (it refuses with `resolve_in_app`), and never say it was not published.
     - Ask the user to check the profile (`social feed <profile-id>` shows an Instagram account's last 30 posts). If it is live, run `social mark-published <target-id>`; otherwise they retry it in the app.
8. **Published posts are final:** QuickDesign cannot edit or delete them.

## Media

- `--media design:<id>`: a library design (`quickdesign design list`). Video designs post their video.
- `--media https://…`: a QuickDesign upload URL (ext.quickdesign.io / library.quickdesign.io).
- `--media ./file.jpg`: a local file, uploaded first.
- 1–10 items, in order.
- The type is inferred: one video is a reel, two or more items a carousel, one image an image. Pass `--type story` for a story.
- Use `--validate-only` when unsure; it checks aspect ratio, length and caption limits.

## Flow

```bash
quickdesign social profiles --human
quickdesign design list --limit 10
quickdesign social create --page 1234567890 --to fb,ig --media design:4521 \
  --caption "New drop" --ig-caption "New drop #silver" --date 2026-10-10 --time 19:00 --validate-only --human
quickdesign social create --page 1234567890 --to fb,ig --media design:4521 \
  --caption "New drop" --ig-caption "New drop #silver" --date 2026-10-10 --time 19:00 --human
quickdesign social posts --page 1234567890 --human
quickdesign social get <post-id>            # updated_at for edits
quickdesign social edit <post-id> --expected-updated-at <updated_at> --date 2026-10-10 --time 20:00
quickdesign social cancel <post-id>
quickdesign social publish-now <post-id>    # only on an explicit request; prompts on a TTY, else needs --yes
quickdesign social caption --write --image ./photo.jpg --page 1234567890 --platform ig --human
```
