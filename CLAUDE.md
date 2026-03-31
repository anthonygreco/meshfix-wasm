# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Client-side 3D mesh repair library. PMP Library (C++) compiled to WebAssembly via Emscripten, with TypeScript API for browser use. Supports STL/OBJ/OFF import and export, mesh analysis, and automated repair pipeline.

## Build Commands

```bash
# First-time setup: install Emscripten SDK
bash scripts/install-emsdk.sh

# Build WASM (C++ → dist/meshfix-core.js + .wasm)
bash scripts/build-wasm.sh

# Build TypeScript (src/ → dist/)
npm run build:ts

# Full build (WASM + TypeScript)
npm run build

# Clean rebuild (needed when compile flags change)
rm -rf build && bash scripts/build-wasm.sh

# Serve for testing (tests are browser-based HTML pages)
npm run serve
# Then open http://localhost:8080/tests/index.html
```

## Testing

Tests run in the browser, not Node.js. Start the dev server with `npm run serve`, then:
- `tests/index.html` — hub page linking to all test pages
- `tests/main-tests.html` — automated main-thread tests (28 tests)
- `tests/worker-tests.html` — automated worker tests (25 tests)
- `tests/demo.html` — interactive demo with 3D viewport

## Architecture

**C++ layer** (`cpp/bindings.cpp`): Single file containing all Embind bindings, mesh I/O, analysis, repair operations, and render data export. Uses PMP Library for half-edge mesh data structure and geometry processing. Custom `read_stl_robust()` wraps `add_face()` in try-catch to skip non-manifold faces instead of aborting.

**TypeScript layer** (`src/`): Two parallel APIs — `MeshFix` (synchronous, main thread) and `MeshFixWorker` (async, Web Worker). Both expose identical operations: analyze, weld, removeDegenerates, fixNormals, fillHoles, splitVertices, repair, exportMesh, toRenderData.

**Key data flow**: JS writes file bytes to Emscripten MEMFS → C++ reads via file path → processes mesh → writes results back to MEMFS → JS reads output. Render data uses a packed binary format: `[uint32 nV][uint32 nIdx][float32 positions][float32 normals][uint32 indices][uint8 faceFlags]`.

**Worker communication**: `worker-bridge.ts` provides promise-based RPC over `postMessage`. `worker.ts` is a classic worker script (no import/export). `worker-client.ts` wraps the bridge in the `MeshFixWorker` class.

**Repair pipeline order**: weld → removeDegenerates → splitVertices → fillHoles → fixNormals. Order matters: fixNormals must run after fillHoles to orient newly-closed components.

## Key Files

| File | Purpose |
|------|---------|
| `cpp/bindings.cpp` | All C++ logic: Embind bindings, I/O, analysis, repairs |
| `cpp/CMakeLists.txt` | WASM build config with critical flags |
| `src/index.ts` | MeshFix class (main thread API) + re-exports |
| `src/types.ts` | TypeScript interfaces (MeshStats, MeshAnalysis, RenderData, etc.) |
| `src/worker-client.ts` | MeshFixWorker class (async worker API) |
| `src/worker-bridge.ts` | Promise-based postMessage RPC |
| `src/worker.ts` | Worker script (classic, no import/export) |
| `src/issues.ts` | buildIssues() — shared issue detection logic |

## Design Decisions

- **Single C++ file**: All logic in `cpp/bindings.cpp` — Embind bindings, I/O, analysis, repairs, render data. No separate `.h/.cpp` modules.
- **Flat C++ structs, not vectors**: Embind `register_vector` is clunky. C++ returns flat int fields (`nonManifoldVertexCount`, etc.); TypeScript's `buildIssues()` maps these to `MeshIssue[]`.
- **Non-manifold edges don't exist in loaded meshes**: The fault-tolerant STL reader skips faces that would create them. Only non-manifold vertices (bowties) need splitting.
- **PMP v3.0.0 has no `connected_components()`**: Implemented via BFS with `face_property<int>`.
- **Worker is stateful**: Holds persistent `analyzer` instance with sequential message processing. ArrayBuffers are transferred (zero-copy, detached after send).
- **Test shapes**: Built-in shapes generated in C++ — `icosphere`, `torus`, `tetrahedron`, `bowtie` (two open triangle fans sharing a vertex).

## Critical Build Details

- **PMP Library v3.0.0** as git submodule at `third_party/pmp-library/` — requires C++20
- **Emscripten 5.0.1** installed locally at `./emsdk/` (gitignored)
- `-fexceptions` must be on BOTH compile and link flags (PMP's setting doesn't propagate)
- `-sEXPORT_EXCEPTION_HANDLING_HELPERS=1` required for `getExceptionMessage()` in JS
- `-sEXPORTED_RUNTIME_METHODS=['FS','getExceptionMessage']` exposes both FS and exception helpers
- CMake flag is `PMP_BUILD_VIEWERS` (not `PMP_BUILD_VIS`)
- PMP's `--no-heap-copy` flag removed (deprecated in Emscripten 5.x)
- Root `package.json` has `"type": "module"` — browser works fine, Node.js ESM may conflict
- PMP's `fill_hole()` replaced with simple fan triangulation (PMP's Delaunay refinement crashes in WASM on complex boundaries)
- WASM output: ~106KB JS + ~425KB WASM
