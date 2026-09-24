// Load with the 0.5.0 engine, run weld -> guarded removeDegenerates -> splitVertices, export STL (the exact mesh fillHoles sees).
import { createRequire } from "node:module"; import { readFileSync, writeFileSync } from "node:fs";
const E = "/home/node/repos/meshfix-wasm/research/2026-09-23-repair-batch/engines/0.5.0/";
const m = await createRequire(import.meta.url)(E + "core.cjs")({ locateFile: p => p.endsWith(".wasm") ? E + "core.wasm" : p });
for (const f of process.argv.slice(2)) { const a = new m.MeshAnalyzer(); m.FS.writeFile("/tmp/i.stl", readFileSync(f)); a.loadFromFile("/tmp/i.stl"); a.weldVertices(1e-6); if (!a.getAnalysis().isWatertight) a.removeDegenerates(1e-10); a.splitVertices(); a.exportMesh("/tmp/o.stl"); writeFileSync("prefill/" + f.split("/").pop(), m.FS.readFile("/tmp/o.stl")); a.delete(); }
