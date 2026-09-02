// Classic Web Worker script — NO import/export statements.
// TypeScript treats files without imports/exports as scripts,
// so tsc emits no module syntax → valid for importScripts() workers.

declare function importScripts(...urls: string[]): void;
declare function createMeshFixCore(opts?: Record<string, unknown>): Promise<any>;

interface WorkerRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
  buffer?: ArrayBuffer;
}

interface WorkerResponse {
  id: number;
  result?: unknown;
  error?: { message: string };
}

var module: any = null;
var analyzer: any = null;

async function initModule(coreUrl?: string, wasmUrl?: string): Promise<void> {
  importScripts(coreUrl || "meshfix-core.js");
  const opts: Record<string, unknown> = {};
  if (wasmUrl) {
    opts.locateFile = (path: string) => {
      if (path.endsWith(".wasm")) return wasmUrl;
      return path;
    };
  }
  module = await createMeshFixCore(opts);
  analyzer = new module.MeshAnalyzer();
}

function postProgress(requestId: number, step: string, stepIndex: number, totalSteps: number): void {
  (self as any).postMessage({ type: "progress", requestId, step, stepIndex, totalSteps });
}

function handleMessage(method: string, params: Record<string, unknown>, buffer?: ArrayBuffer, requestId?: number): unknown {
  switch (method) {
    case "init":
      // handled separately (async)
      return null;

    case "analyze": {
      const uint8 = new Uint8Array(buffer!);
      const fmt = (params.format as string) || "stl";
      const path = "/tmp/input." + fmt;
      try {
        module.FS.writeFile(path, uint8);
        const ok = analyzer.loadFromFile(path);
        if (!ok) throw new Error(analyzer.getLastError() || "Failed to load mesh");
        return analyzer.getStats();
      } finally {
        try { module.FS.unlink(path); } catch {}
      }
    }

    case "analyzeDetailed": {
      const uint8 = new Uint8Array(buffer!);
      const fmt = (params.format as string) || "stl";
      const path = "/tmp/input." + fmt;
      try {
        module.FS.writeFile(path, uint8);
        const ok = analyzer.loadFromFile(path);
        if (!ok) throw new Error(analyzer.getLastError() || "Failed to load mesh");
        const analysis = analyzer.getAnalysis();
        return { analysis, colorsDropped: analyzer.colorsDropped() };
      } finally {
        try { module.FS.unlink(path); } catch {}
      }
    }

    case "analyzeTestShape": {
      const name = params.name as string;
      const ok = analyzer.loadTestShape(name);
      if (!ok) throw new Error(analyzer.getLastError() || "Failed to create test shape");
      return analyzer.getStats();
    }

    case "analyzeTestShapeDetailed": {
      const name = params.name as string;
      const ok = analyzer.loadTestShape(name);
      if (!ok) throw new Error(analyzer.getLastError() || "Failed to create test shape");
      return analyzer.getAnalysis();
    }

    case "weldVertices": {
      if (!analyzer.isLoaded()) throw new Error("No mesh loaded");
      const epsilon = (params.epsilon as number) ?? 1e-6;
      return analyzer.weldVertices(epsilon);
    }

    case "removeDegenerates": {
      if (!analyzer.isLoaded()) throw new Error("No mesh loaded");
      const minArea = (params.minArea as number) ?? 1e-10;
      return analyzer.removeDegenerates(minArea);
    }

    case "fixNormals": {
      if (!analyzer.isLoaded()) throw new Error("No mesh loaded");
      return analyzer.fixNormals();
    }

    case "fillHoles": {
      if (!analyzer.isLoaded()) throw new Error("No mesh loaded");
      const maxEdges = (params.maxEdges as number) ?? 100;
      const fillFeatures = (params.fillFeatures as boolean) ?? false;
      return analyzer.fillHoles(maxEdges, fillFeatures);
    }

    case "describeHoles": {
      if (!analyzer.isLoaded()) throw new Error("No mesh loaded");
      return analyzer.describeHoles();
    }

    case "splitVertices": {
      if (!analyzer.isLoaded()) throw new Error("No mesh loaded");
      return analyzer.splitVertices();
    }

    case "repair": {
      if (!analyzer.isLoaded()) throw new Error("No mesh loaded");
      const weldEpsilon = (params.weldEpsilon as number) ?? 1e-6;
      const minArea = (params.minArea as number) ?? 1e-10;
      const maxHoleEdges = (params.maxHoleEdges as number) ?? 100;
      const id = requestId!;
      const totalSteps = 5;

      const verticesBefore = analyzer.getVertexCount();
      const facesBefore = analyzer.getFaceCount();

      postProgress(id, "weld", 0, totalSteps);
      const weld = analyzer.weldVertices(weldEpsilon);

      // Only remove degenerates if mesh is not watertight — removing
      // faces from a closed surface tears holes that may not fill cleanly.
      var midAnalysis = analyzer.getAnalysis();
      postProgress(id, "removeDegenerates", 1, totalSteps);
      var removeDegenerates = null;
      if (!midAnalysis.isWatertight) {
        removeDegenerates = analyzer.removeDegenerates(minArea);
      }

      postProgress(id, "splitVertices", 2, totalSteps);
      const splitVertices = analyzer.splitVertices();

      postProgress(id, "fillHoles", 3, totalSteps);
      const fillHoles = analyzer.fillHoles(maxHoleEdges);

      postProgress(id, "fixNormals", 4, totalSteps);
      const fixNormals = analyzer.fixNormals();

      return {
        weld,
        removeDegenerates,
        splitVertices,
        fillHoles,
        fixNormals,
        verticesBefore,
        verticesAfter: analyzer.getVertexCount(),
        facesBefore,
        facesAfter: analyzer.getFaceCount(),
      };
    }

    case "reanalyze": {
      if (!analyzer.isLoaded()) throw new Error("No mesh loaded");
      const analysis = analyzer.getAnalysis();
      return { analysis, colorsDropped: analyzer.colorsDropped() };
    }

    case "scale": {
      if (!analyzer.isLoaded()) throw new Error("No mesh loaded");
      const factor = params.factor as number;
      const ok = analyzer.scale(factor);
      if (!ok) throw new Error(analyzer.getLastError() || "Failed to scale mesh");
      return true;
    }

    case "decimate": {
      if (!analyzer.isLoaded()) throw new Error("No mesh loaded");
      // Resolve target to vertex count (classic worker — no imports, logic duplicated from index.ts)
      const opts = params as { targetVertices?: number; targetFaces?: number; targetRatio?: number; aspectRatio?: number; normalDeviation?: number; hausdorffError?: number };
      const defined = [opts.targetVertices, opts.targetFaces, opts.targetRatio].filter(v => v !== undefined);
      if (defined.length !== 1) throw new TypeError("Exactly one of targetVertices, targetFaces, or targetRatio must be provided");
      var targetVertices: number;
      if (opts.targetVertices !== undefined) {
        targetVertices = opts.targetVertices;
      } else if (opts.targetFaces !== undefined) {
        targetVertices = Math.ceil((opts.targetFaces + 4) / 2);
      } else {
        if (opts.targetRatio! <= 0 || opts.targetRatio! >= 1) throw new TypeError("targetRatio must be in (0, 1)");
        targetVertices = Math.max(4, Math.round(analyzer.getVertexCount() * opts.targetRatio!));
      }
      var raw = analyzer.decimate(targetVertices, opts.aspectRatio ?? 0, opts.normalDeviation ?? 0, opts.hausdorffError ?? 0);
      if (!raw.success) throw new Error(analyzer.getLastError() || "Failed to decimate mesh");
      return {
        verticesBefore: raw.verticesBefore,
        verticesAfter: raw.verticesAfter,
        facesBefore: raw.facesBefore,
        facesAfter: raw.facesAfter,
        reachedTarget: raw.verticesAfter <= targetVertices,
      };
    }

    case "colorsDropped": {
      return analyzer.colorsDropped();
    }

    case "nonFiniteFacesRemoved": {
      return analyzer.nonFiniteFacesRemoved();
    }

    case "toRenderData": {
      if (!analyzer.isLoaded()) throw new Error("No mesh loaded");
      var renderPath = "/tmp/render.bin";
      try {
        var ok = analyzer.writeRenderData(renderPath);
        if (!ok) throw new Error(analyzer.getLastError() || "Failed to write render data");
        var data = module.FS.readFile(renderPath);
        var buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        return { buffer: buf };
      } finally {
        try { module.FS.unlink(renderPath); } catch {}
      }
    }

    case "exportMesh": {
      if (!analyzer.isLoaded()) throw new Error("No mesh loaded");
      var format = (params.format as string) || "stl";
      var exportPath = "/tmp/export." + format;
      try {
        var ok = analyzer.exportMesh(exportPath);
        if (!ok) throw new Error(analyzer.getLastError() || "Failed to export mesh");
        var data = module.FS.readFile(exportPath);
        var buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        return { buffer: buf };
      } finally {
        try { module.FS.unlink(exportPath); } catch {}
      }
    }

    case "dispose": {
      if (analyzer) {
        analyzer.delete();
        analyzer = null;
      }
      module = null;
      return null;
    }

    default:
      throw new Error("Unknown method: " + method);
  }
}

self.onmessage = async function (event: MessageEvent<WorkerRequest>) {
  const { id, method, params, buffer } = event.data;
  try {
    if (method === "init") {
      await initModule(params.coreUrl as string | undefined, params.wasmUrl as string | undefined);
      (self as any).postMessage({ id, result: true } as WorkerResponse);
    } else {
      const result = handleMessage(method, params, buffer, id);
      // Transfer ArrayBuffer back for exportMesh and toRenderData
      if ((method === "exportMesh" || method === "toRenderData") && result && (result as any).buffer instanceof ArrayBuffer) {
        (self as any).postMessage({ id, result } as WorkerResponse, [(result as any).buffer]);
      } else {
        (self as any).postMessage({ id, result } as WorkerResponse);
      }
    }
  } catch (e: any) {
    const message = e && e.message ? e.message : String(e);
    (self as any).postMessage({ id, error: { message } } as WorkerResponse);
  }
};
