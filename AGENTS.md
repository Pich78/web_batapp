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
   Vorbis packets; sprites and text come from the shipped scenes. Say so in any
   UI that credits the author.
5. Python/ffmpeg/UnityPy are **development-time tools only**. They are never
   required to run the app and must not leak into `index.html`, `js/` or `css/`.

## Repository layout

```
index.html, app.css, js/     the app (classic scripts, no build)
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
```

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

# 2) decompile an app method by its VA from script.json
rea decompile .work/native/arm64-v8a/libil2cpp.so 0x4E86D0 \
  --provider ghidra --snapshot .work/ghidra/libil2cpp.snapshot --format json
```

Addresses for the app's own methods are cached in
`.work/il2cpp/interesting-methods.json` (names as `Type$$Method`). The first
decompilation pays for Ghidra's analysis of the 14 MB binary; `--snapshot`
keeps it for later queries.

## Layout model

Screens are emitted as **anchor-relative layout graphs**, not baked rectangles:
`tools/build_app_data.py` writes `layout` (one node per RectTransform, with
`anchors/pivot/anchored/delta/scale` and a parent index) and every drawable
references a `node`. `js/batapp.js#computeLayout` runs Unity's RectTransform math
in the browser, so geometry follows the live canvas.

Canvas rules (derived from the scenes, not chosen):

- authored reference is 1920x1080 with `CanvasScaler` **match-height**;
- wide screens: canvas height = 1080 units, width = `1080 x aspect`, scale =
  `height / 1080` (this is what the original does, so edge-anchored widgets stay
  put and extra width is simply revealed);
- narrower than 16:9 the canvas would shrink under the authored width and push
  the player off-screen — the original rotates instead, so the port keeps 1920
  units and letterboxes;
- nodes with a plain `Transform` (e.g. an `Actions` holder) are non-drawing
  pass-throughs and deliberately do **not** contribute their localScale: the
  shipped child positions only form a sane row without it (applying the 1.8
  multiplier put "Next Lesson" at x=2039 in a 1920 canvas).

A `CanvasScaler` of 298.5x456 (`Expand`) also exists in `Volume Selector`; that
is the original's portrait menu canvas and is not yet wired into the port.

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
