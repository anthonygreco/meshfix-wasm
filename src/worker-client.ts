import type {
  MeshStats,
  MeshAnalysis,
  WeldResult,
  RemoveDegeneratesResult,
  FixNormalsResult,
  FillHolesResult,
  SplitVerticesResult,
  RepairResult,
  RepairOptions,
  ProgressEvent,
  RenderData,
} from "./types.js";
import type { WorkerInitOptions } from "./worker-types.js";
import { WorkerBridge, type ProgressCallback } from "./worker-bridge.js";
import { buildIssues } from "./issues.js";

export type ExportFormat = "stl" | "obj" | "off";

export interface AnalysisResult {
  analysis: MeshAnalysis;
  issues: import("./types.js").MeshIssue[];
}

export class MeshFixWorker {
  private bridge: WorkerBridge;

  private constructor(bridge: WorkerBridge) {
    this.bridge = bridge;
  }

  static async init(options?: WorkerInitOptions): Promise<MeshFixWorker> {
    const workerUrl = options?.workerUrl ?? new URL("worker.js", import.meta.url);
    const bridge = new WorkerBridge(workerUrl);
    const instance = new MeshFixWorker(bridge);
    await bridge.call("init", {
      coreUrl: options?.coreUrl,
      wasmUrl: options?.wasmUrl,
    });
    return instance;
  }

  async analyze(data: ArrayBuffer): Promise<MeshStats> {
    return (await this.bridge.call("analyze", { buffer: data }, [data])) as MeshStats;
  }

  async analyzeDetailed(data: ArrayBuffer): Promise<AnalysisResult> {
    const analysis = (await this.bridge.call("analyzeDetailed", { buffer: data }, [data])) as MeshAnalysis;
    return { analysis, issues: buildIssues(analysis) };
  }

  async analyzeTestShape(name: string): Promise<MeshStats> {
    return (await this.bridge.call("analyzeTestShape", { name })) as MeshStats;
  }

  async analyzeTestShapeDetailed(name: string): Promise<AnalysisResult> {
    const analysis = (await this.bridge.call("analyzeTestShapeDetailed", { name })) as MeshAnalysis;
    return { analysis, issues: buildIssues(analysis) };
  }

  async weldVertices(epsilon?: number): Promise<WeldResult> {
    return (await this.bridge.call("weldVertices", { epsilon })) as WeldResult;
  }

  async removeDegenerates(minArea?: number): Promise<RemoveDegeneratesResult> {
    return (await this.bridge.call("removeDegenerates", { minArea })) as RemoveDegeneratesResult;
  }

  async fixNormals(): Promise<FixNormalsResult> {
    return (await this.bridge.call("fixNormals")) as FixNormalsResult;
  }

  async fillHoles(maxEdges?: number): Promise<FillHolesResult> {
    return (await this.bridge.call("fillHoles", { maxEdges })) as FillHolesResult;
  }

  async splitVertices(): Promise<SplitVerticesResult> {
    return (await this.bridge.call("splitVertices")) as SplitVerticesResult;
  }

  async repair(options?: RepairOptions, onProgress?: (event: ProgressEvent) => void): Promise<RepairResult> {
    return (await this.bridge.call("repair", {
      weldEpsilon: options?.weldEpsilon,
      minArea: options?.minArea,
      maxHoleEdges: options?.maxHoleEdges,
    }, undefined, onProgress as ProgressCallback | undefined)) as RepairResult;
  }

  async reanalyze(): Promise<AnalysisResult> {
    const analysis = (await this.bridge.call("reanalyze")) as MeshAnalysis;
    return { analysis, issues: buildIssues(analysis) };
  }

  async toRenderData(): Promise<RenderData> {
    const result = (await this.bridge.call("toRenderData")) as { buffer: ArrayBuffer };
    const buf = result.buffer;
    const view = new DataView(buf);
    const vertexCount = view.getUint32(0, true);
    const indexCount = view.getUint32(4, true);
    const posOffset = 8;
    const normOffset = posOffset + vertexCount * 3 * 4;
    const idxOffset = normOffset + vertexCount * 3 * 4;
    const flagsOffset = idxOffset + indexCount * 4;
    const faceCount = indexCount / 3;
    return {
      positions: new Float32Array(buf, posOffset, vertexCount * 3),
      normals: new Float32Array(buf, normOffset, vertexCount * 3),
      indices: new Uint32Array(buf, idxOffset, indexCount),
      faceFlags: new Uint8Array(buf, flagsOffset, faceCount),
    };
  }

  async exportMesh(format: ExportFormat = "stl"): Promise<ArrayBuffer> {
    const result = (await this.bridge.call("exportMesh", { format })) as { buffer: ArrayBuffer };
    return result.buffer;
  }

  /** @deprecated Use exportMesh("stl") instead */
  async exportSTL(): Promise<ArrayBuffer> {
    return this.exportMesh("stl");
  }

  dispose(): void {
    this.bridge.call("dispose").catch(() => {});
    this.bridge.terminate();
  }
}
