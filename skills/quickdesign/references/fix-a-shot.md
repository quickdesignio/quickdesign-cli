---
name: Fix a bad shot inside an existing video — regenerate that shot on Seedance 2.5, splice it back
description: When one or two shots of a finished video hallucinate (a person appears twice, someone vanishes, the product changes, a face drifts), don't re-render the whole video and don't hand it to a video-to-video edit model. Cut out only the bad shot, regenerate it on the default Seedance model with every person as a reference image and their positions spelled out, then splice it back into the original at the exact frames.
---

The user wants the rest of the video untouched. So the unit of work is **the shot**, not the video, and the model is the default one (`seedance-2.5`, cardinal rule #0).

**Don't use a video-to-video edit model for this** (`kling-o1-edit`, Gemini Omni v2v). They re-render the whole clip from a prompt like "remove the extra woman", and in practice they remove or replace the wrong people too. On 2026-10-14 O1 Edit was asked to remove one duplicated woman from a 3-person pile; it removed both women in one clip and the woman plus the tactical man in the other.

## 1. Find the bad shot's exact frames

```bash
ffprobe -v error -count_frames -select_streams v -show_entries stream=nb_read_frames,r_frame_rate,width,height -of compact in.mp4
ffmpeg -hide_banner -i in.mp4 -vf "select='gt(scene,0.2)',showinfo" -an -f null - 2>&1 | grep -o 'pts_time:[0-9.]*'   # shot cuts
```

Turn the cut times into frame numbers (`time × fps`) and look at the frames on both sides of each cut (`select=eq(n\,N)`) to confirm where the shot starts and ends. Watch the whole shot at 2 fps and say exactly when the defect starts ("from 15.5 s a second woman lies next to her").

## 2. Build clean references — one per person, plus the opening composition

- **Opening composition (`@Image1`)**: the shot's first frame if it is still clean. If the defect is already in it, remove it with an image edit (`gpt-image-2-5-sunburst-i2i`, edit-style prompt: "Edit @Image1: remove only …; keep every other pixel unchanged"). **Show the edit to the user and wait for approval** before it goes into Seedance (`confirmation-rules.md`).
- **Each person (`@Image2…`)**: crop a frame from another shot of the same video where that person is clear and alone (face plus the clothes that identify them). Prefer the identity the neighbouring shots show, so the fixed shot matches what comes before and after.
- The product, if it is in the shot (a crop, or the product photo the user has).

Stay within the registry's `maxReferenceImages` (`quickdesign video models`).

## 3. Prompt: who is there, where they are, what they do

- Head count, stated outright: "Exactly three people in the scene, nobody else … Only one woman."
- One line per person with their label and **position** in the frame ("the tactical man on the left by the window, the woman in the middle, the man in the white shirt on the right").
- The action of the original shot, with timing if it matters ("within about two seconds they collapse onto the floor, then lie still").
- Camera: "same camera position as @Image1; the camera does not move" (rule #10).
- Quoted dialogue if the shot has speech. For the same voice, pass the original shot's audio as `--reference-audio` (`ffmpeg -ss <start> -to <end> -i in.mp4 -vn -acodec libmp3lame -q:a 2 shot.mp3`).
- `No music score. No subtitles or on-screen text.`

Generate at least as long as the shot (2.5's shortest is 5 s), at the original aspect ratio, 720p. Put the plan (shots, durations, cost) in front of the user before spending credits.

## 4. Splice it back

- Normalise the new clip to the original's size and fps (`scale=W:H,setsar=1,fps=N`) and trim it to the frames you need.
- Join with `trim`/`concat` in one `filter_complex`, re-encoding once (`libx264 -crf 16`).
- **Audio**: a shot without speech can keep the original audio for its range, so the cut is invisible. A shot with new speech must take the new clip's audio, or the lips won't match. If the new shot is longer than the old one, take each segment's audio with its own video so nothing after it drifts.

## 5. Check before you hand it over

Pull frames from every replaced shot plus both sides of each splice, then count the people and compare faces. Report what you checked, and anything that is still off (for example a face that drifts in a shot you didn't regenerate).
