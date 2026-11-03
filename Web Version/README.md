# ShanweiGeo 3D Geoscience Platform — Web Build

A browser version of the ShanweiGeo 3D geoscience platform. The application
code is the same source as the desktop build; a thin bridge layer replaces
the Electron main process with browser APIs.

---

## Quick start

### Windows

Double-click **`Start-WebApp.bat`**.

It starts a local server and opens the application in your default browser.
Keep the console window open while you work — closing it stops the server.

### macOS / Linux

```sh
chmod +x start-web-app.sh
./start-web-app.sh
```

### Manual start

```sh
python -m http.server 8765 --bind 127.0.0.1
```

Then open <http://127.0.0.1:8765/index8.html>.

> **Python 3 is required** (any recent version). The server only serves
> static files; no packages need to be installed.

---

## What works in the browser

Everything in the application runs in the browser:

| Area | Notes |
|---|---|
| GOCAD `.ts` geological models | Parsed in JavaScript, no backend needed |
| OBJ models | Parsed in JavaScript |
| Tunnel models (`.str` + `.dtm`) | Parsed in JavaScript |
| Block models | Parsed in a Web Worker |
| ASC terrain | Parsed in JavaScript |
| DXF / GeoJSON vectors | Inlined DXF parser |
| Drillhole tables (CSV / Excel) | SheetJS runs in the page |
| PDF and Word viewing | The libraries are bundled locally |
| TIFF images | Coordinates read in the page |
| Point drawing and editing | Unchanged from the desktop build |
| Geological mapping and figures | Unchanged |
| Region comparison, research regions | Unchanged |
| Presentation mode | Unchanged |

### What is desktop only

**The COORD coordinate conversion tool** launches a separate Windows program
through the Electron main process. It cannot run in a browser, so its entry
point in the right-hand utility rail explains this when clicked.

The Python backend that accelerates model parsing on the desktop is not
required here: the JavaScript parsers are used instead. They cover the same
formats, so no feature is lost.

---

## How it works

Three files are added to the application source; nothing in the shared
modules was edited.

```
app/web-bridge.js    implements window.electronAPI with browser APIs
app/web-only.js      browser-only adjustments (disables the COORD launcher)
app/web-bridge.js    loaded as the first script, before any module
```

`web-bridge.js` provides:

- **File dialogs** — the browser file picker and a download for saving
- **Session drafts** — `localStorage`
- **Custom material library** — `IndexedDB`
- **Project files** — the File API

The application guards every Electron call with a presence check, so any
method the bridge does not provide simply removes the corresponding entry
point instead of raising an error.

---

## Sample data

`Sample Data/` contains real test data so the application can be evaluated
straight away:

```
Sample Data/
  3D Models/Tunnel Models/
    simulated_1_1_surrounding_tunnels.ts   GOCAD model (1 MB, 22152 triangles)
    tunnel_test.str + tunnel_test.dtm      tunnel model pair
  Drillhole Data/
    R_collar.csv, R_survey.csv, R_lithology.csv,
    R_alteration.csv, R_geochem.csv         drillhole tables
```

To import a model: right-click a category under **3D Geological Models** in
the left-hand tree, choose **Import TS Model**, and pick a file from
`Sample Data/`.

---

## Project layout

```
index8.html              the application (identical to the desktop build)
three.min.js             3D engine
xlsx.full.min.js         spreadsheet library
app/                     application modules
  web-bridge.js          browser implementation of the Electron bridge
  web-only.js            browser-only adjustments
  block-model-worker.js  block model parser (Web Worker)
lib/                     pdf.js and docx-preview (local, offline)
assets/                  material textures
Sample Data/             test data
tools/                   automated tests
```

---

## Tests

The `tools/` folder contains automated checks that drive a headless Chrome
through the DevTools protocol.

```sh
python -m http.server 8765 --bind 127.0.0.1   # in one terminal
node tools/smoke-test.js   http://127.0.0.1:8765/index8.html
node tools/e2e-import.js  http://127.0.0.1:8765/index8.html
node tools/e2e-scene.js   http://127.0.0.1:8765/index8.html
```

| Script | Covers |
|---|---|
| `smoke-test.js` | bridge methods, page start-up, WebGL context, session and material storage |
| `e2e-import.js` | fetching and parsing the real sample models and tables |
| `e2e-scene.js` | importing through the application's own code path and capturing the result |
| `diagnose.js` | module load state and uncaught errors |
| `capture.js` | screenshot with a model loaded |

---

## Browser requirements

Any current Chrome, Edge, Firefox or Safari. WebGL 2 is used for the 3D
canvas.

---

## Licence

MIT — see the desktop build for the full terms.
