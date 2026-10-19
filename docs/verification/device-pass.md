# Real-device pass — modern player

Manual checklist for the live site. The automated suite covers headless
Chromium, Firefox and (where host libraries exist) WebKit; real iPhone Safari,
Android Chrome and Windows browsers must be checked by a person.

**Target:** <https://pich78.github.io/web_batapp/>

**Prerequisites**

- iPhone/iPad: iOS/iPadOS **18.4 or newer** (Ogg Vorbis support). Older versions
  cannot decode the lesson audio.
- A network connection for the first lesson load (the player fetches all stems
  before enabling Play). On iPhone, check that the silent switch/volume allows
  media playback.
- Use the modern page at `/`; the scene reconstruction is at `/index_old.html`
  and is out of scope for this pass.

## Steps (repeat per device)

1. Open the URL. The library appears with Toques / Oru Seco tabs.
2. Switch to **Oru Seco**, confirm the order is `1, 2, 3, … 20A, 20B, 21, 22`.
3. Open **01 Alubanche** (Volume I). The loading gate appears, then Play becomes
   enabled when all five stems are local. No Play before that point.
4. Tap Play. All five stems start together; Vox is audible at 100%. Pause,
   resume, Stop, then Play again.
5. While playing, mute a stem, unmute it, then pause → mute a track → play.
6. Drag the seek bar to roughly the middle while still playing. All stems jump
   together and stay in sync (listen for flams between the drums). Then drag it
   **backwards** to an earlier point; the stems must stay synchronized and no
   second/overlapping stream may start.
7. Seek near the end (last second) and let the lesson cross the loop boundary.
   All five stems must restart together, with Beat still present; no rapid
   repeated loop or doubled voice.
8. Move the Iya/Itotele/Okonkolo/Beat/Vox sliders; mute one, confirm its slider
   value is preserved, then unmute.
9. Prev/Next moves through the volume; at the ends the button is disabled.
10. Open an instrumental lesson (Volume II or Volume I 19 Egbi pami); there is
    no Vox row, and the other four stems work.
11. Rotate the phone (portrait and landscape). The landscape layout is
    two-column; nothing is clipped and the page does not scroll unexpectedly.
12. Check the browser tab title: e.g. `Alubanche · Toque 01 · Batá`.
13. Reload the page directly on a lesson URL; the lesson loads and the title is
    correct.

## Results

Record exactly what ran; leave rows blank until tested. Do not mark simulated or
desktop-emulated runs as device results.

| device | OS / version | browser | date | result | notes |
|---|---|---|---|---|---|
| iPhone (model) | iOS 18.4+ | Safari | | pending | |
| Android phone (model) | Android version | Chrome | | pending | |
| Windows PC | Windows version | Chrome / Edge | | pending | |

### Failure notes

- **No audio at all:** check iOS version (18.4+), the silent switch, and whether
  the loader reached “Loading stems 5/5”. If the gate shows an error, note the
  stem name.
- **Play stays disabled:** the fetch gate did not finish; note the loading
  counter and whether the error state offers Retry.
- **Stems drift:** note the lesson, elapsed time and which stems flammed.
- **Layout:** attach a screenshot and the viewport orientation.

## Automated cross-browser baseline

`tests/verify-browsers.mjs` records Chromium/Firefox/WebKit results in
[cross-browser-summary.json](cross-browser-summary.json). WebKit on Linux needs
`sudo npx playwright install-deps webkit`; without those host libraries it is
recorded as unavailable, not passed.
