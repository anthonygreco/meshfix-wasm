# Repair batch findings — 2026-09-23

Research only. Nothing in meshfix-wasm has been changed. This folder is the
evidence for planning fixes to the repair pipeline.

## Why this exists

JustFixSTL user feedback (Sep 2026) reported: a repair that timed out twice on
the same 117k-face STL, "repair fixed 0 of N", a part going missing after
repair, and a cavity still visible in the slicer. None of the reporters' models
are available, so 60 of Anthony's own models (`~/.vaxis-backups/models`, a
Windows bind of `C:\Users\antis\vaxis-backups\models`) were run through the
site's exact repair path, against every engine build the site has shipped.

## How the harness works

- `child.mjs` — one model, one process. Mirrors the site worker's `repair` case
  step by step (weld 1e-6 → removeDegenerates 1e-10, skipped when watertight →
  splitVertices → fillHoles(100) → fixNormals → reanalyze → export), printing
  one JSON line per step. Env: `CORE` (loader .cjs), `WASM`, `GUARD=0` to
  disable the watertight skip.
- `run.mjs` — batch driver. Applies the site's rules: 300s limit per engine
  call, 100 MB upload cap, formats stl/obj/off/ply. Env: `OUT`, `TAG`, `CONC`.
- `versions.sh` — runs the batch against each build in `engines/`
  (`feb` = vendored build the site ran Feb 25–Mar 30; then npm 0.1.0, 0.2.0,
  0.3.1, 0.5.0; plus 0.5.0 with the guard off). Results in `res-<tag>.jsonl`.
- `cmp.mjs` — cross-version comparison and "worse than input" check.
- `summarize.mjs` — per-model table for `results.jsonl` (0.5.0 run).
- `probe.mjs` — runs weld alone on a named model to isolate the weld tear.
- `out/` — every repaired STL, prefixed by engine tag.

The loader must be a `.cjs` copy: the site's package is `"type": "module"`.
The models themselves are not in this folder, and several are third-party
designs, so don't commit them.

## Results (60 models, 5 builds)

No timeouts or crashes on any build. The largest model is 1.69M faces
(`loba-smoothed.stl`, 81 MB), and no single step took more than 6s. **The
timeout is not about size.**

52/62 files give identical results on every build. Defects found:

| Defect | Models | When it started | Evidence |
|---|---|---|---|
| Weld tears a watertight mesh | `organizer.stl`: watertight/1 part → open/2 parts/6 non-manifold edges | Original design (all builds) | `probe.mjs organizer.stl`: weld alone does it. It merges 1 vertex and deletes 6 faces. Weld runs on every mesh and is not limited to boundary vertices (`cpp/bindings.cpp` `weldVertices`). |
| Hole fill adds zero-area slivers | `fan` 0→27 degenerates, `connector` 0→16, `ceiling-claw` 0→17 (also −32% volume, but its input was open so the before-volume is unreliable) | Original design (all builds) | Fan triangulation from the loop's first vertex (`fillHolesEx`, "Simple fan triangulation"). A fan across a straight run of boundary edges produces exactly-zero-area triangles. The analyzer and removeDegenerates both use area < 1e-10. |
| Degenerates on watertight meshes never repaired | `files-test` 10, `spool-rails` 9, `codeandmake` 3, SDOT trays 1 | Feb 26, justfixstl `dea89c4` (deliberate watertight skip in the worker) | With the skip off, only `files-test` improves (10→6). Deleting faces can't remove them from a closed mesh without tearing; they need an edge collapse or flip. |
| Holes left open as "features" | `desk-padding`, `car-phone-holder-test`, `precision-bits-holder-size-test`, `connector`: closed by 0.3.1, left open (2 holes each) by 0.5.0 | **0.5.0, `465ef65`** (feature-hole classification) | The only actual regression. It's a trade-off from the "it filled in the holes that were supposed to be there" report. Someone has to look at these 4 models to label each hole as a designed opening or damage. |
| Part count increases | `loba-smoothed` 15→20 parts | All builds | Probably splitVertices separating pieces joined at one vertex, which may be correct. Unverified. |

"Worse than input" by build (watertight→open, more parts, or more defects):
feb/0.1.0/0.2.0/0.3.1 = 5 models; 0.5.0 = 4 (`organizer`, `fan`, `connector`,
`loba-smoothed`).

## The timeout is not a regression

GA4 (property 526101383), weekly since June. Before Sep 2, 10–14% of
`repair_started` each week had no `repair_completed` and no `repair_failed`:
silent hangs. justfixstl `3923c57` (Sep 2) added the 300s limit. Since then
7–11% are "Worker terminated: repair exceeded 300s" and ~1% are unaccounted
for. The hangs have always been there; now they're measured. Last 30 days:
250 repair timeouts, 28 reanalyze timeouts, 6 fillHoles timeouts, 33 "memory
access out of bounds", out of 4,097 repairs.

Nothing in this corpus reproduces a hang. The only known reproducer is the
French reporter's file, which has been requested by email (7.2 MB, 117,089
faces, 7 issues, hung twice).

## Test gaps

- `repairs.test.ts` / `pipeline.test.ts` mostly check result fields and that
  nothing throws. Nothing checks that a repair leaves a mesh no worse than it
  came in.
- The built-in test shapes (icosphere, torus, tetrahedron, bowtie) have no
  short edge, no hole with a straight boundary, and no non-convex hole.
- `hole-classification.test.ts` is the only outcome-based repair test.
- C++ `repair()` runs removeDegenerates unconditionally. The worker skips it
  on watertight meshes. The pipeline test covers the version the site doesn't
  run.

## Proposed tests: models broken in a known way, built in code

1. Closed solid with one edge shorter than 1e-6. After repair: still
   watertight, still one part.
2. Box missing one face, with extra points along the straight edges of the
   opening. After filling: 0 degenerate triangles.
3. Flat L- or star-shaped hole. The fill's area equals the hole's area, with
   no triangles outside the outline.
4. Watertight mesh containing a zero-area triangle. After repair: 0
   degenerates, still watertight.
5. Designed-opening vs torn-damage pairs added to the hole-classification
   tests, including the labels for the 4 models above.
6. C++ `repair()` and the worker's steps give the same result on every test
   model.

Plus a corpus check run on every build, over whatever real models are
available locally: fail any repair that makes a model non-watertight, adds
parts, or ends with more defects than it started with.

## Fix directions (not yet planned)

- Weld: only merge vertices that sit on an open edge, so a closed surface
  passes through untouched.
- Fill: minimum-area triangulation of the loop only (no refinement or fairing,
  which is where pmp's hole filler trapped).
- Degenerates on closed meshes: an edge collapse or flip, checked with pmp's
  `is_collapse_ok`/`is_flip_ok`, or stop reporting them as issues (the site
  already calls them cosmetic in its UI).
