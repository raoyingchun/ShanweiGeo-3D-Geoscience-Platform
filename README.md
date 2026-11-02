# ShanweiGeo 3D Geoscience Platform

ShanweiGeo 3D Geoscience Platform is a local desktop workspace for 3D geoscience data management and visualization. It combines geological models, drillholes, terrain, imagery, maps and supporting documents in one working environment.

## Repository layout

- **ShanweiGeo 3D Geoscience Platform/**: English application source code, local processing backend and runtime assets.
- **Test data/**: exploration datasets and example models for importing into the application. All folder and file names are in English; original numeric data and document contents are retained.

## Getting started

See **[DOWNLOAD-AND-RUN.md](DOWNLOAD-AND-RUN.md)** for the full guide: how to download the repository, restore the large exploration datasets with checksum verification, install dependencies and launch the application.

## Run from source

```sh
cd "ShanweiGeo 3D Geoscience Platform"
npm install
npm start
```

The desktop build targets Windows x64. Node.js 20 or newer is required for development. Python 3.11 is required for local backend processing when running from source. See the application README and backend documentation for configuration.

## Explore the test data

Start with drillhole CSV files in `Test data/Drillhole Data`, geological surfaces in `Test data/3D Models/Geological Models`, or ASC terrain and georeferenced imagery in `Test data/Surface`. Import each file through its corresponding project-tree category. Paired tunnel STR and DTM files must stay together. Large block models and imagery require more memory and may take longer to load.

Folder names are translated; this does not change coordinate reference systems, units or measurement values. Check those settings before combining datasets. The simulated tunnel example is explicitly marked as simulated and is not a validated engineering design.

## Current scope

Research-region organization, multiple 3D views, layer controls, side-by-side comparison, registration and imagery draping, document viewing, project persistence and local processing. Automated geological modeling and mineral prediction are future research objectives rather than completed features.

## Packaging

```sh
cd "ShanweiGeo 3D Geoscience Platform"
npm run build:english
```

Packaging also requires the embedded Python distribution at `ShanweiGeo 3D Geoscience Platform/runtime/python`. That runtime, npm dependencies, build outputs, logs, caches and personal user profiles are intentionally excluded from Git. Legacy COORD is an external application and is not included.

## License

See `ShanweiGeo 3D Geoscience Platform/LICENSE` for the software license. Third-party assets retain their accompanying notices. Inclusion of datasets and documents does not extend the software license to material owned by others.

## Restore large test files

Three large datasets are distributed as lossless ZIP files. After cloning or downloading this repository, run the following command in PowerShell from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File "Test data/Restore-Large-Data.ps1"
```

The script restores the original CSV and TIFF filenames beside the archives and verifies each file against its recorded SHA-256 hash. The coordinate values, block records and raster pixels are unchanged.
