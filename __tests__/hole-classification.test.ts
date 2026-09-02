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
