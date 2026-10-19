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

- [ ] **Content model** → `js/data.js` (classic script, no JSON fetch):
      volumes, lessons, stems, durations, credits, UI strings.
- [ ] **Layout model** → `js/scenes.js`: for each of the 4 app screens plus the
      lesson player blueprint, the measured rects/anchors/pivots/sizes taken
      from the dump, at the 1920×1080 reference resolution.
- [ ] **Stage scaling**: render into a fixed 1920×1080 stage and scale it to the
      viewport, mirroring `CanvasScaler` (match height), so geometry matches the
      original.
- [ ] **Screens**: opening → volume selector → toque index (Volume I) / oru seco
      index (Volume II) → lesson player → credits/links, with hash routing.
- [ ] **Mixer**: five `Slider_Volume` controls (0…1, not whole numbers), track
      labels `Iya/Itotele/Okonkolo/Beat/Vox`, Play/Pause/Stop; one stem starts at
      volume 0 as in the original.
- [ ] **Playback strategy**:
      - `https://` (GitHub Pages): Web Audio, sample-accurate start, per-track
        `GainNode`, live spectrum;
      - `file://`: `<audio>` elements with per-element volume and a drift
        correction loop (Web Audio cannot read local media).
- [ ] **Pause/resume semantics** matching `AudioSource.Pause`/`Stop` for all five
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

## Next: verification

- [ ] Re-run `tools/unity_schema.py` and `tools/export_audio.py --verify` in CI
      fashion and store the summaries under `docs/verification/`.
- [ ] Compare the port's rendered screens against the shipped scene data
      (rect-by-rect diff of the layout model vs the dumps) and against the
      store screenshots for a visual sanity check.
- [ ] Document remaining visual differences (font substitution, spectrum
      animation, transitions).

## Next: the original app's own logic (optional depth)

- [ ] Metadata → method inventory, and a method→address map for
      `libil2cpp.so` (REA does not decode IL2CPP metadata; the mapping is ours).
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
