// Ground-truth volume from the raw STL file (all triangles, before any reader skipping),
// compared to the engine's loaded volume and repaired volume from res-v050.jsonl.
import { readFileSync, readdirSync } from "node:fs";
const DIR = process.env.HOME + "/.vaxis-backups/models";
const R = Object.fromEntries(readFileSync("/home/node/repos/meshfix-wasm/research/2026-09-23-repair-batch/res-v050.jsonl","utf8").trim().split("\n").map(JSON.parse).map(r=>[r.file,r]));
function parseStl(buf) {
  const tris = [];
  const head = buf.subarray(0, 80).toString("latin1");
  const n = buf.readUInt32LE(80);
  const isBin = buf.length === 84 + n * 50;
  if (isBin) {
    for (let i = 0, o = 84; i < n; i++, o += 50) {
      const f = j => buf.readFloatLE(o + 12 + j * 4);
      tris.push([[f(0),f(1),f(2)],[f(3),f(4),f(5)],[f(6),f(7),f(8)]]);
    }
  } else {
    const txt = buf.toString("latin1"); const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g; let m, cur = [];
    while ((m = re.exec(txt))) { cur.push([+m[1],+m[2],+m[3]]); if (cur.length===3) { tris.push(cur); cur=[]; } }
  }
  return { tris, isBin };
}
const vol = tris => { let v=0; for (const [a,b,c] of tris) v += (a[0]*(b[1]*c[2]-b[2]*c[1]) - a[1]*(b[0]*c[2]-b[2]*c[0]) + a[2]*(b[0]*c[1]-b[1]*c[0]))/6; return v; };
console.log("file | rawTris | rawVol | loadedVol | repairedVol | loaded/raw | repaired/raw | skippedAtLoad | wt before->after");
for (const f of readdirSync(DIR).filter(f=>f.endsWith(".stl")).sort()) {
  const r = R[f]; if (!r || !r.before) continue;
  const { tris } = parseStl(readFileSync(DIR + "/" + f));
  const rv = vol(tris), lv = r.before.volume, av = r.after.volume;
  const pct = x => (100*x).toFixed(1)+"%";
  const flag = Math.abs(av/rv - 1) > 0.02 ? "  <<<" : "";
  console.log(`${f} | ${tris.length} | ${rv.toFixed(0)} | ${lv.toFixed(0)} | ${av.toFixed(0)} | ${pct(lv/rv)} | ${pct(av/rv)} | ${r.before.nonManifoldEdgeCount} | ${r.before.isWatertight?1:0}->${r.after.isWatertight?1:0}${flag}`);
}
