# ShanweiGeo 3D Geoscience Platform — English Edition

A desktop platform for 3D geological model visualization, built on Electron and
Three.js. The English Edition is the international-facing build of the ShanweiGeo 3D Geoscience Platform
3D geoscience platform, used for mine-site data review, block-model inspection,
terrain analysis and cross-region comparison.

> The Chinese-language edition is maintained separately. This repository tracks
> the English Edition only.

---

## Features

| Area | What it does |
| --- | --- |
| **3D geological models** | Loads and renders GOCAD TS surfaces, block models and drillhole data in a single Three.js scene, using project coordinates (not lat/lon). |
| **Drillholes** | 3D collar / survey rendering, core-image association, per-hole attribute inspection. |
| **Terrain** | ASC grid parsing with edge-connected nodata masking; large raster handling through `sharp`. |
| **Block models** | Binary block-model parsing with dimension and coordinate checks, offloaded to a Web Worker. |
| **Project tree** | Per-project organisation of models, figures, tables and documents; sessions are persisted to `userData`. |
| **Research regions** | Region scoping, region comparison and presentation mode for reporting. |
| **Coordinate utilities** | A web shell that drives the original COORD executable for point and file conversion (four projections, six preset formats). |
| **Document notes** | Read/write project notes with PDF and DOCX preview. |
| **Geochemistry** | Geochemical sample rendering and colour-attribute driving. |
| **Materials** | Poly Haven PBR rock/terrain textures plus user-imported custom materials. |
| **Figures** | In-app figure manager for the scanned geological map archive. |
| **Import / export** | CSV / TXT / XLSX tabular data, DXF and GeoJSON vector data, Shapefile read and write. |

---

## Requirements

- **Node.js 20 or newer** (developed against 22.x)
- **Python 3.11** — only needed for the local Python bridge. The packaged
  release ships an embedded runtime under `runtime/python/`, so end users need
  nothing installed.
- **Windows x64** for the packaged build. The source is platform-agnostic;
  `npm install` pulls matching binaries for other platforms.

---

## Getting started

```bash
npm install     # install dependencies
npm start       # launch the app
npm run dev     # launch with DevTools open
```

`npm start` requires `node_modules/electron/dist/electron.exe`. On Windows you
can also double-click **`Start-ShanweiGeo.vbs`**.

### Building a distributable

```bash
npm run build:english   # -> dist-english-<date>/ShanweiGeo 3D Geoscience Platform-<date>-x64.zip
```

The build is driven by `build/english-release.json`, which uses
`node_modules/electron/dist` as the Electron runtime source, packs `src/` and
`desktop/` into an ASAR archive, and ships the embedded Python runtime and
backend sources as `extraResources`.

Other targets:

```bash
npm run build            # portable exe
npm run build:portable   # explicit portable exe
npm run build:test       # test-flavoured package
```

---

## Project layout

```
ShanweiGeo 3D Geoscience Platform/
├── main.js                  # Electron main process: app:// protocol, window, IPC
├── preload.js               # Context-isolated bridge (window.electronAPI)
├── package.json             # Dependencies and default electron-builder config
├── index8.html              # Main HTML shell  (src/index8.html)
│
├── src/                     # Renderer
│   ├── index8.html          #   application shell
│   ├── three.min.js         #   Three.js r1xx (3D rendering)
│   ├── xlsx.full.min.js     #   SheetJS (tabular import/export)
│   ├── app/                 #   application logic, split by concern
│   │   ├── app_3.js         #     core program logic (largest module)
│   │   ├── app_4.js         #     figure management
│   │   ├── rock-texture.js  #     material library and PBR textures
│   │   ├── terrain-image.js #     terrain raster pipeline
│   │   ├── region-compare.js#     region comparison
│   │   └── ...
│   ├── lib/                 #   PDF.js, docx-preview
│   ├── assets/textures/     #   Poly Haven PBR textures (CC0)
│   └── 图件/                 #   scanned geological figures (~440 MB, Git LFS)
│
├── desktop/                 # Main-process modules
│   ├── python-manager.js    #   Python child-process bridge
│   ├── custom-materials.js  #   user material import (sharp)
│   ├── image-preprocessor.js#   large-image downscaling
│   ├── document-notes.js    #   note persistence
│   └── file-logs.js         #   rotating file logging
│
├── backend/                 # Python side
│   ├── worker.py            #   one-task-per-process JSON Lines server
│   ├── operations/          #   terrain / block / geometry / coordinate ops
│   └── requirements.txt
│
├── runtime/python/          # Embedded CPython 3.11 (not in git)
├── build/                   # Packaging configuration and test fixtures
├── tools/                   # Localisation and test tooling
└── 素材库/                   # Reference mineral imagery (not in git)
```

> **Note on directory names.** `src/图件/` (figure library) and `素材库/`
> (reference library) keep their original Chinese names because they are real
> paths on disk that the application resolves at runtime. Renaming them would
> break the figure manager and the material library.

### Data files

`src/图件/` (~440 MB of scanned geological maps) is tracked through **Git LFS**
so the repository history stays small. Cloning pulls the figures automatically
when Git LFS is installed.

`素材库/` (~52 MB of reference mineral imagery) is excluded — nothing reads it
at runtime. See [`docs/DATA-SETUP.md`](docs/DATA-SETUP.md) for details.

---

## Architecture notes

- **No server.** The application is fully local. There is no backend service, no
  telemetry and no network dependency at runtime.
- **Two-process split.** `main.js` owns the filesystem, IPC and the Python
  bridge; the renderer owns Three.js and the UI. The renderer reaches the
  filesystem only through `preload.js`.
- **Python bridge.** `desktop/python-manager.js` spawns `backend/worker.py` as a
  one-task-per-process child. Communication is UTF-8 JSON Lines over
  stdin/stdout; stderr is kept separate so it can never corrupt the protocol.
- **Project storage.** Session and project state live under the app's
  `userData` directory, not inside the installation folder.
- **Coordinate convention.** 3D data uses project grid coordinates
  (X = east, Y = north, Z = elevation). Geographic coordinates appear only in
  coordinate-conversion utilities.

---

## Development notes

### Localisation

The English edition is maintained by scripted translation. The tooling lives in
`tools/`:

| File | Purpose |
| --- | --- |
| `extract-english.js` | Extract translatable strings from the renderer |
| `extract-python.py` | Extract translatable strings from the Python backend |
| `configure-english.js` | Apply the translation map to the source tree |
| `build-english.js` | Full localisation build |
| `build-english-python.py` | Python-side localisation build |
| `english-glossary.txt` | Domain glossary (geological terminology) |
| `english-phrases.txt` | Approved phrasing |
| `english-preserved.json` | Strings intentionally left untranslated |
| `english-source-strings.json` | Generated extraction result |

Run these before committing renderer or backend changes, and re-run the
regression scripts after:

```bash
node tools/test-english-electron.js       # renderer checks
node tools/test-packaged-english.js        # packaged-build checks
```

### Test fixtures

`build/test-fixtures/` ships as "Sample Data" in the packaged build and covers
block models (`demo-blocks.csv`), terrain (`demo-terrain.asc`), models
(`demo-model.ts`), documents (`demo-document.pdf`) and imagery
(`demo-image.tif`).

### Coordinate conversion

Coordinate conversion is delegated to the original COORD executable rather than
reimplemented. In the packaged build the executable is read from
`userData/tools/COORD/COORD.exe`; the Python bridge receives that location
through the `SHANWEI_COORD_DIR` environment variable. In development, the path
is currently hard-coded in `main.js` — point it at your own installation, or
place `COORD.exe` under `userData/tools/COORD/`.

---

## Documentation

- [`docs/DATA-SETUP.md`](docs/DATA-SETUP.md) — the excluded data directories,
  Git LFS, and how to verify a fresh clone
- [`docs/GITHUB-SETUP.md`](docs/GITHUB-SETUP.md) — creating the remote
  repository and completing the first push

---

## License

MIT — see [`LICENSE`](LICENSE).

Note that third-party assets and the excluded data directories carry their own
terms; see the "THIRD-PARTY ASSETS" section of the license file.
