# Plan — remaining work

Status legend: `[x]` done and verified · `[~]` in progress · `[ ]` not started.

## Done

- [x] Identify the artifact and record Evidence (`rea inspect-artifact`, sha256).
- [x] Extract XAPK, rejoin Android asset splits, record per-file digests.
- [x] Read `BuildSettings` and build the authoritative scene/lesson map.
- [x] Classify all 281 `AudioClip`s and export them as bit-identical Ogg
      (88.5 MB), verified packet-for-packet with duration checks.
- [x] Derive the UI serialization schemas empirically (100% coverage of
      Image/Text/Button/Slider/… instances, length *and* value checks).
- [x] Read the lesson-player wiring out of the scenes (play/pause/stop,
      sliders, navigation).
- [x] Recover app metadata: script class inventory, UI copy, credit links.
- [x] Resolve the `SetVolume` targets: five sliders → `Audios/{Iya,Ito,Oko,Bit,Vox}`
      volume components, in all 61 lessons.
- [x] Dump all 65 scenes to `.work/scenes/level*.json` (nodes, geometry,
      components, texts, sliders, audio sources, resolved wiring).

## Next: finish the model

- [x] **Export sprites and textures**: 32 sprites + 73 textures (3.7 MB) into
      `assets/img/`, with rect/pivot/9-slice borders in
      `docs/verification/sprite-export.json`. All 29 assets referenced by scene
      `Image`/`RawImage` components resolve; the one non-sprite reference is the
      `Video Book` RenderTexture.
- [ ] **Decode `SimpleSpectrum` fields** enough to reproduce the spectrum bars
      (bar count, origin, colours, source type) or document the approximation.
- [ ] Tidy the scene dump: some nodes list placeholder `null` component entries
      alongside their real ones (cosmetic; the typed components are complete).

## Next: build the app

- [x] **Content model** → `js/data.js` (classic script, no JSON fetch):
      volumes, lessons, stems, durations, credits, UI strings.
- [x] **Layout model** → anchor-relative layout graphs for all 65 screens; the
      browser runs Unity's RectTransform math against the live canvas, with mask
      clipping, canvas ordering, local rotation, ContentSizeFitter labels,
      sprite tinting and a reactive clamp pass (verified at 720×1440,
      1080×1920, 1600×900 and 2560×1080; the Playwright suite now has 60 checks).
- [x] Wire the original's **portrait menu canvas**. The scene's menu and lesson
      canvases are authored in `584.69×1169.38` (1:2), matching the phone
      screenshots; `298.5×456` / `Expand` belongs to the inactive `Libri Video`
      canvas, not the menu. The stage now uses the authored canvas height
      (`canvas_size` from the root RectTransform) as its match-height reference.
- [x] **Stage scaling**: authored canvas (`584.69×1169.38` for menus/player)
      scaled to the viewport, mirroring `CanvasScaler` match-height.
- [x] **Screens**: opening → volume selector → toque index (Volume I) / oru seco
      index (Volume II) → lesson player → credits/links, with hash routing.
- [x] **Mixer**: five `Slider_Volume` controls (0…1, not whole numbers), track
      labels `Iya/Itotele/Okonkolo/Beat/Vox`, Play/Pause/Stop; the Vox stem starts
      at volume 0 as in the original.
- [ ] **Playback strategy**:
      - `https://` (GitHub Pages): Web Audio, sample-accurate start, per-track
        `GainNode`, live spectrum;
      - `file://`: `<audio>` elements with per-element volume and a drift
        correction loop (Web Audio cannot read local media).
- [x] **Pause/resume semantics** matching `AudioSource.Pause`/`Stop` for all five
      stems, plus per-track mute without losing the slider value.
- [ ] **Keyboard/pointer affordances** for Prev/Next/Home/Menu as in the
      original bindings.
- [ ] **Video area**: the Volume Selector shows a `RawImage` fed by a
      `Video Book` RenderTexture. No video payload ships in the build, so the
      original must stream it (`INTERNET` permission, `VideoPlayer` objects with
      no bundled `VideoClip`). Offline port: render the frame area as a
      placeholder and keep the "Libri Video" link instead of streaming.
- [ ] **Self-test page** (`selftest.html`): every lesson resolves its stems and
      sprites, durations match the manifest, no `fetch`/module syntax anywhere in
      the shipped scripts.
- [ ] **Browser pass by the maintainer**: open `index.html` from `file://` and
      confirm each screen against the original (geometry is generated from the
      scenes, so this is a confirmation rather than a design review).
- [ ] **Index screens as shipped**: the visible cards are drawn from the scene
      dump; the generated scroll strip is a stand-in for the original
      `ScrollRect` carousel and should be replaced by the full card list once
      inactive cards are rendered inside the clipped viewport.

## Next: finish the reactive layout

- [x] Anchor-relative layout with live CanvasScaler semantics; full-bleed art
      follows the canvas, canvas-level containers stretch to it, and the player's
      five track rows are pinned to a stable fraction of their container.
- [x] **Clamp pass in `rectsAt`**. Every node is clamped into its parent after
      its rect is computed: overflow is shifted back in, and an oversized box
      shrinks its local size so its children follow the new box. Oversized
      groups whose children use fixed offsets (scroll strips, carousels,
      centred banners) keep that axis unchanged so their content is not stacked;
      they stay clipped by the stage or their own mask, as in CSS overflow.
      Result: zero visible widgets outside the canvas at 720×1440, 1080×1920,
      1600×900 and 2560×1080, and the five lesson sliders stay 256 units wide
      (previously x≈-15 at 540-unit canvas width). Covered by `tests/verify.mjs`.
- [x] Wire the original's portrait menu canvas: root canvas size, per-screen
      camera background, nested-canvas draw order (yellow band above the white
      panel, foreground text above the band), 90° UI rotation (the list gradient),
      ContentSizeFitter labels and Unity sprite tinting. The `298.5×456` `Expand`
      scaler is the inactive video canvas; see the note above.

## Next: verification

- [x] Per-lesson browser sweep (`tests/lesson-sweep.mjs`): all 61 lessons at
      720×1440 reach their route, load the expected stems with durations, render
      the title and five ≥200-unit sliders, keep every visible widget inside the
      canvas, and report no console/network errors. Summary in
      `docs/verification/lesson-sweep-summary.json` (61/61 passed).
- [ ] Re-run `tools/unity_schema.py` and `tools/export_audio.py --verify` in CI
      fashion and store the summaries under `docs/verification/`.
- [ ] Compare the port's rendered screens against the shipped scene data
      (rect-by-rect diff of the layout model vs the dumps) and against the
      store screenshots for a visual sanity check.
- [ ] Document remaining visual differences (font substitution, spectrum
      animation, transitions).

## Next: the original app's own logic (optional depth)

- [x] Metadata → method inventory and a method→address map: Il2CppDumper v6.7.46
      (.NET 8 runtime, user-level) reports Il2Cpp 24.3, `CodeRegistration 0xcc0080`,
      and writes `dump.cs` + `script.json`; the app's 16 classes and their
      signatures are recorded in `docs/verification/app-classes.txt`, and
      `tools/extract_app_classes.py` re-extracts them.
- [x] REA MCP evaluated — **not usable with this client**: the server advertises a
      3.4 MB catalog (largest schema 196 KB) that OpenCode drops silently
      (`rea mcp doctor` green; issue draft in `.work/rea-mcp-catalog-issue.md`).
      REA is driven through its CLI instead (documented in AGENTS.md).
- [~] Decompile the app's own methods with Ghidra by their VA from `script.json`.
      All five attempts (`VolumeValueChange.SetVolume`,
      `VolumeValueChangefromzero.SetVolume`, `SceneSurf.LoadNextLevel/LoadPrevLevel`,
      `MoveOnClick.ChangeScene`) returned `provider_timeout` after ~5.5 minutes: the
      first analysis of the 14 MB `libil2cpp.so` exceeds REA's budget, and
      `docs/ghidra-provider.md` documents no timeout knob. Options: find the
      underlying timeout (env or provider setting), or pre-build the Ghidra
      database with `analyzeHeadless` and query the addresses from it directly.
- [ ] Install Ghidra 12.1.4 + JDK 21 (byo) and register the REA MCP server
      (`rea setup --client opencode --dry-run` first, review paths and backups,
      then apply, then restart).
- [ ] Decompile only the app's own methods (`Assembly-CSharp`: 16 classes) to
      confirm `SetVolume`, `LoadNextLevel`, `ChangeScene`, `Hide`, `PauseMenu`
      and the `VolumeValueChange*` variants, and to settle open questions such
      as the 4-byte field and any purchase gating.

## Publishing

- [ ] Confirm the rights position with the maintainer before publishing audio
      and scores to a public Pages site (the content belongs to the original
      author; the port keeps the credit/links screen).
- [ ] Repository size check: `assets/audio` is ~88 MB; Pages serves the branch
      verbatim (no LFS).
- [ ] GitHub Pages from the branch root; verify a subpath deployment
      (`/batapp-web/`) has no absolute paths.
