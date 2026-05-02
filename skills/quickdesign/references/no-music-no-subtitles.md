---
name: No music, no subtitles — but keep real-world ambient sound
description: Seedance R2V defaults are bad on two axes for UGC ads. (1) Auto-layers a music bed under voiceover (pop song, score, café playlist, DJ set). (2) Burns hallucinated subtitles into the pixels when the prompt has quoted speech. Both defaults are off-target for authentic creator content. Real-world ambient sound (street noise, room tone, chatter, dish clatter) is WANTED — only the music component is excluded. Standard split rules + setting-aware ambient phrasing.
---

Seedance has two off-target defaults for UGC ad content. Both are easily fixed with explicit prompt lines.

## Default 1: music bed under voiceover

When a prompt has quoted speech, Seedance auto-layers a music track (pop song, instrumental beat, cinematic score, café playlist, DJ set, gym workout music) under the voiceover. This kills the authentic creator vibe — UGC reels should sound like a real person in a real space, not a produced commercial.

**But: real-world ambient sound is WANTED.** Street noise, room tone, distant conversation, dish clatter, footsteps, wind, espresso machine, kids playing, dog barking — these are what make videos feel real. Only the MUSIC component gets excluded.

## Default 2: burned-in hallucinated subtitles

When the prompt contains quoted speech, Seedance defaults to **rendering on-screen subtitles** of the spoken text. These are pixel-burned — not toggleable, not removable in post without re-encoding/cropping.

Worse, they hallucinate:
- Partial sentences ("Okay moms — listen. If you" then cut off)
- Paraphrased words (script says "obsessed", subtitle says "loving")
- Wrong timing (subtitle for sentence 2 appears during sentence 1's audio)
- Random punctuation or glyphs

For ads this is worse than no subtitle — the message viewers READ doesn't match what they HEAR. Trust kill.

## Standard split rules (use these by default)

Two clean sentences with separate scopes — audio rule + visual rule. Cleaner than merging them and zero risk of cross-contamination:

```
No background music or score — only the spoken voice and natural ambient sound.
No subtitles, no captions, no on-screen text overlays of any kind.
```

Place after the dialogue line, before the format spec:

```
@Image1 in the same setting. <action>. He/She says: "<script>".
No background music or score — only the spoken voice and natural ambient sound.
No subtitles, no captions, no on-screen text overlays of any kind.
Vertical 9:16 format.
```

## Setting-aware ambient phrasing — keep ambient ON, only kill the music

For environments where music exists in real life (cafe, bar, gym, club, lobby, store), explicitly NAME the ambient sounds you DO want AND exclude the music type the setting would have. Don't kill the ambient — kill only the music layer.

| Setting | ❌ Don't (over-restrictive) | ✅ Right phrasing |
|---|---|---|
| Cafe / restaurant | "no cafe ambient sound" | "natural cafe atmosphere — distant conversations, dish clinks, espresso machine — but no background music, playlist, or DJ track" |
| Bar / club | "no bar ambient" | "natural bar atmosphere — chatter, glass clinks, low murmur — but no music, no DJ set, no playlist" |
| Gym | "no gym sounds" | "natural gym atmosphere — distant equipment clinks, footsteps, breathing — but no workout music or pumping playlist" |
| Office / coworking | "office ambient" | safe as-is. Optionally: "keyboard typing, distant phone calls, hum of HVAC — no music" |
| Bedroom / home selfie | "natural ambient room sound" | safe as-is — home settings don't auto-add music |
| Outdoor street | "outdoor ambient sound" | safe as-is. Add "passing cars, distant footsteps, city hum — no music" if you want extra detail |
| Park / nature | "natural outdoor ambient" | safe — birds, wind, leaves. Add "no nature documentary music" if music has been creeping in |

**Rule of thumb**: if the real-world setting has music ~50%+ of the time, name the ambient sounds you DO want AND exclude the music type the setting would normally have.

## Subtitle bonus rule — text-bearing reference images

If the reference image contains text (signage, product packaging, mural with words, billboard), Seedance sometimes re-draws extracted text as a subtitle-style overlay. Add an explicit pin:

```
Only the text that exists in the reference image @Image1 itself —
no additional text overlays or subtitles added by the model.
```

This keeps the model from extending or duplicating that text as caption-style overlays.

## Skip these rules only when

- User explicitly asks for music ("with a beat", "cinematic score", "ambient music", "müzikli")
- User specifies a music genre or mood ("dark synthwave underneath", "soft piano underscore")
- User explicitly asks for burned captions ("with subtitles", "altyazılı", "TikTok-style text overlay")
- Reference / brief signals editorial commercial where music is expected (perfume ad mood, fashion film)

## Why these instructions work

Seedance treats both as soundscape / overlay constraints — its native audio + render engines respect negation when phrased clearly. Tested on multiple runs: prompts with the no-music + no-subtitle lines consistently produce clean output. Prompts without them consistently produce music tracks + burned captions of varying quality.

## How to apply

1. **Default**: every Seedance R2V prompt with `--generate-audio` on AND quoted speech gets BOTH the no-music line AND the no-subtitle line. Always two separate sentences, audio scope + visual scope.
2. **Plan summary**: when surfacing the plan, mention "background music: off" and "subtitles: off" as parameters the user can flip if they want them.
3. **Multi-segment**: include both lines in EVERY segment's prompt — don't rely on Seg 1's instruction carrying over.
4. **Voice continuity (`--reference-audio`)**: the audio reference locks voice character; it does NOT lock music or subtitle presence. Write both lines into Seg 2/3 prompts independently.
5. **Setting-specific**: when the scene is cafe/bar/gym/club/lobby, replace the generic "natural ambient sound" with the setting-specific phrasing from the table above.
