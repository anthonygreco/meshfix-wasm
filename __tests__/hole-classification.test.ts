/**
 * fillHoles() used to fill every boundary loop under the edge cap. That is a
 * size test, not an intent test. It is harmless on a watertight solid, where a
 * designed bore is closed geometry and never appears as a boundary loop, and
 * wrong on an open shell, where a designed bore IS a boundary loop — so bores,
 * slots and the part's own outer perimeter all got sealed. Hence the report
 * "it filled in the holes that were supposed to be there".
 *
 * The replacement is deliberately lopsided. Leaving real damage unfilled is a
 * worse failure than filling a feature, and filling everything is what the old
 * behaviour did anyway, so a loop must be unmistakably a machined opening before
 * it is left alone. These tests pin both directions: the "damage" cases must
 * still be filled (no regression), the "feature" cases are the ground gained.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { getModule } from './helpers/setup.js';

let module: any;

beforeAll(async () => {
  module = await getModule();
});

function binaryStl(tris: number[][][]): Uint8Array {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const view = new DataView(buf);
  view.setUint32(80, tris.length, true);
  let o = 84;
  for (const t of tris) {
    o += 12;
    for (const v of t) {
      view.setFloat32(o, v[0], true);
      view.setFloat32(o + 4, v[1], true);
      view.setFloat32(o + 8, v[2], true);
      o += 12;
    }
    o += 2;
  }
  return new Uint8Array(buf);
}

// A flat plate is an open shell, so it always contributes one extra boundary
// loop: its own outer edge, which must never be filled.
function plate(N: number, drop: (i: number, j: number, tri: number[][]) => boolean) {
  const tris: number[][][] = [];
  const P = (i: number, j: number) => [(i / N) * 20 - 10, (j / N) * 20 - 10, 0];
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
      for (const t of [[a, b, c], [a, c, d]]) if (!drop(i, j, t)) tris.push(t);
    }
  return tris;
}
const cx = (t: number[][]) => (t[0][0] + t[1][0] + t[2][0]) / 3;
const cy = (t: number[][]) => (t[0][1] + t[1][1] + t[2][1]) / 3;

describe('fillHoles — deliberate geometry vs damage', () => {
  let analyzer: any;

  beforeEach(() => {
    analyzer = new module.MeshAnalyzer();
  });

  afterEach(() => {
    analyzer.delete();
  });

  function load(tris: number[][][]) {
    module.FS.writeFile('/tmp/holes.stl', binaryStl(tris));
    expect(analyzer.loadFromFile('/tmp/holes.stl')).toBe(true);
  }

  // --- damage must still be repaired ---------------------------------------

  it('fills a single missing triangle', () => {
    load(plate(24, (i, j, t) => i === 10 && j === 12 && t[1][0] > t[0][0]));
    const r = analyzer.fillHoles(1000);
    expect(r.holesFilled).toBeGreaterThanOrEqual(1);
  });

  it('fills a missing patch in a flat wall — the shape a bore is hardest to tell from', () => {
    load(plate(24, (i, j) => i >= 10 && i < 13 && j >= 10 && j < 13));
    const r = analyzer.fillHoles(1000);
    expect(r.holesFilled).toBeGreaterThanOrEqual(1);
  });

  it('fills a long thin crack', () => {
    load(plate(24, (i, j) => j === 12 && i >= 4 && i < 20));
    const r = analyzer.fillHoles(1000);
    expect(r.holesFilled).toBeGreaterThanOrEqual(1);
  });

  // --- deliberate geometry must survive ------------------------------------

  it('leaves a large circular bore alone and says so', () => {
    load(plate(48, (i, j, t) => Math.hypot(cx(t), cy(t)) < 4));
    const r = analyzer.fillHoles(1000);
    expect(r.holesFilled).toBe(0);
    expect(r.holesSkippedAsFeature).toBe(2); // the bore and the plate's outer edge
  });

  it('leaves a hexagonal opening alone', () => {
    load(plate(32, (i, j, t) => {
      const x = cx(t), y = cy(t);
      const k = Math.PI / 3;
      const a = Math.atan2(y, x);
      return Math.hypot(x, y) < 3.5 * Math.cos(k / 2) / Math.cos((((a % k) + k) % k) - k / 2);
    }));
    const r = analyzer.fillHoles(1000);
    expect(r.holesFilled).toBe(0);
    expect(r.holesSkippedAsFeature).toBe(2);
  });

  it("never seals an open shell's own outer edge", () => {
    // A plate with nothing wrong with it: one boundary loop, its perimeter.
    load(plate(24, () => false));
    const r = analyzer.fillHoles(1000);
    expect(r.holesFilled).toBe(0);
  });

  it('repairs damage and preserves a bore in the same model', () => {
    load(plate(32, (i, j, t) =>
      Math.hypot(cx(t) - 4, cy(t) - 4) < 2.5 || (j === 6 && i >= 4 && i <= 14)));
    const r = analyzer.fillHoles(1000);
    expect(r.holesFilled).toBeGreaterThanOrEqual(1);      // the tear
    expect(r.holesSkippedAsFeature).toBeGreaterThanOrEqual(1); // the outer edge at minimum
  });

  // --- the user stays in control -------------------------------------------

  it('fillHolesEx can override the decision', () => {
    load(plate(48, (i, j, t) => Math.hypot(cx(t), cy(t)) < 4));
    const kept = analyzer.fillHolesEx(1000, false);
    expect(kept.holesFilled).toBe(0);

    analyzer.delete();
    analyzer = new module.MeshAnalyzer();
    load(plate(48, (i, j, t) => Math.hypot(cx(t), cy(t)) < 4));
    const forced = analyzer.fillHolesEx(1000, true);
    expect(forced.holesFilled).toBeGreaterThan(0);
  });

  it('describeHoles explains every loop', () => {
    load(plate(48, (i, j, t) => Math.hypot(cx(t), cy(t)) < 4));
    const holes = JSON.parse(analyzer.describeHoles());
    expect(holes).toHaveLength(2);
    for (const h of holes) {
      expect(h.edges).toBeGreaterThan(0);
      expect(Number.isFinite(h.planarDeviation)).toBe(true);
      expect(Number.isFinite(h.radiusVariation)).toBe(true);
      expect(typeof h.looksDeliberate).toBe('boolean');
    }
    // Both are deliberate here: the bore, and the plate's outer edge.
    expect(holes.every((h: any) => h.looksDeliberate)).toBe(true);
  });

  it('the edge-count cap still applies independently', () => {
    load(plate(24, (i, j) => i >= 10 && i < 13 && j >= 10 && j < 13));
    const r = analyzer.fillHoles(4);
    expect(r.holesFilled).toBe(0);
    expect(r.holesSkipped).toBeGreaterThan(0);
  });
});

// --- added 2026-09-24: a solid missing one face is damage, however wide -----
//
// The outer-edge exemption above used span alone (loop diameter >= 60% of the
// model diagonal), which is also the shape of a box or prism that has lost one
// face — the commonest export failure the tool exists for. Four of sixty local
// models regressed that way in 0.5.0. The exemption now also needs the loop's
// component to lie within 0.10 x diameter of the loop's plane, which a plate
// does and a solid does not. And the round-opening rule needs the opening to
// be at least 2% of the model diagonal, so a finely tessellated pinprick at
// the tip of a cone is no longer kept open.
describe('fillHoles — solids missing a face, and pinpricks', () => {
  let analyzer: any;

  beforeEach(() => {
    analyzer = new module.MeshAnalyzer();
  });

  afterEach(() => {
    analyzer.delete();
  });

  function load(tris: number[][][]) {
    module.FS.writeFile('/tmp/holes2.stl', binaryStl(tris));
    expect(analyzer.loadFromFile('/tmp/holes2.stl')).toBe(true);
  }

  // A closed box of size sx, sy, sz, outward wound; `skipTop` drops the top.
  function box(sx: number, sy: number, sz: number, skipTop: boolean) {
    const p = (x: number, y: number, z: number) => [x * sx, y * sy, z * sz];
    const q = (a: number[], b: number[], c: number[], d: number[]) => [[a, b, c], [a, c, d]];
    const faces = [
      ...q(p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)),
      ...(skipTop ? [] : q(p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1))),
      ...q(p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)),
      ...q(p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)),
      ...q(p(1, 1, 0), p(0, 1, 0), p(0, 1, 1), p(1, 1, 1)),
      ...q(p(0, 1, 0), p(0, 0, 0), p(0, 0, 1), p(0, 1, 1)),
    ];
    return faces;
  }

  it('fills the missing top of a flat pad, whose opening spans most of the model', () => {
    // 100 x 60 x 8: the opening's diagonal is 97% of the model's. Depth 8/117 = 0.07
    // of the loop diameter would pass as a shell by depth alone; but the solid's
    // walls stand off the plane by the full 8 — it is the reach, not the ratio
    // to the model, that matters, and 8/117 is measured against the diameter.
    load(box(100, 60, 20, true));
    const info = JSON.parse(analyzer.describeHoles());
    expect(info.length).toBe(1);
    expect(info[0].shellDepth).toBeGreaterThan(0.10);
    expect(info[0].shellThickness).toBeGreaterThan(0.02);
    const r = analyzer.fillHoles(100);
    expect(r.holesFilled).toBe(1);
    expect(r.holesSkippedAsFeature).toBe(0);
    expect(analyzer.getAnalysis().isWatertight).toBe(true);
  });

  it('fills the missing long side of a bar: shallow reach, but it encloses the bar', () => {
    load(box(10, 10, 100, false).filter((_, i) => i !== 6 && i !== 7)); // drop the x=1 side wall
    const info = JSON.parse(analyzer.describeHoles());
    expect(info.length).toBe(1);
    expect(info[0].shellDepth).toBeLessThanOrEqual(0.10); // 10 over a loop ~100 wide
    expect(info[0].shellThickness).toBeGreaterThan(0.02);  // the bar itself
    const r = analyzer.fillHoles(100);
    expect(r.holesFilled).toBe(1);
    expect(analyzer.getAnalysis().isWatertight).toBe(true);
  });

  it('still leaves a flat plate alone: its perimeter lies in its own plane', () => {
    load(plate(24, () => false));
    const info = JSON.parse(analyzer.describeHoles());
    expect(info.length).toBe(1);
    expect(info[0].shellDepth).toBeLessThanOrEqual(0.10);
    expect(info[0].shellThickness).toBeLessThanOrEqual(0.02);
    const r = analyzer.fillHoles(1000);
    expect(r.holesFilled).toBe(0);
    expect(r.holesSkippedAsFeature).toBe(1);
  });

  it('fills the pinprick at the tip of a tapered shell but keeps its wide round base', () => {
    // A cone frustum, 64 segments, open at both ends: bottom radius 5, top
    // radius 0.05, height 10. The top is a 64-edge, perfectly round, planar
    // loop 0.1 across — 0.9% of the model — and used to be kept as a feature.
    const N = 64, rb = 5, rt = 0.05, h = 10;
    const ring = (r: number, z: number) =>
      Array.from({ length: N }, (_, i) => [r * Math.cos((2 * Math.PI * i) / N), r * Math.sin((2 * Math.PI * i) / N), z]);
    const B = ring(rb, 0), T = ring(rt, h);
    const tris: number[][][] = [];
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      tris.push([B[i], B[j], T[j]], [B[i], T[j], T[i]]);
    }
    load(tris);
    const before = analyzer.getAnalysis();
    expect(before.holeCount).toBe(2);
    const info = JSON.parse(analyzer.describeHoles());
    const tip = info.find((l: any) => l.diameter < 1);
    const base = info.find((l: any) => l.diameter > 1);
    expect(tip.looksDeliberate).toBe(false);
    // The wide round base is what the round-opening rule exists to keep.
    expect(base.looksDeliberate).toBe(true);
    const r = analyzer.fillHoles(100);
    expect(r.holesFilled).toBe(1);
    expect(r.holesSkippedAsFeature).toBe(1);
    expect(analyzer.getAnalysis().holeCount).toBe(1);
  });
});
