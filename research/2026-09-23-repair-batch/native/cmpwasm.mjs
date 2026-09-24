// Per-file no-worse check: new build vs shipped 0.5.0 results from the site-path harness.
import { readFileSync } from "node:fs";
const [base, next] = process.argv.slice(2);
const load = f => Object.fromEntries(readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse).map(r => [r.file, r]));
const A = load(base), B = load(next);
const K = ["nonManifoldVertexCount","nonManifoldEdgeCount","degenerateTriangleCount","duplicateFaceCount","holeCount","flippedNormalCount","isolatedVertexCount"];
const d = a => K.reduce((s,k)=>s+(a[k]||0),0)+(a.isWatertight?0:1);
let worse = [], better = [], same = 0, other = [];
for (const f of Object.keys(A)) {
  const a = A[f], b = B[f];
  if (!b) { other.push(f + ": missing in new"); continue; }
  if (a.outcome !== "completed" || b.outcome !== "completed") { if (a.outcome !== b.outcome) other.push(`${f}: outcome ${a.outcome} -> ${b.outcome}`); else same++; continue; }
  const x = a.after, y = b.after;
  const flags = [];
  if (x.isWatertight && !y.isWatertight) flags.push("LOST watertight");
  if (y.connectedComponents > x.connectedComponents) flags.push(`comps ${x.connectedComponents}->${y.connectedComponents}`);
  if (d(y) > d(x)) flags.push(`defects ${d(x)}->${d(y)}`);
  for (const k of K) if ((y[k]||0) > (x[k]||0)) flags.push(`${k.replace("Count","")} ${x[k]}->${y[k]}`);
  if (Math.abs(y.volume - x.volume) > 1e-3 * Math.max(1, Math.abs(x.volume))) flags.push(`volume ${x.volume.toFixed(1)}->${y.volume.toFixed(1)}`);
  const gains = [];
  if (!x.isWatertight && y.isWatertight) gains.push("now watertight");
  if (d(y) < d(x)) gains.push(`defects ${d(x)}->${d(y)}`);
  if (y.connectedComponents < x.connectedComponents) gains.push(`comps ${x.connectedComponents}->${y.connectedComponents}`);
  if (flags.length) worse.push(`${f}: ${flags.join(", ")}${gains.length ? " | gains: " + gains.join(", ") : ""}`);
  else if (gains.length) better.push(`${f}: ${gains.join(", ")}`);
  else same++;
}
console.log(`identical/no-change: ${same}   better: ${better.length}   worse-or-changed: ${worse.length}   other: ${other.length}`);
for (const l of better) console.log("  BETTER ", l);
for (const l of worse) console.log("  CHANGED", l);
for (const l of other) console.log("  OTHER  ", l);
