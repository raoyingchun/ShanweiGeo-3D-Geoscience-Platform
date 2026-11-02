# Downloading and running ShanweiGeo 3D Geoscience Platform

This guide explains how to obtain the repository, restore the large exploration datasets, and start the application.

The repository is public. No account or invitation is required to browse or download it.

---

## 1. Get the code

### Option A - download the archive (recommended for a first look)

Open the repository on GitHub, then choose **Code → Download ZIP**.

The archive is roughly 800 MB because it contains the full exploration test datasets, including scanned geological figures and imagery. On a typical connection this takes several minutes.

If the browser download stalls, download the archive directly from:

```
https://codeload.github.com/raoyingchun/ShanweiGeo-3D-Geoscience-Platform/zip/refs/heads/main
```

Unpack it wherever you keep projects. The archive contains a top-level folder named `ShanweiGeo-3D-Geoscience-Platform-main`; you may rename it.

### Option B - clone the repository

```sh
git clone https://github.com/raoyingchun/ShanweiGeo-3D-Geoscience-Platform.git
```

Cloning transfers the same content and keeps the history, so it is the better choice if you plan to track changes.

---

## 2. Restore the large test datasets

Three datasets are distributed in compressed form so that individual files stay inside the size limits imposed by hosting platforms:

| Dataset | Distribution | Recovered file |
| --- | --- | --- |
| `Test data/3D Models/Block Models/Block Model 2.csv` | single ZIP | block model records |
| `Test data/3D Models/Block Models/ljx_2.csv` | single ZIP | block model records |
| `Test data/Surface/Model_Aligned_Zone37_XY_Swapped_Full_Extent/image_xy37_full.tif` | nine ZIP parts | georeferenced imagery |

Run the restore script from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File "Test data/Restore-Large-Data.ps1"
```

The script concatenates the image parts back into a single archive, expands every archive next to its target, and then compares each restored file against the SHA-256 value recorded in `Test data/Compressed_Data_Manifest.json`. It prints `Verified: <path>` for every file that passes.

If the integrity check fails, the archive is incomplete - re-download the repository and run the script again.

On macOS or Linux the same steps work without PowerShell:

```sh
cd "Test data/Surface/Model_Aligned_Zone37_XY_Swapped_Full_Extent"
cat image_xy37_full.tif.zip.part* > image_xy37_full.tif.zip
unzip -o image_xy37_full.tif.zip
```

Verify the result with `shasum -a 256 image_xy37_full.tif` and compare against the `sha256` field in `Compressed_Data_Manifest.json`.

Restoring is optional. The application starts without it, but the block models and the surface imagery will not be available to import.

---

## 3. Run the application

Requirements:

- Windows x64 (the desktop build targets Windows)
- Node.js 20 or newer, to run from source
- Python 3.11, used by the local processing backend

### Run from source

```sh
cd "ShanweiGeo 3D Geoscience Platform"
npm install
npm start
```

`npm install` downloads the Electron runtime and the project dependencies. Neither is stored in Git.

You can also launch the application by double-clicking **`Start-ShanweiGeo.vbs`** after `npm install` has been run once.

### Rendering modes

Hardware acceleration is enabled by default, which is what you want for interactive 3D work. If the GPU driver is incompatible or you are running the application in a headless environment, switch to software rendering:

```sh
npm start -- --sw
```

The equivalent environment variable is `SHANWEI_SW_RENDER=1`. Software rendering is noticeably slower for 3D scenes, so prefer the default unless you have a reason to change it.

### Python backend

The local processing backend uses Python 3.11 with the packages listed in `backend/requirements.txt`:

```sh
pip install -r backend/requirements.txt
```

Offline wheels are shipped with packaged builds. When running from source, install them yourself.

### Build a distributable package

```sh
cd "ShanweiGeo 3D Geoscience Platform"
npm run build:english
```

Packaging additionally requires the embedded Python distribution at `ShanweiGeo 3D Geoscience Platform/runtime/python`. That runtime, the npm dependencies, build output, logs, caches and personal user profiles are deliberately excluded from Git.

---

## 4. Load the test data

Start the application and import files through the matching category in the project tree:

| Category | Where the data lives | Format |
| --- | --- | --- |
| Drillholes | `Test data/Drillhole Data` | CSV |
| Geological models | `Test data/3D Models/Geological Models` | GOCAD TS, Leapfrog surfaces |
| Block models | `Test data/3D Models/Block Models` | CSV (restore first) |
| Surface | `Test data/Surface` | ASC terrain, GeoTIFF imagery |
| Section drawings | `Test data` | JPG, PDF, DOCX |

Two points to keep in mind:

- **Paired tunnel files must stay together.** Every tunnel consists of a `.str` file with the vertices and a `.dtm` file with the triangle indices. Importing one without the other will not produce a surface.
- **Coordinate reference systems are unchanged.** Folder names were translated into English, but the coordinate values, units and block records are exactly as they were recorded. Confirm the reference system and unit of each dataset before combining them.

The tunnel example under `Test data` is explicitly marked as simulated. It is included to demonstrate the import and rendering workflow, and it is not a validated engineering design.

---

## 5. What the application does

The platform organises exploration data into research regions and provides multiple 3D views, layer controls, side-by-side comparison, registration of datasets against each other, imagery drapping over terrain, document viewing, project persistence and local processing.

Automated geological modelling and mineral prospectivity prediction are **future research objectives**. They are not implemented in the current release, and the repository should not be read as evidence that they are.

---

## 6. Licensing

The software is released under the MIT licence; see `ShanweiGeo 3D Geoscience Platform/LICENSE`.

Third-party assets keep their own notices. Including the datasets and documents in this repository does not extend the software licence to material owned by others, and the test data is provided for research and evaluation purposes.

---

## 7. Troubleshooting

**`npm install` fails or `npm start` reports a missing Electron binary**
Run `npm install` again from the `ShanweiGeo 3D Geoscience Platform` folder. The Electron runtime is not tracked in Git.

**A block model or the surface imagery will not import**
Run the restore script in section 2 first, then confirm the file exists at the path shown in `Test data/Compressed_Data_Manifest.json`.

**The restore script reports an integrity failure**
The archive is incomplete. Re-download the repository rather than using the partially written file.

**Python backend errors**
Check that Python 3.11 is on the path and that the packages in `backend/requirements.txt` are installed. The offline wheels under `backend/vendor` are excluded from Git.

**Large downloads stall in the browser**
Use the `codeload.github.com` address above, or clone the repository instead.
