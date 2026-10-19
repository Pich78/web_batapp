# AGENTS.md — working in this repository

This repository is a **static, dependency-free port of an Android app**:
`BatApp – Diario di un Omo Aña` (a Batá drum study app: toque lessons with a
five-stem audio mixer). It is reconstructed from the shipped APK/XAPK, not from
source.

## Hard constraints for the deliverable

1. **Offline first.** `index.html` must work when a user double-clicks it
   (`file://`), with no server, no build step and no network access.
2. **No Node.js, npm, TypeScript, bundlers, frameworks or compiled browser
   libraries in the shipped app.** Classic `<script>` files only.
3. Consequences of `file://` that the code must respect:
   - no `fetch()`/`XMLHttpRequest` of local files → content data is emitted as
     JavaScript, not JSON;
   - no ES modules (`type="module"`) → plain scripts and globals;
   - no Web Workers, no Service Worker, no `history.pushState` → hash routing;
   - Web Audio cannot read local media (tainted) → element-based playback with
     drift correction on `file://`, Web Audio only when served over HTTP(S);
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
index.html, app.css, js/     the shipped-layout page (classic scripts, no build)
index_new.html, app-new.css, js/newapp.js   the modern layout page
js/mixer.js                  shared transport (window.BatappMixer) for both pages
assets/audio/<slug>/<stem>.ogg   281 lesson stems (iya, ito, oko, vox, beat)
assets/img/...               sprites and background art exported from the APK
tools/                       extraction and export tools (development only)
tools/data/fsb_setups.json   original Vorbis setup packets needed for remuxing
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
      --audio-report .work/analysis/audio_export.json --out js/data.js
```

`tools/build_app_data.py` owns the content model: it drops the credit/shop/
promo subtrees (see `OMITTED_PATH_PARTS`), renames the volume switcher away
from the book-era wording, prunes the sprite map to the art the surviving
drawables reference and emits `js/data.js`. Run it after `dump_scenes.py`; it
reads only `.work/` inputs, no XAPK.

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

## Modern layout (`index_new.html`)

`index_new.html` + `app-new.css` + `js/newapp.js` are a fresh player, not a
re-skin of the shipped scenes: no scene geometry and no sprites are used, only
`js/data.js` (lessons, audio paths, durations) and the shared transport in
`js/mixer.js`.

- Two-tab library (Toques / Oru Seco) → lesson player with Play/Pause/Stop,
  prev/next (clamped per volume), a progress ring and a mixer row per available
  stem (Beat, Itotele, Iya, Okonkolo, Vox; Vox is absent in Volume II and in
  `Egbi pami`). Each row has a volume slider and a mute that preserves the
  slider value.
- The mixer order and stem labels follow the shipped player's draw order.
- Three responsive modes built from one DOM:
  - portrait phones: one pane at a time (library or player);
  - landscape phones (`orientation: landscape` and `max-height: 559px`):
    full-bleed two-column player and a two-column library;
  - desktop (`min-width: 900px` and `min-height: 600px`): full-bleed persistent
    library sidebar + player/empty main pane, with a narrower stacked player
    below 1200 px.
- `prefers-color-scheme` selects the theme; there is no toggle and no external
  resource (inline SVG icons, data-URI favicon, system font stack).
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
- `tests/verify-new.mjs` covers the modern layout (`index_new.html`) over
  `file://` and over HTTP: portrait, landscape-phone and desktop modes, library
  order, shared-transport sync, mute semantics, prev/next, both colour schemes,
  no external requests/links and a sweep of all 61 lessons; its summary is
  written to `docs/verification/new-ui-sweep-summary.json`.
- Record unresolved questions in `docs/REVERSE-ENGINEERING.md` under
  “Unknowns” instead of guessing.

## Commits and pull requests

- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`), breaking changes
  marked with `!`.
- Keep the binary payload intentional: `assets/audio/**` is ~88 MB and is
  regenerable; if it grows past GitHub's comfort zone, revisit rather than add
  LFS (Pages does not serve LFS objects).

## Do not commit

`.work/`, `.venv/`, `__pycache__/`, the source XAPK/APK/OBB, temporary WAVs, or
anything under `dist/`.
