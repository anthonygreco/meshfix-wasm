/**
 * Regression: pmp::decimate() can return normally having left faces that
 * reference vertices its own garbage_collection() removed. The shipped build is
 * -O2 with NDEBUG, so PMP's bounds assert is gone and the next traversal to read
 * a vertex position indexes past the end of the property array — a WASM trap
 * that aborts the whole module and kills the engine for the rest of the session.
 *
 * Found via GA4: 276 decimate_failed over 90 days, every one a WASM abort
 * ("memory access out of bounds" 229, "index out of bounds" 36), 100% on .stl,
 * failure rate climbing from 2.0% under 1k faces to 30.6% at 100-250k.
 *
 * corrupting-decimate.stl is that case delta-debugged from 20,334 triangles to
 * 13. Against the unfixed build it decimates "successfully" and then traps in
 * writeRenderData(); the fix is the connectivityIsValid() check in decimate().
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

describe('Decimate — connectivity after decimation', () => {
  let analyzer: any;

  beforeEach(() => {
    analyzer = new module.MeshAnalyzer();
  });

  afterEach(() => {
    analyzer.delete();
  });

  function loadFixture(name: string) {
    const bytes = readFileSync(path.resolve(__dirname, 'fixtures', name));
    module.FS.writeFile('/tmp/' + name, bytes);
    expect(analyzer.loadFromFile('/tmp/' + name)).toBe(true);
  }

  it('leaves a mesh every later traversal can walk', () => {
    loadFixture('corrupting-decimate.stl');
    const before = analyzer.getVertexCount();

    const r = analyzer.decimate(Math.max(4, Math.round(before * 0.5)), 0, 0, 0);
    expect(r.success).toBe(true);

    // Each of these reads face -> vertex positions. Before the fix,
    // writeRenderData() threw "memory access out of bounds" here.
    expect(() => analyzer.getAnalysis()).not.toThrow();
    expect(() => analyzer.getStats()).not.toThrow();
    expect(analyzer.writeRenderData('/tmp/render_decimate.bin')).toBe(true);
    expect(analyzer.exportMesh('/tmp/out_decimate.stl')).toBe(true);
  });

  it('reports the faces it had to drop rather than dropping them silently', () => {
    loadFixture('corrupting-decimate.stl');
    const r = analyzer.decimate(Math.max(4, Math.round(analyzer.getVertexCount() * 0.5)), 0, 0, 0);
    expect(r.success).toBe(true);
    // This fixture is the whole point: decimation really does corrupt it, so a
    // zero here means the guard stopped running, not that the mesh came out clean.
    expect(r.facesDropped).toBeGreaterThan(0);
    expect(r.facesAfter).toBeGreaterThan(0);
  });

  it('a clean mesh still decimates with nothing dropped', () => {
    expect(analyzer.loadTestShape('icosphere')).toBe(true);
    const r = analyzer.decimate(100, 0, 0, 0);
    expect(r.success).toBe(true);
    expect(r.facesDropped).toBe(0);
    expect(analyzer.writeRenderData('/tmp/render_clean.bin')).toBe(true);
  });
});
