import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { getModule } from './helpers/setup.js';

describe('Test Shape Loading', () => {
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

  function verifyStats(stats: any, expectTriangles = true) {
    expect(stats.vertexCount).toBeGreaterThan(0);
    expect(stats.faceCount).toBeGreaterThan(0);
    expect(stats.edgeCount).toBeGreaterThan(0);
    if (expectTriangles) {
      expect(stats.isTriangleMesh).toBe(true);
    }
    expect(Number.isFinite(stats.bboxMinX)).toBe(true);
    expect(Number.isFinite(stats.bboxMaxX)).toBe(true);
    expect(Number.isFinite(stats.bboxMinY)).toBe(true);
    expect(Number.isFinite(stats.bboxMaxY)).toBe(true);
    expect(Number.isFinite(stats.bboxMinZ)).toBe(true);
    expect(Number.isFinite(stats.bboxMaxZ)).toBe(true);
    expect(stats.surfaceArea).toBeGreaterThan(0);
    expect(Number.isFinite(stats.volume)).toBe(true);
  }

  function verifyAnalysis(analysis: any) {
    expect(typeof analysis.isManifold).toBe('boolean');
    expect(typeof analysis.isWatertight).toBe('boolean');
    expect(Number.isInteger(analysis.eulerCharacteristic)).toBe(true);
    expect(analysis.connectedComponents).toBeGreaterThanOrEqual(1);
    expect(analysis.boundaryLoops).toBeGreaterThanOrEqual(0);
    expect(analysis.nonManifoldVertexCount).toBeGreaterThanOrEqual(0);
    expect(analysis.nonManifoldEdgeCount).toBeGreaterThanOrEqual(0);
    expect(analysis.flippedNormalCount).toBeGreaterThanOrEqual(0);
    expect(analysis.degenerateTriangleCount).toBeGreaterThanOrEqual(0);
    expect(analysis.holeCount).toBeGreaterThanOrEqual(0);
    expect(analysis.duplicateFaceCount).toBeGreaterThanOrEqual(0);
    expect(analysis.isolatedVertexCount).toBeGreaterThanOrEqual(0);
  }

  describe('icosphere', () => {
    it('loads successfully with valid stats', () => {
      expect(analyzer.loadTestShape('icosphere')).toBe(true);
      verifyStats(analyzer.getStats());
    });

    it('is manifold and watertight', () => {
      analyzer.loadTestShape('icosphere');
      const analysis = analyzer.getAnalysis();
      verifyAnalysis(analysis);
      expect(analysis.isManifold).toBe(true);
      expect(analysis.isWatertight).toBe(true);
      expect(analysis.boundaryLoops).toBe(0);
      expect(analysis.genus).toBe(0);
    });
  });

  describe('torus', () => {
    it('loads successfully with valid stats', () => {
      expect(analyzer.loadTestShape('torus')).toBe(true);
      // PMP's torus() generates quad faces, not triangles
      verifyStats(analyzer.getStats(), false);
    });

    it('is manifold and watertight with genus 1', () => {
      analyzer.loadTestShape('torus');
      const analysis = analyzer.getAnalysis();
      verifyAnalysis(analysis);
      expect(analysis.isManifold).toBe(true);
      expect(analysis.isWatertight).toBe(true);
      expect(analysis.genus).toBe(1);
    });
  });

  describe('tetrahedron', () => {
    it('loads successfully with 4 vertices and 4 faces', () => {
      expect(analyzer.loadTestShape('tetrahedron')).toBe(true);
      const stats = analyzer.getStats();
      verifyStats(stats);
      expect(stats.vertexCount).toBe(4);
      expect(stats.faceCount).toBe(4);
    });

    it('is manifold and watertight', () => {
      analyzer.loadTestShape('tetrahedron');
      const analysis = analyzer.getAnalysis();
      verifyAnalysis(analysis);
      expect(analysis.isManifold).toBe(true);
      expect(analysis.isWatertight).toBe(true);
    });
  });

  describe('bowtie', () => {
    it('loads successfully with valid stats', () => {
      expect(analyzer.loadTestShape('bowtie')).toBe(true);
      verifyStats(analyzer.getStats());
    });

    it('has non-manifold vertices and is not manifold', () => {
      analyzer.loadTestShape('bowtie');
      const analysis = analyzer.getAnalysis();
      verifyAnalysis(analysis);
      expect(analysis.isManifold).toBe(false);
      expect(analysis.nonManifoldVertexCount).toBeGreaterThan(0);
    });
  });

  describe('icosphere6 (high-poly)', () => {
    it('loads and has correct face count (81,920)', () => {
      expect(analyzer.loadTestShape('icosphere6')).toBe(true);
      const stats = analyzer.getStats();
      expect(stats.faceCount).toBe(81920);
      expect(stats.isTriangleMesh).toBe(true);
    });
  });
});
