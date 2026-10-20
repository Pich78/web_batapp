# Real-device pass — modern player

Manual checklist for the live site. The automated suite covers headless
Chromium, Firefox and (where host libraries exist) WebKit; real iPhone Safari,
Android Chrome and Windows browsers must be checked by a person.

**Target:** <https://pich78.github.io/web_batapp/>

**Prerequisites**

- iPhone/iPad: iOS/iPadOS **18.4 or newer** (Ogg Vorbis support). Older versions
  cannot decode the lesson audio.
- A network connection for the first lesson load (the player lazily fetches only
  that lesson's stems before enabling Play). On iPhone, check that the silent
  switch/volume allows media playback.
- Use the modern page at `/`; the scene reconstruction is at `/index_old.html`
  and is out of scope for this pass.

## Steps (repeat per device)

1. Open the URL with the browser network panel recording. The library appears
   with Toques / Oru Seco tabs and **no audio file is requested**.
2. Switch to **Oru Seco**, confirm the order is `1, 2, 3, … 20A, 20B, 21, 22`.
3. Open **01 Alubanche** (Volume I). On first open the loading gate fetches
   only that lesson's five stems, verifies them and converts them to WAV; no
   player controls appear until every stem is ready. The five source Ogg files
   are cached on the device. This can take a few seconds and uses roughly 60 MB
   of WAV in RAM for this lesson; the largest lessons use about 139 MB. The
   mixer order must be Beat, Vox, Iya, Itotele, Okonkolo.
4. Tap Play. All five stems start together; Vox is audible at 100%. Pause: the
   stems stay loaded and resume from the exact same point without replaying old
   audio. Stop: the stems stay loaded and the next Play starts all of them from
   the beginning, again without queued audio from the previous position.
5. With the rhythm playing, press and hold **+**. The audio must keep playing
   and the speed must stay unchanged while held; on release it must change by
   exactly 1% and resume without a position jump. Repeat with **−**. Every stem
   must slow down or speed up together and keep its recorded pitch. The timeline
   and progress ring must follow the audible position. Step down to 50% and up
   to 150%: the matching button must become disabled at each limit. Stop, set
   75%, then step to the next rhythm: the new rhythm must start at 75%. Leave the
   phone untouched for at least 30 seconds while playing: the screen must not
   dim or sleep where the browser supports the Screen Wake Lock API. Pause and
   Stop must release it; the app-info panel reports the state. This needs HTTPS,
   and power-saving modes or browser policy may refuse the lock. Then switch to
   another app for at least 10 seconds while playing and return. The UI must
   match reality: if audio kept playing, leave it alone; if the browser paused
   the media or suspended the AudioContext, the button must show **Play** with
   “Playback paused. Tap Play to resume.”, and the next tap must rebuild and
   resume every stem from the same position. A moving slider with no sound is a
   failure.
6. While playing, mute a stem and move another slider. Only the level changes:
   the timeline keeps advancing and no stem pauses, seeks or reloads. Unmute and
   confirm the previous slider value is restored. Then pause → mute a track →
   play.
7. Drag the seek bar to roughly the middle while still playing. Audio must keep
   playing during the drag; on release it may stop for a moment while the media
   generation is rebuilt, then all stems restart together at the new position
   in sync (listen for flams between the drums). Drag it **backwards** to an
   earlier point and repeat: no buffered audio from the old position may replay
   and no second/overlapping stream may start. Repeat while paused: the player
   stays paused and Play starts at the chosen point.
8. Seek near the end (last second) and let the lesson cross the loop boundary.
   All five stems must restart together, with Beat still present; no rapid
   repeated loop, doubled voice or end-of-loop noise. Repeat at 50% and 150%:
   the shared rewind must happen after the rate-adjusted duration, not early or
   late. Also drag from near the start to the last fraction of a second several
   times in a row: every stem must start and loop, never leaving a silent
   running clock.
9. Move the sliders in the order Beat, Vox, Iya, Itotele, Okonkolo; mute one,
   confirm its slider value is preserved, then unmute.
10. Prev/Next moves through the volume; at the ends the button is disabled.
11. Open an Oru Seco lesson including **19 Egbi pami**. The order must be Beat,
    Iya, Itotele, Okonkolo; there is no Vox row.
12. Rotate the phone (portrait and landscape). Neither view may scroll the page
    or the player. Portrait and landscape must show the speed controls below
    Play, the seek bar, the transport with Stop beside Next, and every mixer row
    inside the viewport.
13. Check the browser tab title: e.g. `Alubanche · Toque 01 · Batá`.
14. Press Back to the rhythm list. The player must stop and release every stem;
    the network panel must show no retained audio response. Open the same
    rhythm again: no Ogg request should occur, and the app must rebuild the WAV
    from the cached source. Confirm the cache does not contain WAV files.
15. Reload the page directly on a lesson URL; the lesson loads and the title is
    correct.
16. Go offline (airplane mode / browser offline). Reload the lesson opened
    above: the service worker must serve the app shell, the cached Ogg must
    verify, and the WAV must be rebuilt. Then open an unvisited rhythm: it must
    show “This rhythm is not available offline. Open it once while online.”
17. Open the top-left hamburger. Confirm exactly **one Version row** equal to
    the repository tag (for example `v1.4.1`), plus the current lesson, WAV/OGG
    source, screen-awake state and offline cache status. Confirm the cached
    rhythm count and “Clear offline audio” action, and that clearing removes
    only the audio cache (the app still opens offline from the shell cache).
    If the manifest is newer, verify the version row is highlighted and the
    “Reload latest” action appears without a second version number. Confirm the
    panel closes with Escape/outside tap and never scrolls the page.
18. Home-screen/standalone app only: after a new release is deployed, reopen the
    app. The shell cache must update; previously opened immutable Ogg rhythms
    must remain cached.

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
  stem name and whether it was a transfer, checksum, WAV preparation or playback
  error. Duration estimates must not block loading; note the stem and the
  reported duration only if playback itself is wrong.
- **Play stays disabled:** the gate did not finish; note whether it stopped at
  “Checking stems”, “Preparing WAV” or “Loading stems”, and whether Retry offers
  a new attempt.
- **WAV preparation fails or the tab crashes:** note the lesson duration, device
  memory and whether the WAV step reached 5/5. The largest lessons use about
  139 MB of WAV in addition to the media pipeline.
- **Checksum/error state:** note the stem name and the detail line. Do not retry
  against a proxy that rewrites media; verify the URL and the manifest version.
- **Offline failure:** note whether the shell loaded, whether the lesson had
  been opened online before, the app-info cached-rhythm count, and whether the
  service worker was controlling the page. A corrupt or evicted Ogg entry must
  be reported with its stem; only the failed entry is refetched when online.
- **Cache grows unexpectedly:** inspect Cache Storage. It must contain
  `batapp-audio-v1` with `.ogg` entries only and a versioned `batapp-shell-*`
  cache. Any `.wav` entry is a bug.
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

`npm run verify-sw` records the service-worker release/clear/eviction/install
lifecycle in [service-worker-summary.json](service-worker-summary.json).
Neither suite substitutes for the manual audio and offline-device steps above.
