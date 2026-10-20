# BatApp — static offline port

A reverse-engineered, dependency-free web port of a freely distributed Android
batá study app (Afro-Cuban Batá drumming, Regla de Ocha / Santería) with Volume
I (toques) and Volume II (oru seco), each lesson offering a five-stem practice
mixer.

The original is a Unity 2019.3.7f1 IL2CPP Android app. This port reuses the
app's own assets — the lesson audio is the original Vorbis stream, remuxed
losslessly — and rebuilds the interface as plain HTML/CSS/JavaScript.

**Live app:** <https://pich78.github.io/web_batapp/>  
**Scene reconstruction:** <https://pich78.github.io/web_batapp/index_old.html>

## Status

| part | state |
|---|---|
| Audio (281 stems, 61 lessons, 88.5 MB) | **done**, verified against the original bytes |
| Reverse engineering of scene layout, UI schemas, widget wiring | **done** |
| All 65 scenes dumped to a machine-readable model | **done** |
| Layout + content model emitted as `js/data.js` | **done** |
| Shipped-layout page (`index_old.html`) | working; reconstructs the original screens |
| Modern layout page (`index.html`) | working; responsive player (portrait phone, landscape phone, desktop sidebar), same data and transport |
| Lazy offline cache | working; first open stores only that rhythm's verified Ogg, later opens rebuild WAV in RAM |
| App icon + manifest | working; three fanned batá drums, smooth black/amber silhouettes, full favicon/home-screen set |

See [docs/PLAN.md](docs/PLAN.md) for the next steps and
[docs/REVERSE-ENGINEERING.md](docs/REVERSE-ENGINEERING.md) for the evidence
behind the reconstruction.

## Running the app

- **Live site** — <https://pich78.github.io/web_batapp/> (modern layout at the
  root, scene reconstruction at `/index_old.html`). The repository publishes
  itself from `master` with GitHub Pages; all paths are relative, so it also
  works from a subpath.
- **Double-click `index.html`** — the modern layout. No server, no build:
  library with the two volumes, lesson player with Play/Pause/Stop, Prev/Next,
  a draggable seek bar, 50–150% speed buttons with pitch preservation, loop
  progress, per-lesson browser titles and a five-stem mixer (volume + mute per
  stem). Every stem starts at 100%, including Vox. The player loads all stems
  first and only enables Play when they are local. The mixer order is Beat, Vox,
  Iya, Itotele, Okonkolo for Toques and Beat, Iya, Itotele, Okonkolo for Oru
  Seco. Stop sits beside Next in the transport, and the speed controls sit below
  Play and before the mixer. It adapts from a fixed one-pane portrait phone shell
  (no page or player scrolling) to a two-column landscape phone view and a full
  desktop layout with a persistent library sidebar. While playing, the page
  requests a screen wake lock so the phone does not dim or sleep where the
  browser supports it.
- **App info** — the hamburger button in the top-left shows one **Version** row
  equal to the repository tag (for example `v1.3.0`), the current lesson,
  whether audio is WAV or Ogg, whether the screen wake lock is active, off,
  blocked or unsupported, and the offline cache state (cached rhythms, storage
  use and a Clear offline audio action). If the manifest is newer it highlights
  the version and offers a manual “Reload latest” action without printing a
  second number.
- **Offline** — on HTTP(S) a shell-only service worker caches the app shell. Each
  rhythm is downloaded lazily the first time it is opened; its verified Ogg
  source is stored in Cache Storage, while WAV is rebuilt in RAM on every open
  and never persisted. Previously opened rhythms work offline; unopened ones
  report that they are not available offline. There is no bulk precache. On
  `file://`, the local folder itself is the offline copy and no service worker
  is registered.
- **Home-screen / PWA updates** — the page compares its own version with
  `site.webmanifest` through a `no-store` request and, when a newer version is
  deployed, reloads once with a versioned URL. The manifest uses standalone
  display and its `start_url` and icons are versioned. The service worker
  updates only the shell cache; the immutable Ogg cache survives app releases.
- **Double-click `index_old.html`** — the shipped-layout reconstruction: opening
  → volume selector → toque/oru-seco index → lesson player, rendered from the
  app's own scene geometry.

## Static by design

The shipped app is plain HTML, CSS and classic `<script>` files: **no Node.js,
npm, bundler, framework, module loader or build step is used or required at
runtime**. Node and Playwright are only used by the optional development test
suite in `tests/`; Python/ffmpeg are only used by the extraction tools.

GitHub Pages deploys the branch with GitHub's managed builder. If its Actions
log shows a Node 20 deprecation notice for `actions/upload-artifact`, that
comes from GitHub's deployment runner, not from this project's code or tests.

## Development checks

Node/Playwright are used only by the development suite in `tests/`:

```bash
cd tests
npm ci
node verify.mjs                 # shipped-layout page
node verify-new.mjs             # modern page, Chromium full sweep
BROWSER=firefox node verify-new.mjs
BROWSER=webkit node verify-new.mjs   # needs: sudo npx playwright install-deps webkit
node lesson-sweep.mjs           # all 61 lessons on the shipped-layout page
npm run mcp:check               # validate the repo Playwright MCP wiring
npm run mcp:smoke               # opt-in MCP handshake + file:// navigation
```

The repository-level `opencode.json` starts the Playwright MCP from
`tests/playwright-mcp.mjs` as `batapp-playwright`. It reuses the test Chromium,
writes generated artifacts under `.work/playwright-mcp/`, and is development
tooling only; see [tests/mcp/README.md](tests/mcp/README.md).

The real-device pass is manual; use
[docs/verification/device-pass.md](docs/verification/device-pass.md) for the
iPhone Safari (iOS 18.4+), Android Chrome and Windows Chrome/Edge checklist.

## Versioning

The repository tag is the single version number. The app displays exactly that
tag, and the internal `?v=` cache-busting strings use it so a PWA cannot mix old
and new files:

```bash
python3 tools/set_version.py set v1.3.0   # rewrite all shipped version values
python3 tools/set_version.py check        # after tagging HEAD: must match
python3 tools/set_version.py show
```

Release in this order: finish the change, run `set` with the intended tag,
commit and push `master`, then create and push the tag on that exact commit,
and run `check --tag vX.Y.Z` there.

## Playback

`index.html` uses `js/player.js` (`window.BatappPlayer`). `index_old.html` keeps
the original scene-reconstruction transport in `js/mixer.js`.

- Opening the library creates no audio element, no `AudioContext` and no audio
  request. Audio loading begins only after a rhythm is chosen.
- On HTTP(S) the player first checks Cache Storage for each stem. A cached Ogg
  is accepted only after its byte count and SHA-256 (CRC-32 on origins without
  Web Crypto) match the manifest in `js/lessons.js`; a miss or mismatch fetches
  that stem from the repository with `cache: "no-store"` and a fresh per-load
  URL, verifies it, and stores only the Ogg source. The immutable SHA/CRC values
  already in `js/lessons.js` are the validation source; no separate CRC manifest
  is needed. The whole gate has a 300 s deadline, so a stalled transfer fails
  with an error instead of leaving the loader up; Back during a load also stops
  WAV encoding between chunks.
- On HTTP/PWA the verified Ogg is decoded with `decodeAudioData` and re-encoded
  as 16-bit PCM WAV by `js/wav.js`; the player waits until all five WAV Blobs
  can play through. WAV is rebuilt on every open and never persisted. The exact
  WAV sample length is the transport duration; the manifest remains the fallback
  for the Ogg playback path. The largest lesson uses about 139 MB of WAV at
  44.1 kHz. If a browser cannot decode Ogg for conversion, that stem falls back
  to direct Ogg playback.
- On `file://` the browser cannot read local bytes reliably, so the local Ogg
  elements are awaited directly. The manifest duration remains the transport
  length if a mobile browser estimates the duration.
- The playing screen appears only after the last stem is ready; failures name
  the stem and fail closed.
- The first open of a rhythm downloads only that rhythm's stems. Reopening it
  uses the cached verified Ogg and makes no audio request, then rebuilds the
  WAV. Only previously opened rhythms are available offline; there is no bulk
  precache. The app-info panel reports the cached rhythm count and storage use.
- Back navigation aborts pending transfers, pauses and clears every media
  element, revokes the Blob URLs and closes the `AudioContext`. Verified Ogg
  source stays in Cache Storage for the next open.
- One GainNode per stem controls the level when Web Audio accepts the media
  source; a per-element volume fallback is used elsewhere. Mute and the volume
  slider never pause, seek, restart or reload a stem.
- Every stem loops. The transport resets all stems to the beginning together at
  the loop boundary, so a browser that recalculates one stem's duration after a
  near-end seek cannot leave that stem behind.
- Pause keeps every stem loaded and resumes all of them from one shared
  position. Stop keeps them loaded and rewinds all of them to 0; the next Play
  starts from the beginning. On HTTP/PWA, Play after Pause or Stop builds a new
  media generation from the same Blob URL data, so queued audio from the old
  position cannot replay. A pending `play()` from a quick tap cannot undo
  Pause or Stop.
- Dragging the seek bar leaves playback running. On release, every stem is
  stopped, the current media generation is discarded (object URLs revoked,
  elements unloaded) and rebuilt at the new position, then playback resumes.
  Paused seeks stay paused at the new point and rebuild on the next Play. This
  prevents buffered audio from the old position replaying after a seek.
- A rebuilt generation waits until every stem is ready and seeks to the shared
  position before starting the elements. Near-end seeks therefore start and
  enter the normal loop boundary instead of racing a not-yet-seekable element.
- Returning from another app is reconciled with the real audio state. If the
  browser suspended/interrupted the `AudioContext` or paused the media, the UI
  returns to **Play** and shows “Playback paused. Tap Play to resume.”; the next
  tap rebuilds a fresh generation and resumes the context inside the gesture. If
  audio kept playing in the background, it is left untouched.
- The Speed **−** and **+** buttons change every stem's playback rate together
  from 50% to 150% in 1% steps while preserving the recorded pitch. Pressing a
  button leaves playback running; releasing it rebuilds the media generation at
  the current position with the new rate, so buffered data from the old speed
  cannot replay. The seek bar, progress ring and loop boundary follow the
  selected rate. The speed carries over when stepping to another rhythm in the
  same session; the buttons are disabled at their limits.
- While a rhythm is playing, the modern page requests the Screen Wake Lock API
  so the screen does not dim or sleep. It releases the lock on Pause, Stop, Back
  and page hide, and requests it again when the page becomes visible if playback
  is still running. Browsers without the API, insecure origins and power-saving
  modes that refuse the request keep the normal screen timeout; the app-info
  panel reports the state. This prevents idle dimming and sleep only while the
  page is visible and playing.

**iPhone/iPad:** iOS/Safari 18.4+ is required for Ogg Vorbis playback. On older
iOS versions the browser cannot decode the lesson audio.

Stems within a lesson all have the exact same duration; the audible parts enter
at different points (some start with several seconds of rest), which is part of
the arrangement. The player always starts every stem at the same position and
never trims that leading silence.

## Content

**Volume I — 38 toques:** 01 Alubanche, 02 Tani tani cho bi, 03 Oyankota,
04 Bariba oguedema, 05 Kuru kuru bete, 06 Tiwi tiwi, 07 Ekua e, 08 Oricha
mpawa, 09 Odduaremuo, 10 Ochicambo, 11 Baba lo di de, 12 Bonko y bonko,
13 Agayu chola, 14 Oya otagua, 15 Elekoto, 16 Ifa, 17 Elekete melli, 18 Kele
kele ya, 19 Egbi pami, 20 Oferere, 21 Alado okuo, 22 Oba ere, 23 Eni alado,
24 Fomaloguede, 25 Kowo kowo, 26 Wemilere, 27 Emi so, 28 Obatilemi, 29 Yewa
kunfe, 30 Bayuba kante, 31 Tui tui, 32 Cheke cheke, 33 Tosun tosun,
34 Bamila ochun, 35 Ochinche iwama, 36 Eni o bobo, 37 Sogun tamiwo,
38 Taniboya.

**Volume II — 23 oru seco lessons:** Elegba, Oggun, Ochosi, Imbaloke, Inle,
Babalu aye, Osain, Osun, Obatala, Dada, Ogue, Agayu, Orula, Orichaoko, Ibedy,
Chango, Yewa, Oya, Ochun, Yemaya (20A/20B), Obba, Oddudua.

Each lesson has stems `iya`, `ito`, `oko`, `vox`, `beat` (Volume II lessons are
instrumental: four stems, no voice).

## Provenance and rights

The port is reconstructed from a freely distributed Android build and reuses
that build's own audio and UI assets; nothing was redrawn or re-recorded. The
content, recordings and scores remain the property of their rights holders, and
this repository is a technical port, not a redistribution license. Credit, shop
and third-party promo screens of the original app are deliberately omitted:
both pages ship the practice player only, with no external links.
