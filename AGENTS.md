# AGENTS.md — working in this repository

This repository is a **static, dependency-free port of an Android app**:
`BatApp – Diario di un Omo Aña` (a Batá drum study app: toque lessons with a
five-stem audio mixer). It is reconstructed from the shipped APK/XAPK, not from
source.

## Hard constraints for the deliverable

1. **Offline first.** Both `index.html` (modern) and `index_old.html`
   (shipped-layout) must work when a user double-clicks them (`file://`), with
   no server, no build step and no network access.
2. **No Node.js, npm, TypeScript, bundlers, frameworks or compiled browser
   libraries in the shipped app.** Classic `<script>` files only.
3. Consequences of `file://` that the code must respect:
   - no `fetch()`/`XMLHttpRequest` of local files → content data is emitted as
     JavaScript, not JSON; the modern page may `fetch` its own same-origin audio
     over HTTP(S) for the load gate, never on `file://`;
   - no ES modules (`type="module"`) → plain scripts and globals;
   - no Web Workers and no `history.pushState` → hash routing;
   - no Service Worker on `file://`. On HTTP(S) a shell-only service worker may
     cache the app shell for offline start; it must never cache audio. The page
     may keep immutable Ogg source in Cache Storage, but WAV/decoded audio is
     never persisted;
   - Web Audio may be unavailable or tainted for local media. The modern player
     attempts it on `file://` and falls back to element volume; the legacy
     `js/mixer.js` keeps its element-based fallback and drift correction;
   - all paths relative (GitHub Pages serves from a repository subpath).
4. **Original assets are reused, not redrawn**: audio comes from the APK's own
   Vorbis packets; sprites and text come from the shipped scenes. Credit, shop
   and third-party promo content of the original is deliberately omitted from
   the port, which ships the practice player only — see the omission policy in
   `tools/build_app_data.py`.
5. Python/ffmpeg/UnityPy are **development-time tools only**. They are never
   required to run the app and must not leak into `index.html`, `js/` or `css/`.

## Repository layout

```
index_old.html, app.css, js/     the shipped-layout page (classic scripts, no build)
index.html, app-new.css, js/newapp.js   the modern layout page
sw.js                        shell-only service worker for HTTP(S) offline start
js/offline.js                Cache Storage source cache + shell registration
js/wav.js                    pure-JS 16-bit PCM WAV encoder for the modern page
js/player.js                 modern transport (window.BatappPlayer), used by index.html
js/mixer.js                  legacy transport (window.BatappMixer), used by index_old.html
js/lessons.js                slim generated data + audio integrity for the modern page
assets/icon*.png, icon.svg, site.webmanifest   app icon set (tools/make_icons.py)
assets/audio/<slug>/<stem>.ogg   281 lesson stems (iya, ito, oko, vox, beat)
assets/img/...               sprites and background art exported from the APK
tools/                       extraction and export tools (development only)
tools/data/fsb_setups.json   original Vorbis setup packets needed for remuxing
tests/                       Playwright verification + Playwright MCP wrapper (dev only)
opencode.json                project OpenCode config (Playwright MCP, dev only)
docs/                        findings, plan, verification records
.work/                       scratch: extracted APK/OBB, dumps, reports (git-ignored)
```

## Source artifact (not committed)

The port is derived from one file supplied by the maintainer:

```
/home/apicciano/ai/batapp/BatApp+-+Diario+di+un+Omo+Aña_2.1_APKPure.xapk
sha256 2bbcd115aad2e93036bc53d5d3ff8f496ff9b53bbe9ee0caf6e0b56934bd87e4
size   137,372,985 bytes
```

Base APK `b04db1b778bf0908…` (39,927,971 B) + OBB `fe5084758c0b3e93…`
(97,270,367 B). Unity 2019.3.7f1, IL2CPP, Android.

## Development environment

```bash
uv venv .venv --python 3.10
uv pip install --python .venv/bin/python UnityPy fsb5 numpy     # UnityPy 1.25.4
# ffmpeg (with libvorbis/libogg/libvorbisenc) must be on PATH
```

## Playwright MCP (development only)

The repository-level `opencode.json` registers `batapp-playwright` under
`mcp.servers` (OpenCode V2). The command is `tests/playwright-mcp.mjs`, which
resolves the Chromium used by `tests/node_modules/playwright`, enables
`--allow-unrestricted-file-access` for local `file://` URLs, and writes
generated artifacts under `.work/playwright-mcp/`. `npm ci` installs the pinned
`@playwright/mcp` dev dependency; without the local copy the `npx` fallback can
exceed OpenCode's 45 s startup timeout. After changing the config, run
`opencode reload` and confirm `opencode mcp list` reports connected.

```bash
cd tests
npm run mcp:check     # config + browser path + required flags
npm run mcp:smoke     # opt-in MCP handshake and file:// navigation
```

`opencode mcp list` should show `batapp-playwright` connected. The MCP is for
exploratory and visual checks; `tests/verify-new.mjs` remains the deterministic
regression gate, and audible/device behaviour remains the manual device pass.
Do not commit MCP screenshots or copy the stale `.playwright-mcp/` snapshots
from another checkout.

## Regenerating everything

```bash
XAPK="/home/apicciano/ai/batapp/BatApp+-+Diario+di+un+Omo+Aña_2.1_APKPure.xapk"
P=.venv/bin/python

$P tools/extract_xapk.py --xapk "$XAPK" --work .work
$P tools/unity_inventory.py --data .work/unity/Data --out .work/analysis --mode types
$P tools/scene_map.py      --data .work/unity/Data --out .work/analysis
$P tools/export_audio.py   --inventory .work/analysis/file_inventory.json \
      --scene-map .work/analysis/scene_map.json --data .work/unity/Data \
      --setups tools/data/fsb_setups.json --out assets/audio \
      --report .work/analysis/audio_export.json --verify --verify-all
$P tools/dump_scenes.py    --data .work/unity/Data \
      --scene-map .work/analysis/scene_map.json --out .work/scenes
$P tools/unity_schema.py   --data .work/unity/Data        # schema validation
$P tools/build_app_data.py --scenes .work/scenes \
      --sprites .work/analysis/sprites.json \
      --audio-report .work/analysis/audio_export.json --out js/data.js \
      --lessons-out js/lessons.js
.venv/bin/python tools/make_icons.py
```

`tools/build_app_data.py` owns the content model: it drops the credit/shop/
promo subtrees (see `OMITTED_PATH_PARTS`), renames the volume switcher away
from the book-era wording, prunes the sprite map to the art the surviving
drawables reference and emits `js/data.js` (full scene model) plus the compact
`js/lessons.js` used by `index.html`. In the slim model Vox starts at 100% for
the modern player; the scene reconstruction keeps the shipped 0. Run it after
`dump_scenes.py`; it reads only `.work/` inputs, no XAPK. `tools/make_icons.py`
regenerates the SVG/PNG icon set and the web manifest from one geometry source.

`tools/extract_fsb_setups.py` regenerates `tools/data/fsb_setups.json` from
vgmstream's codebook table (needs network); the committed copy keeps the audio
export offline-reproducible.

## Native analysis (REA + Ghidra)

REA is driven through its **CLI** here. The MCP server cannot be used with this
client: it advertises a 3.4 MB catalog (largest schema 196 KB) which the client
drops silently — `opencode mcp list` says "connected" but no tools appear. The
issue draft is in `.work/rea-mcp-catalog-issue.md`.

```bash
# user-level toolchain (installed once, outside the repo)
#   ~/tools/ghidra_12.1.4_PUBLIC   (Ghidra 12.1.x, verified sha256)
#   ~/tools/jdk-21.0.12.1+1        (JDK 21, JAVA_HOME)
#   ~/tools/dotnet + ~/tools/il2cppdumper  (Il2CppDumper v6.7.46, net6 build)
export GHIDRA_INSTALL_DIR="$HOME/tools/ghidra_12.1.4_PUBLIC" JAVA_HOME="$HOME/tools/jdk-21.0.12.1+1"
export DOTNET_ROLL_FORWARD=LatestMajor

# 1) IL2CPP metadata: dump.cs + script.json (method -> RVA/offset/VA)
~/tools/dotnet/dotnet ~/tools/il2cppdumper/Il2CppDumper.dll \
  .work/native/arm64-v8a/libil2cpp.so \
  .work/unity/Data/Managed/Metadata/global-metadata.dat .work/il2cpp
.venv/bin/python tools/extract_app_classes.py --dump .work/il2cpp/dump.cs

# 2) decompile an app method by its VA from script.json.
# Il2CppDumper reports RVAs; Ghidra's image base is +0x100000, so
# VolumeValueChange.SetVolume (RVA 0x4E8990) is queried at 0x5E8990.
REA_GHIDRA_STARTUP_TIMEOUT_MS=1800000 \
rea decompile .work/native/arm64-v8a/libil2cpp.so 0x5E8990 \
  --provider ghidra --snapshot .work/ghidra/libil2cpp.snapshot --format json
```

Addresses for the app's own methods are cached in
`.work/il2cpp/interesting-methods.json` (names as `Type$$Method`). Every CLI
query imports the 14 MB binary into an ephemeral Ghidra project and pays for its
analysis (~7-9 minutes with 16 cores; budget `REA_GHIDRA_STARTUP_TIMEOUT_MS`
above the 330,000 ms default). `--snapshot` pins the analysis profile so a later
query fails closed if the profile changes; it does not cache the decompilation.
The five port methods and their Evidence IDs are recorded in
`docs/verification/app-methods.txt`.

## Layout model

Screens are emitted as **anchor-relative layout graphs**, not baked rectangles:
`tools/build_app_data.py` writes `layout` (one node per RectTransform, with
`anchors/pivot/anchored/delta/scale/rotation` and a parent index) and every
drawable references a `node`. `js/batapp.js#computeLayout` runs Unity's
RectTransform math in the browser, so geometry follows the live canvas.

Canvas rules (derived from the scenes, not chosen):

- the menu and lesson canvases are authored in **584.69×1169.38** (1:2), which
  matches the phone screenshots. The `CanvasScaler` still says 1920×1080, but
  the root RectTransform's `sizeDelta` is the design space the children were
  laid out in; `screen.canvas_size` carries it;
- the stage keeps that authored height (`height = 1169.38` units) and widens
  with the window (`width = height × aspect`), mirroring match-height CanvasScaler
  semantics. The port is reactive in both orientations: it never rotates, locks
  orientation or letterboxes;
- `rectsAt` clamps every node into its parent after computing the anchor rect.
  Overflow is shifted back in, and an oversized box shrinks its local size so
  its children follow the new box. Oversized groups whose children use fixed
  offsets (scroll strips, carousels, centred banners) keep that axis unchanged
  so their content is not stacked; the stage or their own mask clips them, as
  in CSS overflow. `tests/verify.mjs` asserts zero widgets outside the canvas
  and five ≥200-unit sliders at 720×1440, 1080×1920, 1600×900 and 2560×1080;
- local rotations are applied as affine frames (`rotation` in degrees); e.g. the
  index's 91×3070 list gradient is rotated 90° and must not be treated as a
  vertical stripe. Mask layers stay full-stage and clip with `clip-path`, so
  children keep using canvas coordinates instead of inheriting the mask origin;
- `ContentSizeFitter` labels are grown with `width: max-content` around their
  centre pivot; sprite `m_Color` is applied with an SVG `feFlood`/`feComposite`
  filter because CSS mask images cannot load `file://` resources;
- nested canvases without `overrideSorting` draw after their parent canvas's
  background images (yellow band above the white panel) while foreground
  text/buttons draw above the band; per-screen camera background is recorded in
  `screen.background`;
- `SimpleSpectrum` is decoded from its serialized fields (`screen.spectrum`):
  40 bars at `SpectrumOrigin`, spacing/scale/colour curve and attack/decay. The
  browser animates them from a Web Audio `AnalyserNode` when served over HTTP;
  on `file://` it uses a batá-shaped reconstruction, labelled as such;
- nodes with a plain `Transform` (e.g. an `Actions` holder) are non-drawing
  pass-throughs and deliberately do **not** contribute their localScale: the
  shipped child positions only form a sane row without it (applying the 1.8
  multiplier put "Next Lesson" at x=2039 in a 1920 canvas).

A second `CanvasScaler` of **298.5×456** (`Expand`) exists in `Volume Selector`
on the inactive `Libri Video / Canvas video` object; it is the video canvas, not
the menu design space. Do not use it as the menu reference.

## Modern layout (`index.html`)

`index.html` + `app-new.css` + `js/newapp.js` are a fresh player, not a
re-skin of the shipped scenes: no scene geometry and no sprites are used, only
the generated `js/lessons.js` (lessons, audio paths, durations and per-stem
integrity) and the transport in `js/player.js`. `index_old.html` keeps the
legacy `js/mixer.js` transport.

- Two-tab library (Toques / Oru Seco) → lesson player with Play/Pause/Stop,
  prev/next (clamped per volume), a draggable seek bar, 50–150% speed −/+ buttons
  (pitch preserved) below Play and before the mixer, a progress ring and a mixer
  row per available stem (Beat, Itotele, Iya, Okonkolo, Vox; Vox is absent in
  Volume II and in `Egbi pami`). Stop is an icon-only button inside the transport
  beside Next. Each row has a volume slider and a mute that preserves the slider
  value. Every stem, including Vox, starts at 100%.
- Mixer order is Beat, Vox, Iya, Itotele, Okonkolo for Toques and Beat, Iya,
  Itotele, Okonkolo for Oru Seco (Vox is omitted when the stem is absent).
- A fixed top-left hamburger opens the app-info panel with exactly one
  **Version** row equal to the repository tag, plus the current lesson, audio
  format and wake-lock state. A newer manifest highlights that row and offers a
  manual Reload latest action without printing a second version number.
- Opening a lesson runs a lazy load gate: on HTTP(S) each stem is first looked
  up in Cache Storage. A cached Ogg is accepted only after its byte count and
  SHA-256/CRC-32 match `js/lessons.js`; a missing, corrupt or mismatched entry
  is fetched from the repository with `cache: "no-store"` and a fresh per-load
  URL, verified, then stored as Ogg source. The verified Ogg is decoded with
  `decodeAudioData` and re-encoded as 16-bit PCM WAV by `js/wav.js` before the
  player is shown. WAV is rebuilt on every open and never persisted. The exact
  WAV sample length is the transport duration when conversion succeeds; the
  manifest is the fallback for the Ogg playback path. If decoding fails, the
  stem falls back to direct Ogg. On `file://` the local Ogg elements are awaited
  directly. The gate has a 300 s overall deadline (stalled transfers fail
  closed), and Back cancels WAV encoding between chunks. Failures are named and
  Retry restarts the whole load.
- Offline source cache is lazy and per rhythm: the first open downloads only
  that lesson's stems; later opens use Cache Storage without audio requests.
  There is no bulk precache. Only previously opened rhythms are available
  offline; an unvisited rhythm fails with "This rhythm is not available
  offline." The app-info panel reports cached rhythm count, storage use and a
  Clear offline audio action. A shell-only service worker caches the modern app
  shell for offline starts on HTTP(S); it does not cache audio. The static
  SHA-256/CRC-32 values already in `js/lessons.js` are the cache-validation
  source; because Ogg is immutable, no second CRC manifest is fetched.
- Transport: every stem loops (the scene object `Bit` maps to the exported
  `beat` stem). The transport resets all stems to 0 together at the loop
  boundary, so a browser that recalculates one stem's duration after a near-end
  seek cannot leave that stem behind. Pause captures the actual shared element
  position; Stop rewinds to 0. On HTTP/PWA, Play after Pause or Stop builds a
  fresh media generation from the same Blob with a new object URL, clearing any
  queued old-position audio. Dragging the seek bar leaves playback running; on
  release the same fresh-generation rebuild starts at the new position, so
  buffered old-position audio cannot replay. A rebuilt generation waits for
  every element to become ready and aligns the shared position before starting,
  which also covers near-end seeks. Mute and volume only change per-stem gain.
  Back disposes the player, revokes Blob URLs and closes the AudioContext; the
  verified Ogg source in Cache Storage is kept for the next open.
- The speed −/+ buttons below Play change every stem's `playbackRate` together
  (50–150% in 1% steps, pitch preserved) and carry the selected rate across
  rhythm navigation in the same session. Pressing keeps the current audio
  running; releasing applies one step through a fresh media generation at the
  current position, discarding the old buffer/object URLs. The shared
  wall-clock position and the loop timer scale by the rate.
- The seek bar under the title seeks all stems together; the title format is
  `Title · Toque/Oru Seco NN · Batá`, with `Toques · Batá`, `Oru Seco · Batá`
  and the root title for library routes.
- While playing, the page requests the Screen Wake Lock API and releases it on
  Pause, Stop, Back and page hide; it reacquires on `visibilitychange` when
  playback is still active. Unsupported, insecure or refused requests are
  explicit states in the app-info panel and fall back to normal screen timeout.
- Returning to the foreground resumes an interrupted AudioContext and then
  reconciles the UI with the real media state. A suspended/interrupted context
  or paused media returns the player to Play with a short message; the next tap
  rebuilds a fresh generation and resumes inside the gesture. Live background
  audio is left untouched.
- Three responsive modes built from one DOM:
  - portrait phones: fixed app shell, one pane at a time; the player fits with
    no page or internal scroll, while the library list is the only scroll
    container. The transport is centred with 44–56 px secondary controls around
    the play ring and a grouped Speed pill; Stop is pinned to the mixer card's
    right edge beside Next. The mixer card fills the remaining height in equal
    rows (two-line channel strips on tall screens, single-line rows below
    840 px, compact rows below 741 px), so no dead band opens between Speed and
    the sliders. Tablets at 600–899 px keep the one-pane flow but use a 640 px
    shell instead of the 440 px phone column;
  - landscape phones (`orientation: landscape` and `max-height: 559px`):
    full-bleed two-column player that fits the viewport without page or player
    scrolling (the transport, speed controls and Stop-beside-Next stay visible),
    and a two-column library whose own lesson list may scroll when 38 rows cannot
    fit;
  - desktop (`min-width: 900px` and `min-height: 600px`): full-bleed persistent
    library sidebar + player/empty main pane, with a narrower stacked player
    below 1200 px. At the 600 px minimum height the header, transport, speed
    controls and five mixer rows use the compact short-desktop rule and fit
    without page, pane or player scrolling; stacked grid items are top-aligned
    so a tall mixer cannot centre upward into the speed controls.
- Home-screen/PWA update check: the page reads `site.webmanifest`
  (`cache: "no-store"`), compares `version` with its own
  `<meta name="batapp-version">`, and reloads once with `?v=` when a newer
  version is deployed. Manifest `start_url` and icon URLs carry the same
  version, and the manifest uses `display: "standalone"`. The shell-only
  service worker updates its versioned shell cache; the immutable Ogg cache is
  retained across app releases.
- `prefers-color-scheme` selects the theme; there is no toggle and no external
  resource (inline SVG icons, generated two-colour three-drum icon set, system
  font stack). The light theme's muted and accent tokens keep at least 4.5:1
  text contrast, and every interactive control stays at least 24×24 CSS px
  (the hamburger is 44×44).
- The modern page declares `lang="en"` (the legacy scene page keeps `it` for
  its Italian scene labels). The app-info button opens a non-modal dialog: the
  panel takes focus, Escape/toggle close restores the button, and outside clicks
  do not steal focus back. Route changes move focus to the player heading, the
  active library row or the invoked Prev/Next control, and a visually hidden
  route-status live region announces the new document title. The initial
  library render and duplicate hash canonicalisation never focus the brand
  title; programmatically focused headings suppress the amber outline. A 12 px
  gap separates the fixed hamburger from the brand and the player's Back
  button. `.player-status` is a polite status live region. The library tabs
  implement the ARIA tab pattern with roving tabindex and Arrow/Home/End keys.
- iOS/Safari 18.4+ is required for Ogg Vorbis playback; older iOS cannot decode
  the lesson audio.
- Playback never autoplays on navigation; the user's first Play tap starts all
  stems together. `window.__batapp_new` is a read-only test hook.

## Verification rules

- **Never claim observed runtime behaviour.** There is no device or emulator in
  this environment. Behaviour is *read from the build* (serialized fields,
  UnityEvent bindings) or *derived from decompiled code* — label which.
- Audio exports are accepted only if `tools/export_audio.py --verify` reports
  `packets_identical: true` for every clip (Ogg audio packets byte-identical to
  the FSB5 banks) **and** the declared duration matches Unity's stored length.
- Script schemas in `tools/unity_schema.py` are accepted only if
  `tools/unity_schema.py --data .work/unity/Data` reports 100% for `len ok` and
  `semantic ok`. A schema that merely consumes the right number of bytes is not
  enough — value plausibility is checked too.
- `tests/lesson-sweep.mjs` walks all 61 lesson routes in a real browser and
  checks stems/durations, the five sliders, the title, canvas bounds and
  console/network errors; record its summary under `docs/verification/`.
- `tests/verify-sw.mjs` runs the service-worker lifecycle against a local
  static server with a mutable release version and failure injection:
  shell-cache contents and scope, root/index offline starts, `index_old.html`
  isolation, new shell install with old-cache deletion and Ogg retention,
  Clear offline audio (audio removed, shell kept), an evicted stem while
  offline, failed install recovery, and the read paths never recreating a
  cleared cache. `npm run verify-sw` writes
  `docs/verification/service-worker-summary.json` for Chromium and a per-engine
  report under `.work/verification/`.
- `tests/verify-new.mjs` covers the modern layout (`index.html`) over
  `file://` and over HTTP: fixed portrait and landscape shells at five sizes
  each, desktop, load gate, seek, titles, mixer order, mute semantics,
  prev/next, both colour schemes, lesson order, slim-data equivalence,
  integrity manifest, app-info versions, icon links, no external requests/links
  and a lesson sweep. It also runs instrumented transport regressions (zero
  audio on library open, one slow stem keeps the player hidden, corrupted
  transfers fail closed, WAV headers and exact duration, estimated mobile
  durations no longer blocking load, Ogg decode fallback, the largest lesson
  converting completely, fresh media generations on Pause/Stop → Play with no
  extra audio requests, seek-drag continuation and seek-release fresh generation,
  loop restart to zero, speed-button hold/release, rate/clock/pitch and
  rate-adjusted loop checks, near-end seek stress, background suspension →
  Play rebuild/resume, mocked screen-wake-lock request/release, a single
  tag-shaped Version row, volume/mute leaving the transport untouched, Back
  unloading every resource, lazy per-rhythm Ogg caching, second-open zero audio
  requests, offline shell reload, unvisited-rhythm offline errors, corrupt
  cache repair, and no service worker on `file://`). Chromium runs
  all 61 lessons; `BROWSER=firefox|webkit` runs
  representative lessons (and the HTTP gate/error paths). Its Chromium summary
  is written to `docs/verification/new-ui-sweep-summary.json`;
  `tests/verify-browsers.mjs` records all engines in
  `docs/verification/cross-browser-summary.json`.
- WebKit needs host libraries for local runs:
  `sudo npx playwright install-deps webkit`. If sudo is unavailable, run
  `cd tests && npm run verify-webkit:docker`; it uses the official Playwright
  Docker image, which already carries WebKit and its dependencies, and writes
  the same report under `.work/verification/`. `node verify-browsers.mjs`
  performs this fallback automatically. The Docker WebKit run uses the
  WebKit-safe test mode: WAV conversion stays enabled, but playback uses
  element volume instead of `MediaElementAudioSourceNode`, which crashes the
  Linux WPE build on seek. This is a WPE test limitation, not a production
  switch; the real iPhone Safari pass in `docs/verification/device-pass.md`
  remains authoritative for the Web Audio path.
- Record unresolved questions in `docs/REVERSE-ENGINEERING.md` under
  “Unknowns” instead of guessing.

## Commits and pull requests

- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`), breaking changes
  marked with `!`.
- **Every shipped feature or bug fix bumps the repository version.** Use SemVer:
  a fix is a patch (`v1.2.2` → `v1.2.3`), a feature is a minor bump
  (`v1.2.3` → `v1.3.0`), and a breaking change is a major bump.
  Development-only docs, test or tooling changes that do not alter the shipped
  app may ride along in the next release without their own bump.
  - Before committing, run `python3 tools/set_version.py set vX.Y.Z` so the
    meta, inline build value, manifest and every `?v=` query carry the new
    version. Do not edit those values by hand.
  - Commit and **push the code first**. Then create and push the tag on that
    exact pushed commit: `git tag vX.Y.Z` (lightweight, matching `v1.2.1` /
    `v1.2.2`) and `git push origin vX.Y.Z`.
  - Run `python3 tools/set_version.py check --tag vX.Y.Z`; it must pass on the
    tagged commit. Without `--tag`, `check` uses HEAD's exact tag.
  - Never reuse or move a version tag. If a release is wrong, bump again.
- The repository tag is the single version number. `set_version.py` keeps the
  `?v=` query on `app.css`/`app-new.css` and every shipped JS file in both HTML
  pages equal to the tag, so a cached old script cannot be mixed with new HTML
  on GitHub Pages.
- The app-info panel must show exactly one Version row. Do not reintroduce
  per-script or duplicate manifest version rows.
- Keep the binary payload intentional: `assets/audio/**` is ~88 MB and is
  regenerable; if it grows past GitHub's comfort zone, revisit rather than add
  LFS (Pages does not serve LFS objects).

## Do not commit

`.work/`, `.venv/`, `__pycache__/`, the source XAPK/APK/OBB, temporary WAVs, or
anything under `dist/`.
