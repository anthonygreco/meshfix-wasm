# Repair pipeline analysis and courses of action — 2026-09-23

Follows on from FINDINGS.md (same folder). This session added three sources
of evidence that FINDINGS.md did not have: GA4 broken down by issue count and
device, a 217-file sample of real Thingiverse models (Thingi10K), and a native
build of the pipeline with PMP's asserts live and a connectivity audit after
every step. Everything measured is reproducible from `native/` (harness,
scripts, prototype patches, result files). Nothing in `cpp/` or `src/` was
changed.

## Ranked by consequence

### 1. The 300s timeout is a hang caused by fillHoles corrupting the mesh. Root cause found and fixed in prototype.

If this ships unchanged, about 1 repair in 16 keeps ending with a dead
engine after five minutes: 285 timeouts in 2,936 repairs since Sep 2, plus
the 33/month "memory access out of bounds" traps, which are the same
corruption reaching a different traversal.

What GA4 says (property 526101383, Sep 2–23):

| issue_count on the mesh | repairs started | timed out | rate |
|---|---|---|---|
| 1–3 | 587 | 0 | 0% |
| 4 | 320 | 1 | 0.3% |
| 5–6 | 944 | 26 | 2.8% |
| 7 | 566 | 131 | 23% |
| 8 | 285 | 63 | 22% |
| 9 | 240 | 64 | 27% |

248 of 251 timeouts are desktop. 0 of 373 loads under 10k faces time out;
7–15% between 10k and 1M faces. So it is neither a slow device nor plain size:
it is a topology that appears in badly broken meshes, and bigger meshes have
more chances to contain it.

What the native harness found. Thingi10K file 197005 (144k faces) hangs in
`fixNormals` after 300s. A connectivity audit after each step shows the mesh
is valid up to and including `splitVertices`, and broken after `fillHoles`:
one new face's halfedge ring never closes, and 998 halfedges point at the
wrong face. Instrumenting every `add_face` in the fan fill gives the exact
call (`native/results/197005-addface-instrument.txt`):

```
CORRUPT at loop 246 (edges=39) tri 34/39 threw=0
  pre: v63337(val=34,bnd_out=1,isB=1,manifold=1) v65213(...) v63337(...)
       e01=new e12=bnd/face e20=new
```

The boundary loop visits vertex 63337 twice (positions 0 and 35 of 39). PMP
reports the vertex as manifold because its rotation circulator only reaches
one of its two fans, so `splitVertices` never splits it. The fan then asks
`add_face` for the triangle (v63337, v65213, v63337). PMP's `add_face` only
asserts `n > 2`, does not reject a repeated vertex, and does not throw: it
links the face and leaves a ring that cannot close. From then on every
face-vertex circulator (`fixNormals`, `getAnalysis`, hence `reanalyze`) and
PMP's own free-gap search inside later `add_face` calls spin forever. That
matches all three production labels: `repair exceeded`, `reanalyze exceeded`
and `fillHoles exceeded`.

A second, independent corruption source: `removeDegenerates` uses PMP's
in-place `delete_face` + `garbage_collection`, which on 2 of 217 wild files
(73177, 815482) leaves 125 and 2 halfedges pointing at deleted vertices. In
the shipped pipeline `splitVertices` usually masks it by rebuilding the mesh
and silently dropping the affected faces (27 faces on 73177); when the mesh
has no bowtie to split, the stale handles reach `fillHoles`/`getAnalysis`,
which is the "memory access out of bounds" trap in production. Running
`splitVertices` first does not help (164 stale handles). Rebuilding the mesh
from the kept faces instead of deleting in place leaves 0 on every file.

Prototype fix (`native/prototype-G-fill-guard.patch` on top of
`prototype-R.patch`): refuse any loop that visits a vertex twice, refuse any
triangle with a repeated vertex, and rebuild in `removeDegenerates`. File
197005 then completes with a clean audit after every step (6 more loops are
reported as failed instead of corrupting the mesh). Sweep of 217 wild + 60
local files with the audit after every step: shipped pipeline corrupts 3
files, the prototype corrupts 0 (see `native/results/checkG-*.txt`).

Strongest case against: the sample is 217 files and the site's uploads are a
more broken population, so there may be corruption paths this sample does
not contain. That is why the fix should also carry a safety net:
`connectivityIsValid()` (already in bindings.cpp for decimate, extended to
boundary chains) after every repair op, rebuilding from valid faces on
failure, and a step cap on the four unguarded loops in bindings.cpp
(`getAnalysis` boundary walk, `splitVertices` rotation, the two face-vertex
volume loops). A capped loop turns a five-minute hang into an immediate,
named error in GA4.

### 2. The pipeline leaves most broken meshes open. Three measured changes close 3× as many.

If this ships unchanged, for the majority of open uploads the user downloads a
file that is still not watertight, with more degenerate triangles than it
came in with. On the 217 wild files:

| variant | open inputs closed | still open | files with degenerates left | degenerates left (sum) | holes left (sum) | fill failures |
|---|---|---|---|---|---|---|
| shipped 0.5.0 | 25 / 136 | 111 | 168 | 50,777 | 3,019 | 774 |
| + skip weld on closed mesh + min-weight fill | 80 / 136 | 57 | 154 | 57,595 | 608 | 103 |
| + collapse degenerates after fill | 80 / 136 | 53 | 57 | 2,868 | 371 | 50 |

Local corpus, same prototype: fan slivers gone (fan 27→0, connector 16→0,
ceiling-claw 17→0 and closed), degenerates on watertight meshes fixed
(files-test 10→1, spool-rails 9→0, codeandmake 3→0, SDOT 1→0), organizer no
longer torn (stays watertight, 1 part), test2 / phone-stand-wide /
better-lexus-key closed. No file lost watertightness in either variant
(80/80 watertight inputs stay watertight).

The three changes, each with its basis:

- **Weld is a no-op on a closed mesh.** A closed surface has no gap to close;
  merging two interior vertices 1e-6 apart can only create a pinch, which
  `add_face` then refuses, which tears the mesh (organizer: 1 merge, 6
  faces dropped, watertight → open). Boundary-only merging was also tried and
  works, but costs 6 degenerates on test2; the closed-mesh skip is identical
  everywhere else on both corpora. Weld tore faces on 7 of 217 wild files,
  one of them watertight.
- **Minimum-weight triangulation instead of a fan** (Barequet–Sharir dynamic
  programme, O(n³) with n ≤ 100, 25 ms on loba's 473 loops). Weight is
  triangle area plus a small chord-length term; near-zero-area triangles and
  chords that already exist as interior edges are penalised so the fill
  routes around them. That is what cuts fill failures 774 → 103: a fan from
  vertex 0 fails whenever any chord (0, i) is already an interior edge.
- **Collapse degenerate triangles instead of deleting them**, and do it after
  the fill. Deleting a face from a closed mesh opens a hole; deleting one
  from an open mesh opens more (112564: 2,388 deleted, holes 23 → 113). A
  zero-area triangle has a shortest edge; collapsing it with PMP's
  `is_collapse_ok` check removes the triangle and stitches the two sides,
  which is also the right fix for the slit loops in fan.stl and connector.stl
  (T-junction seams whose every possible fill is zero-area). Falls back to an
  edge flip, then leaves the face alone.

Strongest case against: the collapse prototype hit 4 PMP asserts on the
wild set. All four were stale-handle inputs from the shipped
`removeDegenerates` (item 1); with the rebuild variant they do not occur, but
the collapse must run only on an audited mesh. Also "worse than input" stays
at 37/216 under the prototype, and 35 of those are only the component count
going up when `splitVertices` separates bowties, which is the correct repair;
the site counts components as an issue, so the UI would still call it worse
(item 5).

### 3. The 0.5.0 hole classification refuses to fill a solid that is missing one face.

If this ships unchanged, the commonest CAD-export failure the tool exists for
(a box or prism with one face dropped by a boolean) is reported as a
"feature" and left open; 4 of the 60 local models regressed this way from
0.3.1 to 0.5.0.

All four regressions are the same rule: `looksDeliberate()` returns true
when the loop's diameter is ≥ 60% of the model's bounding-box diagonal (the
"open shell's outer edge" test). Not one is the round-opening rule
(`native/results`, `describe.mjs`). desk-padding is two closed boxes each
missing the face where they touch (4- and 6-edge loops, 91% of the diagonal);
car-phone-holder-test and precision-bits are the same shape. Any prismatic
part with a missing end cap has a loop spanning most of its diagonal. In the
wild sample the rule fires on 91285 (four 3–5-edge loops at 62%, each the
only opening of a 7-vertex component) and 41939 (a 68-edge loop that is its
component's only opening).

A measurement that separates the cases: the component's surface depth on
each side of the loop's plane, divided by the loop diameter.

| case | depth / diameter | loop is component's only opening |
|---|---|---|
| desk-padding (2 boxes, missing shared face) | 0.30, 0.15 | yes |
| 91285 (4 loops), 41939 | 0.21–0.31, 0.15 | yes |
| connector (wall face missing, 8 loops) | 0.27 / 0.25 | no |
| shower-piece plates (genuine open shells, 5 loops at 89%) | 0.01–0.08 | no |

Rule to test: keep the outer-edge exemption only when the component lies
within ~0.10 × loop diameter of the loop's plane. Judgment call on the
threshold: the measured margin is 0.08 versus 0.15 on nine loops, which is
thin; it needs the labelled test corpus in `hole-classification.test.ts`
(the plate cases must still pass) plus these files as fixtures.

Also from the wild set: the round-opening rule skipped 16-to-64-edge loops
with diameters of 0.0–2.0 units on 66375, 1038441, 601643 and 852620, i.e.
under 1% of the model. A 0.1 mm "bore" is not a designed opening a slicer
can print; a size floor (diameter ≥ 1–2% of the diagonal, or an absolute
1 mm) belongs in that rule. 71 loops in 16 of 217 files were skipped as
features; the site never tells the user (`holesSkippedAsFeature` and
`fillFeatures` are not wired in justfixstl.com).

### 4. fixNormals turns an internal cavity into a solid.

If this ships unchanged, a hollow part prints solid: dugout-bottom gains 22%
volume because a nested inner shell (2,450 faces, inward normals, a void of
about 5,500 mm³, bounding box entirely inside the outer body) is closed by the
fill and then flipped outward as a "flipped component". In the wild sample
fixNormals flipped something in 50 of 216 files; 13 of those contain a
closed inward-facing shell nested inside a closed outer one (`nest.mjs`),
about 4 with non-trivial volume.

Fix: decide orientation by nesting parity (a ray from the component, counted
against other closed components, bounding-box prefiltered), not by the sign
of the signed volume alone. The strongest case against is cost on models like
the Star Destroyer with 2,335 components; the bbox prefilter keeps it to the
few that are actually nested.

### 5. Reporting makes correct repairs look like failures (site-side).

If this ships unchanged the "repair fixed 0 of N" feedback keeps coming even
after items 1–4: `issuesFromAnalysis` counts `multipleComponents` as an
issue, so splitting a bowtie into two parts (correct) raises the count; and
zero-area triangles are counted as defects even when they are the only
possible seal of a slit seam. This is a justfixstl.com decision, not an
engine one, and is listed here because the wild-sample "worse than input"
number is dominated by it (35 of 37 under the prototype).

## Things checked and ruled out

- Timeouts are not mobile or size-bound (see item 1 table). 1.69M faces
  repairs in 10 s natively; the slowest wild file (600k faces) takes 6 s.
- Skipped faces at load are not winding flips: on every file with skipped
  faces the raw STL has 0 same-direction edge pairs and only 3-or-more-face
  edges (`skipped.mjs`). A re-orientation pass would recover nothing.
- The local corpus is clean under ASan + UBSan + PMP asserts (60 files,
  `corpus-asan.jsonl`, no reports), which is why it never reproduced anything.
- PMP `add_face` is atomic when it throws; the corruption is the non-throwing
  repeated-vertex path.

## Courses of action, in order

1. **Hang/corruption fix in meshfix-wasm** (item 1): loop and triangle
   guards in `fillHolesEx`, rebuild in `removeDegenerates`, connectivity
   audit after every op with rebuild-from-valid-faces on failure, step caps
   on the unguarded loops. Fixtures: Thingi10K 197005, 73177, 815482
   delta-debugged to small STLs (same method as the decimate fixture). This
   is the smallest diff with the largest effect: it removes the 6% timeout
   class and the trap class, and makes any remaining failure visible in GA4
   with a real error string.
2. **Pipeline quality** (item 2): weld no-op on closed meshes, minimum-weight
   fill, collapse-after-fill. Pipeline order becomes weld → split → fill →
   collapse degenerates → fixNormals, with removeDegenerates's duplicate-face
   pass kept. Tests: the FINDINGS.md proposals plus a "no worse than input"
   corpus check (watertight stays watertight, components stay ≤ input after
   accounting for bowtie splits, defects ≤ input).
3. **Hole classification** (item 3): depth test for the outer-edge rule, size
   floor for the round rule; add the 4 local models and 91285/41939 as
   labelled fixtures; wire `holesSkippedAsFeature` into the site so the user
   is told what was kept.
4. **Nesting-aware fixNormals** (item 4), with dugout-bottom as the fixture.
5. **Site reporting** (item 5).

Item 1 does not depend on 2–4 and should ship alone first; 2 reuses the
audit from 1 and should not ship without it.
