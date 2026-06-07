/**
 * Full test suite for decimate() — promoted from Phase 0 spike.
 * Tests operate on raw module.MeshAnalyzer (same pattern as ply-scale.test.ts).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { getModule } from './helpers/setup.js';

let module: any;

beforeAll(async () => {
    module = await getModule();
});

describe('Decimate', () => {
    let analyzer: any;

    beforeEach(() => {
        analyzer = new module.MeshAnalyzer();
    });

    afterEach(() => {
        analyzer.delete();
    });

    // ── Basic correctness ────────────────────────────────────────────────────

    it('decimates icosphere to approximately target vertex count', () => {
        expect(analyzer.loadTestShape('icosphere')).toBe(true);
        const result = analyzer.decimate(100, 0, 0, 0);
        expect(result.success).toBe(true);
        expect(result.verticesAfter).toBeLessThan(result.verticesBefore);
        expect(result.facesAfter).toBeLessThan(result.facesBefore);
        // PMP stops at or near target — allow small overshoot from constraints
        expect(result.verticesAfter).toBeLessThanOrEqual(120);
        // F ≈ 2V − 4 for closed manifold: rough sanity check
        expect(result.facesAfter).toBeGreaterThan(0);
    });

    it('result struct counts match live mesh state (garbage_collection ran)', () => {
        expect(analyzer.loadTestShape('icosphere')).toBe(true);
        const result = analyzer.decimate(100, 0, 0, 0);
        expect(result.success).toBe(true);
        // pmp::decimate() calls garbage_collection() — struct should match live counts
        expect(result.verticesAfter).toBe(analyzer.getVertexCount());
        expect(result.facesAfter).toBe(analyzer.getFaceCount());
    });

    it('decimated mesh exports as valid STL and reimports with matching face count', () => {
        expect(analyzer.loadTestShape('icosphere')).toBe(true);
        const result = analyzer.decimate(100, 0, 0, 0);
        expect(result.success).toBe(true);

        const path = '/tmp/decimate_test_export.stl';
        expect(analyzer.exportMesh(path)).toBe(true);
        const data = module.FS.readFile(path);
        module.FS.unlink(path);
        expect(data).toBeInstanceOf(Uint8Array);
        expect(data.length).toBeGreaterThan(84);

        // Reimport and verify face count consistency
        module.FS.writeFile('/tmp/decimate_reimport.stl', data);
        const analyzer2 = new module.MeshAnalyzer();
        try {
            expect(analyzer2.loadFromFile('/tmp/decimate_reimport.stl')).toBe(true);
            expect(analyzer2.getFaceCount()).toBe(result.facesAfter);
        } finally {
            analyzer2.delete();
            try { module.FS.unlink('/tmp/decimate_reimport.stl'); } catch {}
        }
    });

    it('closed icosphere stays watertight after decimation', () => {
        expect(analyzer.loadTestShape('icosphere')).toBe(true);
        const result = analyzer.decimate(100, 0, 0, 0);
        expect(result.success).toBe(true);
        const analysis = analyzer.getAnalysis();
        expect(analysis.isWatertight).toBe(true);
    });

    // ── Edge cases ───────────────────────────────────────────────────────────

    it('target >= current vertices is a clean no-op success', () => {
        expect(analyzer.loadTestShape('icosphere')).toBe(true);
        const stats = analyzer.getStats();
        const result = analyzer.decimate(stats.vertexCount + 500, 0, 0, 0);
        expect(result.success).toBe(true);
        expect(result.verticesAfter).toBe(result.verticesBefore);
        expect(result.facesAfter).toBe(result.facesBefore);
    });

    it('target < 4 is rejected cleanly', () => {
        expect(analyzer.loadTestShape('icosphere')).toBe(true);
        const result = analyzer.decimate(3, 0, 0, 0);
        expect(result.success).toBe(false);
        expect(analyzer.getLastError()).toMatch(/at least 4/i);
    });

    it('not loaded returns success=false with error message', () => {
        const result = analyzer.decimate(100, 0, 0, 0);
        expect(result.success).toBe(false);
        expect(analyzer.getLastError()).toMatch(/no mesh loaded/i);
    });

    // ── Quality constraints ──────────────────────────────────────────────────

    it('hausdorffError constraint stops decimation earlier than unconstrained', () => {
        // Tight hausdorff bound should leave more vertices than unconstrained
        expect(analyzer.loadTestShape('icosphere')).toBe(true);
        const unconstrained = analyzer.decimate(50, 0, 0, 0);
        expect(unconstrained.success).toBe(true);

        const analyzer2 = new module.MeshAnalyzer();
        try {
            expect(analyzer2.loadTestShape('icosphere')).toBe(true);
            // Very tight tolerance: 0.01 model units — should stop far above target 50
            const constrained = analyzer2.decimate(50, 0, 0, 0.01);
            expect(constrained.success).toBe(true);
            expect(constrained.verticesAfter).toBeGreaterThanOrEqual(unconstrained.verticesAfter);
        } finally {
            analyzer2.delete();
        }
    });

    it('normalDeviation constraint stops decimation earlier than unconstrained', () => {
        expect(analyzer.loadTestShape('icosphere')).toBe(true);
        const unconstrained = analyzer.decimate(50, 0, 0, 0);
        expect(unconstrained.success).toBe(true);

        const analyzer2 = new module.MeshAnalyzer();
        try {
            expect(analyzer2.loadTestShape('icosphere')).toBe(true);
            // Tight normal deviation: 1 degree
            const constrained = analyzer2.decimate(50, 0, 1, 0);
            expect(constrained.success).toBe(true);
            expect(constrained.verticesAfter).toBeGreaterThanOrEqual(unconstrained.verticesAfter);
        } finally {
            analyzer2.delete();
        }
    });

    // ── Quad mesh auto-triangulation ─────────────────────────────────────────

    it('quad torus auto-triangulates before decimation and succeeds', () => {
        // pmp::torus() produces quads — decimate() must triangulate before calling PMP
        expect(analyzer.loadTestShape('torus')).toBe(true);
        const before = analyzer.getStats();
        const result = analyzer.decimate(200, 0, 0, 0);
        expect(result.success).toBe(true);
        expect(result.verticesAfter).toBeLessThan(before.vertexCount);
        // Mesh is still a triangle mesh after decimation
        const analysis = analyzer.getAnalysis();
        expect(analysis.isTriangleMesh).toBe(true);
    });

    // ── Robustness with damaged meshes ───────────────────────────────────────

    it('bowtie (non-manifold) does not trap; produces success or clean failure', () => {
        expect(analyzer.loadTestShape('bowtie')).toBe(true);
        let result: any;
        expect(() => {
            result = analyzer.decimate(4, 0, 0, 0);
        }).not.toThrow();
        expect(typeof result.success).toBe('boolean');
        if (!result.success) {
            expect(analyzer.getLastError()).toBeTruthy();
        }
    });

    it('decimate after full repair pipeline does not trap', () => {
        // Realistic path: damaged mesh → repair → decimate
        expect(analyzer.loadTestShape('bowtie')).toBe(true);
        analyzer.weldVertices(1e-6);
        analyzer.removeDegenerates();
        analyzer.splitVertices();
        analyzer.fillHoles();
        analyzer.fixNormals();
        let result: any;
        expect(() => {
            result = analyzer.decimate(4, 0, 0, 0);
        }).not.toThrow();
        expect(typeof result.success).toBe('boolean');
    });

    // ── Constraint floor (stops early without error) ─────────────────────────

    it('tetrahedron: target at minimum (4) is a clean no-op', () => {
        expect(analyzer.loadTestShape('tetrahedron')).toBe(true);
        const stats = analyzer.getStats();
        const result = analyzer.decimate(stats.vertexCount, 0, 0, 0);
        expect(result.success).toBe(true);
        expect(result.verticesAfter).toBe(result.verticesBefore);
    });

    it('icosphere: large reduction reaches approximate target (PMP stops near target)', () => {
        expect(analyzer.loadTestShape('icosphere')).toBe(true);
        const result = analyzer.decimate(20, 0, 0, 0);
        expect(result.success).toBe(true);
        // PMP QEM: stops when no more safe collapses — should get close to 20
        expect(result.verticesAfter).toBeGreaterThan(0);
        expect(result.verticesAfter).toBeLessThan(100); // significantly reduced
    });
});
