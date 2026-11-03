# Local Python channel

## Overview

The existing business logic is unchanged. The Python channel provides a health check, diagnostics, `coord.native.convert` and `coord.native.batch`. Python controls a copy of the original COORD executable using only the standard library; it passes data in and exports the results produced by the original file converter. It does not compute coordinates itself. Custom algorithms and the vendored dependencies remain disabled. No model computation or SQLite business storage has been added. Single-point operations time out after 30 seconds, file batches after 120 seconds.

## Running in development

Interpreter selection: `runtime/python/python.exe` is preferred; when it is absent in a development environment the path given by `SHANWEI_PYTHON` is used, otherwise `python` from PATH. A packaged build only accepts the bundled interpreter.

Restart the desktop application, then run the following in the DevTools console:

```javascript
await backendClient.healthCheck()
await backendClient.run('diagnostic.progress', {steps: 10}, {onProgress: console.log})
// cancellation test (the promise is expected to reject with code=CANCELLED)
await backendClient.run('diagnostic.progress', {steps: 100}, {
  onStarted: id => setTimeout(() => backendClient.cancel(id), 300)
})
```

Development check: `node tools/test-python-bridge.js`.

## Boundaries

- The main process controls the allowed operation names and runs one task at a time. Each task gets its own Python process with a default timeout of 30 seconds.
- The protocol is UTF-8 JSON Lines on stdout, reserved for logs on stderr. A result is confirmed only after the process has exited.
- Page navigation or destruction cancels that page's task; quitting the application waits for the processes to close. The original COORD task manages an isolated copy through a Windows Job Object, so the calculation process is cleaned up when Python exits or is cancelled. The user's own window of the original application is never taken over.
- Any future long-running operation needs its own bounded timeout policy and must not inherit the 30-second limit used by diagnostics.
- `backend-client.js` does not modify the existing state. Large payloads are exchanged through result files.
- The packaging configuration currently includes the desktop JavaScript and the backend Python sources; the disabled vendored dependencies are excluded, and **the packaged Python interpreter is not provided yet**. Before distribution, prepare a complete interpreter and package `runtime/python` as an extraResources entry under the same directory name. The interpreter must sit in the real resources directory. The original COORD connection layer uses only the standard library, supports Windows only, and the original software still depends on its designated local directory.
- The current JSON archive, session handling and IndexedDB cache logic are unchanged. That does not mean SQLite business persistence is complete.

## Backup

Before this change, the source code, configuration and figures were copied to `backups/before-python-step1-20261009-142810/`, together with a SHA-256 manifest. node_modules, caches and user sessions were neither modified nor copied.

## Local model parsing (13 October 2026)

`model.parse` performs streaming parsing of desktop TS and OBJ files and of paired DTM/STR tunnel files. The request carries only the source file path; the cache directory is fixed by the main process and the front end cannot choose an output location.

Vertices use little-endian Float32 and indices use little-endian Uint32, consistent with the existing model parsing results. JSON Lines returns only metadata and cache keys; `models:read-geometry` accepts a 64-digit hexadecimal cache key and transfers the binary data over IPC rather than Base64 geometry.

The cache key contains the parsing version, the full source path, the file size and the modification time in nanoseconds; tunnels are checked against both the STR and the DTM file. Metadata is committed last, so a half-finished task left behind by an interruption cannot become a valid cache entry.

The on-disk cache directory is `Electron userData/geometry-cache`. This version keeps the existing Float32 coordinate precision and OBJ origin convention and applies no coordinate correction. The front end continues to handle materials, colouring, transparency, the camera, textures and drawing. Browser mode, and File objects without a real disk path, keep using the front-end parser.

Model tasks time out after 120 seconds and can use the existing cancellation interface. Backend errors are surfaced; there is no silent fallback to blocking front-end parsing. The first call still includes the cost of starting Python and the IPC transfer, so the `elapsedMs` value in the backend log covers only parsing and cache access, not the full import time.

Verification: `node tools/test-model-backend.js` compares the vertices, indices, names, bounding boxes and origins of real geological TS, OBJ and tunnel files byte for byte against the previous parser, and also covers negative OBJ indices, cache invalidation and malformed geometry. `tools/test-asc-terrain-electron.js` verifies the real desktop IPC, binary reads and project restore. `node tools/test-python-bridge.js` verifies the backend lifecycle and compatibility.

## Block model CSV parsing (13 October 2026)

When a real path is available, the desktop application uses `block.parse` so that the full CSV text is not read in the renderer. Python performs two streaming passes to classify and count the records, then produces a little-endian Float32 instance matrix and a Float64 pick-block bounding box. The front end keeps the existing `blockGmColor` name matching, the InstancedMesh display and the current picking optimisations. Browser mode, or the absence of a disk path, keeps using the existing Web Worker.

The cache key contains the parsing version, the source path, size and modification time, and the target scene origin, so the same file under different coordinate origins cannot reuse the wrong instance matrix. `blocks:read-data` accepts only 64-digit hexadecimal cache keys from a fixed directory; the task times out after 120 seconds. Block project saving still uses the existing instance snapshot and does not change the business data structure.

Verification: `node tools/test-block-backend.js` compares the instance matrix and pick bounding box of the real Block Model 2.csv (658,767 valid blocks) byte for byte, and checks the categories, extents, origin, quoted CSV fields and cache invalidation. The desktop integration test compares the real IPC result against the Web Worker result. The `elapsedMs` value of the first parse does not include Python start-up, IPC or GPU upload time, and does not indicate the overall import speed-up.

## Terrain and imagery preprocessing (13 October 2026)

`terrain.parse` streams the ASC file and produces little-endian Float64 vertices, Uint32 triangle faces and a boundary connectivity index for zero-valued cells. The boundary mask is stored separately as binary data to avoid inflating the JSON messages. The original one-million-cell grid and 100 MB limits, the NoData handling, the cell-centre convention, the axis swap and the vertical scaling logic are all preserved. Desktop import and restore use this path. The front end still handles colouring, normals and rendering, and no claim is made that GPU drawing has moved to Python.

Imagery goes through the local `images:preprocess` operation: sharp generates PNG previews asynchronously from the file path, limited to 2048/4096/8192 pixels and the GPU limit, while preserving the original pixel dimensions, transparency and affine coordinates. GeoTIFF tags are read by random access, touching only the necessary headers. When embedded coordinates are present their precedence is kept, and a world file supplied explicitly by the user still takes priority. Ordinary images without coordinates continue to use manual registration. Image import, independent display, drapping and restore no longer send the whole source file back through Base64. Browser mode and the absence of a real file path keep using the original decoding path.

Caching: terrain data is stored in `userData/geometry-cache`, previews in `userData/image-preview-cache`. Caches are invalidated when the source path, size, modification time or preview size changes; the world file is re-read every time when there are no embedded coordinates. Preprocessing does not clip the geographic extent, does not reproject and does not modify the original file.

Verification: `test-raster-backend.js` compares the ASC file (including a 160,000-cell grid), NoData handling, boundary zero values, Float64 precision and centre/corner coordinates byte for byte, and checks the GeoTIFF coordinate tags, image dimensions, GPU clamping and cache invalidation. Real Electron import, drapping, manual registration integration and project restore regression tests pass.
