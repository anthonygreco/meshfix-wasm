import { readFileSync } from "node:fs";
const rows = readFileSync(new URL("results.jsonl", import.meta.url), "utf8").trim().split("\n").map(JSON.parse);
const K = ["nonManifoldVertexCount","nonManifoldEdgeCount","degenerateTriangleCount","duplicateFaceCount","holeCount","flippedNormalCount","isolatedVertexCount"];
const defects = a => a ? K.reduce((s,k)=>s+(a[k]||0),0) + (a.isWatertight?0:1) + (a.connectedComponents>1?a.connectedComponents:0) : null;
const by = {}; for (const r of rows) (by[r.outcome] ??= []).push(r);
console.log("OUTCOMES:", Object.entries(by).map(([k,v])=>`${k}=${v.length}`).join(" "));
for (const r of [...(by.timeout||[]), ...(by.crashed||[])]) console.log(`  ${r.outcome} ${r.file} (${r.mb}MB) at ${r.timeoutCall||""}/${r.timeoutStep||r.crashStep} ${r.error||""}`);
console.log("\nCOMPLETED (file | MB | faces b->a | comps b->a | watertight b->a | defects b->a | vol% | slowest step | leftover detail)");
for (const r of (by.completed||[]).sort((a,b)=>b.mb-a.mb)) {
  const b=r.before,a=r.after, slow=r.steps.reduce((m,s)=>s.ms>m.ms?s:m,{ms:-1});
  const vol = b.volume ? (100*(a.volume-b.volume)/Math.abs(b.volume)).toFixed(1) : "n/a";
  const left = K.filter(k=>a[k]>0).map(k=>`${k.replace("Count","")}=${a[k]}`).join(",");
  const fh = r.steps.find(s=>s.step==="fillHoles")?.result;
  console.log(`${r.file} | ${r.mb} | ${b.faceCount}->${a.faceCount} | ${b.connectedComponents}->${a.connectedComponents} | ${b.isWatertight}->${a.isWatertight} | ${defects(b)}->${defects(a)} | ${vol} | ${slow.step} ${slow.ms}ms | ${left}${fh&&(fh.holesFailed||fh.holesSkipped||fh.holesSkippedAsFeature)?` holes: found=${fh.holesFound} filled=${fh.holesFilled} failed=${fh.holesFailed} skipped=${fh.holesSkipped} feature=${fh.holesSkippedAsFeature}`:""}`);
}
