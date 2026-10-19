# Reverse-engineering record

Everything below is derived from the shipped artifact. Nothing here was
observed at runtime: this environment has no Android device or emulator, so
behaviour is read from serialized scene data and UnityEvent bindings, or
decompiled code.

## 1. Target identity

| item | value |
|---|---|
| artifact | `BatApp+-+Diario+di+un+Omo+Aña_2.1_APKPure.xapk` |
| sha256 | `2bbcd115aad2e93036bc53d5d3ff8f496ff9b53bbe9ee0caf6e0b56934bd87e4` |
| size | 137,372,985 B |
| REA Evidence | `ev_6233f36de3db434aba667f9869b44876046dbd87fca216dbff8478c54f0f4e63` (`rea inspect-artifact`, provider `rea-artifact-graph`, authority `shipped-artifact`) |
| members | base APK `b04db1b778bf0908…` (39,927,971 B), OBB `fe5084758c0b3e93…` (97,270,367 B), `icon.png`, `manifest.json` |
| package | `com.batangoma.batapp`, versionCode 21, versionName 2.1, minSdk 19, targetSdk 28 |
| engine | Unity 2019.3.7f1, IL2CPP, arm64-v8a + armeabi-v7a, DEX stub (109,780 B) |
| permissions | INTERNET, CHANGE_WIFI_MULTICAST_STATE, RECORD_AUDIO, MODIFY_AUDIO_SETTINGS, BLUETOOTH, READ_EXTERNAL_STORAGE |

UnityPy loads the merged tree as 307 files / 164,736,184 B; four serialized
files are split by the Android build and were rejoined (`globalgamemanagers.assets`,
`sharedassets0.assets`, `sharedassets2.assets`, `sharedassets3.assets`).

## 2. Scene inventory (authoritative)

Unity numbers scenes by the `BuildSettings` list, not by string order; the tool
reads that list and pairs `levelN` with `sharedassetsN`, then cross-checks the
pairing against the audio clip names inside each file.

65 scenes: 4 app-level (`Opening Scene`, `Volume Selector`,
`00 - Main Scene_Specific Toque`, `00 - Main Scene_Oru Seco`) + 38 Volume I
lessons + 23 Volume II lessons (`2 - Lezione 1..22`, with `20A`/`20B`).

Pairing evidence: 61 of 65 scenes contain clip names that mention the lesson
title. The four exceptions are the app's own spelling variants, and were
verified by hand:

| lesson | song title | clip name prefix |
|---|---|---|
| Lezione 11 | `baba lo di de` | `lo dide` |
| Lezione 1 (Vol. II) | `Elegba` | `la tokpa` |
| Lezione 11 (Vol. II) | `Ogue` | `oggue` |
| Lezione 13 (Vol. II) | `Orula` | `orunla` |

## 3. Audio

281 `AudioClip` objects: all `Vorbis`, 44,100 Hz, 2 channels,
`DecompressOnLoad`, total 294.9 minutes (189 stems in Volume I, 92 in Volume II).
Each clip is one FSB5 bank; the bank's payload is raw Vorbis packets with 16-bit
length prefixes, and the Vorbis **setup packet is not stored** — the bank only
carries its CRC32 (`VORBISDATA`).

Three distinct setups are used:

| CRC32 | clips | source |
|---|---|---|
| `0xb03f2dd0` | 270 | vgmstream codebook table |
| `0x1fdf9e1c` | 10 | vgmstream codebook table |
| `0x90021eee` | 1 | vgmstream codebook table |

`tools/extract_fsb_setups.py` copies those exact packets out of vgmstream's
`libs/vorbis_codebooks_fsb.h` (itself extracted from FMOD by python-fsb5) into
`tools/data/fsb_setups.json`, so the export stays reproducible offline.

**Export method.** `tools/export_audio.py` rebuilds an Ogg container around the
untouched packets, injecting the original setup packet, synthesising an
identification header (2048/256 blocks, matching FSB) and a comment header, and
setting the end-of-stream granule to the bank's stored frame count.
Result: 281 files, 88.5 MB, `assets/audio/<volume>/<lesson>/<stem>.ogg`.

**Verification (all 281 clips).**

- `packets_identical: true` — the Ogg's audio packets are byte-identical to the
  FSB5 packets; nothing was re-encoded.
- Declared durations match Unity's stored length: e.g. `54.073469 s` vs
  `54.0735 s`.
- PCM decoded by ffmpeg (libvorbis) vs FMOD differs by at most ±2 LSB, which is
  decoder rounding, not stream loss. FFmpeg's raw PCM output pads the final
  block by up to 64 frames; the granule (what players use) is exact.

**Why not WAV.** Decoded PCM would be 3,121.7 MB — beyond GitHub's 1 GB
repository/Pages limits and unpleasant to double-click. The Ogg remux is both
smaller and *more* faithful than a decode (it keeps the original bitstream).

ffmpeg cannot help here: its `fsb` demuxer stops at FSB v3/v4
(`version 5 is not implemented`).

## 4. Scripts and UI schemas

IL2CPP player builds ship no type trees for scripts, so UnityPy decodes engine
classes but not uGUI or gameplay components. The build's own script inventory
(16 classes in `Assembly-CSharp`) is:

`BackButton`, `IconPreview`, `MoveOnClick`, `OutputVolume`, `PauseGame`,
`PauseMenu`, `SceneSurf`, `SimpleSpectrum`, `SliderMenu`, `SoundFileOpener`,
`UIController`, `VolumeValueChange`, `VolumeValueChangefromzero`,
`WebURLScript`, `gameClose`, `pauseScript`.

`tools/unity_schema.py` now holds wire schemas for the classes the port needs.
They were **derived, not guessed**: a candidate layout is accepted only when it
consumes every instance's payload *exactly* and every decoded value is
plausible (bools 0/1, colours within 0…1, pointer ids sane, strings printable).

Validated coverage (100% of instances, length *and* semantics):

| class | instances | class | instances |
|---|---|---|---|
| Image | 3776 | CanvasScaler | 249 |
| Shadow | 1129 | GraphicRaycaster | 249 |
| Text | 1117 | EventSystem | 65 |
| Outline | 893 | StandaloneInputModule | 65 |
| Button | 717 | Mask | 16 |
| Slider | 305 | ScrollRect | 4 |
| ContentSizeFitter | 258 | GridLayoutGroup | 2 |

Findings that only came out of byte-level derivation:

- **UnityEvent has no type name in this build** — a call list only. Proven by
  decoding a Button whose click binds `LoadNextLevel` with the string argument
  `Entermenu`: the count sits immediately before the method name.
- uGUI is the 2019-generation layout: `Navigation.m_WrapAround`,
  `ColorBlock.m_SelectedColor`, `SpriteState.m_SelectedSprite`,
  `AnimationTriggers.m_SelectedTrigger`, `MaskableGraphic.m_Maskable`,
  `Image.m_PixelsPerUnitMultiplier` (1.0 in all 3776 instances),
  `RawImage.m_UVRect` = (0,0,1,1).
- Several classes carry one unexplained 4-byte field between `m_Script` and
  their first documented field (`CanvasScaler`, `ContentSizeFitter`,
  `EventSystem`, `GraphicRaycaster`, `GridLayoutGroup`, `Mask`, `Shadow`,
  `Outline`, `StandaloneInputModule`, `ScrollRect`). `CanvasScaler` pins the
  position: with the field, the values are `m_UiScaleMode=1`,
  `m_ReferencePixelsPerUnit=100`, `m_ReferenceResolution=(1920,1080)`,
  `m_MatchWidthOrHeight=1`, DPI 96/96 — i.e. a 1080p match-height canvas;
  without it every value shifts. The field is 0 everywhere; its meaning is
  unresolved (see Unknowns).

## 5. Behaviour model (read from the build)

Lesson player (`Lezione NN`, 5 sliders):

| trigger | binding | meaning |
|---|---|---|
| `Play` | `AudioSource.Play()` on 5 AudioSources | all stems start together |
| `Pause` | `AudioSource.Pause()` on 5 | pause all |
| `Stop` | `AudioSource.Stop()` on 5 | stop all |
| `Slider_Volume` ×5 | `SetVolume` (MonoBehaviour target) | per-track gain, range 0…1, not whole numbers |
| `Prev Lesson` | `LoadPrevLevel("Entermenu")` | previous lesson |
| `Next Lesson` | `LoadNextLevel("Entermenu")` | next lesson |
| `Cambia Lezione` | `ChangeScene("00 - Main Scene")` | toque index |
| `Home` | `ChangeScene("00 - Main Scene_Specific Toque")` | toque index |
| `Torna alla lezione` | `Hide()` | close overlay |

### Mixer chain (resolved)

Every lesson scene holds five track objects under one parent, each carrying a
`Transform`, an `AudioSource` and a volume component:

| parent path | components | volume script |
|---|---|---|
| `Audios/Iya` | Transform, AudioSource, MonoBehaviour | `VolumeValueChange` |
| `Audios/Ito` | Transform, AudioSource, MonoBehaviour | `VolumeValueChange` |
| `Audios/Oko` | Transform, AudioSource, MonoBehaviour | `VolumeValueChange` |
| `Audios/Bit` | Transform, AudioSource, MonoBehaviour | `VolumeValueChange` |
| `Audios/Vox` | Transform, AudioSource, MonoBehaviour | `VolumeValueChangefromzero` |

Each of the five `Slider_Volume` sliders fires `SetVolume` on exactly one of
those objects (five sliders, five distinct targets, verified in all 61 lessons),
so the original wiring is *slider → volume component → that track's
AudioSource*. Slider values ship as 1,1,0,1,1 — the `0` sits on the track whose
component is `VolumeValueChangefromzero`, i.e. `Audios/Vox`.

### Empty tracks (a property of the original, not a port defect)

- Volume I: 190 tracks of which 189 carry audio — `Lezione 19 - Egbi pami` has
  **no voice stem** (`Audios/Vox` clip is null).
- Volume II: 115 tracks of which 92 carry audio — every oru seco lesson leaves
  `Audios/Vox` empty (four stems, no canto).

The player still shows five sliders in those lessons; the fifth simply has
nothing to play. Labels visible in
the player: `Iya`, `Itotele`, `Okonkolo`, `Beat`, `Vox`, `Home`, `Prev`, `Next`,
`Menu`, `CAMBIA LEZIONE`, `TORNA ALLA LEZIONE`.

Canvases use `ScaleWithScreenSize` with reference `1920×1080`,
`matchWidthOrHeight = 1` (match height); the `Volume Selector` additionally has
a second canvas at reference `298.5×456` (match width) for the small layout.
Sprite/UI sorting orders observed: 0, 1, 2.

Text in the shipped scenes confirms the intended UI copy, e.g.
`DIARIO DI UN OMO AÑA`, `Volume I`, `Volume II`, `Specific toque`, `Oru Seco`,
`Where to buy`, `Buy the book`, `Paolo Batà Bianconcini`,
`Attention! This app has to be considered just an example of how to play Batá
drums. You have to study and experience them with the master drums.`

App metadata literals recovered from `global-metadata.dat` include the credit
links used by the app: `batangoma.it/didattica`, `facebook.com/BataNgoma`,
`instagram/paolobatablanco`, `youtube/paoloBata`, the iTunes artist page for
Batà Ngoma, and an Amazon link for the album “Don't Stress”.

## 6. Unknowns and limitations

- **No runtime observation.** Synchronisation behaviour, pause semantics across
  five stems, animation timing and the spectrum animation are reconstructed
  from data; they are not verified against the running original.
- **The 4-byte mystery field** (section 4) is included in the affected schemas
  as `m_Unknown4`; all observed values are 0. If a future finding identifies it,
  update the schema and note it here.
- **`SetVolume` target not yet resolved to a component instance** — the event
  points at a MonoBehaviour whose class is resolved but whose GameObject path is
  not yet reported; the five sliders are each paired with a volume component by
  hierarchy, and that mapping should be confirmed before the mixer is written.
- **Fonts**: the app ships TextMeshPro SDF assets and `LiberationSans SDF`;
  only the atlas (not a TTF) is present, so the port uses a metric-compatible
  system/Bundled font and may differ by a pixel or two.
- **`SimpleSpectrum`** (a bundled third-party asset, 256 B of serialized fields
  per instance) drives the animated spectrum bars; those fields are not yet
  decoded, so the bars are a reconstruction.
- **In-app purchase**: `UnityEngine.Purchasing.dll` is referenced by the player
  settings, but no product identifiers or unlock strings were found. Whether
  Volume II was ever gated is unresolved; the shipped build contains all
  Volume II audio.
- `TextMeshPro` is present as assets/settings but no `TextMeshProUGUI`
  component exists in any scene — the UI uses legacy uGUI `Text`.
