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
- [x] Recover app metadata: script class inventory, UI copy, credit/shop link
      inventory (the links are recorded as evidence but excluded from the port).
- [x] Resolve the `SetVolume` targets: five sliders → `Audios/{Iya,Ito,Oko,Bit,Vox}`
      volume components, in all 61 lessons.
- [x] Dump all 65 scenes to `.work/scenes/level*.json` (nodes, geometry,
      components, texts, sliders, audio sources, resolved wiring).

## Next: finish the model

- [x] **Export sprites and textures**: 32 sprites + 73 textures (3.7 MB) into
      `assets/img/` at export time; `tools/build_app_data.py` now keeps only the
      22 the surviving drawables reference (~1.2 MB), with rect/pivot/9-slice
      borders in
      `docs/verification/sprite-export.json`. All assets referenced by scene
      `Image`/`RawImage` components resolve; the one non-sprite reference is the
      `Video Book` RenderTexture (removed with the book area).
- [x] **Decode `SimpleSpectrum` fields** (61/61 instances validate): 40 bars,
      `barXScale=2.2`, spacing `6`, `barYScale=40`, `barMinYScale=0.1`, the
      `SpectrumOrigin` node, white→cream value-gradient curve, attack/decay
      `0.25`. `tests/verify.mjs` asserts the 40 bars and their animation. On
      `https://` the bars read a real `AnalyserNode`; on `file://` they use a
      documented batá-shaped reconstruction because Web Audio cannot read local
      media.
- [ ] Tidy the scene dump: some nodes list placeholder `null` component entries
      alongside their real ones (cosmetic; the typed components are complete).

## Next: build the app

- [x] **Content model** → `js/data.js` (classic script, no JSON fetch):
      volumes, lessons, stems, durations, UI strings; credit/shop/promo
      subtrees and the sprite entries only they used are omitted.
- [x] **Layout model** → anchor-relative layout graphs for all 65 screens; the
      browser runs Unity's RectTransform math against the live canvas, with mask
      clipping, canvas ordering, local rotation, ContentSizeFitter labels,
      sprite tinting and a reactive clamp pass (verified at 720×1440,
      1080×1920, 1600×900 and 2560×1080; the Playwright suite now has 64 checks).
- [x] Wire the original's **portrait menu canvas**. The scene's menu and lesson
      canvases are authored in `584.69×1169.38` (1:2), matching the phone
      screenshots; `298.5×456` / `Expand` belongs to the inactive `Libri Video`
      canvas, not the menu. The stage now uses the authored canvas height
      (`canvas_size` from the root RectTransform) as its match-height reference.
- [x] **Stage scaling**: authored canvas (`584.69×1169.38` for menus/player)
      scaled to the viewport, mirroring `CanvasScaler` match-height.
- [x] **Screens**: opening → volume selector → toque index (Volume I) / oru seco
      index (Volume II) → lesson player, with hash routing. No credit/link view.
- [x] **Mixer**: five `Slider_Volume` controls (0…1, not whole numbers), track
      labels `Iya/Itotele/Okonkolo/Beat/Vox`, Play/Pause/Stop; the scene page
      keeps the shipped Vox-at-0 default, while the modern page starts every
      stem (including Vox) at 100%.
- [x] **Playback strategy** → `js/player.js` (`window.BatappPlayer`) for the
      modern page; the legacy scene page keeps `js/mixer.js`:
      - opening the library creates no audio element, context or request;
      - HTTP(S): every stem is fetched with `cache: "no-store"` and a unique
        per-load URL, checked against byte count and SHA-256/CRC-32 in
        `js/lessons.js`, and awaited until it can play through;
      - `file://`: local elements are awaited and their durations checked;
      - one `GainNode` per stem controls the level where Web Audio is
        available; otherwise the element volume is the fallback;
      - scene `Audios/Bit` maps to the exported `beat` stem, so Beat loops like
        every other stem; a missing loop flag defaults to true;
      - all stems reset to 0 together at the loop boundary; no per-stem
        wrap-seek can leave a stem behind or add loop noise;
      - Pause keeps the stems loaded and resumes them from one shared position;
        Stop rewinds all stems to 0 and the next Play starts from the beginning;
      - Back aborts pending transfers, clears the elements, revokes Blob URLs
        and closes the AudioContext; reopening downloads all stems again.
- [x] **Pause/resume semantics** matching `AudioSource.Pause`/`Stop` for all five
      stems, plus per-track mute without losing the slider value.
- [x] **Keyboard affordances**: Space toggles playback, arrows step lessons and
      Escape returns to the list on the modern page; `Esc` keeps the original
      pause layer on the shipped-layout page.
- [x] **Modern layout** (`index.html` + `app-new.css` + `js/newapp.js`):
      responsive player with portrait-phone, landscape-phone and desktop modes
      (persistent sidebar on desktop), progress ring, draggable seek bar,
      per-lesson titles, per-stem volume and mute, natural lesson order
      (1, 2, … 20A, 20B, 21, 22), system light/dark theme, generated
      two-colour three-drum icon set, no external resources. Landscape fits the
      whole player without page or mixer scrolling and places Stop beside the
      transport. The generated `js/lessons.js` is a compact lessons-only payload
      for this page; the scene page keeps `js/data.js`.
      Vox starts at 100% in the modern model. All stems are loaded and verified
      (fetch-to-Blob with checksums on HTTP, local elements with duration checks
      on file://) before the playing screen appears, with named errors and
      Retry. A no-store manifest version check reloads an installed home-screen
      app once when a newer release is deployed, without a service worker.
      Verified by `tests/verify-new.mjs` (file:// and HTTP,
      Chromium/representative Firefox+WebKit); summary in
      `docs/verification/new-ui-sweep-summary.json` and
      `docs/verification/cross-browser-summary.json`.
- [ ] **Real-device pass**: follow `docs/verification/device-pass.md` on
      iPhone Safari (iOS 18.4+), Android Chrome and Windows Chrome/Edge. The
      automated suite cannot establish real-device audio behaviour.
- [x] **Video area**: removed with the rest of the credit/book content; the port
      ships the practice player only.
- [ ] **Self-test page** (`selftest.html`): every lesson resolves its stems and
      sprites, durations match the manifest, no `fetch`/module syntax anywhere in
      the shipped scripts.
- [ ] **Browser pass by the maintainer**: open `index_old.html` from `file://` and
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
- [x] Modern-layout sweep (`tests/verify-new.mjs`): portrait, landscape-phone
      and desktop modes, load gate, seek, titles, library order, mixer, mute
      semantics, prev/next, keyboard, light/dark themes, all 61 lessons and an
      HTTP pass exercising fetch-to-Blob, the gate, named errors/Retry and the
      Web Audio gains. Landscape runs at five sizes up to 480×320 and asserts
      no page, player or mixer scroll, all five stems visible and Stop beside
      the transport. The HTTP pass also checks the manifest version reload.
      Chromium runs the full sweep; Firefox/WebKit run representative lessons.
      The instrumented transport regression covers zero audio on open, one slow
      stem, corrupt transfers, pause → mute → play → backward seek, the
      loop restart to zero, volume-only changes, Back unloading and fresh
      reloads. Summary in `docs/verification/new-ui-sweep-summary.json`;
      cross-browser record in `docs/verification/cross-browser-summary.json`.
- [ ] Re-run `tools/unity_schema.py` and `tools/export_audio.py --verify` in CI
      fashion and store the summaries under `docs/verification/`.
- [ ] Compare the port's rendered screens against the shipped scene data
      (rect-by-rect diff of the layout model vs the dumps) and against the
      store screenshots for a visual sanity check.
- [ ] Document remaining visual differences (font substitution, transitions;
      the spectrum bars are now decoded and animated, with a synthetic fallback
      only where `file://` blocks Web Audio input).

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
- [x] Decompile the app's own methods with Ghidra. The timeout knob is
      **`REA_GHIDRA_STARTUP_TIMEOUT_MS`** (REA default `330000` ms = 5.5 min,
      exactly where the previous attempts stopped); the first analysis takes
      ~7 min with `REA_GHIDRA_STARTUP_TIMEOUT_MS=1800000`. Ghidra's image base
      is `+0x100000` over Il2CppDumper's RVA, so the five methods live at
      `0x5E8990`, `0x5E8A24`, `0x5E1F74`, `0x5E1F84`, `0x5E13FC`. Pseudocode and
      REA Evidence IDs are recorded in
      `docs/verification/app-methods.txt`: `SetVolume` stores `musicVolume` at
      `+0x20`; `LoadPrev/NextLevel` call
      `SceneManager.LoadScene(sceneIndex ± 1)`; `ChangeScene(name)` calls
      `Application.LoadLevel(name)`.
- [x] Ghidra 12.1.4 + JDK 21 are installed user-level under `~/tools` and
      registered through `GHIDRA_INSTALL_DIR`/`JAVA_HOME` in the REA CLI
      invocation. REA MCP registration was not applied: the advertised catalog
      is unusable with this client, so the CLI is the supported path here.
- [x] Decompile the port-relevant methods: both `SetVolume` variants,
      `LoadPrevLevel`, `LoadNextLevel` and `ChangeScene`, with Evidence recorded
      in `docs/verification/app-methods.txt`. Remaining optional depth (not
      needed to reproduce the port): `UIController.Show/Hide`, `PauseMenu`,
      `SceneSurf.Start`. The 4-byte schema slot and any purchase gating remain
      unresolved; they are not exercised by these five methods.

## Publishing

- [ ] Confirm the rights position with the maintainer before publishing audio
      and scores to a public Pages site. **This is a human decision; do not
      publish the audio until it is recorded.**
- [x] Repository size check: the committed tree is ~86 MiB; `assets/audio` is
      ~86 MiB and `assets/img` ~1.2 MiB (only the art the surviving drawables
      reference; the social/book imagery was pruned). Pages serves the branch
      verbatim (no LFS), so this stays well under the 1 GiB limit.
- [x] GitHub Pages subpath smoke test: served the repo at `/batapp-web/` over
      HTTP; the lesson loads, all five stems play, the 40-bar spectrum runs and
      there are no console/network errors. Shipped paths are relative (no
      absolute `src`/`href`/`url` roots).
- [x] Modern layout over HTTP: `tests/verify-new.mjs` serves the repo and checks
      the fetch-to-Blob load gate, SHA-256/CRC-32 integrity failure, named
      errors/Retry, the Web Audio gain path (Vox from 100% down/up), fresh
      reloads after Back and no console errors; `index.html` works from the
      repository subpath. Live at <https://pich78.github.io/web_batapp/>.
