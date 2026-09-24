import { readFileSync } from "node:fs";
const files = process.argv.slice(2);
const rows = files.flatMap(f => readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse));
const meta = JSON.parse(readFileSync("../thingi/sample-meta.json", "utf8"));
const id = r => r.file.split("/").pop().replace(".stl", "");
const by = {}; for (const r of rows) (by[r.outcome] ??= []).push(r);
console.log("OUTCOMES:", Object.entries(by).map(([k, v]) => `${k}=${v.length}`).join(" "));
for (const r of rows.filter(r => r.outcome !== "completed")) console.log("  ", id(r), r.outcome, r.err || "", "faces=" + meta[id(r)]?.faces, "cats=" + meta[id(r)]?.cats);
const done = by.completed || [];
const steps = ["load", "analyze", "weld", "midanalyze", "removeDegenerates", "splitVertices", "fillHoles", "fixNormals", "reanalyze"];
console.log("\nSLOWEST 15 (total_ms, faces, per-step ms):");
for (const r of [...done].sort((a, b) => b.total_ms - a.total_ms).slice(0, 15)) console.log("  ", id(r), r.total_ms + "ms", "faces=" + r.before.faces, steps.map(s => r[s + "_ms"] != null ? `${s}=${r[s + "_ms"]}` : "").filter(Boolean).join(" "));
// per-step: max ms per 100k faces (superlinearity hint)
console.log("\nSTEP ms per 100k input faces — max (file):");
for (const s of steps) { let best = null; for (const r of done) { const v = r[s + "_ms"]; if (v == null) continue; const k = v / (r.before.faces / 1e5); if (!best || k > best.k) best = { k, r, v }; } if (best) console.log("  ", s.padEnd(18), best.k.toFixed(0).padStart(6), "ms/100k", `(${id(best.r)} faces=${best.r.before.faces} ${best.v}ms)`); }
// worse than input
const K = ["holes", "nmV", "nmE", "degen", "dup", "flipped", "iso"];
const d = a => K.reduce((s, k) => s + (a[k] || 0), 0) + (a.wt ? 0 : 1) + (a.comps > 1 ? a.comps : 0);
const worse = done.filter(r => (r.before.wt && !r.after.wt) || r.after.comps > r.before.comps || d(r.after) > d(r.before));
console.log(`\nWORSE THAN INPUT: ${worse.length}/${done.length}`);
for (const r of worse) console.log("  ", id(r), `wt ${r.before.wt}->${r.after.wt} comps ${r.before.comps}->${r.after.comps} def ${d(r.before)}->${d(r.after)} degen ${r.before.degen}->${r.after.degen} holes ${r.before.holes}->${r.after.holes} nmV ${r.before.nmV}->${r.after.nmV} | weld merged=${r.weld.merged} skipped=${r.weld.skipped} fill filled=${r.fill.filled} failed=${r.fill.failed} feature=${r.fill.feature} fixn flipped=${r.fixn.flipped}`);
const closed = done.filter(r => !r.before.wt && r.after.wt).length, stillOpen = done.filter(r => !r.before.wt && !r.after.wt).length;
console.log(`\nOPEN INPUTS: closed by repair=${closed}, still open=${stillOpen}; feature-skips total=${done.reduce((s, r) => s + r.fill.feature, 0)} in ${done.filter(r => r.fill.feature > 0).length} files; fill failed total=${done.reduce((s, r) => s + r.fill.failed, 0)} in ${done.filter(r => r.fill.failed > 0).length} files`);
console.log(`degenerates left after repair: ${done.filter(r => r.after.degen > 0).length} files (${done.filter(r => r.after.degen > r.before.degen).length} more than input); watertight inputs with degenerates: ${done.filter(r => r.before.wt && r.before.degen > 0).length}`);
console.log(`fixNormals flipped a component in ${done.filter(r => r.fixn.flipped > 0).length} files`);
console.log(`weld tore faces (skipped>0): ${done.filter(r => r.weld.skipped > 0).length} files; on watertight inputs: ${done.filter(r => r.weld.skipped > 0 && r.before.wt).length}`);
