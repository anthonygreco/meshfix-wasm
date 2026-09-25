import { readFileSync } from "node:fs";
for (const s of process.argv.slice(2)) {
  const rows = readFileSync(s + ".jsonl", "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(r => !r.err);
  const total = readFileSync(s + ".txt", "utf8").trim().split("\n").length;
  let open = 0, overFiles = 0, overLoops = 0, overDel = 0, overDelFiles = 0, mism = 0, skipped = 0, unfixedNow = 0, unfixedNew = 0, filesUnfixedNow = 0, filesUnfixedNew = 0, flipToByDesign = 0;
  const detail = [];
  for (const r of rows) {
    if (r.loops.length) open++;
    const over = r.loops.filter(l => l.e > 100), del = over.filter(l => l.d);
    if (over.length !== r.fill.skipped) mism++;
    skipped += r.fill.skipped;
    if (over.length) overFiles++;
    overLoops += over.length; overDel += del.length; if (del.length) overDelFiles++;
    const now = Math.max(0, r.holesAfter - r.fill.feat), nw = Math.max(0, now - del.length);
    unfixedNow += now; unfixedNew += nw; if (now) filesUnfixedNow++; if (nw) filesUnfixedNew++;
    if (now > 0 && nw === 0) flipToByDesign++;
    if (del.length) detail.push(`${r.f.split("/").pop()}  over=${over.length} deliberate=${del.length} ${JSON.stringify(del.map(l => ({ e: l.e, diaPct: +(100 * l.dia / r.diag).toFixed(0), sd: l.sd, st: l.st, rv: l.rv })))}`);
  }
  console.log(`\n## ${s}: ${rows.length}/${total} files ran, ${open} open after weld+split`);
  console.log(`  files with a loop >100 edges: ${overFiles}; such loops: ${overLoops} (holesSkipped total ${skipped}, per-file mismatches ${mism})`);
  console.log(`  of those loops, looksDeliberate: ${overDel} in ${overDelFiles} files`);
  console.log(`  loops the site reports as unfixed holes after auto-repair: now ${unfixedNow} (${filesUnfixedNow} files) -> classified ${unfixedNew} (${filesUnfixedNew} files); files that would read "open by design" instead: ${flipToByDesign}`);
  for (const d of detail) console.log("   ", d);
}
