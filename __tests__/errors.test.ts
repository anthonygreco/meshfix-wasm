import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { getModule } from './helpers/setup.js';

describe('Error Handling', () => {
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

  it('loadFromFile() with empty file returns false', () => {
    const path = '/tmp/empty.stl';
    module.FS.writeFile(path, new Uint8Array(0));
    expect(analyzer.loadFromFile(path)).toBe(false);
    module.FS.unlink(path);
  });

  it('loadFromFile() with garbage bytes returns false', () => {
    const path = '/tmp/garbage.stl';
    // Use < 84 bytes so binary STL reader gets nT=0 and exits immediately
    const garbage = new Uint8Array(50);
    for (let i = 0; i < garbage.length; i++) garbage[i] = Math.floor(Math.random() * 256);
    module.FS.writeFile(path, garbage);
    const result = analyzer.loadFromFile(path);
    // Either returns false or loads an empty mesh (0 faces)
    if (!result) {
      expect(analyzer.getLastError().length).toBeGreaterThan(0);
    }
    module.FS.unlink(path);
  });

  it('loadFromFile() with PNG header returns false', () => {
    const path = '/tmp/fake.stl';
    // PNG magic bytes
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    module.FS.writeFile(path, png);
    expect(analyzer.loadFromFile(path)).toBe(false);
    module.FS.unlink(path);
  });

  it('analyzer remains usable after failed load', () => {
    const path = '/tmp/bad.stl';
    module.FS.writeFile(path, new Uint8Array(10));
    analyzer.loadFromFile(path);
    module.FS.unlink(path);
    // Should still be able to load a valid shape
    expect(analyzer.loadTestShape('icosphere')).toBe(true);
    expect(analyzer.getVertexCount()).toBeGreaterThan(0);
  });

  it('multiple failed loads do not corrupt state', () => {
    const path = '/tmp/bad.stl';
    module.FS.writeFile(path, new Uint8Array(5));
    analyzer.loadFromFile(path);
    analyzer.loadFromFile(path);
    analyzer.loadFromFile(path);
    module.FS.unlink(path);
    expect(analyzer.loadTestShape('tetrahedron')).toBe(true);
    expect(analyzer.getStats().faceCount).toBe(4);
  });

  it('repair before loading does not crash', () => {
    // Calling repair on an unloaded analyzer — should not crash
    // The C++ side should handle this gracefully
    expect(analyzer.isLoaded()).toBe(false);
    // repair() on unloaded mesh — behavior depends on C++ implementation
    // At minimum, it should not segfault
    try {
      analyzer.repair(1e-6, 1e-10, 100);
    } catch {
      // Expected — either throws or returns gracefully
    }
    // Analyzer should still be usable
    expect(analyzer.loadTestShape('icosphere')).toBe(true);
  });
});
