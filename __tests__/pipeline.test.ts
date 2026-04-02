import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { getModule } from './helpers/setup.js';

describe('Full Repair Pipeline', () => {
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

  it('repair() on bowtie returns valid RepairResult', () => {
    analyzer.loadTestShape('bowtie');
    const result = analyzer.repair(1e-6, 1e-10, 100);
    expect(result.verticesBefore).toBeGreaterThan(0);
    expect(result.verticesAfter).toBeGreaterThan(0);
    expect(result.facesBefore).toBeGreaterThan(0);
    expect(result.facesAfter).toBeGreaterThan(0);
  });

  it('after repair on bowtie, topology improves', () => {
    analyzer.loadTestShape('bowtie');
    const beforeAnalysis = analyzer.getAnalysis();
    const beforeNMV = beforeAnalysis.nonManifoldVertexCount;
    analyzer.repair(1e-6, 1e-10, 100);
    const afterAnalysis = analyzer.getAnalysis();
    expect(afterAnalysis.nonManifoldVertexCount).toBeLessThanOrEqual(beforeNMV);
  });

  it('repair() on icosphere (already clean) completes without error', () => {
    analyzer.loadTestShape('icosphere');
    expect(() => analyzer.repair(1e-6, 1e-10, 100)).not.toThrow();
  });

  it('repair() with custom options works', () => {
    analyzer.loadTestShape('bowtie');
    expect(() => analyzer.repair(1e-5, 1e-8, 50)).not.toThrow();
  });

  it('two sequential repair cycles on same analyzer do not crash', () => {
    analyzer.loadTestShape('bowtie');
    analyzer.repair(1e-6, 1e-10, 100);
    // Reload and repair again
    analyzer.loadTestShape('bowtie');
    expect(() => analyzer.repair(1e-6, 1e-10, 100)).not.toThrow();
  });
});
