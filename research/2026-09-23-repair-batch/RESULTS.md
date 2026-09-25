# Implementation results — 2026-09-24

Items 1–4 of ANALYSIS.md implemented in `cpp/bindings.cpp`, `src/`, tests and
docs (see CHANGELOG.md "Unreleased"). Item 5 (how justfixstl.com counts
components and cosmetic degenerates) is site-side and not touched here.

Every number below is from the files in `native/results/` and the research
harness, all run on the final code.

## Wild sample: 217 Thingi10K models, native build, site pipeline order

| | shipped 0.5.0 | final |
|---|---|---|
| hangs (300s) | 1 | 0 |
| files with a corrupt half-edge structure after any step | 3 | 0 |
| repairs ending worse than input | 41 | 0 |
| open inputs closed by repair | 25 / 136 | 108 / 136 |
| boundary loops left after repair (sum) | 3,019 | 86 |
| zero-area triangles left (sum) | 50,777 | 5,779 |
| component count went up | 39 | 0 |
| watertight inputs still watertight, volume unchanged | 80 / 80 | 80 / 80 |

Per file against the shipped build, five files have more zero-area triangles
than before (697602, 73177, 41939, 66375, 815482); each of them is now
watertight or merged from hundreds of pieces into a few, and the leftover
triangles are slit fills that cannot be resolved without moving geometry.
No file lost watertightness, gained a hole, or gained a component.

## Local corpus: 60 models through the site's exact path (WASM), vs 0.5.0

21 better, 32 unchanged, 0 lost anything. Counts that rose: zero-area
triangles on connector.stl (16 → 22, now watertight, was 2 holes) and
organizer.stl (0 → 1, no longer torn open). Volumes of the models that were
open before changed to their correct values (car-phone-holder-test now
matches the raw file exactly; dugout-bottom keeps its cavity).

## Test matrix on the final code

- vitest: 127 passed (22 new, three delta-debugged fixtures from the wild set).
- ASan + UBSan native build over the local corpus: clean.
- Connectivity audit after every pipeline step over 277 files: clean.
- Sweeps: `native/results/thingi-new6-*.jsonl`, `checkNew6-*.txt`,
  `corpus-new6*.jsonl`, `res-final-wasm.jsonl`.

## What was tried and rejected, with the measurement

- Collapse-first for every zero-area triangle: fewest leftovers (fan 0,
  connector 2) but moved vertices along seams — lamp-mount.stl lost 4% of its
  volume to one collapse. Needle-collapse / cap-flip / re-triangulate keeps
  volume exact everywhere and leaves fan 9, connector 22.
- Boundary-only welding: fixed organizer.stl but cost 6 degenerates on
  test2.stl; the closed-mesh no-op is identical elsewhere and simpler.
- Reach-only shell test (depth ≤ 0.10 × diameter): a 10 × 10 × 100 bar
  missing a long side has reach 0.0995 and was kept open; the enclosed
  thickness test (≤ 0.02) separates it from a plate.
- Guarding collapses with `is_manifold()` and a rotation-closure check: still
  hung on 3 files, because the offending vertices have a second fan the
  rotation never reaches. The global incoming-vs-reached count is what works.

---

# Follow-up — 2026-09-24, later: the leftover zero-area triangles, and two measurement defects

Task: seven files ended repair with more zero-area triangles than 0.5.0 (fan.stl,
connector.stl, test2.stl; Thingiverse 697602, 73177, 41939, 66375, 815482). The
suggested cause was `tryRetriangulate` refusing when the edge M–D exists and one half
is already a face. That was the cause on three of the seven; the other four had two
different causes, one of them a measurement error that also affects the analysis.

## What was actually wrong

1. **`pmp::face_area()` is rounding noise for small faces far from the origin.** It sums
   `cross(q, r)` of absolute float positions. On 815482 (coordinates ~50, triangles
   0.003 wide) the terms are ~2500 with a float ulp of 2.4e-4, against a true area of
   3.5e-6: real triangles came out as exactly 0 and their neighbours as several times
   their area, quantised to powers of two (2^-22, 2^-19, 2^-17). The raw file 73177
   reported 2,384 zero-area triangles and has 0; 815482 reported 321 and has 0; the
   whole wild sample reported 74,138 on input and has 14,956 (`areacount.cpp`, both
   formulas on the raw files). `removeDegenerates()` was working on those phantom
   triangles: flipping real geometry, and cycling, because a flip between two
   noise-level triangles just moves which one computes as zero (66375, 815482, 73177:
   11, 63 and ~250 flips per pass with the count never changing). Everything that
   decides "zero area" — the analysis count, the render-data flag, `removeDegenerates()`
   — now uses edge vectors in double (`faceArea()`).
2. **A slit seam is a chain of collinear fill triangles, and the pass loop cycled on it.**
   fan.stl's 81-vertex loop has singular values 40 / 3e-5 / 3e-6: every triangle any fill
   can put in it has zero area, up to float noise. Flipping the middle vertex of one fill
   triangle across into the next fill triangle and back never reaches the surface; fan
   went 8 → 9 → 8 leftovers for ever, connector 22, test2 6, 66375 11. Fix: a triangle
   counts as collinear when its apex is within four ulps of its longest side; a cap
   whose neighbour across that side is itself collinear waits, so the chain is eaten
   from the ends where it borders real faces, one triangle per pass (up to 20 passes,
   stopping when the count stops falling); a fix is only made when both triangles it
   produces have area; two fill triangles sharing their common longest edge are flipped
   to the strictly shorter chord so they can reach the surface.
3. **The fold case (the suggested cause), on 697602, 73177, 815482.** When M–D exists and
   a face sits on {M, B, D} or {A, M, D}, that face coincides with half of the face across,
   wound the other way, a zero-thickness fold. Its winding is forced (it shares B–M or
   A–M with the cap and B–D or A–D with the face across), so "add only the missing half"
   requires deleting that layer too: the cap, the face across and the fold's other layer
   go, the missing half is added, and the fourth vertex, which had no other face, goes
   with it. Nothing moves and the signed volume is unchanged. The restore-on-failure
   guard stays; it re-creates the dropped vertex at its position, because
   `pmp::delete_face()` marks a vertex deleted when its last edge goes while leaving its
   halfedge pointing at the dead edge, and `add_face()` on such a vertex links into
   garbage (found the hard way: 41939 asserted and 73177 opened 11 holes with a naive
   restore). Where M–D exists and neither half does, another surface passes through the
   face across and the cap is left.
4. **The analysis volume was noisy the same way.** `dot(p0, cross(pPrev, pCur))` in float
   on absolute positions: 472000 (held-out) read 3772.2 for a true 3768.2 and "changed"
   to 3773.4 when 128 fold faces were removed without the geometry changing. Now in
   double. 51354's 170032.1 → 170032.0 in the previous run was the same noise.
5. **Needle collapses moved vertices.** With areas measured correctly, the old rule
   "collapse a needle along its shortest edge" reached needles with 0.2–3 unit edges:
   41086 lost 0.3% of its volume, and the committed build had already changed the
   volume of watertight 51354, 51355, 138194 and 78618 (+0.06%, +0.06%, +0.01%, −0.02%),
   which the previous write-up's "80/80 volumes unchanged" missed because it compared
   0.5.0's after-volume with the new build's after-volume, two different instruments.
   A collinear triangle is now first handed across its longest edge, which moves
   nothing, and collapsed only when its shortest edge is under 1e-4 of the diagonal.
   Every watertight input in the wild sample and the held-out sample now keeps its
   volume to the printed digit.

## The seven files

| file | 0.5.0 (its own count) | committed 142f708 (its count) | final (correct count) | exact zeros on the exported mesh: committed → final | watertight / holes / comps, final | volume |
|---|---|---|---|---|---|---|
| fan.stl | 27 | 9 | 0 | 6 → 0 | yes / 0 / 1 | 11410.6 (open input) |
| connector.stl | 16 | 22 | 0 | 22 → 0 | yes / 0 / 1 | 2658.9 (open input) |
| test2.stl | 6 | 6 | 0 | 8 → 0 | yes / 0 / 1 | 859.7 (open input) |
| 697602 | 176 | 193 | 24 | 208 → 24 | no / 6 / 28 (was 29) | 17189.0 |
| 73177 | 448 | 1086 | 6 | 56 → 6 | no / 4 / 31 (was 29, see below) | 1007598.3 |
| 41939 | 0 | 6 | 0 | 6 → 0 | yes / 0 / 6 | 20563.0 |
| 66375 | 0 | 11 | 0 | 11 → 0 | no / 4 / 50 | 8704.6 |
| 815482 | 69 | 193 | 0 | 0 → 0 | yes / 0 / 1 | 143879.4 |

"Its own count" is what that build's analysis reported, i.e. PMP's formula. The
exported-mesh column is `areacount.cpp` with the double formula on both builds' output
files, the only like-for-like comparison. 697602's 24: 21 needles whose two vertices are
1e-5 apart (PMP's `is_collapse_ok` refuses the collapse; flipping would make a collinear
triangle), 3 caps with another surface through the face across. 73177's 6: same two
reasons (input had 0 exact zeros; these are fills of slits the fold rule cannot reach).

## Verification matrix on the final code

All five checks of the 2026-09-24 bar, against both baselines, plus the three new ones.
Result files: `native/results/thingi-new7-*.jsonl`, `corpus-new7.jsonl`,
`corpus-new7-asan.jsonl`, `checkNew7-*.txt`, `res-new7-wasm.jsonl`,
`zerocount-final-vs-committed.tsv`, `heldout-*.jsonl`, `checkNew7-heldout-*.txt`,
`checkRel-heldout-*.txt`, `heldout-new7-asan-*.jsonl`, `perturb-new7-checkasan-*.txt`.

1. vitest: 130 passed, 1 skipped (3 new in `repair-integrity.test.ts`: the interleaved
   slit seam, the fold, a 0.003 mm part 64 mm from the origin; the last two fail on the
   committed build, the first passes on it because near the origin the fills are exact
   zeros).
2. Native audit after every step (`-O2`, PMP asserts live): 217 wild + 58 local files, no
   line printed, `connectivityRebuilds()` and `facesDroppedByAudit()` 0 everywhere.
3. ASan + UBSan over the local corpus: 60 completed, no report.
4. Wild sample per file, native, final vs 0.5.0: 187 better, 29 same, 0 worse (the one
   "changed" is 197005: hang → completed). Final vs committed: 84 better, 127 same, 6
   changed — 138194 (15 zero-area needles left where the committed build collapsed
   them and moved the volume by 0.01%) and five component counts up by one or two
   (73177 29 → 31, 135793 2 → 3, 197005 13 → 14, 441709 21 → 22, 85537 155 → 156):
   specks of 2–8 real triangles with areas 1e-6 to 1e-4 that the committed build
   collapsed away because they computed as zero, kept now. No file lost watertightness
   or gained a hole against either baseline; every watertight input keeps its volume
   (the committed build changed four).
   Zero-area triangles on the exported meshes, double formula: input 14,956 →
   committed 914 (68 files) → final 67 (11 files). Counted PMP's way the final build
   leaves more than the committed one on 114 files (42,856 vs 5,878) — those are real
   triangles the old formula misreads, which the committed build was flipping away.
5. Site-path WASM over the local corpus vs 0.5.0: 22 better, 32 same, 0 worse
   (organizer.stl's count 0 → 5 is the corrected formula reading the same file: it has 6
   exact zeros on input, the committed build left 6 and reported 1, the final leaves 5 —
   micro-triangles with 1e-6 edges that PMP refuses to collapse). Vs committed: 9 better,
   52 same, organizer as above.

## Held-out: 300 Thingi10K models never used before

`native/results/heldout-sample.tsv` (picked by `sample-heldout.py` from
`geometry_data.csv`, stratified so every category is represented, none of the 220 in
`sample.txt`: 128 clean, 65 non-manifold-vertex, 40 non-manifold-edge, 40 open, 47 with
degenerate faces, 20 with duplicates, 72 multi-component, 23 unoriented, 129
self-intersecting; up to 1.56 M faces). Per-file table with every column below:
`native/results/heldout-per-file.tsv`. One file (52135, 4 faces) is under the batch
scripts' 1000-byte cutoff and has native results only from the WASM run.

| | shipped 0.5.0 (native `harness-rel`) | final (native) | shipped 0.5.0 (WASM, site path) | final (WASM, site path) |
|---|---|---|---|---|
| completed | 298 / 299 | 299 / 299 | 299 / 300 | 300 / 300 |
| hangs | 1 (996800, fixNormals, 300 s) | 0 | 1 (996800, fixNormals) | 0 |
| files with a corrupt half-edge structure after a step | 3 (278141, 132432: stale vertex handles after removeDegenerates; 996800: ring broken after fillHoles) | 0 | — | — |
| audit rebuilds / faces dropped by the audit | — | 0 / 0 on all 299 | — | — |
| open inputs closed | 39 / 69 | 61 / 70 | | |
| watertight after | 267 | 290 | | |
| boundary loops left (sum) | 971 | 16 | | |
| zero-area triangles left (sum) | 11,482 (its formula) | 12 (exact) | | |

Per file, final vs 0.5.0, native: 113 better, 184 same, 0 worse, 2 changed; WASM: 112
better, 186 same, 0 worse, 2 changed. The two changed are 81568 (volume 6019.8 →
13970.0) and 136167 (55514.2 → 56759.0), watertight multi-component inputs whose
volume changes in `fixNormals()` when it flips an inward-facing component — identically
in 0.5.0 (`harness-steps`: every step before fixNormals leaves the volume alone in both
builds). Not touched by this work. No file lost watertightness, gained a hole, gained a
component, or ended with more zero-area triangles than under 0.5.0.

ASan + UBSan (`harness-new7-asan`, the final build) over the 290 held-out files under
20 MB: 290 completed, no sanitizer report, no `.err` file.

## Perturbation: damage no one has seen

`perturb.mjs` deletes 1% of the faces of an STL at random (xorshift, seeded). 100 wild
files with at most 300k faces (`native/results/perturb-ids.txt`, drawn at random from the
220 with seed 20260924) × seeds 1, 2, 3 = 300 files, 5.7 M faces per seed. Run with the
ASan + UBSan build of the audit harness (`harness-new7-check-asan`: connectivity audit
after every step, `AUDIT rebuilds= dropped=` at the end, 900 s watchdog):
`native/results/perturb-new7-checkasan-*.txt` are empty — on all 300 files no hang, no
audit line with a non-zero count at any step, no sanitizer report, and
`connectivityRebuilds()` and `facesDroppedByAudit()` both 0.

## What could not be verified

- The wild sample's zero-area comparison against 0.5.0 is only like-for-like on the
  exported meshes (`zerocount-final-vs-committed.tsv` covers the committed build and
  the final one; 0.5.0's outputs were not re-exported). Against 0.5.0's own reported
  counts the final build is lower on every file.
- The held-out run compares against 0.5.0 only; the committed build was not run on it.
- Timing: `removeDegenerates()` on dual-smoothed-loba.stl (6.8 M faces) took 14 s native
  under a loaded machine against 11 s for the committed build; the collinear scan is up
  to 20 passes over every face. Not measured in the browser.
