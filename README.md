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
  loop progress and a five-stem mixer (volume + mute per stem). It adapts from
  a one-pane portrait phone view to a two-column landscape phone view and a
  full desktop layout with a persistent library sidebar.
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

## Playback

Both pages share `js/mixer.js` (`window.BatappMixer`): one `<audio>` element per
stem, all started in the same tick, each looping, with a 500 ms drift-correction
pass that re-seeks any stem more than 80 ms off the reference.

- On `file://` the element volume is the level control (Web Audio cannot read
  local media).
- On `http(s)` (e.g. GitHub Pages) a GainNode per stem controls the level, which
  also works on iOS, where `HTMLMediaElement.volume` ignores writes. Every stem
  is advanced even at volume 0, so Vox can be unmuted mid-playback.

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
