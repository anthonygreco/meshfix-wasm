# Changelog

## 0.2.0

- **PLY import**: `loadFromFile("/tmp/input.ply")` now reads ASCII and binary PLY meshes via happly (header-only, MIT). Vertex colour properties (red/green/blue etc.) are accepted but discarded — geometry only. Use `colorsDropped()` to detect whether a file had colours.
- **PLY export**: `exportMesh("/tmp/out.ply")` produces a binary-LE PLY file with vertex positions and faces.
- **Scale**: `scale(factor: double)` multiplies all vertex positions by a scalar factor in-place. Returns false (and sets `getLastError()`) for non-positive factors or when no mesh is loaded.
- **Format-aware load (bug fix)**: `analyze()` and `analyzeDetailed()` in all APIs now accept an optional `format` parameter (`'stl'|'obj'|'off'|'ply'`, default `'stl'`). This fixes a live bug where OBJ and OFF files were written to `/tmp/input.stl` and therefore parsed as STL (producing empty meshes). All callers should pass the correct format.
- **`colorsDropped()` getter**: exposed on `MeshAnalyzer`, `MeshFix`, and `MeshFixWorker`. Returns `true` when the most recently loaded file had vertex colour data that was discarded.
- **`AnalysisResult.colorsDropped`**: `analyzeDetailed()` and `reanalyze()` now include `colorsDropped?: boolean` in their return value.
- Vendor happly (single header, `third_party/happly/happly.h`); WASM binary grows ~105KB.
- 17 new tests covering PLY round-trip, colour detection, format-aware load regression, and scale semantics.

## 0.1.2

- Pin Emscripten to 5.0.1 in `scripts/install-emsdk.sh` — previously used `latest`, which could silently change the compiled WASM across CI runs
- Bump devDependencies: vitest `^3.1.1` → `^4.1.8`, TypeScript `^5.3.0` → `^6.0.3`
- Update `tsconfig.json` `moduleResolution` from deprecated `node` to `bundler` (TypeScript 6 deprecates `node`/`node10`)
- Bump CI Node.js 20 → 22 LTS
- Update Three.js in demo from `0.170.0` → `0.184.0`

## 0.1.1

- Add wildcard subpath export (`"./dist/*"`) for deep imports

## 0.1.0

Initial release.

- STL, OBJ, and OFF import/export
- Mesh analysis: topology, geometry stats, issue detection
- Auto-repair pipeline: weld, remove degenerates, split vertices, fill holes, fix normals
- Web Worker support (`MeshFixWorker`) for non-blocking processing
- Main-thread API (`MeshFix`) for synchronous use
- Progress callbacks during repair
- Render data export for Three.js integration (positions, normals, indices, per-face issue flags)
