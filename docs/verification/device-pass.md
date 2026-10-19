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

1. Open the URL with the browser network panel recording. The library appears
   with Toques / Oru Seco tabs and **no audio file is requested**.
2. Switch to **Oru Seco**, confirm the order is `1, 2, 3, … 20A, 20B, 21, 22`.
3. Open **01 Alubanche** (Volume I). The loading gate appears and no player
   controls are shown until every stem has downloaded, passed its checksum and
   can play through.
4. Tap Play. All five stems start together; Vox is audible at 100%. Pause: the
   stems stay loaded and resume from the same point. Stop: the stems stay
   loaded and the next Play starts all of them from the beginning.
5. While playing, mute a stem and move another slider. Only the level changes:
   the timeline keeps advancing and no stem pauses, seeks or reloads. Unmute and
   confirm the previous slider value is restored. Then pause → mute a track →
   play.
6. Drag the seek bar to roughly the middle while still playing. All stems jump
   together and stay in sync (listen for flams between the drums). Then drag it
   **backwards** to an earlier point; the stems must stay synchronized and no
   second/overlapping stream may start.
7. Seek near the end (last second) and let the lesson cross the loop boundary.
   All five stems must restart together, with Beat still present; no rapid
   repeated loop, doubled voice or end-of-loop noise.
8. Move the Iya/Itotele/Okonkolo/Beat/Vox sliders; mute one, confirm its slider
   value is preserved, then unmute.
9. Prev/Next moves through the volume; at the ends the button is disabled.
10. Open an instrumental lesson (Volume II or Volume I 19 Egbi pami); there is
    no Vox row, and the other four stems work.
11. Rotate the phone (portrait and landscape). The landscape player must fit
    the viewport completely: no page scroll, no scrolling inside the player or
    the mixer, all five stems visible and Stop beside the transport controls.
12. Check the browser tab title: e.g. `Alubanche · Toque 01 · Batá`.
13. Press Back to the rhythm list. The player must stop and release every stem;
    the network panel must show no retained audio response. Open the same
    rhythm again: all five stems are downloaded again from scratch.
14. Reload the page directly on a lesson URL; the lesson loads and the title is
    correct.
15. Home-screen app only: after a new release is deployed, reopen the app. The
    version check must replace the old build once (the first update may need
    clearing the site data or removing/re-adding the icon). Confirm the new
    Stop size and the new mixer are present.

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
  stem name and whether it was a transfer, checksum, duration or playback error.
- **Play stays disabled:** the gate did not finish; note the loading counter and
  whether the error state offers Retry.
- **Checksum/error state:** note the stem name and the detail line. Do not retry
  against a proxy that rewrites media; verify the URL and the manifest version.
- **Stems drift:** note the lesson, elapsed time and which stems flammed. Note
  whether the browser was backgrounded during the loop.
- **Audio still cached after Back:** record the request URL and whether the
  browser network panel marks it as disk/memory cache; the player requests
  unique `?load=` URLs with `no-store`.
- **Layout:** attach a screenshot and the viewport orientation.

## Automated cross-browser baseline

`tests/verify-browsers.mjs` records Chromium/Firefox/WebKit results in
[cross-browser-summary.json](cross-browser-summary.json). WebKit on Linux needs
`sudo npx playwright install-deps webkit`; without those host libraries it is
recorded as unavailable, not passed.
