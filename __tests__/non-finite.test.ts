/**
 * Regression: nothing checked that coordinates were finite, on load or export.
 *
 * Two separate failures came out of that. First, CompareVec3 (the STL weld map's
 * comparator) orders with `<`, and every comparison against NaN is false, so a
 * NaN key compares equivalent to whatever it meets in the tree — std::map's
 * ordering requirement is violated and unrelated positions weld together. With
 * NaN on one triangle in 23 a sphere collapsed to a single vertex and zero
 * faces, reported as a successful load. Second, Inf survived load, repair and
 * export intact, so the downloaded file had an infinite bounding box and slicers
 * rejected it as larger than the build volume — the shape of the FlashPrint
 * "outlined in red, delete the model" report.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { getModule } from './helpers/setup.js';

let module: any;

beforeAll(async () => {
  module = await getModule();
});

// Binary STL from a triangle list, so specific bad coordinates can be planted.
function binaryStl(tris: number[][][]): Uint8Array {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const view = new DataView(buf);
  view.setUint32(80, tris.length, true);
  let o = 84;
  for (const t of tris) {
    o += 12; // normal, ignored by the reader
    for (const v of t) {
      view.setFloat32(o, v[0], true);
      view.setFloat32(o + 4, v[1], true);
      view.setFloat32(o + 8, v[2], true);
      o += 12;
    }
    o += 2; // attribute byte count
  }
  return new Uint8Array(buf);
}

function sphereTris(seg = 40, ring = 26): number[][][] {
  const tris: number[][][] = [];
  const P = (i: number, j: number) => {
    const th = (Math.PI * j) / ring, ph = (2 * Math.PI * i) / seg;
    return [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)];
  };
  for (let j = 0; j < ring; j++)
    for (let i = 0; i < seg; i++) {
      const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
      if (j !== 0) tris.push([a, b, c]);
      if (j !== ring - 1) tris.push([a, c, d]);
    }
  return tris;
}

describe('Non-finite coordinates', () => {
  let analyzer: any;

  beforeEach(() => {
    analyzer = new module.MeshAnalyzer();
  });

  afterEach(() => {
    analyzer.delete();
  });

  function load(tris: number[][][]) {
    module.FS.writeFile('/tmp/nonfinite.stl', binaryStl(tris));
    return analyzer.loadFromFile('/tmp/nonfinite.stl');
  }

  it('scattered NaN no longer collapses the whole model', () => {
    const tris = sphereTris();
    for (let i = 0; i < tris.length; i += 23) tris[i][0] = [NaN, NaN, NaN];

    expect(load(tris)).toBe(true);
    const stats = analyzer.getStats();
    // Before the fix this was vertexCount 1, faceCount 0 — and still "loaded".
    expect(stats.faceCount).toBeGreaterThan(tris.length * 0.9);
    expect(stats.vertexCount).toBeGreaterThan(100);
    expect(analyzer.nonFiniteFacesRemoved()).toBeGreaterThan(0);
  });

  it('drops only the offending triangle, not its neighbours', () => {
    const tris = sphereTris();
    const total = tris.length;
    tris[100][0] = [NaN, NaN, NaN];

    expect(load(tris)).toBe(true);
    expect(analyzer.getStats().faceCount).toBe(total - 1);
    expect(analyzer.nonFiniteFacesRemoved()).toBe(1);
  });

  it('keeps an infinite coordinate out of the bounding box', () => {
    const tris = sphereTris();
    tris[100][0] = [Infinity, 0, 0];

    expect(load(tris)).toBe(true);
    const stats = analyzer.getStats();
    for (const d of [stats.dimX, stats.dimY, stats.dimZ, stats.volume, stats.surfaceArea]) {
      expect(Number.isFinite(d)).toBe(true);
    }
    expect(stats.dimX).toBeLessThan(10);
  });

  it('keeps an infinite coordinate out of the exported file', () => {
    const tris = sphereTris();
    tris[100][0] = [Infinity, 0, 0];
    expect(load(tris)).toBe(true);
    expect(analyzer.exportMesh('/tmp/nonfinite_out.stl')).toBe(true);

    const out = module.FS.readFile('/tmp/nonfinite_out.stl') as Uint8Array;
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const n = dv.getUint32(80, true);
    let o = 84;
    for (let i = 0; i < n; i++) {
      o += 12;
      for (let k = 0; k < 9; k++) {
        expect(Number.isFinite(dv.getFloat32(o + k * 4, true))).toBe(true);
      }
      o += 36 + 2;
    }
    module.FS.unlink('/tmp/nonfinite_out.stl');
  });

  it('a file that is nothing but bad coordinates fails rather than loading empty', () => {
    expect(load([[[NaN, 0, 0], [0, NaN, 0], [0, 0, NaN]]])).toBe(false);
    expect(analyzer.getLastError().length).toBeGreaterThan(0);
  });

  it('a clean file reports nothing removed', () => {
    expect(load(sphereTris())).toBe(true);
    expect(analyzer.nonFiniteFacesRemoved()).toBe(0);
  });
});
