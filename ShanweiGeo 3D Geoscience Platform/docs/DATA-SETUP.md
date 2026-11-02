# Data setup

Two directories in this project are **not tracked by git** because of their
size. This document explains what they contain and how to restore them.

| Directory | Size | Purpose | Tracked |
| --- | --- | --- | --- |
| `src/图件/` | ~440 MB | Scanned geological maps, cross-sections and resource-estimate figures | Yes, via Git LFS |
| `素材库/` | ~52 MB | Reference mineral imagery and vein-texture candidates | No |

Everything else — source code, the Poly Haven texture set, the Python backend
and the packaging configuration — is tracked in the repository and can be
cloned directly.

---

## Why the figure library uses Git LFS

Git stores every revision of every tracked file. Committing 440 MB of scanned
imagery as ordinary blobs would permanently bloat the repository history and
make every clone slow.

The figures are therefore stored in **Git LFS**: the repository keeps a small
pointer file, and the actual image data lives in LFS storage. Cloning the
repository pulls the figures automatically as long as Git LFS is installed
(it ships with GitHub Desktop and is a single `git lfs install` away on the
command line).

The remaining tracked tree is roughly **150 MB**, of which ~144 MB is the
runtime texture set, so a fresh clone is practical.

### Working with LFS

```bash
git lfs install          # once per machine
git lfs pull             # fetch LFS objects after a clone
git lfs ls-files         # list tracked LFS files
```

If a clone reports missing LFS objects, run `git lfs pull` in the repository.

---

## Restoring `src/图件/`

The figure library is the scanned geology archive for the project area:

```
src/图件/
├── 2千地形地质图.JPG              (1:2000 topographic geological map)
├── 剖面图/                        (cross-sections, one file per line)
│   ├── 1线.JPG
│   ├── 2线.JPG
│   ├── ...
│   └── 42线.JPG
└── 资源估算图/                    (resource-estimate projections)
    ├── Ⅱ-1、Ⅲ-1、Ⅵ-1水平投影资源量估算图.JPG
    ├── ...
```

The figures are loaded by the figure manager in `src/app/app_4.js`. The
application reads the directory at runtime, so restoring the files is enough —
no configuration change is required.

Because the figures are tracked through Git LFS, a normal `git clone` restores
them automatically. Only if the LFS objects are missing do you need to copy
them in from the project archive.

**Note on duplicates:** `2千地形地质图.JPG` previously existed both at the
top level and inside `剖面图/`. Only the copy under `剖面图/` is kept now; the
duplicate was removed during the GitHub preparation cleanup.

### Where to get them

The figures are project data and are not redistributable. Obtain them from
whichever internal source the project archive uses, and place them so that the
directory layout above is reproduced exactly.

---

## Restoring `素材库/`

Reference imagery used while authoring the material library:

```
素材库/
├── 常见矿石图片/                  (common ore photographs, by commodity)
│   ├── 磷矿_磷块岩/
│   ├── 金矿_含金矿石/
│   ├── 钨矿_白钨矿/
│   ├── ...
│   └── 锡矿_锡石/
└── 矿脉贴图候选/                   (vein-texture candidates)
    ├── 原图/
    └── 裁剪展示图/
```

This directory is a **design-time reference only** — no runtime code path
reads it. The shipped application uses `src/assets/textures/` for the material
library, and users can import their own images at runtime through
`desktop/custom-materials.js`.

Because nothing depends on it at runtime, `素材库/` can be left out entirely.
The application works normally without it.

---

## Runtime materials (tracked)

The material library used by the running application lives in
`src/assets/textures/` and **is** tracked:

```
src/assets/textures/
├── rock-library.json          # catalogue consumed by src/app/rock-texture.js
├── _previews/
└── <material-name>/
    ├── color.jpg              # albedo
    ├── normal.jpg             # normal map
    ├── roughness.jpg          # roughness
    ├── preview.jpg            # thumbnail
    ├── LICENSE.txt            # Poly Haven CC0 terms
    └── textures/              # full-resolution maps
```

Only the runtime maps are tracked. The `.blend` and `.exr` originals are
excluded — they are re-downloadable from <https://polyhaven.com> and the
packaged build excludes them anyway.

All Poly Haven assets are released under the
[CC0 1.0 Universal Public Domain Dedication](https://creativecommons.org/publicdomain/zero/1.0/).

---

## Verifying a fresh clone

```bash
npm install
npm start
```

Then confirm:

1. The application launches and renders the scene.
2. **Materials** loads the catalogue (the material list is populated).
3. **Figures** lists any restored files from `src/图件/`.
4. **Research regions** and **Block models** behave as expected.

If step 2 fails, check that `src/assets/textures/rock-library.json` is present
and that no `.blend`/`.exr` exclusion was applied too broadly.
