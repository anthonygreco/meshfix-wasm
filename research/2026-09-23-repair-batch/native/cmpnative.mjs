// Per-file no-worse check between two native-harness jsonl sets (files may be several jsonl chunks).
// usage: node cmpnative.mjs "<base glob-ish list>" "<new list>"   (comma-separated file lists)
import { readFileSync } from "node:fs"; import { basename } from "node:path";
const load = list => { const m = {}; for (const f of list.split(",")) for (const l of readFileSync(f, "utf8").split("\n")) { if (!l.trim()) continue; const r = JSON.parse(l); m[basename(r.file)] = r; } return m; };
const [A, B] = process.argv.slice(2).map(load);
const flagsOf = (a, b) => {
  const F = [], G = [];
  if (a.outcome !== "completed" || b.outcome !== "completed") { if (a.outcome !== b.outcome) F.push(`outcome ${a.outcome} -> ${b.outcome}${b.err ? " (" + b.err + ")" : ""}`); return [F, G]; }
  const x = a.after, y = b.after;
  if (x.wt && !y.wt) F.push("LOST watertight");
  if (y.holes > x.holes) F.push(`holes ${x.holes}->${y.holes}`);
  if (y.comps > x.comps) F.push(`comps ${x.comps}->${y.comps}`);
  if (y.degen > x.degen) F.push(`degen ${x.degen}->${y.degen}`);
  if (y.nmV > x.nmV) F.push(`nmV ${x.nmV}->${y.nmV}`);
  if (y.dup > x.dup) F.push(`dup ${x.dup}->${y.dup}`);
  // Volume of a watertight input must survive the new build's repair; the two builds may measure volume differently, so each is checked against its own "before".
  const dv = r => Math.abs(r.after.vol - r.before.vol) > 0.05 + 1e-4 * Math.abs(r.before.vol);
  if (b.before.wt && dv(b)) F.push(`VOLUME changed by repair (watertight input) ${b.before.vol}->${b.after.vol}${a.before.wt && dv(a) ? " (base also: " + a.before.vol + "->" + a.after.vol + ")" : " (base kept it)"}`);
  if (!x.wt && y.wt) G.push("now watertight");
  if (y.holes < x.holes) G.push(`holes ${x.holes}->${y.holes}`);
  if (y.comps < x.comps) G.push(`comps ${x.comps}->${y.comps}`);
  if (y.degen < x.degen) G.push(`degen ${x.degen}->${y.degen}`);
  return [F, G];
};
let worse = [], better = [], same = 0, missing = [];
for (const f of Object.keys(A).sort()) { const a = A[f], b = B[f]; if (!b) { missing.push(f); continue; } const [F, G] = flagsOf(a, b); if (F.length) worse.push(`${f}: ${F.join(", ")}${G.length ? " | gains: " + G.join(", ") : ""}`); else if (G.length) better.push(`${f}: ${G.join(", ")}`); else same++; }
const sum = (m, k) => Object.values(m).filter(r => r.outcome === "completed").reduce((s, r) => s + r.after[k], 0);
const cnt = (m, fn) => Object.values(m).filter(fn).length;
console.log(`files: base ${Object.keys(A).length} new ${Object.keys(B).length}   same ${same}  better ${better.length}  worse-or-changed ${worse.length}  missing-in-new ${missing.length}`);
console.log(`outcomes base: ${JSON.stringify(Object.values(A).reduce((o, r) => (o[r.outcome] = (o[r.outcome] || 0) + 1, o), {}))}  new: ${JSON.stringify(Object.values(B).reduce((o, r) => (o[r.outcome] = (o[r.outcome] || 0) + 1, o), {}))}`);
console.log(`open inputs closed: base ${cnt(A, r => r.outcome === "completed" && !r.before.wt && r.after.wt)}/${cnt(A, r => r.outcome === "completed" && !r.before.wt)}  new ${cnt(B, r => r.outcome === "completed" && !r.before.wt && r.after.wt)}/${cnt(B, r => r.outcome === "completed" && !r.before.wt)}`);
console.log(`sums after: holes base ${sum(A, "holes")} new ${sum(B, "holes")}; degen base ${sum(A, "degen")} new ${sum(B, "degen")}; watertight after base ${cnt(A, r => r.outcome === "completed" && r.after.wt)} new ${cnt(B, r => r.outcome === "completed" && r.after.wt)}`);
for (const l of worse) console.log("  CHANGED", l);
if (process.env.SHOW_BETTER) for (const l of better) console.log("  BETTER ", l);
for (const f of missing) console.log("  MISSING", f);
