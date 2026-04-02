import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { getModule } from './helpers/setup.js';

describe('Export', () => {
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

  it('exportMesh("stl") writes non-empty STL to MEMFS', () => {
    const path = '/tmp/test_export.stl';
    expect(analyzer.exportMesh(path)).toBe(true);
    const data = module.FS.readFile(path);
    expect(data.length).toBeGreaterThan(0);
    module.FS.unlink(path);
  });

  it('exportMesh("obj") writes valid OBJ to MEMFS', () => {
    const path = '/tmp/test_export.obj';
    expect(analyzer.exportMesh(path)).toBe(true);
    const data = module.FS.readFile(path);
    const text = new TextDecoder().decode(data);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('v ');
    expect(text).toContain('f ');
    module.FS.unlink(path);
  });

  it('exportMesh("off") writes valid OFF to MEMFS', () => {
    const path = '/tmp/test_export.off';
    expect(analyzer.exportMesh(path)).toBe(true);
    const data = module.FS.readFile(path);
    const text = new TextDecoder().decode(data);
    expect(text.length).toBeGreaterThan(0);
    expect(text.startsWith('OFF')).toBe(true);
    module.FS.unlink(path);
  });

  it('export after repair still works', () => {
    analyzer.loadTestShape('bowtie');
    analyzer.repair(1e-6, 1e-10, 100);
    const path = '/tmp/test_post_repair.stl';
    expect(analyzer.exportMesh(path)).toBe(true);
    const data = module.FS.readFile(path);
    expect(data.length).toBeGreaterThan(0);
    module.FS.unlink(path);
  });

  it('writeRenderData() produces valid binary format', () => {
    const path = '/tmp/test_render.bin';
    expect(analyzer.writeRenderData(path)).toBe(true);
    const data = module.FS.readFile(path);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const view = new DataView(buf);
    const vertexCount = view.getUint32(0, true);
    const indexCount = view.getUint32(4, true);
    expect(vertexCount).toBeGreaterThan(0);
    expect(indexCount).toBeGreaterThan(0);
    expect(indexCount % 3).toBe(0);

    const expectedSize = 8 + vertexCount * 3 * 4 + vertexCount * 3 * 4 + indexCount * 4 + (indexCount / 3);
    expect(data.byteLength).toBe(expectedSize);
    module.FS.unlink(path);
  });
});
