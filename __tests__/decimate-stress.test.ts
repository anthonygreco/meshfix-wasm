/**
 * Stress / high-poly tests for decimate().
 * icosphere6 (81,920 faces) runs by default with a generous timeout.
 * icosphere7 (327,680 faces) is gated behind MESHFIX_SLOW=1.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { getModule } from './helpers/setup.js';

let module: any;

beforeAll(async () => {
    module = await getModule();
});

describe('Decimate — stress', () => {
    let analyzer: any;

    beforeEach(() => {
        analyzer = new module.MeshAnalyzer();
    });

    afterEach(() => {
        analyzer.delete();
    });

    it('icosphere6 (81,920 faces) → target 5,000 vertices: completes, watertight, exports', { timeout: 120_000 }, () => {
        expect(analyzer.loadTestShape('icosphere6')).toBe(true);
        const before = analyzer.getStats();
        expect(before.faceCount).toBe(81920);

        const result = analyzer.decimate(5000, 0, 0, 0);
        expect(result.success).toBe(true);
        expect(result.verticesAfter).toBeLessThan(before.vertexCount);
        expect(result.facesAfter).toBeLessThan(before.faceCount);

        const analysis = analyzer.getAnalysis();
        expect(analysis.isWatertight).toBe(true);
        expect(analysis.isTriangleMesh).toBe(true);

        // Export smoke test
        const path = '/tmp/decimate_stress_icosphere6.stl';
        expect(analyzer.exportMesh(path)).toBe(true);
        const data = module.FS.readFile(path);
        module.FS.unlink(path);
        expect(data.length).toBeGreaterThan(84);
    });

    it.skipIf(!process.env.MESHFIX_SLOW)(
        'icosphere7 (327,680 faces) → target 10,000 vertices: completes without trap',
        { timeout: 600_000 },
        () => {
            expect(analyzer.loadTestShape('icosphere7')).toBe(true);
            const before = analyzer.getStats();
            expect(before.faceCount).toBe(327680);

            const result = analyzer.decimate(10000, 0, 0, 0);
            expect(result.success).toBe(true);
            expect(result.verticesAfter).toBeLessThan(before.vertexCount);
        }
    );
});
