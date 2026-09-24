import { readFileSync } from "node:fs";
const load = v => ["00","01","02","03"].flatMap(c => readFileSync(`thingi-${v}-${c}.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse));
const K = ["holes","nmV","nmE","degen","dup","flipped","iso"];
const d = a => K.reduce((s,k)=>s+(a[k]||0),0)+(a.wt?0:1)+(a.comps>1?a.comps:0);
const id = r => r.file.split("/").pop();
console.log("variant | completed | hang | worse-than-input | open->closed | still open | wt inputs kept wt | files w/ degenerates after | degenerates after (sum) | holes after (sum) | fill failed (sum) | comps up | max total_ms");
for (const v of ["rel","BF","C"]) {
  const rows = load(v), done = rows.filter(r=>r.outcome==="completed");
  const worse = done.filter(r=>(r.before.wt&&!r.after.wt)||r.after.comps>r.before.comps||d(r.after)>d(r.before));
  const s = f => done.reduce((a,r)=>a+f(r),0);
  console.log(`${v} | ${done.length} | ${rows.length-done.length} | ${worse.length} | ${done.filter(r=>!r.before.wt&&r.after.wt).length} | ${done.filter(r=>!r.before.wt&&!r.after.wt).length} | ${done.filter(r=>r.before.wt&&r.after.wt).length}/${done.filter(r=>r.before.wt).length} | ${done.filter(r=>r.after.degen>0).length} | ${s(r=>r.after.degen)} | ${s(r=>r.after.holes)} | ${s(r=>r.fill.failed)} | ${done.filter(r=>r.after.comps>r.before.comps).length} | ${Math.max(...done.map(r=>r.total_ms))}`);
}
// per-file: where do variants differ in watertightness outcome
const R = Object.fromEntries(["rel","BF","C"].map(v=>[v, Object.fromEntries(load(v).map(r=>[id(r),r]))]));
let flips = { relOnly:0, cOnly:0 };
for (const f of Object.keys(R.rel)) { const a=R.rel[f], c=R.C[f]; if(!a?.after||!c?.after) continue; if(a.after.wt&&!c.after.wt) flips.relOnly++; if(!a.after.wt&&c.after.wt) flips.cOnly++; }
console.log("\nwatertight after: only shipped =", flips.relOnly, " only prototype C =", flips.cOnly);
// worse-than-input breakdown for C: reasons
const doneC = load("C").filter(r=>r.outcome==="completed");
const worseC = doneC.filter(r=>(r.before.wt&&!r.after.wt)||r.after.comps>r.before.comps||d(r.after)>d(r.before));
console.log("C worse-than-input reasons: comps up =", worseC.filter(r=>r.after.comps>r.before.comps).length, " defects up =", worseC.filter(r=>d(r.after)>d(r.before)).length, " wt lost =", worseC.filter(r=>r.before.wt&&!r.after.wt).length, " (comps-up only, everything else better:", worseC.filter(r=>r.after.comps>r.before.comps && d(r.after)-(r.after.comps>1?r.after.comps:0) <= d(r.before)-(r.before.comps>1?r.before.comps:0)).length, ")");
