# Changelog

## 0.1.0

Initial release.

- STL, OBJ, and OFF import/export
- Mesh analysis: topology, geometry stats, issue detection
- Auto-repair pipeline: weld, remove degenerates, split vertices, fill holes, fix normals
- Web Worker support (`MeshFixWorker`) for non-blocking processing
- Main-thread API (`MeshFix`) for synchronous use
- Progress callbacks during repair
- Render data export for Three.js integration (positions, normals, indices, per-face issue flags)
