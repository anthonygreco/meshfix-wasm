import { readFileSync } from "node:fs";
const tags = ["feb","v010","v020","v031","v050","v050-noguard"];
const load = t => Object.fromEntries(readFileSync(`res-${t}.jsonl`,"utf8").trim().split("\n").map(JSON.parse).map(r=>[r.file,r]));
const R = Object.fromEntries(tags.map(t=>[t,load(t)]));
const K = ["nonManifoldVertexCount","nonManifoldEdgeCount","degenerateTriangleCount","duplicateFaceCount","holeCount","flippedNormalCount","isolatedVertexCount"];
const d = a => K.reduce((s,k)=>s+(a[k]||0),0)+(a.isWatertight?0:1)+(a.connectedComponents>1?a.connectedComponents:0);
const sig = r => r.outcome!=="completed" ? r.outcome : `wt=${r.after.isWatertight?1:0} c=${r.after.connectedComponents} def=${d(r.after)} dg=${r.after.degenerateTriangleCount} h=${r.after.holeCount} vol=${r.before.volume?(100*(r.after.volume-r.before.volume)/Math.abs(r.before.volume)).toFixed(0):0}%`;
const files = Object.keys(R.v050);
let same = 0;
for (const f of files) { const s = tags.map(t=>R[t][f]?sig(R[t][f]):"-"); if (new Set(s).size===1) { same++; continue; }
  const b=R.v050[f].before; console.log(`\n${f}  [before: wt=${b?.isWatertight?1:0} c=${b?.connectedComponents} def=${b?d(b):"-"}]`); tags.forEach((t,i)=>console.log(`  ${t.padEnd(13)} ${s[i]}`)); }
console.log(`\n${same}/${files.length} files identical across all engines`);
// regressions per engine: watertight->not, components up, defects up
for (const t of tags) { const bad = files.filter(f=>{const r=R[t][f]; return r?.outcome==="completed" && ((r.before.isWatertight&&!r.after.isWatertight)||r.after.connectedComponents>r.before.connectedComponents||d(r.after)>d(r.before));}); console.log(`${t.padEnd(13)} worse-than-input: ${bad.length} ${bad.join(", ")}`); }
