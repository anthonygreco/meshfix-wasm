/**
 * MeshFixWorker end to end: the real client, bridge and dist/worker.js, with
 * only the Worker thread faked. Messages are passed through structuredClone
 * (transfer lists honoured), so a result the browser could not post fails here
 * too. Until 0.6.1 no test went through the worker, and two of its cases were
 * wrong without anything noticing: fillHoles called the raw binding, which
 * silently drops fillFeatures, and describeHoles returned the JSON string
 * instead of the HoleInfo[] it is typed as.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { MeshFixWorker } from '../src/worker-client.js';

const require = createRequire(import.meta.url);
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');

// Runs a classic worker script in this thread. importScripts() is only ever
// asked for meshfix-core.js, so it hands over the Node build of it.
class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private scope: any;

  constructor(url: string | URL) {
    const file = url instanceof URL ? fileURLToPath(url) : url;
    this.scope = {
      onmessage: null,
      postMessage: (data: unknown, transfer?: Transferable[]) => {
        const copy = structuredClone(data, { transfer: transfer as any });
        setImmediate(() => this.onmessage?.({ data: copy }));
      },
    };
    const createMeshFixCore = require(path.join(dist, 'meshfix-core.js'));
    new Function('self', 'importScripts', 'createMeshFixCore', fs.readFileSync(file, 'utf8'))(
      this.scope, () => {}, createMeshFixCore);
  }

  postMessage(data: unknown, transfer?: Transferable[]) {
    const copy = structuredClone(data, { transfer: transfer as any });
    setImmediate(() => this.scope.onmessage({ data: copy }));
  }

  terminate() {}
}

function binaryStl(tris: number[][][]): ArrayBuffer {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const view = new DataView(buf);
  view.setUint32(80, tris.length, true);
  let o = 84;
  for (const t of tris) {
    o += 12;
    for (const v of t) {
      view.setFloat32(o, v[0], true);
      view.setFloat32(o + 4, v[1], true);
      view.setFloat32(o + 8, v[2], true);
      o += 12;
    }
    o += 2;
  }
  return buf;
}

// The bore plate from hole-classification.test.ts: a flat 48x48 plate with a
// round bore of radius 4, so two loops (the bore and the plate's outer edge),
// both classified as designed openings.
function borePlate(): ArrayBuffer {
  const N = 48;
  const tris: number[][][] = [];
  const P = (i: number, j: number) => [(i / N) * 20 - 10, (j / N) * 20 - 10, 0];
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
      for (const t of [[a, b, c], [a, c, d]]) {
        const x = (t[0][0] + t[1][0] + t[2][0]) / 3, y = (t[0][1] + t[1][1] + t[2][1]) / 3;
        if (Math.hypot(x, y) >= 4) tris.push(t);
      }
    }
  return binaryStl(tris);
}

describe('MeshFixWorker', () => {
  let savedWorker: unknown;
  let mf: MeshFixWorker;

  beforeAll(async () => {
    savedWorker = (globalThis as any).Worker;
    (globalThis as any).Worker = FakeWorker;
    mf = await MeshFixWorker.init({ workerUrl: path.join(dist, 'worker.js') });
  });

  afterAll(() => {
    mf.dispose();
    (globalThis as any).Worker = savedWorker;
  });

  it('fillHoles(1000, true) passes fillFeatures through and fills both loops', async () => {
    await mf.analyze(borePlate());
    const r = await mf.fillHoles(1000, true);
    expect(r.holesFound).toBe(2);
    expect(r.holesFilled).toBe(2);
    expect(r.holesSkippedAsFeature).toBe(0);
  });

  it('fillHoles(1000) without fillFeatures still leaves both alone', async () => {
    await mf.analyze(borePlate());
    const r = await mf.fillHoles(1000);
    expect(r.holesFilled).toBe(0);
    expect(r.holesSkippedAsFeature).toBe(2);
  });

  it('describeHoles() returns an array of 2 HoleInfo, not a string', async () => {
    await mf.analyze(borePlate());
    const holes = await mf.describeHoles();
    expect(Array.isArray(holes)).toBe(true);
    expect(holes).toHaveLength(2);
    expect(holes.every(h => h.looksDeliberate)).toBe(true);
  });
});
