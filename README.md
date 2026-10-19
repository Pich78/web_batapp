# BatApp — static offline port

A reverse-engineered, dependency-free web port of **BatApp – Diario di un Omo
Aña** by Paolo “Batà” Bianconcini: an Afro-Cuban Batá drum study app
(Regla de Ocha / Santería) with Volume I (toques) and Volume II (oru seco),
each lesson offering a five-stem practice mixer.

The original is a Unity 2019.3.7f1 IL2CPP Android app. This port reuses the
app's own assets — the lesson audio is the original Vorbis stream, remuxed
losslessly — and rebuilds the interface as plain HTML/CSS/JavaScript.

## Status

| part | state |
|---|---|
| Audio (281 stems, 61 lessons, 88.5 MB) | **done**, verified against the original bytes |
| Reverse engineering of scene layout, UI schemas, widget wiring | **done** |
| All 65 scenes dumped to a machine-readable model | **done** |
| Sprites/textures exported (3.7 MB) | **done** |
| Layout + content model emitted as `js/data.js` | **done** |
| The web app itself (`index.html`, `js/`, `css/`) | **working first version** |

See [docs/PLAN.md](docs/PLAN.md) for the next steps and
[docs/REVERSE-ENGINEERING.md](docs/REVERSE-ENGINEERING.md) for the evidence
behind the reconstruction.

## Running the app

- **Double-click `index.html`** — it runs from `file://` with no server.
  Screens: opening → volume selector → toque/oru-seco index → lesson player
  (five sliders, Play/Pause/Stop, Prev/Next/Home, pause layer on `Esc`), plus a
  credits view with the author's links.
- Or publish the repository with GitHub Pages (Settings → Pages → deploy from
  the branch root). All paths are relative, so it works from a subpath too.

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

## Credits and rights

All audio, scores, artwork and text are the work of the original author,
Paolo “Batà” Bianconcini (batangoma.it, facebook.com/BataNgoma,
instagram/paolobatablanco, youtube/paoloBata). This repository is a technical
port of a freely distributed app; the underlying content is not licensed for
redistribution here. Keep the app's credit/links screen intact.
