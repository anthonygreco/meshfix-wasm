/**
 * Repair must leave a mesh no worse than it found it, and must never leave
 * the half-edge structure in a state that hangs or traps the next call.
 *
 * Background (research/2026-09-23-repair-batch/ANALYSIS.md): the production
 * 300s repair timeout was fillHoles() handing pmp::add_face() a triangle with
 * a repeated vertex, which PMP accepts and which corrupts the mesh so the next
 * face circulator spins forever; removeDegenerates() deleting faces in place
 * left stale vertex handles that trap; welding tore closed meshes open; the
 * fan fill produced zero-area triangles across collinear boundary vertices;
 * and deleting degenerate faces opened holes instead of closing them.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getModule } from './helpers/setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let module: any;

beforeAll(async () => {
  module = await getModule();
});

type V = [number, number, number];
type Tri = [V, V, V];

function binaryStl(tris: Tri[]): Uint8Array {
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

// A closed unit box, outward-wound, 12 triangles. `skip` drops faces by
// index; `edit` can rewrite the list before it is returned.
function box(opts: { skip?: number[]; size?: number } = {}): Tri[] {
  const s = opts.size ?? 10;
  const p = (x: number, y: number, z: number): V => [x * s, y * s, z * s];
  const q = (a: V, b: V, c: V, d: V): Tri[] => [[a, b, c], [a, c, d]];
  const faces: Tri[] = [
    ...q(p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)), // bottom (z=0), facing -z
    ...q(p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)), // top
    ...q(p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)), // y=0
    ...q(p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)), // x=1
    ...q(p(1, 1, 0), p(0, 1, 0), p(0, 1, 1), p(1, 1, 1)), // y=1
    ...q(p(0, 1, 0), p(0, 0, 0), p(0, 0, 1), p(0, 1, 1)), // x=0
  ];
  const skip = new Set(opts.skip ?? []);
  return faces.filter((_, i) => !skip.has(i));
}

describe('repair integrity', () => {
  let analyzer: any;

  beforeEach(() => {
    analyzer = new module.MeshAnalyzer();
  });

  afterEach(() => {
    analyzer.delete();
  });

  function load(tris: Tri[]) {
    module.FS.writeFile('/tmp/integrity.stl', binaryStl(tris));
    expect(analyzer.loadFromFile('/tmp/integrity.stl')).toBe(true);
  }

  function loadFixture(name: string) {
    const bytes = readFileSync(path.join(__dirname, 'fixtures', name));
    module.FS.writeFile('/tmp/fixture.stl', new Uint8Array(bytes));
    expect(analyzer.loadFromFile('/tmp/fixture.stl')).toBe(true);
  }

  // --- the closed box itself is a fixed point of every operation ------------

  it('a closed box passes through repair untouched', () => {
    load(box());
    const before = analyzer.getAnalysis();
    expect(before.isWatertight).toBe(true);
    const r = analyzer.repair(1e-6, 1e-10, 100);
    const after = analyzer.getAnalysis();
    expect(r.weld.verticesMerged).toBe(0);
    expect(r.weld.facesRemoved).toBe(0);
    expect(after.isWatertight).toBe(true);
    expect(after.faceCount).toBe(12);
    expect(after.connectedComponents).toBe(1);
    expect(after.degenerateTriangleCount).toBe(0);
    expect(analyzer.connectivityRebuilds()).toBe(0);
  });

  // --- weld ----------------------------------------------------------------

  it('weld is a no-op on a closed mesh even when two interior vertices are within epsilon', () => {
    // Two closed boxes side by side with a 5e-7 gap between their facing
    // walls: the facing corners are distinct vertices within epsilon of each
    // other. Welding them would pinch the two solids together at four
    // vertices, which add_face() refuses, tearing both open.
    const a = box({ size: 10 });
    const b = box({ size: 10 }).map((t) => t.map((v) => [v[0] + 10 + 5e-7, v[1], v[2]] as V) as Tri);
    load([...a, ...b]);
    const before = analyzer.getAnalysis();
    expect(before.isWatertight).toBe(true);
    expect(before.connectedComponents).toBe(2);
    const r = analyzer.weldVertices(1e-6);
    expect(r.verticesMerged).toBe(0);
    expect(r.facesRemoved).toBe(0);
    const after = analyzer.getAnalysis();
    expect(after.isWatertight).toBe(true);
    expect(after.connectedComponents).toBe(2);
    expect(after.faceCount).toBe(24);
  });

  it('weld still closes a gap on an open mesh', () => {
    // One corner of one triangle nudged by 5e-7: the loader keeps it as a
    // separate vertex, so the box has a slit at that corner.
    const tris = box();
    tris[0] = [[5e-7, 0, 0], tris[0][1], tris[0][2]];
    load(tris);
    const before = analyzer.getAnalysis();
    expect(before.isWatertight).toBe(false);
    const r = analyzer.weldVertices(1e-6);
    expect(r.verticesMerged).toBe(1);
    const after = analyzer.getAnalysis();
    expect(after.isWatertight).toBe(true);
    expect(after.faceCount).toBe(12);
  });

  // --- fill ----------------------------------------------------------------

  it('fills a missing face whose opening has collinear boundary vertices with no zero-area triangles', () => {
    // Top face removed, and each side wall built as three triangles meeting
    // at the midpoint of its top edge, so the opening's boundary carries a
    // midpoint on every edge: a fan from any corner would put three collinear
    // vertices in a triangle.
    const s = 10;
    const P = (x: number, y: number, z: number): V => [x, y, z];
    const tris: Tri[] = box({ skip: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }); // keep only the bottom
    const wall = (a: V, b: V, top: (v: V) => V): Tri[] => {
      const m: V = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      const [ta, tb, tm] = [top(a), top(b), top(m)];
      return [[a, b, tm], [a, tm, ta], [b, tb, tm]];
    };
    const up = (v: V): V => [v[0], v[1], s];
    tris.push(...wall(P(0, 0, 0), P(s, 0, 0), up));
    tris.push(...wall(P(s, 0, 0), P(s, s, 0), up));
    tris.push(...wall(P(s, s, 0), P(0, s, 0), up));
    tris.push(...wall(P(0, s, 0), P(0, 0, 0), up));
    load(tris);
    const before = analyzer.getAnalysis();
    expect(before.holeCount).toBe(1);
    expect(before.boundaryEdges).toBe(8);
    const r = analyzer.fillHoles(100);
    expect(r.holesFilled).toBe(1);
    const after = analyzer.getAnalysis();
    expect(after.isWatertight).toBe(true);
    expect(after.degenerateTriangleCount).toBe(0);
    expect(analyzer.connectivityRebuilds()).toBe(0);
  });

  it('does not seal a lone flap into a zero-thickness sandwich', () => {
    load([[[0, 0, 0], [10, 0, 0], [0, 10, 0]]]);
    const r = analyzer.fillHoles(100);
    expect(r.holesFilled).toBe(0);
    const after = analyzer.getAnalysis();
    expect(after.faceCount).toBe(1);
    expect(after.duplicateFaceCount).toBe(0);
  });

  // --- degenerates ---------------------------------------------------------

  it('removes a zero-area triangle from a closed mesh without opening it', () => {
    // Bottom face: one side of the diagonal split at its midpoint M, the other
    // side unsplit, and the seam between them sealed by the zero-area triangle
    // (A, M, B). Every edge has two faces, so the mesh is closed with exactly
    // one degenerate face — what a T-junction looks like once it is sealed.
    const tris = box({ skip: [0, 1] });
    const A: V = [0, 0, 0], B: V = [10, 10, 0], C: V = [0, 10, 0], D: V = [10, 0, 0], M: V = [5, 5, 0];
    tris.push([A, C, M], [M, C, B], [A, B, D], [A, M, B]);
    load(tris);
    const before = analyzer.getAnalysis();
    expect(before.isWatertight).toBe(true);
    expect(before.degenerateTriangleCount).toBe(1);
    const r = analyzer.removeDegenerates(1e-10);
    expect(r.degenerateRemoved).toBe(1);
    const after = analyzer.getAnalysis();
    expect(after.degenerateTriangleCount).toBe(0);
    expect(after.isWatertight).toBe(true);
    expect(after.connectedComponents).toBe(1);
    expect(analyzer.connectivityRebuilds()).toBe(0);
  });

  it('stitches a T-junction seam: repair closes it with no degenerate triangles left', () => {
    // Bottom face as two triangles on one side of the diagonal split at its
    // midpoint, one unsplit triangle on the other: the diagonal is a seam with
    // a zero-width slit (a 3-edge boundary loop through the midpoint).
    const tris = box({ skip: [0, 1] });
    const A: V = [0, 0, 0], B: V = [10, 10, 0], C: V = [0, 10, 0], D: V = [10, 0, 0], M: V = [5, 5, 0];
    tris.push([A, C, M], [M, C, B], [A, B, D]);
    load(tris);
    const before = analyzer.getAnalysis();
    expect(before.isWatertight).toBe(false);
    analyzer.repair(1e-6, 1e-10, 100);
    const after = analyzer.getAnalysis();
    expect(after.isWatertight).toBe(true);
    expect(after.degenerateTriangleCount).toBe(0);
    expect(after.connectedComponents).toBe(1);
    expect(analyzer.connectivityRebuilds()).toBe(0);
  });

  it('removes duplicate faces and reports them', () => {
    // A duplicate can only load when both copies have free halfedges, i.e. a
    // lone triangle and its reverse: a zero-thickness pillow, which is junk
    // on both sides.
    load([
      [[0, 0, 0], [10, 0, 0], [0, 10, 0]],
      [[0, 0, 0], [0, 10, 0], [10, 0, 0]],
    ]);
    const before = analyzer.getAnalysis();
    expect(before.duplicateFaceCount).toBe(1);
    const r = analyzer.removeDegenerates(1e-10);
    expect(r.duplicateRemoved).toBe(2); // a pillow: both copies go
    expect(analyzer.getAnalysis().faceCount).toBe(0);
    expect(analyzer.connectivityRebuilds()).toBe(0);
  });

  it('a mesh that made delete_face() leave stale vertex handles is handled cleanly', () => {
    // 8 faces delta-debugged from Thingiverse model 815482 and 9 from 73177:
    // in 0.5.0, removeDegenerates() left 2 and 4 halfedges pointing at
    // removed vertices, and the next position read trapped ("memory access
    // out of bounds").
    for (const fixture of ['stale-vertex-handles.stl', 'stale-vertex-handles-2.stl']) {
      loadFixture(fixture);
      const before = analyzer.getAnalysis();
      analyzer.removeDegenerates(1e-10);
      // What matters is that the structure survives: the degenerate faces
      // here touch non-manifold vertices, which the collapse rightly refuses.
      const after = analyzer.getAnalysis();
      expect(after.faceCount).toBeGreaterThan(0);
      expect(after.degenerateTriangleCount).toBeLessThanOrEqual(before.degenerateTriangleCount);
      expect(analyzer.connectivityRebuilds()).toBe(0);
      loadFixture(fixture);
      expect(() => analyzer.repair(1e-6, 1e-10, 100)).not.toThrow();
      expect(analyzer.getAnalysis().faceCount).toBeGreaterThan(0);
      expect(analyzer.connectivityRebuilds()).toBe(0);
    }
  });

  it('a boundary loop that passes through one vertex twice is filled without corrupting the mesh', () => {
    // 13 faces delta-debugged from Thingiverse model 197005. In 0.5.0 the fan
    // fill handed add_face() a triangle with a repeated vertex, PMP accepted
    // it, and fixNormals() then spun forever on the broken face ring — the
    // production 300s repair timeout.
    loadFixture('pinched-boundary-loop.stl');
    const before = analyzer.getAnalysis();
    expect(before.holeCount).toBeGreaterThan(0);
    const r = analyzer.repair(1e-6, 1e-10, 100);
    expect(r.fillHoles.holesFilled).toBeGreaterThan(0);
    const after = analyzer.getAnalysis();
    expect(after.faceCount).toBeGreaterThan(0);
    expect(after.holeCount).toBeLessThan(before.holeCount);
    expect(analyzer.connectivityRebuilds()).toBe(0);
  });

  // --- normals -------------------------------------------------------------

  it('fixNormals leaves an internal cavity facing inward', () => {
    // A 30-unit box with an inverted 10-unit box inside it: a hollow part.
    const outer = box({ size: 30 });
    const inner = box({ size: 10 })
      .map((t) => t.map((v) => [v[0] + 10, v[1] + 10, v[2] + 10] as V) as Tri)
      .map((t) => [t[0], t[2], t[1]] as Tri); // inward
    load([...outer, ...inner]);
    const before = analyzer.getAnalysis();
    expect(before.connectedComponents).toBe(2);
    expect(before.flippedNormalCount).toBe(0);
    expect(before.volume).toBeCloseTo(27000 - 1000, 0);
    const r = analyzer.fixNormals();
    expect(r.componentsFlipped).toBe(0);
    expect(analyzer.getAnalysis().volume).toBeCloseTo(27000 - 1000, 0);
  });

  it('fixNormals still flips a lone inside-out solid', () => {
    load(box({ size: 10 }).map((t) => [t[0], t[2], t[1]] as Tri));
    const before = analyzer.getAnalysis();
    expect(before.flippedNormalCount).toBe(12);
    const r = analyzer.fixNormals();
    expect(r.componentsFlipped).toBe(1);
    expect(r.facesFlipped).toBe(12);
    expect(analyzer.getAnalysis().flippedNormalCount).toBe(0);
  });

  it('fixNormals ignores a zero-volume closed pillow instead of flipping it back and forth', () => {
    const tris: Tri[] = [
      ...box({ size: 10 }),
      [[50, 50, 50], [60, 50, 50], [50, 60, 50]],
      [[50, 50, 50], [50, 60, 50], [60, 50, 50]],
    ];
    load(tris);
    expect(analyzer.getAnalysis().flippedNormalCount).toBe(0);
    const r = analyzer.fixNormals();
    expect(r.componentsFlipped).toBe(0);
  });

  it('removes both halves of a zero-thickness pillow rather than leaving a flap with a hole', () => {
    const tris: Tri[] = [
      ...box({ size: 10 }),
      [[50, 50, 50], [60, 50, 50], [50, 60, 50]],
      [[50, 50, 50], [50, 60, 50], [60, 50, 50]],
    ];
    load(tris);
    expect(analyzer.getAnalysis().duplicateFaceCount).toBe(1);
    const r = analyzer.removeDegenerates(1e-10);
    expect(r.duplicateRemoved).toBe(2);
    const after = analyzer.getAnalysis();
    expect(after.faceCount).toBe(12);
    expect(after.holeCount).toBe(0);
    expect(after.isWatertight).toBe(true);
  });

  it('drops a lone flap instead of sealing it into a pillow', () => {
    load([...box({ size: 10 }), [[50, 50, 50], [60, 50, 50], [50, 60, 50]]]);
    const before = analyzer.getAnalysis();
    expect(before.connectedComponents).toBe(2);
    expect(before.holeCount).toBe(1);
    const r = analyzer.fillHoles(100);
    expect(r.holesFilled).toBe(0);
    expect(r.flapsRemoved).toBe(1);
    const after = analyzer.getAnalysis();
    expect(after.connectedComponents).toBe(1);
    expect(after.holeCount).toBe(0);
    expect(after.faceCount).toBe(12);
    expect(after.duplicateFaceCount).toBe(0);
  });

  it('resolves a sealed T-junction without moving any vertex: volume is exact', () => {
    // Same seam as the stitching test, but assert the geometry: the box is
    // 10 x 10 x 10, and nothing the repair does may change that.
    const tris = box({ skip: [0, 1] });
    const A: V = [0, 0, 0], B: V = [10, 10, 0], C: V = [0, 10, 0], D: V = [10, 0, 0], M: V = [5, 5, 0];
    tris.push([A, C, M], [M, C, B], [A, B, D], [A, M, B]);
    load(tris);
    analyzer.repair(1e-6, 1e-10, 100);
    const after = analyzer.getAnalysis();
    expect(after.isWatertight).toBe(true);
    expect(after.degenerateTriangleCount).toBe(0);
    expect(after.volume).toBeCloseTo(1000, 3);
    expect(after.surfaceArea).toBeCloseTo(600, 3);
  });

  it('a slit seam with interleaved vertices on both sides is stitched with no zero-area triangles left', () => {
    // fan.stl: the bottom face is two triangles meeting on the diagonal,
    // one side subdivided at t = 0, .2, .4, .6, .8, 1 along it and the other
    // at t = 0, .3, .7, 1. The seam is an 8-vertex boundary loop with every
    // vertex on one line, so every triangle fillHoles() can put in it has
    // zero area (up to float noise: 0, 2^-22, 2^-19 ...). removeDegenerates()
    // must eat that chain from its ends by handing each middle vertex to the
    // real face across, never flipping between two fill triangles (that
    // cycled for ever), and must not move anything.
    const tris = box({ skip: [0, 1] });
    const c0: V = [0, 0, 0], c1: V = [10, 0, 0], c2: V = [10, 10, 0], c3: V = [0, 10, 0];
    const S = [0, 0.2, 0.4, 0.6, 0.8, 1].map((t): V => [10 * t, 10 * t, 0]);
    const T = [0, 0.3, 0.7, 1].map((t): V => [10 * t, 10 * t, 0]);
    for (let i = 0; i + 1 < S.length; i++) tris.push([c1, S[i], S[i + 1]]);
    for (let j = 0; j + 1 < T.length; j++) tris.push([c3, T[j + 1], T[j]]);
    void c0; void c2;
    load(tris);
    const before = analyzer.getAnalysis();
    expect(before.isWatertight).toBe(false);
    expect(before.holeCount).toBe(1);
    analyzer.repair(1e-6, 1e-10, 100);
    const after = analyzer.getAnalysis();
    expect(after.isWatertight).toBe(true);
    expect(after.degenerateTriangleCount).toBe(0);
    expect(after.connectedComponents).toBe(1);
    expect(after.volume).toBeCloseTo(1000, 3);
    expect(after.surfaceArea).toBeCloseTo(600, 3);
    expect(analyzer.connectivityRebuilds()).toBe(0);
  });

  it('a zero-area triangle on a fold where two surfaces overlap: the fold goes, the missing half is added, nothing moves', () => {
    // Bottom face of the box with a pocket glued into a triangular hole
    // (A, M, D): the face across (B, A, D), a zero-area cap (A, B, M) with M
    // on A–B, and a fold (M, B, D) that coincides with half of the face
    // across, wound the other way. B belongs to those three faces only.
    // The cap cannot be flipped (M–D already exists) and the face across
    // cannot be split through M (the half (M, B, D) is already there):
    // the whole pocket is replaced by the one missing half (M, A, D), and
    // B, which has lost its last face, goes with it.
    const tris = box({ skip: [0, 1] });
    const c0: V = [0, 0, 0], c1: V = [10, 0, 0], c2: V = [10, 10, 0], c3: V = [0, 10, 0];
    const A: V = [6, 6, 0], M: V = [4, 4, 0], B: V = [2, 2, 0], D: V = [6, 2, 0];
    tris.push([c0, c3, M], [c3, A, M], [c3, c2, A], [c2, D, A], [c2, c1, D], [c0, D, c1], [c0, M, D]);
    tris.push([B, A, D], [A, B, M], [M, B, D]);
    load(tris);
    const before = analyzer.getAnalysis();
    expect(before.isWatertight).toBe(true);
    expect(before.degenerateTriangleCount).toBe(1);
    expect(before.vertexCount).toBe(12);
    const r = analyzer.repair(1e-6, 1e-10, 100);
    expect(r.removeDegenerates.degenerateRemoved).toBe(1);
    const after = analyzer.getAnalysis();
    expect(after.isWatertight).toBe(true);
    expect(after.degenerateTriangleCount).toBe(0);
    expect(after.vertexCount).toBe(11);
    expect(after.faceCount).toBe(tris.length - 2);
    expect(after.volume).toBeCloseTo(1000, 3);
    expect(after.surfaceArea).toBeCloseTo(600, 3);
    expect(analyzer.connectivityRebuilds()).toBe(0);
  });

  it('a small part far from the origin has no zero-area triangles and repair leaves it alone', () => {
    // pmp::face_area() sums cross products of absolute positions in float:
    // for a 0.003 mm box 64 mm from the origin the terms are ~4000 and the
    // true area (4.5e-6) is below their rounding, so faces came out with an
    // area of exactly 0 and were "repaired" (Thingiverse 815482, 73177).
    const tris = box({ size: 0.003 }).map(t => t.map(([x, y, z]) => [x + 50, y - 40, z + 7] as V) as Tri);
    load(tris);
    const before = analyzer.getAnalysis();
    expect(before.degenerateTriangleCount).toBe(0);
    const r = analyzer.repair(1e-6, 1e-10, 100);
    expect(r.removeDegenerates.degenerateRemoved).toBe(0);
    const after = analyzer.getAnalysis();
    expect(after.faceCount).toBe(12);
    expect(after.vertexCount).toBe(8);
    expect(after.isWatertight).toBe(true);
    expect(after.degenerateTriangleCount).toBe(0);
  });

  // --- the pipeline as a whole ---------------------------------------------

  it('repair never leaves the mesh structurally invalid on any built-in shape', () => {
    for (const shape of ['icosphere', 'torus', 'tetrahedron', 'bowtie']) {
      expect(analyzer.loadTestShape(shape)).toBe(true);
      const before = analyzer.getAnalysis();
      analyzer.repair(1e-6, 1e-10, 100);
      const after = analyzer.getAnalysis();
      expect(analyzer.connectivityRebuilds()).toBe(0);
      if (before.isWatertight) expect(after.isWatertight).toBe(true);
      expect(after.degenerateTriangleCount).toBeLessThanOrEqual(before.degenerateTriangleCount);
      expect(after.holeCount).toBeLessThanOrEqual(before.holeCount);
    }
  });

  it('repair on a box missing one face closes it and changes nothing else', () => {
    load(box({ skip: [2, 3] }));
    const before = analyzer.getAnalysis();
    expect(before.holeCount).toBe(1);
    analyzer.repair(1e-6, 1e-10, 100);
    const after = analyzer.getAnalysis();
    expect(after.isWatertight).toBe(true);
    expect(after.faceCount).toBe(12);
    expect(after.degenerateTriangleCount).toBe(0);
    expect(after.connectedComponents).toBe(1);
  });
});
