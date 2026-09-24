// Batch driver: one child per model, the site's 300s per-engine-call limit,
// 100 MB upload cap, formats the site accepts. Writes results.jsonl.
import { spawn } from "node:child_process"; import { readdirSync, statSync, appendFileSync, writeFileSync } from "node:fs"; import { join, basename } from "node:path";
const DIR = process.env.HOME + "/.vaxis-backups/models", S = new URL(".", import.meta.url).pathname;
const LIMIT = 300_000, CAP = 100 * 1024 * 1024, OK = ["stl", "obj", "off", "ply"], CONC = +process.env.CONC || 4;
const out = join(S, process.env.OUT || "results.jsonl"); writeFileSync(out, "");
const files = readdirSync(DIR).map(f => ({ f, size: statSync(join(DIR, f)).size })).sort((x, y) => x.size - y.size);
const one = ({ f, size }) => new Promise(res => {
  const ext = f.split(".").pop().toLowerCase(), rec = { file: f, mb: +(size / 1048576).toFixed(1), steps: [] };
  if (!OK.includes(ext)) return res(Object.assign(rec, { outcome: "unsupported_format" }));
  if (size > CAP) return res(Object.assign(rec, { outcome: "over_size_cap" }));
  const c = spawn("node", ["--max-old-space-size=8192", join(S, "child.mjs"), join(DIR, f), join(S, "out", (process.env.TAG||"") + basename(f, "." + ext) + ".repaired.stl")]);
  let buf = "", err = "", callStart = null, current = null, timer = null;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => { rec.outcome = "timeout"; rec.timeoutCall = current?.call; rec.timeoutStep = current?.step; c.kill("SIGKILL"); }, LIMIT - (Date.now() - callStart)); };
  c.stdout.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.ev === "start") { if (!current || current.call !== e.call) { callStart = Date.now(); } current = e; arm(); }
    if (e.ev === "end") rec.steps.push({ step: e.step, ms: e.ms, result: e.result });
    if (e.ev === "done") { rec.before = e.before; rec.after = e.after; } } });
  c.stderr.on("data", d => err += d);
  c.on("close", code => { clearTimeout(timer); if (!rec.outcome) rec.outcome = code === 0 && rec.after ? "completed" : "crashed"; if (rec.outcome === "crashed") { rec.crashStep = current?.step; rec.error = err.trim().split("\n").slice(-3).join(" | ").slice(0, 300); } res(rec); });
});
const q = [...files]; let n = 0;
await Promise.all(Array.from({ length: CONC }, async () => { while (q.length) { const r = await one(q.shift()); appendFileSync(out, JSON.stringify(r) + "\n"); console.log(`${++n}/${files.length} ${r.outcome.padEnd(18)} ${r.file} ${r.timeoutStep || r.crashStep || ""}`); } }));
