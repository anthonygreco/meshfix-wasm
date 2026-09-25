// Delete a fraction of faces at random from an STL (binary or ASCII) and write a binary STL.
// usage: node perturb.mjs <in.stl> <out.stl> <fraction> <seed>
import { readFileSync, writeFileSync } from "node:fs";
const [inp, out, fracS, seedS] = process.argv.slice(2); const frac = +fracS; let seed = +seedS >>> 0;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const buf = readFileSync(inp); let tris = [];
const isBinary = !(buf.slice(0, 5).toString() === "solid" && !/^solid[\s\S]*?\n\s*facet/.test(buf.slice(0, 2000).toString()) === false && buf.length !== 84 + 50 * buf.readUInt32LE(80));
if (buf.length >= 84 && buf.length === 84 + 50 * buf.readUInt32LE(80)) {
  const n = buf.readUInt32LE(80); for (let i = 0; i < n; i++) { const o = 84 + 50 * i; const f = new Float32Array(12); for (let k = 0; k < 12; k++) f[k] = buf.readFloatLE(o + 4 * k); tris.push(f); }
} else {
  const txt = buf.toString("latin1"); const re = /facet\s+normal\s+(\S+)\s+(\S+)\s+(\S+)[\s\S]*?outer\s+loop\s+vertex\s+(\S+)\s+(\S+)\s+(\S+)\s+vertex\s+(\S+)\s+(\S+)\s+(\S+)\s+vertex\s+(\S+)\s+(\S+)\s+(\S+)/g; let m;
  while ((m = re.exec(txt))) { tris.push(new Float32Array(m.slice(1, 13).map(Number))); }
}
const keep = tris.filter(() => rnd() >= frac);
const o = Buffer.alloc(84 + 50 * keep.length); o.write("perturbed " + frac + " seed " + seedS, 0, "latin1"); o.writeUInt32LE(keep.length, 80);
keep.forEach((f, i) => { const b = 84 + 50 * i; for (let k = 0; k < 12; k++) o.writeFloatLE(f[k], b + 4 * k); o.writeUInt16LE(0, b + 48); });
writeFileSync(out, o); console.log(`${inp}: ${tris.length} -> ${keep.length} faces`);
