/**
 * Phase 0 feasibility spike for pmp::decimate() in WASM.
 * Gate: any RuntimeError: unreachable (WASM trap) here = STOP, reassess.
 * On pass: promotes to decimate.test.ts in Phase 3.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { getModule } from './helpers/setup.js';

let module: any;

beforeAll(async () => {
    module = await getModule();
});

describe('Decimate — Phase 0 spike', () => {
    let analyzer: any;

    beforeEach(() => {
        analyzer = new module.MeshAnalyzer();
    });

    afterEach(() => {
        analyzer.delete();
    });

    it('icosphere → target 100 vertices: completes, counts drop, exports', () => {
        expect(analyzer.loadTestShape('icosphere')).toBe(true);
        const before = analyzer.getStats();
        // icosphere(3) = 642 verts / 1280 faces
        expect(before.vertexCount).toBeGreaterThan(100);

        const result = analyzer.decimate(100, 0, 0, 0);
        expect(result.success).toBe(true);
        expect(result.verticesAfter).toBeLessThan(result.verticesBefore);
        expect(result.facesAfter).toBeLessThan(result.facesBefore);

        // Must still export a valid mesh (exportMesh writes to MEMFS, returns bool)
        const path = '/tmp/decimate_spike_icosphere.stl';
        expect(analyzer.exportMesh(path)).toBe(true);
        const data = module.FS.readFile(path);
        expect(data).toBeInstanceOf(Uint8Array);
        expect(data.length).toBeGreaterThan(84); // STL header = 84 bytes minimum
        module.FS.unlink(path);
    });

    it('bowtie (non-manifold) → does not trap; success or clean failure', () => {
        expect(analyzer.loadTestShape('bowtie')).toBe(true);
        // Should not throw RuntimeError (WASM trap). Either succeeds or returns success=false.
        let result: any;
        expect(() => {
            result = analyzer.decimate(3, 0, 0, 0);
        }).not.toThrow();
        // If it failed, lastError should be set
        if (!result.success) {
            expect(analyzer.getLastError()).toBeTruthy();
        }
    });

    it('post-repair pipeline mesh → decimate does not trap', () => {
        // Realistic damaged-mesh path: bowtie → full repair → decimate
        expect(analyzer.loadTestShape('bowtie')).toBe(true);
        analyzer.weldVertices(1e-6);
        analyzer.removeDegenerates();
        analyzer.splitVertices();
        analyzer.fillHoles();
        analyzer.fixNormals();
        // After repair, mesh should be in better shape
        let result: any;
        expect(() => {
            result = analyzer.decimate(4, 0, 0, 0);
        }).not.toThrow();
        // Either succeeds or fails cleanly — no trap
        expect(typeof result.success).toBe('boolean');
    });

    it('tetrahedron → target 4 (no-op at floor)', () => {
        expect(analyzer.loadTestShape('tetrahedron')).toBe(true);
        const before = analyzer.getStats();
        const result = analyzer.decimate(4, 0, 0, 0);
        expect(result.success).toBe(true);
        // Either no-op or stops early — counts should be ≥ 4
        expect(result.verticesAfter).toBeGreaterThanOrEqual(4);
        expect(result.verticesAfter).toBeLessThanOrEqual(before.vertexCount);
    });

    it('tetrahedron → target 2 (below our guard of 4: rejected cleanly)', () => {
        expect(analyzer.loadTestShape('tetrahedron')).toBe(true);
        let result: any;
        expect(() => {
            result = analyzer.decimate(2, 0, 0, 0);
        }).not.toThrow();
        // targetVertices < 4 → our guard rejects it with success=false
        expect(result.success).toBe(false);
        expect(analyzer.getLastError()).toMatch(/at least 4/i);
    });

    it('torus (quads) → auto-triangulates and decimates without crash', () => {
        expect(analyzer.loadTestShape('torus')).toBe(true);
        // torus() produces quads — decimate() must triangulate first
        let result: any;
        expect(() => {
            result = analyzer.decimate(200, 0, 0, 0);
        }).not.toThrow();
        // Should succeed after auto-triangulation
        if (!result.success) {
            console.log('[spike] torus decimate failed:', analyzer.getLastError());
        }
        expect(result.success).toBe(true);
        expect(result.verticesAfter).toBeLessThan(result.verticesBefore);
    });

    it('not loaded → success=false with error', () => {
        const result = analyzer.decimate(100, 0, 0, 0);
        expect(result.success).toBe(false);
        expect(analyzer.getLastError()).toMatch(/no mesh loaded/i);
    });

    it('target < 4 → success=false with error', () => {
        expect(analyzer.loadTestShape('icosphere')).toBe(true);
        const result = analyzer.decimate(3, 0, 0, 0);
        expect(result.success).toBe(false);
        expect(analyzer.getLastError()).toBeTruthy();
    });

    it('target >= current vertices → clean no-op success', () => {
        expect(analyzer.loadTestShape('icosphere')).toBe(true);
        const stats = analyzer.getStats();
        const result = analyzer.decimate(stats.vertexCount + 100, 0, 0, 0);
        expect(result.success).toBe(true);
        expect(result.verticesAfter).toBe(result.verticesBefore);
        expect(result.facesAfter).toBe(result.facesBefore);
    });
});
