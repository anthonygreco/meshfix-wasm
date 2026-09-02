import type {
  HoleInfo,
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
  ImportFormat,
  DecimateOptions,
  DecimateResult,
} from "./types.js";
import type { WorkerInitOptions } from "./worker-types.js";
import { WorkerBridge, type ProgressCallback } from "./worker-bridge.js";
import { buildIssues } from "./issues.js";

export type ExportFormat = "stl" | "obj" | "off" | "ply";
export type { ImportFormat };

export interface AnalysisResult {
  analysis: MeshAnalysis;
  issues: import("./types.js").MeshIssue[];
  colorsDropped?: boolean;
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

  async analyze(data: ArrayBuffer, format: ImportFormat = "stl"): Promise<MeshStats> {
    return (await this.bridge.call("analyze", { buffer: data, format }, [data])) as MeshStats;
  }

  async analyzeDetailed(data: ArrayBuffer, format: ImportFormat = "stl"): Promise<AnalysisResult> {
    const result = (await this.bridge.call("analyzeDetailed", { buffer: data, format }, [data])) as { analysis: MeshAnalysis; colorsDropped: boolean };
    return { analysis: result.analysis, issues: buildIssues(result.analysis), colorsDropped: result.colorsDropped };
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

  async fillHoles(maxEdges?: number, fillFeatures?: boolean): Promise<FillHolesResult> {
    return (await this.bridge.call("fillHoles", { maxEdges, fillFeatures })) as FillHolesResult;
  }

  /** Measurements for every boundary loop, including why each was classified. */
  async describeHoles(): Promise<HoleInfo[]> {
    return (await this.bridge.call("describeHoles")) as HoleInfo[];
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
    const result = (await this.bridge.call("reanalyze")) as { analysis: MeshAnalysis; colorsDropped: boolean };
    return { analysis: result.analysis, issues: buildIssues(result.analysis), colorsDropped: result.colorsDropped };
  }

  async scale(factor: number): Promise<void> {
    await this.bridge.call("scale", { factor });
  }

  async decimate(options: DecimateOptions): Promise<DecimateResult> {
    // Validate client-side so bad options fail before the worker round-trip
    const defined = [options.targetVertices, options.targetFaces, options.targetRatio].filter(v => v !== undefined);
    if (defined.length !== 1) {
      throw new TypeError("Exactly one of targetVertices, targetFaces, or targetRatio must be provided");
    }
    if (options.targetRatio !== undefined && (options.targetRatio <= 0 || options.targetRatio >= 1)) {
      throw new TypeError("targetRatio must be in the range (0, 1) exclusive");
    }
    return (await this.bridge.call("decimate", { ...options })) as DecimateResult;
  }

  async colorsDropped(): Promise<boolean> {
    return (await this.bridge.call("colorsDropped")) as boolean;
  }

  /** Faces removed at load for carrying a NaN or infinite coordinate. */
  async nonFiniteFacesRemoved(): Promise<number> {
    return (await this.bridge.call("nonFiniteFacesRemoved")) as number;
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
