# Editing the user's open video editor (`quickdesign editor`)

Needs CLI >= 0.23.0 (`quickdesign --version`). The user must have the **video editor open in QuickDesign**, signed in as the same account. Edits appear live in their editor. If a command says live editing isn't available on this server, the server has it switched off: tell the user, do not retry.

## Workflow: status, tools, call

1. `quickdesign editor status` lists the open tabs. If none is open it prints a hint and exits 1: ask the user to open the video editor, then run it again. With several tabs pass `--tab <tabId>` on every later command (default: the most recently focused).
2. `quickdesign editor tools` lists the editing tools (one line each). `--json` adds the input schemas. Read the schema before calling a tool you have not used.
3. `quickdesign editor call <tool> '<json args>'` runs one tool. Start with `get_editor_state` to learn track ids, clip ids and the timeline. Long args: `--args-file ranges.json` (or `-` for stdin). Invalid JSON or a non-object exits 2.

A failed tool prints its message to stderr and exits 1. Read the message and correct the call; do not guess.

## Look before you cut

- `view_frames` renders up to 16 frames of the committed timeline into one labelled contact-sheet image. The CLI writes it to a file and prints `image saved: <path>`: **Read that file** to see it. Give `times` (timeline seconds), or `fromSec` / `toSec` / `count` to sample a range; call again with a narrow range to look closer. `--out <path>` chooses the file name. `inspect_preview` does the same for the current playhead frame.
- `detect_silence` (per clip) returns silent regions in **timeline seconds**, already padded 0.1 s, ready for `cut_ranges`. `thresholdDb` (-70..-10, default -40) and `minSilenceSec` (0.1..10, default 0.5) tune it. It answers `available:false` with a reason when the clip has no sound.
- `transcribe_clip` returns a word-level transcript with each word's start and end in **timeline seconds**, to find filler words, retakes and pauses. It can take up to 3 minutes (the CLI waits 200 s); at most 1200 words per answer, so when it is truncated call again with `fromSec = nextFromSec`. Free for the user with a daily limit (30 minutes a day by default): on `available:false` carry on without it. A clip that uses more than 10 minutes of source audio answers `available:false` with reason `too_long`: split the clip and transcribe the parts.

Edits made in a turn are not visible to `view_frames` until they commit, so view again after a cut.

## Remove everything in ONE `cut_ranges` call

`cut_ranges` removes time ranges (timeline seconds) from the whole timeline and closes the gaps, in one undoable edit. Sound, captions and titles stay in sync; transitions the cut runs through are removed too (listed in the result); plain clips are split at the range edges and text, shapes, stickers and subtitles are shortened.

- Give **every** range in a single call (max 50). They are clamped, sorted and merged, and `detect_silence` regions can be passed as they are. Several calls shift the timeline under you: later ranges then point at the wrong place.
- `keepTrackIds` lists tracks that keep playing unchanged through the cut, such as background music: they are not cut, only trimmed to the new end.
- Shape: `{"ranges":[{"startSec":3.2,"endSec":4.1},{"startSec":10,"endSec":11.5}],"keepTrackIds":["<music track id>"]}`.

## Undo, locks, and what a refusal means

- **Each live call is one undo step** in the user's editor (Ctrl/Cmd+Z). Mention it after a big edit.
- **Locked tracks are never changed.** A refused `cut_ranges` (locked track with content inside or after a range, or a range edge inside a reversed, speed-ramped, freeze-frame, compound, multicam, motion or adjustment item) **changed nothing** and returns an error with a `code` (`CUT_TRACK_LOCKED`, `CUT_UNSPLITTABLE`, …) and the offending item. You cannot unlock tracks: ask the user to unlock the track, or fix the ranges / `keepTrackIds`, then call again. Live calls never return `retryOf` (only the editor's own chat loop adds it): ignore the `retryOf` wording in the tool descriptions. The same applies to `add_transition`.
- A call that timed out or lost the tab may still have landed: check `get_editor_state` before repeating it.

## Other tools worth knowing

- `get_transition_options` then `add_transition`: list adjacent clip pairs on unlocked tracks (with `cutTime`, `maxDuration`), then add a transition between a pair using the returned `clipAId` / `clipBId`. Gaps, overlaps and cross-track pairs are rejected.
- `list_media`, `add_track`, `add_clip`, `split_clip`: library assets are not timeline clips. `add_clip` (mediaId from `list_media`, trackId from `list_tracks` / `add_track`, `startTime` in timeline seconds) puts one on the timeline.
- `list_text_clips`, `set_text_timing`: text overlays and their timing.
- `add_video_effect` / `update_video_effect`, `apply_edit_preset`, `open_export` (opens the user's local export dialog; they choose and start it).

Run `quickdesign editor tools --json` for the authoritative list: it is the open tab's own.

## Bring a design in, save the result

- `quickdesign editor add-media <design-id>` imports a QuickDesign design's video, audio or image into the media bin and prints its `mediaId`. It is not on the timeline yet: `add_clip` places it.
- `quickdesign editor save [--title "…"] [--collection <id>]` renders the project and saves it to the user's library. It returns at once with a `saveId`; run `quickdesign editor status` later to see when it is saved. Do not save twice.

## Rules

- **Never ask the user for time ranges you can find with the tools.** Use `view_frames`, `detect_silence` and `transcribe_clip`, then cut.
- Look first, change second, look again. Prefer one precise call over several small ones.
- Ask before destructive structural changes the user did not request (deleting tracks, replacing media).
- Never print or pass the CLI's token; the commands authenticate themselves.
