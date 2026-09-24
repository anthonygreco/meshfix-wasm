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
