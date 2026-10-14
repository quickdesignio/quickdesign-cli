---
name: Edit methods — polish a finished video without re-rendering it
description: Frame-accurate fixes for a video that is mostly right — replace a random logo with the brand's own animated card, replace a bad shot without breaking the voiceover, fix a picture-in-picture product inset, swap AI-sounding effects for real recordings, assemble once, check, and save the result as a design. Works on any finished video (Replicate, URL to Video, a user upload).
---

The user wants the rest of the video untouched. Every method below changes a **frame range** and leaves everything outside it byte-for-byte the same: same length, same frame count, the original voice. One re-encode at the end. A bad shot itself is `fix-a-shot.md`; this file is everything around it.

Paid steps keep their gates (`confirmation-rules.md`): put the plan (ranges, models, credits) in front of the user before any generation, and show a reference edit before it goes into a video model. Video regeneration is always the default Seedance (cardinal rule #0): never switch models on your own.

## 0. Map the video once

```bash
ffprobe -v error -count_frames -show_entries stream=codec_type,width,height,r_frame_rate,nb_read_frames,sample_rate -of compact in.mp4
ffmpeg -v error -i in.mp4 -vf "fps=1,scale=180:-1,drawtext=text='%{pts\:hms}':x=4:y=4:fontsize=18:fontcolor=yellow:box=1:boxcolor=black" -frames:v 30 f%02d.png
ffmpeg -v error -i f%02d.png -vf tile=10x3 sheet.png                      # look at it
ffmpeg -i in.mp4 -vf "select='gt(scene,0.25)',showinfo" -an -f null - 2>&1 | grep -o 'pts_time:[0-9.]*'   # cuts
ffmpeg -v error -i in.mp4 -lavfi "showspectrumpic=s=1800x500:legend=1:scale=log:fscale=log:stop=16000" spec.png
```

- Turn every range the user names ("10–11 sn", "24–25") into **frame numbers** (`time × fps`) and confirm both edges with a 4–8 fps strip around each cut. Users round: "24–25" may be 24.04–25.88, and the next shot may be part of the same problem ("25–27 added another bracelet").
- Read the spectrogram for **where people speak**: speech shows stacked formant harmonics up to 4 kHz; AI music beds show flat horizontal lines; effects show broadband bursts. Then pin the exact speech edges at 40 ms resolution (RMS plus the 1–4 kHz / 80–600 Hz energy ratio). These edges decide every audio cut below.

## 1. Replace a logo or end card (no credits)

The video models invent logos ("GF" on black). Replace the whole card with the brand's real one.

- **Get the real logo**, never a generated one: the brand kit, or the brand's site (`grep -oiE '[^"]*logo[^"]*\.(svg|png)'` on the page; prefer a white or transparent PNG/SVG for dark cards).
- **Render the card as frames** (Python + PIL, exactly as many frames as the range you replace):
  - background: a dark radial gradient (centre ~#1a1a1a → black), not flat black;
  - fade in ~0.4 s (ease-out), hold, fade out ~0.35 s;
  - a slow push-in over the whole card (≈0.955 → 1.02), placed with a sub-pixel affine transform (`Image.transform(..., Image.AFFINE, ..., BICUBIC)`); `zoompan` jitters;
  - optional: one soft light band sweeping across the logo during the hold, masked by the logo's alpha (reads as polished silver/metal; keep it subtle);
  - light grain (σ ≈ 1.6) on every frame, or h264 bands the gradient.
- **Dip to black around it**: fade the shot before out over its last 5 frames and the shot after in over its first 5.
- Its sound: see 4 (one real whoosh-hit landing as the logo reaches full opacity).

## 2. Replace a bad shot without breaking the voiceover

Generate the new shot as in `fix-a-shot.md`. When a voiceover runs across the range:

- **Replace the picture, keep the audio.** Cutting the range out drops words mid-sentence. "Remove 25–27" means: put a good shot there.
- Make the new shot cover the whole bad range in one piece (e.g. 3-arm close-up + a wrong-product insert = one new 3.9 s shot), from a 5 s generation.
- Two takes in parallel when the budget allows. Pick by: anatomy (count arms and hands in every frame), product accuracy (clasp, engraving, bead colour against the product photo), and the cut: a framing **different** from the previous shot reads as a new angle; the same framing reads as a jump cut. Use the take's best continuous window (e.g. hands working → looks up and smiles).
- **Colour-match**: compare the mean RGB of a background patch in the new shot with the neighbours and correct with `colorchannelmixer` (e.g. `gg=0.97:bb=0.88` when Seedance came out cooler). Seedance 720p is 720×1280 at 24 fps; still normalise with `fps=24,scale=W:H:flags=lanczos,setsar=1`.

## 3. Fix a picture-in-picture inset

Replicate edits often float a rounded product close-up over the speaker; the product in it can be wrong (a broken clasp, unreadable engraving).

- **Measure the box** on a full-resolution frame: scan rows and columns for the brightness step at its edges; the corner radius follows from how far the edge sits in a few pixels below the top (`r − √(r² − (r−d)²)`). Check the same box on the first, middle and last frame of the shot.
- **New content**: regenerate the close-up on Seedance with the product photos as references and a crop of the old inset for composition. Then read the product detail frame by frame (zoomed crop). Video models often garble small engravings; if the text is wrong, say so and **ask** before using a still instead: an image edit (`gpt-image-2-5-sunburst-i2i`, the old inset as `@Image1`, the product photo as `@Image2`, the exact engraving in quotes), two variants, a zoomed read of the engraving (one variant wrote "OZTA" for "OTTA"), then a slow push-in toward the detail.
- **Composite** per frame: a rounded, anti-aliased mask (draw at 4×, downscale), 1 px larger than the measured box so no old edge shows; Gaussian 0.45 + grain σ≈2.2 to match the footage; a partial colour gain toward the old inset's mean.

## 4. Swap AI-sounding effects for real recordings

AI soundtracks fake the effects (dumbbells, water, a logo sting) and ring hollow. Rebuild the sound of the ranges **without speech**; never touch the speech.

- **Original track envelope**: full level while people speak; ramp to 0 over ~120 ms right after the last word before the range; back to full ~180 ms before the next word (`asetnsamples=n=128,volume=eval=frame:volume='if(lt(t,A),1,…)'`).
- **Real recordings**: Mixkit's free sound-effect licence allows commercial use without attribution. Category pages `https://mixkit.co/free-sound-effects/<tag>/` (gym, water, splash, shower, bathroom, metal, crowd, train, whoosh, …) carry the titles and `data-audio-player-preview-url-value` mp3 links. Download into a fresh folder and measure each file (RMS, peak, onset times) before placing it.
- **Placement**:
  - transients on visual events: the plate hit on the cut frame, the clink when the dumbbells meet at the top of the curl;
  - loops at an offset whose onsets line up with the strokes or steps on screen;
  - room character: a short `aecho` slap for a tiled indoor pool; quiet real room tone instead of digital silence;
  - logo card: one real whoosh-hit (a metallic resonance suits jewellery), impact as the logo becomes fully visible.
- **A real ambience bed** (station, street, café) about 20 dB under the voice across the talking shots makes an AI voice sound recorded; ~−32 dB RMS while nobody talks.
- **Levels** (RMS): speech ≈ −19 dBFS, beds −28 … −38, transient peaks ≤ −6; `alimiter=limit=0.89`; integrated loudness within 0.5 LU of the original (`ebur128`).
- You cannot hear the mix. Say so, and ask the user to check it on headphones.

## 5. Assemble once

- Video: one `filter_complex` that `trim`s the original by `start_frame`/`end_frame` (+ `setpts=PTS-STARTPTS`), adds PNG sequences (`-framerate 24 -start_number N -i p%03d.png`) and the new clips, and `concat`s them in order. Audio: the mix as one WAV. `libx264 -preset slow -crf 18`, `aac -b:a 192k -ar 48000`, `-movflags +faststart`.
- **Check**: the frame count equals the original's (`ffprobe -count_frames`); a strip of the frames on both sides of every splice; every replaced range; loudness against the original.

## 6. Deliver

- Save the result as a design: `quickdesign design create final.mp4 --title "…"` (CLI ≥ 0.20.0). Don't run an upscale only to get a design row: it costs credits and the ByteDance upscaler turns 24 fps into 30 fps with blended frames. Upscale only when the user asks for 1080p.
- Report per range what changed, the credits spent (per job, as charged), and what you could not verify (the sound).
