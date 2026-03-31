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
| `removeDegenerates(minArea?)` | `RemoveDegeneratesResult` | Remove zero-area and duplicate faces |
| `splitVertices()` | `SplitVerticesResult` | Fix non-manifold (bowtie) vertices |
| `fillHoles(maxEdges?)` | `FillHolesResult` | Fill boundary loops |
| `fixNormals()` | `FixNormalsResult` | Orient normals outward |
| `reanalyze()` | `{ analysis, issues }` | Re-analyze after modifications |
| `exportMesh(format?)` | `ArrayBuffer` | Export as `"stl"`, `"obj"`, or `"off"` |
| `toRenderData()` | `RenderData` | Get vertex/index buffers for 3D rendering |
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

1. **Weld vertices** — merge duplicates within epsilon distance
2. **Remove degenerates** — delete zero-area and duplicate faces (skipped if mesh is already watertight)
3. **Split vertices** — fix non-manifold (bowtie) vertices
4. **Fill holes** — close boundary loops with fan triangulation
5. **Fix normals** — orient all faces outward using signed volume

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
