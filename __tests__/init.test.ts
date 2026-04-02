import { describe, it, expect, beforeAll } from 'vitest';
import { getModule } from './helpers/setup.js';

describe('Initialization', () => {
  let module: any;

  beforeAll(async () => {
    module = await getModule();
  });

  it('loads the WASM module', () => {
    expect(module).toBeDefined();
  });

  it('creates a MeshAnalyzer instance', () => {
    const analyzer = new module.MeshAnalyzer();
    expect(analyzer).toBeDefined();
    analyzer.delete();
  });

  it('has all expected methods on MeshAnalyzer', () => {
    const analyzer = new module.MeshAnalyzer();
    const methods = [
      'loadFromFile', 'loadTestShape', 'getStats', 'getAnalysis',
      'weldVertices', 'removeDegenerates', 'fixNormals', 'fillHoles',
      'splitVertices', 'repair', 'exportMesh', 'writeRenderData',
      'isLoaded', 'getLastError', 'getVertexCount', 'getFaceCount',
    ];
    for (const method of methods) {
      expect(typeof analyzer[method]).toBe('function');
    }
    analyzer.delete();
  });

  it('isLoaded() returns false before loading', () => {
    const analyzer = new module.MeshAnalyzer();
    expect(analyzer.isLoaded()).toBe(false);
    analyzer.delete();
  });

  it('getStats() before load returns zeros', () => {
    const analyzer = new module.MeshAnalyzer();
    const stats = analyzer.getStats();
    expect(stats.vertexCount).toBe(0);
    expect(stats.faceCount).toBe(0);
    analyzer.delete();
  });

  it('delete() does not throw', () => {
    const analyzer = new module.MeshAnalyzer();
    expect(() => analyzer.delete()).not.toThrow();
  });

  it('exposes FS for file operations', () => {
    expect(module.FS).toBeDefined();
    expect(typeof module.FS.writeFile).toBe('function');
    expect(typeof module.FS.readFile).toBe('function');
    expect(typeof module.FS.unlink).toBe('function');
  });
});
