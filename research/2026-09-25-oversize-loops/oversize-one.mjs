// One file through the site's auto-repair path (MeshFix.repair order, maxHoleEdges 100),
// recording every boundary loop at the moment fillHoles sees it (after weld + split).
import { createRequire } from "node:module"; import { readFileSync } from "node:fs";
const D = "/home/node/repos/meshfix-wasm/dist/";
const m = await createRequire(import.meta.url)(D + "meshfix-core.js")();
const f = process.argv[2]; const fmt = f.split(".").pop().toLowerCase();
const a = new m.MeshAnalyzer();
m.FS.writeFile("/tmp/i." + fmt, readFileSync(f));
if (!a.loadFromFile("/tmp/i." + fmt)) { console.log(JSON.stringify({ f, err: "load" })); process.exit(0); }
a.weldVertices(1e-6); a.splitVertices();
const loops = JSON.parse(a.describeHoles());
const fill = a.fillHolesEx(100, false);
a.removeDegenerates(1e-10); a.fixNormals();
const after = a.getAnalysis();
console.log(JSON.stringify({ f, loops: loops.map(h => ({ e: h.edges, d: h.looksDeliberate, dia: +h.diameter.toFixed(2), sd: +h.shellDepth.toFixed(3), st: +h.shellThickness.toFixed(3), rv: +h.radiusVariation.toFixed(3), pd: +h.planarDeviation.toFixed(3) })),
  fill: { found: fill.holesFound, filled: fill.holesFilled, skipped: fill.holesSkipped, feat: fill.holesSkippedAsFeature, failed: fill.holesFailed },
  holesAfter: after.boundaryLoops ?? after.holes, diag: Math.hypot(after.dimX, after.dimY, after.dimZ) }));
