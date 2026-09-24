// Run the site's pre-fill steps with the 0.5.0 engine, then print the engine's own per-loop
// measurements (describeHoles) and export the pre-fill mesh so loops.mjs can measure depth.
import { createRequire } from "node:module"; import { readFileSync, writeFileSync } from "node:fs";
const E = "/home/node/repos/meshfix-wasm/research/2026-09-23-repair-batch/engines/0.5.0/";
const m = await createRequire(import.meta.url)(E + "core.cjs")({ locateFile: p => p.endsWith(".wasm") ? E + "core.wasm" : p });
const DIR = process.env.HOME + "/.vaxis-backups/models/";
for (const f of process.argv.slice(2)) {
  const a = new m.MeshAnalyzer(); m.FS.writeFile("/tmp/i.stl", readFileSync(DIR + f)); a.loadFromFile("/tmp/i.stl");
  a.weldVertices(1e-6); const mid = a.getAnalysis(); if (!mid.isWatertight) a.removeDegenerates(1e-10); a.splitVertices();
  const an = a.getAnalysis();
  const d = Math.hypot(an.dimX, an.dimY, an.dimZ);
  console.log(`\n=== ${f}  meshDiag=${d.toFixed(1)} comps=${an.connectedComponents} loops=${an.boundaryLoops}`);
  for (const h of JSON.parse(a.describeHoles())) console.log(`  edges=${h.edges} diameter=${h.diameter.toFixed(1)} (${(100*h.diameter/d).toFixed(0)}% diag) planarDev=${h.planarDeviation.toFixed(3)} radiusVar=${h.radiusVariation.toFixed(3)} edgeVar=${h.edgeVariation.toFixed(3)} deliberate=${h.looksDeliberate}  ${h.looksDeliberate ? (h.diameter >= 0.6*d ? "<- outer-edge rule (>=60% diag)" : "<- round-opening rule") : ""}`);
  a.exportMesh("/tmp/o.stl"); writeFileSync("prefill-" + f, m.FS.readFile("/tmp/o.stl"));
}
