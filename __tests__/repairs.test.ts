import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { getModule } from './helpers/setup.js';

describe('Individual Repair Operations', () => {
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

  describe('weldVertices', () => {
    it('returns a WeldResult with numeric fields', () => {
      analyzer.loadTestShape('icosphere');
      const result = analyzer.weldVertices(1e-6);
      expect(typeof result.verticesBefore).toBe('number');
      expect(typeof result.verticesAfter).toBe('number');
      expect(typeof result.verticesMerged).toBe('number');
      expect(typeof result.facesBefore).toBe('number');
      expect(typeof result.facesAfter).toBe('number');
      expect(typeof result.facesRemoved).toBe('number');
      expect(typeof result.degenerateFaces).toBe('number');
      expect(typeof result.skippedFaces).toBe('number');
    });

    it('does not throw on a clean mesh', () => {
      analyzer.loadTestShape('icosphere');
      expect(() => analyzer.weldVertices(1e-6)).not.toThrow();
    });

    it('vertex count after weld is <= before', () => {
      analyzer.loadTestShape('icosphere');
      const before = analyzer.getVertexCount();
      analyzer.weldVertices(1e-6);
      expect(analyzer.getVertexCount()).toBeLessThanOrEqual(before);
    });
  });

  describe('removeDegenerates', () => {
    it('returns a RemoveDegeneratesResult with numeric fields', () => {
      analyzer.loadTestShape('icosphere');
      const result = analyzer.removeDegenerates(1e-10);
      expect(typeof result.facesBefore).toBe('number');
      expect(typeof result.facesAfter).toBe('number');
      expect(typeof result.degenerateRemoved).toBe('number');
      expect(typeof result.duplicateRemoved).toBe('number');
      expect(typeof result.isolatedVerticesRemoved).toBe('number');
    });

    it('does not throw on a clean mesh', () => {
      analyzer.loadTestShape('icosphere');
      expect(() => analyzer.removeDegenerates(1e-10)).not.toThrow();
    });
  });

  describe('fixNormals', () => {
    it('returns a FixNormalsResult with expected fields', () => {
      analyzer.loadTestShape('icosphere');
      const result = analyzer.fixNormals();
      expect(typeof result.componentsFlipped).toBe('number');
      expect(typeof result.facesFlipped).toBe('number');
      expect(typeof result.skippedOpen).toBe('number');
    });

    it('on icosphere, facesFlipped should be 0', () => {
      analyzer.loadTestShape('icosphere');
      const result = analyzer.fixNormals();
      expect(result.facesFlipped).toBe(0);
    });
  });

  describe('fillHoles', () => {
    it('returns a FillHolesResult with expected fields', () => {
      analyzer.loadTestShape('icosphere');
      const result = analyzer.fillHoles(100);
      expect(typeof result.holesFound).toBe('number');
      expect(typeof result.holesFilled).toBe('number');
      expect(typeof result.holesFailed).toBe('number');
      expect(typeof result.holesSkipped).toBe('number');
      expect(typeof result.facesAdded).toBe('number');
    });

    it('on watertight mesh, holesFound should be 0', () => {
      analyzer.loadTestShape('icosphere');
      const result = analyzer.fillHoles(100);
      expect(result.holesFound).toBe(0);
    });

    it('on bowtie (open mesh), should find holes', () => {
      analyzer.loadTestShape('bowtie');
      const result = analyzer.fillHoles(100);
      expect(result.holesFound).toBeGreaterThan(0);
    });
  });

  describe('splitVertices', () => {
    it('returns a SplitVerticesResult with expected fields', () => {
      analyzer.loadTestShape('icosphere');
      const result = analyzer.splitVertices();
      expect(typeof result.verticesBefore).toBe('number');
      expect(typeof result.verticesAfter).toBe('number');
      expect(typeof result.nonManifoldVerticesFound).toBe('number');
      expect(typeof result.verticesAdded).toBe('number');
    });

    it('on bowtie, finds non-manifold vertices', () => {
      analyzer.loadTestShape('bowtie');
      const result = analyzer.splitVertices();
      expect(result.nonManifoldVerticesFound).toBeGreaterThan(0);
    });

    it('on icosphere (already manifold), finds 0', () => {
      analyzer.loadTestShape('icosphere');
      const result = analyzer.splitVertices();
      expect(result.nonManifoldVerticesFound).toBe(0);
    });
  });
});
