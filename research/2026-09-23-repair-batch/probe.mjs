import { createRequire } from "node:module"; import { readFileSync } from "node:fs";
const m = await createRequire(import.meta.url)("./meshfix-core.cjs")({ locateFile: p => "/home/node/repos/justfixstl.com/tool-site/public/meshfix/meshfix-core.wasm" });
for (const f of process.argv.slice(2)) { const a = new m.MeshAnalyzer(); m.FS.writeFile("/tmp/i.stl", readFileSync(process.env.HOME+"/.vaxis-backups/models/"+f)); a.loadFromFile("/tmp/i.stl");
  const s = x => `wt=${x.isWatertight} comps=${x.connectedComponents} holes=${x.holeCount} nmE=${x.nonManifoldEdgeCount} degen=${x.degenerateTriangleCount}`;
  console.log(f, "before:", s(a.getAnalysis())); a.weldVertices(1e-6); console.log("   after weld:", s(a.getAnalysis())); }
