// Delta-debug an STL to the smallest face subset that still trips the connectivity audit.
// usage: node ddmin.mjs <in.stl> <out.stl> <predicate-regex> [limitSec]
import { readFileSync, writeFileSync } from "node:fs"; import { spawnSync } from "node:child_process";
const [inp, outp, predRe, lim = "30"] = process.argv.slice(2);
const buf = readFileSync(inp); const n = buf.readUInt32LE(80); let faces = [];
for (let i = 0, o = 84; i < n; i++, o += 50) faces.push(buf.subarray(o, o + 50));
// spatial order so chunks are coherent
const cx = f => f.readFloatLE(12) + f.readFloatLE(24) + f.readFloatLE(36);
// file order preserved: the loader adds faces in file order and the corrupting configuration depends on it
const write = (fs, p) => { const b = Buffer.alloc(84 + fs.length * 50); b.writeUInt32LE(fs.length, 80); fs.forEach((f, i) => f.copy(b, 84 + i * 50)); writeFileSync(p, b); };
const re = new RegExp(predRe); let trials = 0;
const test = fs => { write(fs, outp + ".try.stl"); trials++; const r = spawnSync("./harness-check", [outp + ".try.stl", lim], { encoding: "utf8", maxBuffer: 1 << 26 }); return re.test((r.stdout || "") + (r.stderr || "")); };
if (!test(faces)) { console.log("predicate false on input"); process.exit(1); }
let gran = 2;
while (faces.length >= 2) {
  const size = Math.ceil(faces.length / gran); let reduced = false;
  for (let i = 0; i < gran; i++) {
    const complement = [...faces.slice(0, i * size), ...faces.slice((i + 1) * size)];
    if (complement.length && test(complement)) { faces = complement; gran = Math.max(gran - 1, 2); reduced = true; console.log(`faces=${faces.length} trials=${trials}`); break; }
  }
  if (!reduced) { if (gran >= faces.length) break; gran = Math.min(faces.length, gran * 2); }
}
write(faces, outp); console.log(`done: ${faces.length} faces, ${trials} trials -> ${outp}`);
