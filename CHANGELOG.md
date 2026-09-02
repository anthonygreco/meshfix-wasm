# Changelog

## 0.5.0

Three defects found from JustFixSTL user reports and GA4 telemetry.

- **Decimation no longer kills the engine.** `pmp::decimate()` can return normally having left faces that reference vertices its own `garbage_collection()` removed. This module ships `-O2` with `NDEBUG`, so PMP's `assert(idx < data_.size())` in `PropertyArray::operator[]` is compiled out, and the next traversal to read a vertex position — `getAnalysis()`, `writeRenderData()`, the exporters — indexes past the end of the property array. When the stale index falls outside linear memory that is a WASM trap, which aborts the *whole module*: every later call on the instance fails and the engine is dead until the page reloads. `decimate()` now validates connectivity before returning and rebuilds the mesh from its valid faces when needed, reporting the count in the new `DecimateResult.facesDropped`. Reproduced from a real file (20,334 triangles, delta-debugged to 13 — `__tests__/fixtures/corrupting-decimate.stl`) and corroborated by GA4, where 276 of 1,740 decimate attempts over 90 days ended in a WASM abort, the failure rate climbing from 2.0% under 1k faces to 30.6% at 100–250k.
- **NaN and infinite coordinates are rejected at import.** `CompareVec3`, the STL weld map's comparator, orders with `<`, and every comparison against NaN is false — so a NaN key compares equivalent to whatever it meets in the tree, violating `std::map`'s ordering requirement and welding unrelated positions together. A sphere carrying NaN on one triangle in 23 collapsed to a single vertex and zero faces, and still reported a successful load. Non-finite values also survived load, repair and export intact, giving the downloaded file an infinite bounding box that slicers reject as larger than the build volume. The STL and PLY readers now drop such triangles at source, PMP-read formats (OBJ, OFF) are swept after load, and the count is available from `nonFiniteFacesRemoved()`. A file with no finite faces now fails to load rather than loading empty.
- **`fillHoles()` no longer seals deliberate geometry.** It filled every boundary loop under `maxEdges`, which is a size test, not an intent test — harmless on a watertight solid, where a designed bore is closed geometry and never a boundary loop, and wrong on an open shell, where a bore, a slot and the part's own outer perimeter all are. Loops that are unmistakably machined openings (large, flat, round), or that span most of the model (an open shell's outer edge), are now left alone and counted in `FillHolesResult.holesSkippedAsFeature`. The thresholds are deliberately lopsided — leaving real damage unfilled is a worse failure than filling a feature, and filling everything is what the old behaviour did — so on the labelled test corpus this fills 7/7 damage cases (0 missed) while preserving 10/13 features, against 0/13 before. `fillHolesEx(maxEdges, fillFeatures)` overrides the decision, and `describeHoles()` returns the per-loop measurements behind it, so a caller can show the user what was kept and offer to fill it anyway.
- **PLY face indices are bounds-checked.** A face naming a vertex index the file does not define read past the end of the vertex vector.
- 19 new tests: `decimate-corruption.test.ts`, `non-finite.test.ts`, `hole-classification.test.ts`.

### API additions

- `DecimateResult.facesDropped`
- `FillHolesResult.holesSkippedAsFeature`
- `fillHoles(maxEdges, fillFeatures)` on `MeshFix` and `MeshFixWorker`
- `describeHoles(): HoleInfo[]`, and the `HoleInfo` type
- `nonFiniteFacesRemoved(): number`

`fillHoles()` changes behaviour by default: a caller relying on every boundary loop being filled should now pass `fillFeatures: true`.

## 0.3.0

- **Decimate**: `decimate(options)` reduces the triangle count of a mesh using PMP Library's QEM (Quadric Error Metric) decimator. Accepts `targetVertices`, `targetFaces` (converted via V = ⌈(F+4)/2⌉), or `targetRatio` (fraction of current vertex count). Optional quality constraints: `hausdorffError` (maximum deviation from original surface in model units — the print-tolerance bound), `normalDeviation` (max face-normal deviation in degrees), and `aspectRatio` (minimum triangle aspect ratio). Quads are auto-triangulated before decimation. Early stop (constraints prevent reaching target) is not an error — `reachedTarget: false` in the result indicates this. Exposed on `MeshFix` (sync), `MeshFixWorker` (async), and the raw `MeshAnalyzer` Embind class.
- **High-poly test shapes**: `loadTestShape("icosphereN")` now accepts levels 0–7 (e.g. `"icosphere6"` = 81,920 faces, `"icosphere7"` = 327,680 faces). Bare `"icosphere"` stays level 3 for back-compat.
- WASM binary grows ~162KB (decimation.cpp + triangulation.cpp linked in).
- 34 new tests: 15 in `decimate.test.ts`, 2 in `decimate-stress.test.ts` (icosphere6 default; icosphere7 gated on `MESHFIX_SLOW=1`), 8 in `decimate-spike.test.ts`, 1 in `shapes.test.ts`.

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
