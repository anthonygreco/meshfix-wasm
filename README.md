# meshfix-wasm

Client-side 3D mesh repair for the browser. Fixes broken STL, OBJ, and OFF files so they load cleanly in slicers like PrusaSlicer, Cura, and OrcaSlicer.

Built on [PMP Library](https://www.pmp-library.org/) compiled to WebAssembly.

See it in action at [www.justfixstl.com](https://www.justfixstl.com). All processing runs locally in the browser, no server, no uploads.

## Install

```bash
npm install meshfix-wasm
```

## Quick Start

```typescript
import { MeshFixWorker } from "meshfix-wasm";

// Initialize (loads WASM in a Web Worker)
const meshfix = await MeshFixWorker.init();

// Load an STL file
const buffer = await fetch("model.stl").then((r) => r.arrayBuffer());

// Analyze
const { analysis, issues } = await meshfix.analyzeDetailed(buffer);
console.log(`${analysis.vertexCount} vertices, ${analysis.faceCount} faces`);
console.log(`Issues: ${issues.map((i) => i.message).join(", ") || "none"}`);

// One-click repair
const result = await meshfix.repair();
console.log(`Vertices: ${result.verticesBefore} → ${result.verticesAfter}`);
console.log(`Faces: ${result.facesBefore} → ${result.facesAfter}`);

// Export repaired mesh
const repaired = await meshfix.exportMesh("stl");
const blob = new Blob([repaired], { type: "application/octet-stream" });

// Clean up
meshfix.dispose();
```

## API

### `MeshFixWorker` (recommended)

Runs all processing in a Web Worker so the UI stays responsive.

```typescript
const meshfix = await MeshFixWorker.init(options?);
```

**Init options:**

| Option | Type | Description |
|--------|------|-------------|
| `workerUrl` | `string \| URL` | Custom worker script URL |
| `coreUrl` | `string` | Custom meshfix-core.js URL |
| `wasmUrl` | `string` | Custom .wasm file URL |

**Methods:**

| Method | Returns | Description |
|--------|---------|-------------|
| `analyze(buffer)` | `MeshStats` | Basic geometry stats |
| `analyzeDetailed(buffer)` | `{ analysis, issues }` | Full topology analysis with issue detection |
| `repair(options?, onProgress?)` | `RepairResult` | Auto-repair pipeline |
| `weldVertices(epsilon?)` | `WeldResult` | Merge duplicate vertices |
| `removeDegenerates(minArea?)` | `RemoveDegeneratesResult` | Drop duplicate faces; collapse or flip zero-area triangles |
| `splitVertices()` | `SplitVerticesResult` | Fix non-manifold (bowtie) vertices |
| `fillHoles(maxEdges?, fillFeatures?)` | `FillHolesResult` | Fill boundary loops (designed openings kept unless `fillFeatures`) |
| `describeHoles()` | `HoleInfo[]` | Per-loop measurements behind the fill decision |
| `fixNormals()` | `FixNormalsResult` | Orient inside-out components outward; cavities stay inward |
| `connectivityRebuilds()` | `number` | Times a repair step had to rebuild an invalid mesh since load (expect 0) |
| `facesDroppedByAudit()` | `number` | Faces lost to those rebuilds |
| `reanalyze()` | `{ analysis, issues }` | Re-analyze after modifications |
| `exportMesh(format?)` | `ArrayBuffer` | Export as `"stl"`, `"obj"`, or `"off"` |
| `toRenderData()` | `RenderData` | Get vertex/index buffers for 3D rendering |
| `scale(factor)` | `void` | Scale all vertex positions by a scalar factor |
| `decimate(options)` | `DecimateResult` | Reduce triangle count using QEM decimation |
| `dispose()` | `void` | Terminate worker and free memory |

### `MeshFix` (main thread)

Same API as `MeshFixWorker` but synchronous. Useful for debugging or environments without Web Workers.

```typescript
import { MeshFix } from "meshfix-wasm";
const meshfix = await MeshFix.init();
```

### Repair Options

```typescript
await meshfix.repair({
  weldEpsilon: 1e-6,   // vertex merge distance (default: 1e-6)
  minArea: 1e-10,       // degenerate face threshold (default: 1e-10)
  maxHoleEdges: 100,    // max hole size to fill (default: 100)
});
```

### Repair Pipeline

The `repair()` method runs these steps in order:

1. **Weld vertices** — merge duplicates within epsilon distance. A no-op on a closed mesh, which has no gap to close.
2. **Split vertices** — fix non-manifold (bowtie) vertices, including ones PMP's own manifold test cannot see (a second fan the vertex rotation never reaches).
3. **Fill holes** — close boundary loops with a minimum-weight triangulation. Loops that look like designed openings, or the perimeter of a genuine open shell, are left alone and counted in `holesSkippedAsFeature`; `describeHoles()` explains each, and `fillHoles(maxEdges, true)` fills them anyway.
4. **Remove degenerates** — drop duplicate faces, and remove zero-area triangles by handing the middle vertex across the longest edge (a flip, or removing a fold where two surfaces overlap), never by deleting the face and never by moving geometry; an edge is collapsed only when it is shorter than 1e-4 of the model, an invisible move. Runs after the fill so the zero-area triangles a slit seam is sealed with get stitched, chain by chain from the ends. Areas are measured in double from edge vectors, so a small part far from the origin is not reported as degenerate.
5. **Fix normals** — orient inside-out closed components outward. An internal cavity (a closed shell nested inside another) keeps facing inward; folded zero-volume sheets are ignored.

Every step audits the half-edge structure when it finishes and rebuilds the mesh from its valid faces if anything is broken; `connectivityRebuilds()` tells you if that ever happened (it should not).

### Decimation

Reduce triangle count while preserving shape, using PMP Library's QEM (Quadric Error Metric) decimator. Particularly useful for AI-generated or photogrammetry meshes that are too dense for slicers.

```typescript
// Target vertex count
const result = await meshfix.decimate({ targetVertices: 5000 });

// Target face count (converted internally via V = ⌈(F+4)/2⌉)
const result = await meshfix.decimate({ targetFaces: 10000 });

// Target ratio — keep 25% of current vertices
const result = await meshfix.decimate({ targetRatio: 0.25 });

// With print-tolerance bound: never deviate more than 0.1 model units from the original surface
const result = await meshfix.decimate({ targetRatio: 0.1, hausdorffError: 0.1 });

console.log(`${result.facesBefore} → ${result.facesAfter} faces`);
console.log(result.reachedTarget ? 'Hit target' : 'Stopped early (constraints)');
```

**Options:**

| Option | Type | Description |
|--------|------|-------------|
| `targetVertices` | `number` | Exact target vertex count. Exactly one of the three targets must be set. |
| `targetFaces` | `number` | Target face count (converted to vertices internally). |
| `targetRatio` | `number` | Fraction (0–1 exclusive) of current vertex count to keep. |
| `hausdorffError` | `number` | Max deviation from original surface in model units (0 = off). The print-tolerance bound. |
| `normalDeviation` | `number` | Max face-normal deviation in degrees (0 = off). |
| `aspectRatio` | `number` | Minimum triangle aspect ratio (0 = off). |

**Notes:**
- Quad meshes (OBJ/OFF imports, `pmp::torus()`) are auto-triangulated before decimation.
- If quality constraints prevent reaching the target, decimation stops early without error — check `result.reachedTarget`.
- Best results on repaired (watertight, manifold) meshes. Run `repair()` first when working with user-uploaded files.

### Progress Callbacks

```typescript
await meshfix.repair({}, (event) => {
  console.log(`Step ${event.stepIndex + 1}/${event.totalSteps}: ${event.step}`);
});
```

### Three.js Integration

```typescript
const renderData = await meshfix.toRenderData();

const geometry = new THREE.BufferGeometry();
geometry.setAttribute("position", new THREE.BufferAttribute(renderData.positions, 3));
geometry.setAttribute("normal", new THREE.BufferAttribute(renderData.normals, 3));
geometry.setIndex(new THREE.BufferAttribute(renderData.indices, 1));
```

The `renderData.faceFlags` field contains per-face bitmask flags for issue visualization:

| Flag | Bit | Meaning |
|------|-----|---------|
| `0x01` | Degenerate | Zero-area face |
| `0x02` | Duplicate | Identical to another face |
| `0x04` | Flipped | Normal points inward |
| `0x08` | Boundary | Face has an open edge |
| `0x10` | Non-manifold | Adjacent to a non-manifold vertex |

## Framework Integration

### Vite · React · Vue · SvelteKit

The worker script and WASM binary must be served as **static files** — they can't be bundled like a regular npm import. Two reasons:

1. **Classic Web Workers need a same-origin URL.** The `new Worker('/path/to/worker.js')` call requires a real HTTP path, not a bundled module.
2. **WASM streaming requires the correct MIME type.** `WebAssembly.instantiateStreaming()` needs `Content-Type: application/wasm`, which static servers provide automatically but bundlers often don't.

The recommended approach is a `postinstall` script that copies the three files into your `public/` directory:

```js
// scripts/copy-meshfix.js
import { copyFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(fileURLToPath(import.meta.url));
const src  = resolve(root, '../node_modules/meshfix-wasm/dist');
const dest = resolve(root, '../public/meshfix');

mkdirSync(dest, { recursive: true });
for (const f of ['worker.js', 'meshfix-core.js', 'meshfix-core.wasm']) {
  copyFileSync(`${src}/${f}`, `${dest}/${f}`);
}
```

```json
// package.json
{ "scripts": { "postinstall": "node scripts/copy-meshfix.js" } }
```

Add `public/meshfix/` to `.gitignore` — the files regenerate on every `npm install`.

If you need non-default paths, pass them to `MeshFixWorker.init()`:

```typescript
const meshfix = await MeshFixWorker.init({
  workerUrl: '/assets/meshfix/worker.js',
  coreUrl:   '/assets/meshfix/meshfix-core.js',
  wasmUrl:   '/assets/meshfix/meshfix-core.wasm',
});
```

## Browser Support

Requires browsers with WebAssembly and Web Worker support:
- Chrome 57+
- Firefox 52+
- Safari 11+
- Edge 16+

## Acknowledgments

This library uses [PMP Library](https://www.pmp-library.org/) (MIT License) by the Polygon Mesh Processing Library developers and Computer Graphics Group, RWTH Aachen.

## License

[MIT](LICENSE)
