# Release v1.0.0 — ShanweiGeo 3D Geoscience Platform

Windows x64 desktop workspace for 3D geoscience data management and visualisation.

- **Release page**: https://github.com/raoyingchun/ShanweiGeo-3D-Geoscience-Platform/releases/tag/v1.0.0
- **Source repository**: https://github.com/raoyingchun/ShanweiGeo-3D-Geoscience-Platform
- **Release date**: 2 November 2026

---

## 1. Two ways to get it

### Option A — download the executable (recommended for a first look)

Fetch `ShanweiGeo-3D-Geoscience-Platform-Windows-x64.zip` (264.6 MB) from the release page:

1. Extract the entire ZIP into a **writable folder** — do not run the program from inside the ZIP.
2. Run `ShanweiGeo 3D Geoscience Platform.exe`.
3. **Neither Node.js nor Python needs to be installed** — a local Python runtime ships with the package.
4. Try the sample files in `Sample Data` before opening your own data.

The accompanying `SHA256.txt` lets you verify the download:

```powershell
Get-FileHash "ShanweiGeo-3D-Geoscience-Platform-Windows-x64.zip" -Algorithm SHA256
```

Expected value: `4bce36234cb83cc23d430c50e7e4733e4884d453701c04dc9a4a67bbeee8c6cf`

### Option B — run from source (recommended if you plan to modify it)

```sh
git clone https://github.com/raoyingchun/ShanweiGeo-3D-Geoscience-Platform.git
cd ShanweiGeo-3D-Geoscience-Platform
powershell -ExecutionPolicy Bypass -File "Test data/Restore-Large-Data.ps1"
cd "ShanweiGeo 3D Geoscience Platform"
npm install
npm start
```

The full step-by-step guide is in **`DOWNLOAD-AND-RUN.md`** in the repository.

---

## 2. How the two differ

| | Release build | From source |
|---|---|---|
| Requires Node.js | No | Yes (20 or newer) |
| Requires Python | No | Yes (3.11) |
| Requires network access | No | Only during `npm install` |
| Download size | 264.6 MB | Dependencies are about 470 MB |
| Best for | Quick evaluation, demonstrations, handover | Development and extension |

**Both provide exactly the same functionality.** The release build simply packages the runtime in advance.

---

## 3. Scope

**Implemented**:

- Research-region (deposit) organisation and management
- Multiple 3D views and layer controls
- Side-by-side comparison
- Registration of datasets against one another
- Imagery drapping over terrain
- Document viewing (PDF, JPG, DOCX)
- Project persistence
- Local processing (coordinate conversion and related operations)

**Not implemented — these are future research objectives**:

- Automated geological modelling
- Mineral prospectivity prediction

> ⚠️ This limitation is stated in the repository README, in these release notes and in the README shipped inside the package. Reviewers should not read the current release as evidence that automatic mineral prospectivity prediction is available.

---

## 4. Test data

The three large datasets under `Test data/` are distributed in compressed form. The restore script verifies each one against its SHA-256 checksum:

| Dataset | Distribution | Size after restore |
|---|---|---|
| `Block Model 2.csv` | single ZIP | 43.75 MB |
| `ljx_2.csv` | single ZIP | 44.91 MB |
| `image_xy37_full.tif` | nine parts | 72.41 MB |

Restore them from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File "Test data/Restore-Large-Data.ps1"
```

The script prints `Verified: <path>` for every file whose checksum matches.

**Please note**: the tunnel example in `Test data/Tunnel Models/Simulated_Tunnels_Around_Orebody_1-1/` is **explicitly labelled as simulated**. It demonstrates the import and rendering workflow and is not a validated engineering design.

---

## 5. Licence

The software is released under the MIT licence — see `ShanweiGeo 3D Geoscience Platform/LICENSE`.

Third-party assets retain their own notices. Inclusion of the test data and documents in this repository does not extend the software licence to material owned by others.

---

## 6. Known limitations

- The desktop build targets Windows x64 only.
- Software rendering (`npm start -- --sw`) is noticeably slower for 3D scenes. Use the default hardware-accelerated mode unless you have a reason not to.
- The embedded Python runtime and the offline wheels are not stored in Git and must be prepared separately when packaging.
- The standalone legacy COORD application is not included in this release; its original interface remains in its own language.
