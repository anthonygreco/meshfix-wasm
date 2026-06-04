# Changelog

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
