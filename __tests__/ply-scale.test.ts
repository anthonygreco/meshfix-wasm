import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { getModule } from './helpers/setup.js';

// Minimal ASCII PLY with vertex colours (3 verts, 1 triangle)
const PLY_ASCII_WITH_COLORS = `ply
format ascii 1.0
element vertex 3
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
element face 1
property list uchar int vertex_indices
end_header
0 0 0 255 0 0
1 0 0 0 255 0
0 1 0 0 0 255
3 0 1 2
`;

// Same geometry, no colour properties
const PLY_ASCII_NO_COLORS = `ply
format ascii 1.0
element vertex 3
property float x
property float y
property float z
element face 1
property list uchar int vertex_indices
end_header
0 0 0
1 0 0
0 1 0
3 0 1 2
`;

// Minimal valid OBJ
const OBJ_TRIANGLE = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';

function writeAscii(module: any, path: string, content: string): void {
  module.FS.writeFile(path, new TextEncoder().encode(content));
}

describe('PLY import', () => {
  let module: any;
  let analyzer: any;

  beforeAll(async () => {
    module = await getModule();
  });

  beforeEach(() => {
    analyzer = new module.MeshAnalyzer();
  });

  afterEach(() => {
    analyzer.delete();
  });

  it('loads ASCII PLY with colours', () => {
    writeAscii(module, '/tmp/test_ply_colors.ply', PLY_ASCII_WITH_COLORS);
    const ok = analyzer.loadFromFile('/tmp/test_ply_colors.ply');
    expect(ok).toBe(true);
    const stats = analyzer.getStats();
    expect(stats.vertexCount).toBe(3);
    expect(stats.faceCount).toBe(1);
    module.FS.unlink('/tmp/test_ply_colors.ply');
  });

  it('sets colorsDropped() when PLY has vertex colours', () => {
    writeAscii(module, '/tmp/test_ply_cd.ply', PLY_ASCII_WITH_COLORS);
    analyzer.loadFromFile('/tmp/test_ply_cd.ply');
    expect(analyzer.colorsDropped()).toBe(true);
    module.FS.unlink('/tmp/test_ply_cd.ply');
  });

  it('does NOT set colorsDropped() when PLY has no colour properties', () => {
    writeAscii(module, '/tmp/test_ply_nocd.ply', PLY_ASCII_NO_COLORS);
    const ok = analyzer.loadFromFile('/tmp/test_ply_nocd.ply');
    expect(ok).toBe(true);
    expect(analyzer.colorsDropped()).toBe(false);
    module.FS.unlink('/tmp/test_ply_nocd.ply');
  });

  it('colorsDropped() is false after loadTestShape (geometry-only)', () => {
    analyzer.loadTestShape('icosphere');
    expect(analyzer.colorsDropped()).toBe(false);
  });
});

describe('PLY export', () => {
  let module: any;
  let analyzer: any;

  beforeAll(async () => {
    module = await getModule();
  });

  beforeEach(() => {
    analyzer = new module.MeshAnalyzer();
    analyzer.loadTestShape('icosphere');
  });

  afterEach(() => {
    analyzer.delete();
  });

  it('exportMesh(".ply") produces a non-empty file', () => {
    const path = '/tmp/test_export.ply';
    expect(analyzer.exportMesh(path)).toBe(true);
    const data = module.FS.readFile(path);
    expect(data.length).toBeGreaterThan(100);
    module.FS.unlink(path);
  });

  it('PLY export round-trips: reimported vertex/face counts match', () => {
    const exportPath = '/tmp/test_roundtrip.ply';
    analyzer.exportMesh(exportPath);

    const b = new module.MeshAnalyzer();
    const ok = b.loadFromFile(exportPath);
    expect(ok).toBe(true);
    const original = analyzer.getStats();
    const reimported = b.getStats();
    expect(reimported.vertexCount).toBe(original.vertexCount);
    expect(reimported.faceCount).toBe(original.faceCount);
    b.delete();
    module.FS.unlink(exportPath);
  });

  it('PLY export after repair still works', () => {
    analyzer.loadTestShape('bowtie');
    analyzer.repair(1e-6, 1e-10, 100);
    const path = '/tmp/test_ply_post_repair.ply';
    expect(analyzer.exportMesh(path)).toBe(true);
    const data = module.FS.readFile(path);
    expect(data.length).toBeGreaterThan(0);
    module.FS.unlink(path);
  });
});

describe('Format-aware load (OBJ/OFF/PLY via correct extension)', () => {
  let module: any;
  let analyzer: any;

  beforeAll(async () => {
    module = await getModule();
  });

  beforeEach(() => {
    analyzer = new module.MeshAnalyzer();
  });

  afterEach(() => {
    analyzer.delete();
  });

  it('OBJ file via /tmp/input.obj loads correctly (regression: was broken via .stl path)', () => {
    writeAscii(module, '/tmp/input.obj', OBJ_TRIANGLE);
    const ok = analyzer.loadFromFile('/tmp/input.obj');
    expect(ok).toBe(true);
    const stats = analyzer.getStats();
    expect(stats.vertexCount).toBe(3);
    expect(stats.faceCount).toBe(1);
    module.FS.unlink('/tmp/input.obj');
  });

  it('OBJ bytes via /tmp/input.stl fails (confirms the extension-dispatch bug)', () => {
    // This documents the bug: OBJ bytes written to .stl path → empty mesh
    writeAscii(module, '/tmp/wrong_ext.stl', OBJ_TRIANGLE);
    const ok = analyzer.loadFromFile('/tmp/wrong_ext.stl');
    expect(ok).toBe(false); // expected failure — wrong extension
    module.FS.unlink('/tmp/wrong_ext.stl');
  });
});

describe('Scale', () => {
  let module: any;
  let analyzer: any;

  beforeAll(async () => {
    module = await getModule();
  });

  beforeEach(() => {
    analyzer = new module.MeshAnalyzer();
    analyzer.loadTestShape('icosphere');
  });

  afterEach(() => {
    analyzer.delete();
  });

  it('scale(25.4) multiplies bounding-box dimensions by 25.4', () => {
    const before = analyzer.getStats();
    expect(analyzer.scale(25.4)).toBe(true);
    const after = analyzer.getStats();
    expect(after.dimX).toBeCloseTo(before.dimX * 25.4, 3);
    expect(after.dimY).toBeCloseTo(before.dimY * 25.4, 3);
    expect(after.dimZ).toBeCloseTo(before.dimZ * 25.4, 3);
  });

  it('scale(1.0) leaves dimensions unchanged', () => {
    const before = analyzer.getStats();
    analyzer.scale(1.0);
    const after = analyzer.getStats();
    expect(after.dimX).toBeCloseTo(before.dimX, 5);
    expect(after.dimY).toBeCloseTo(before.dimY, 5);
    expect(after.dimZ).toBeCloseTo(before.dimZ, 5);
  });

  it('scale(1/25.4) correctly inverts a prior scale(25.4) to restore original size', () => {
    const before = analyzer.getStats();
    analyzer.scale(25.4);
    analyzer.scale(1 / 25.4);
    const after = analyzer.getStats();
    expect(after.dimX).toBeCloseTo(before.dimX, 3);
    expect(after.dimY).toBeCloseTo(before.dimY, 3);
    expect(after.dimZ).toBeCloseTo(before.dimZ, 3);
  });

  it('scale(0) returns false (invalid factor)', () => {
    expect(analyzer.scale(0)).toBe(false);
  });

  it('scale(-1) returns false (invalid factor)', () => {
    expect(analyzer.scale(-1)).toBe(false);
  });

  it('scale() preserves vertex count and face count', () => {
    const before = analyzer.getStats();
    analyzer.scale(10);
    const after = analyzer.getStats();
    expect(after.vertexCount).toBe(before.vertexCount);
    expect(after.faceCount).toBe(before.faceCount);
  });

  it('scaled mesh exports correctly as STL', () => {
    analyzer.scale(25.4);
    const path = '/tmp/scaled_export.stl';
    expect(analyzer.exportMesh(path)).toBe(true);
    const data = module.FS.readFile(path);
    expect(data.length).toBeGreaterThan(0);

    // Reimport and verify dimensions scaled
    const b = new module.MeshAnalyzer();
    b.loadFromFile(path);
    const scaled = b.getStats();
    b.delete();
    module.FS.unlink(path);

    const ref = analyzer.getStats();
    expect(scaled.dimX).toBeCloseTo(ref.dimX, 3);
  });

  it('fails gracefully when no mesh loaded', () => {
    const empty = new module.MeshAnalyzer();
    expect(empty.scale(2.0)).toBe(false);
    expect(empty.getLastError()).toBeTruthy();
    empty.delete();
  });
});
