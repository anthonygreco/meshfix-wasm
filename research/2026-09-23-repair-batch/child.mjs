// Runs one model through the site's auto-repair path, the way worker.js does it,
// printing one JSON line per engine call so the parent can time and kill it.
import { createRequire } from "node:module"; import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const createMeshFixCore = require(process.env.CORE);
const [file, outPath] = process.argv.slice(2);
const emit = o => process.stdout.write(JSON.stringify(o) + "\n");
const m = await createMeshFixCore({ locateFile: p => p.endsWith(".wasm") ? process.env.WASM : p });
const a = new m.MeshAnalyzer();
const plain = x => JSON.parse(JSON.stringify(x, (k, v) => typeof v === "bigint" ? Number(v) : v));
const step = (call, name, fn) => { emit({ ev: "start", call, step: name }); const t = performance.now(); const r = fn(); emit({ ev: "end", call, step: name, ms: Math.round(performance.now() - t), result: plain(r) }); return r; };
const fmt = file.split(".").pop().toLowerCase();
step("analyzeDetailed", "load", () => { m.FS.writeFile("/tmp/input." + fmt, readFileSync(file)); if (!a.loadFromFile("/tmp/input." + fmt)) throw new Error(a.getLastError() || "Failed to load mesh"); m.FS.unlink("/tmp/input." + fmt); return null; });
const before = step("analyzeDetailed", "analyze", () => a.getAnalysis());
if (process.env.ORDER === "new") {
  // 0.6.0 order: weld -> split -> fill -> removeDegenerates -> fixNormals, no watertight guard
  step("repair", "weld", () => a.weldVertices(1e-6));
  step("repair", "splitVertices", () => a.splitVertices());
  step("repair", "fillHoles", () => a.fillHoles(100));
  step("repair", "removeDegenerates", () => a.removeDegenerates(1e-10));
  step("repair", "fixNormals", () => a.fixNormals());
} else {
  step("repair", "weld", () => a.weldVertices(1e-6));
  const mid = a.getAnalysis();
  step("repair", "removeDegenerates", () => (process.env.GUARD !== "0" && mid.isWatertight) ? null : a.removeDegenerates(1e-10));
  step("repair", "splitVertices", () => a.splitVertices());
  step("repair", "fillHoles", () => a.fillHoles(100));
  step("repair", "fixNormals", () => a.fixNormals());
}
const after = step("reanalyze", "reanalyze", () => a.getAnalysis());
if (outPath) step("export", "export", () => { if (!a.exportMesh("/tmp/export.stl")) throw new Error(a.getLastError() || "Failed to export mesh"); writeFileSync(outPath, m.FS.readFile("/tmp/export.stl")); return null; });
emit({ ev: "done", before: plain(before), after: plain(after) });
