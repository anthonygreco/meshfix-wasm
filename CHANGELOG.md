# Changelog

## 0.6.0

Repair pipeline overhaul, driven by the 2026-09-23 study in `research/2026-09-23-repair-batch/` (GA4, a 217-model Thingiverse sample, and a native build of the pipeline with PMP's asserts live).

- **The 300s repair timeout is fixed.** `fillHoles()` handed `pmp::add_face()` a triangle with a repeated vertex whenever a boundary loop passed through the same vertex twice; PMP accepts that without throwing and links a face whose ring never closes, so the next face circulator — `fixNormals()`, `getAnalysis()`, PMP's own `add_face()` — spun forever. In production this was 285 of 2,936 repairs since Sep 2 (22–27% of repairs on meshes with 7+ issue categories), all desktop, none under 10k faces. Such loops are now split into simple sub-loops before filling, and no triangle with a repeated vertex ever reaches PMP. The vertices behind it — a second fan that PMP's vertex rotation never reaches, so `is_manifold()` calls the vertex manifold — are now found by a global test (`nonManifoldVertexMask()`), reported by the analysis, and split by `splitVertices()`, whose fans are clustered by face adjacency instead of by walking the rotation. Fixture: `__tests__/fixtures/pinched-boundary-loop.stl` (13 faces from Thingiverse 197005).
- **"memory access out of bounds" traps are fixed.** `removeDegenerates()` deleted faces in place with `pmp::delete_face()`, which on a non-manifold mesh leaves halfedges pointing at vertices `garbage_collection()` then removes. It now rebuilds from the surviving faces, the path weld and split already used. Fixtures: `stale-vertex-handles.stl`, `stale-vertex-handles-2.stl` (8 and 9 faces from Thingiverse 815482 and 73177).
- **Every repair operation audits the half-edge structure when it finishes** (`connectivityIsValid()`, now also checking halfedge links, vertex rotations and boundary chains) and rebuilds from the valid faces if it fails, so no later call can hang or trap. `connectivityRebuilds()` and `facesDroppedByAudit()` report whether that ever happened; on 277 test files it never does. The four unguarded traversal loops in the analysis and split have step caps.
- **Weld is a no-op on a closed mesh.** It has no gap to close; merging two interior vertices within epsilon only pinches the surface, which `add_face()` refuses, tearing it open (organizer.stl: one merge, six faces lost, watertight → open).
- **Holes are filled with a minimum-weight triangulation** (Barequet–Sharir, O(n³), loops up to 200 edges) instead of a fan. A fan failed whenever a chord from its apex was already an interior edge and produced a zero-area triangle whenever three boundary vertices were collinear. On the wild sample, open inputs closed by repair went from 25 to 108 of 136, and boundary loops left after repair from 3,019 to 86.
- **Degenerate triangles are collapsed, flipped or re-triangulated, never deleted, and never in a way that moves geometry.** Deleting a zero-area face opened holes (one wild model went 23 → 113). A needle collapses its shortest edge; a cap flips its longest edge or has the face across it re-triangulated through the middle vertex (the T-junction stitch). `removeDegenerates()` now runs after the fill, on closed meshes too. Both halves of a duplicate "pillow" are dropped. Leftover zero-area triangles on the wild sample: 50,777 → 5,779 (they are cosmetic; on 5 of 217 files the count is higher than before because far more loops now get filled and some slit fills cannot be resolved without moving geometry).
- **The hole classifier no longer refuses a solid missing one face.** The "outer edge of an open shell" exemption (loop ≥ 60% of the model diagonal) also matched a box or prism with an end cap dropped by a boolean, and left it open — four of sixty local models regressed this way in 0.5.0. The exemption now also requires the loop's component to lie within 0.10 × diameter of the loop's plane and to enclose a mean thickness under 0.02 × diameter when capped; measured shells sit at 0.01–0.08 and solids at 0.15–0.31. The round-opening rule needs the opening to be at least 2% of the model diagonal, so a finely tessellated pinprick at the tip of a cone is no longer kept open. `HoleInfo` gains `shellDepth` and `shellThickness`.
- **`fixNormals()` no longer turns an internal cavity into a solid.** A closed shell nested inside another (ray-parity test, bounding-box prefiltered) keeps facing inward; dugout-bottom.stl kept its 3,024 mm³ void instead of gaining it as volume. Signed volumes are summed in double about a point on the component, so folded zero-volume sheets are no longer flipped back and forth on rounding noise; the analysis's `flippedNormalCount` uses the same test, so what it reports is what `fixNormals()` fixes.
- **Lone flaps are dropped rather than sealed** into a zero-thickness pillow (`FillHolesResult.flapsRemoved`), and duplicate pillows lose both halves.
- Repair pipeline order is now weld → splitVertices → fillHoles → removeDegenerates → fixNormals, and the watertight guard on `removeDegenerates` in `MeshFix.repair()` / `MeshFixWorker.repair()` is gone (it is safe on a closed mesh now). `RepairResult.removeDegenerates` is never `null`.
- 22 new tests: `repair-integrity.test.ts`, and four in `hole-classification.test.ts`.

Follow-up, 2026-09-24 (the seven files that ended with more zero-area triangles than 0.5.0: fan.stl, connector.stl, test2.stl, Thingiverse 697602, 73177, 41939, 66375, 815482):

- **Zero-area triangles are now measured correctly.** `pmp::face_area()` sums the cross products of the absolute positions in float, so for a small face far from the origin the true area is lost in the rounding of terms the size of |p|²: on Thingiverse 815482 (coordinates ~50, triangles 0.003 wide) it returned exactly 0 for triangles whose area is 3.5e-6, and several times the true area for their neighbours. Every zero-area decision — `degenerateTriangleCount`, the render-data degenerate flag, and what `removeDegenerates()` works on — now uses the edge vectors about the face's first vertex in double. The raw file 73177 reported 2,384 zero-area triangles and has 0; 815482 reported 321 and has 0. Most of what the committed build left on those files, and most of what it "fixed" on them, was this: real triangles being flipped and collapsed because they computed as zero.
- **A slit seam is stitched to zero.** `removeDegenerates()` cycled on a chain of collinear fill triangles — flipping the middle vertex of one across into the next and back, fan.stl went 8 → 9 → 8 leftovers for ever, because a triangle whose three vertices lie on one line comes out with an area of 0 or a few float ulps at random and only the exact zeros were being worked on. A triangle now counts as collinear when its apex sits within four ulps of the coordinates of its longest side; a cap whose neighbour across that side is itself collinear waits, so a chain is eaten from its ends where it borders the real surface, one triangle per pass, and a fix is only made when both triangles it produces have area. Two fill triangles that share their common longest edge (both apexes inside it) are flipped to the strictly shorter chord so they can reach the surface. fan.stl, connector.stl, test2.stl: 0 zero-area triangles (were 9, 22, 6), volumes unchanged to the last digit.
- **A zero-area triangle on a fold is resolved.** Where the edge M–D already exists and one half, (M, B, D) or (A, M, D), is already a face, that face coincides with half of the face across, wound the other way — the seam where two surfaces overlap. The cap, the face across and that layer go and only the missing half is added; the fourth vertex, which had no other face, goes with them. Nothing moves and the signed volume is unchanged. A restore-on-failure guard stays, and re-creates the dropped vertex if `pmp::delete_face()` had marked it deleted, since adding a face on a deleted vertex corrupts the mesh.
- **No repair moves a vertex any more.** A needle used to be collapsed along its shortest edge whatever that edge's length; with the area measured correctly that reached needles with 1–3 unit edges on Thingiverse 41086 and cost 0.3% of its volume, and the committed build had already changed the volume of watertight 51354, 51355, 138194 and 78618 the same way (+0.06%, +0.06%, +0.01%, −0.02%). A collinear triangle is now first handed across its longest edge, which moves nothing, and collapsed only when the edge is under 1e-4 of the model diagonal. Every watertight input in the wild sample now keeps its volume exactly; the price is that a needle neither can resolve is left (138194 keeps 15).
- 3 new tests in `repair-integrity.test.ts`: the interleaved slit seam, the fold, and a 0.003 mm part 64 mm from the origin.

Measured on the 217-model wild sample against the committed build: zero-area triangles left 5,779 → 67 (exact count on the exported meshes: 914 → 67; counted PMP's way the final build leaves 42,856 against 5,878, real triangles the old formula misreads), holes left 86 → 86, open inputs closed 108/136 → 108/136, watertight inputs keeping their volume 76/80 → 80/80. Component counts rise on five files (73177 29 → 31, 135793 2 → 3, 197005 13 → 14, 441709 21 → 22, 85537 155 → 156) because the committed build collapsed away specks of 2–8 real triangles (areas 1e-6 to 1e-4) that computed as zero; they are kept now. Held-out check on 300 Thingi10K models never used before, an ASan/UBSan sweep of them, and 300 randomly damaged wild files: `research/2026-09-23-repair-batch/RESULTS.md`.

Measured on the 217-model wild sample (native build): repairs ending worse than input 41 → 0, hangs 1 → 0, structural corruption 3 → 0 files, watertight inputs kept watertight 80/80 with their volumes unchanged, component count never up. On the 60-model local corpus through the site's exact path against 0.5.0: 21 files better, 32 unchanged, none lost watertightness or gained holes; the only counts that rose are zero-area triangles on connector.stl (16 → 22, now watertight) and organizer.stl (0 → 1, no longer torn open). The full test matrix — vitest, the ASan/UBSan native build over the local corpus, the connectivity audit after every step over every file — is in `research/2026-09-23-repair-batch/native/`.

### API additions

- `connectivityRebuilds(): number`, `facesDroppedByAudit(): number` on `MeshFix`, `MeshFixWorker` and the raw `MeshAnalyzer`
- `FillHolesResult.flapsRemoved`
- `HoleInfo.shellDepth`, `HoleInfo.shellThickness`

### Behaviour changes

- `removeDegenerates()` no longer deletes zero-area faces; `degenerateRemoved` counts triangles collapsed, flipped or re-triangulated away. A face none of those can handle is left as it was.
- `weldVertices()` returns immediately on a mesh with no boundary edges.
- `fillHoles()` fills loops it used to skip (solids missing a face, tiny openings) and refuses to seal a lone flap.
- `fixNormals()` leaves nested inward-facing shells and zero-volume sheets alone.
- `nonManifoldVertexCount` can be higher than before on the same mesh: it now includes vertices PMP's own test could not see.

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
