import type {
  MeshStats,
  MeshAnalysis,
  MeshIssue,
  MeshFixCoreModule,
  MeshAnalyzerInstance,
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
} from "./types.js";
import { buildIssues } from "./issues.js";

export type { MeshStats, MeshAnalysis, MeshIssue, MeshFixCoreModule, MeshAnalyzerInstance, WeldResult, RemoveDegeneratesResult, FixNormalsResult, FillHolesResult, SplitVerticesResult, RepairResult, RepairOptions, ProgressEvent, RenderData };
export type { IssueType, IssueSeverity, RepairStep, ImportFormat } from "./types.js";
export { buildIssues } from "./issues.js";
export { MeshFixWorker } from "./worker-client.js";
export type { WorkerInitOptions } from "./worker-types.js";

// createMeshFixCore is loaded as a global from the WASM JS file
declare function createMeshFixCore(): Promise<MeshFixCoreModule>;

export type ExportFormat = "stl" | "obj" | "off" | "ply";

export interface AnalysisResult {
  analysis: MeshAnalysis;
  issues: MeshIssue[];
  colorsDropped?: boolean;
}

export class MeshFix {
  private module: MeshFixCoreModule;
  private analyzer: MeshAnalyzerInstance;

  private constructor(module: MeshFixCoreModule) {
    this.module = module;
    this.analyzer = new module.MeshAnalyzer();
  }

  static async init(): Promise<MeshFix> {
    const module = await createMeshFixCore();
    return new MeshFix(module);
  }

  analyze(data: ArrayBuffer, format: ImportFormat = "stl"): MeshStats {
    const uint8 = new Uint8Array(data);
    const path = `/tmp/input.${format}`;

    try {
      this.module.FS.writeFile(path, uint8);
      const ok = this.analyzer.loadFromFile(path);
      if (!ok) {
        throw new Error(
          this.analyzer.getLastError() || "Failed to load mesh"
        );
      }
      return this.analyzer.getStats();
    } finally {
      try {
        this.module.FS.unlink(path);
      } catch {
        // file may not exist if write failed
      }
    }
  }

  analyzeTestShape(name: string): MeshStats {
    const ok = this.analyzer.loadTestShape(name);
    if (!ok) {
      throw new Error(
        this.analyzer.getLastError() || "Failed to create test shape"
      );
    }
    return this.analyzer.getStats();
  }

  analyzeDetailed(data: ArrayBuffer, format: ImportFormat = "stl"): AnalysisResult {
    const uint8 = new Uint8Array(data);
    const path = `/tmp/input.${format}`;

    try {
      this.module.FS.writeFile(path, uint8);
      const ok = this.analyzer.loadFromFile(path);
      if (!ok) {
        throw new Error(
          this.analyzer.getLastError() || "Failed to load mesh"
        );
      }
      const analysis = this.analyzer.getAnalysis();
      return { analysis, issues: buildIssues(analysis), colorsDropped: this.analyzer.colorsDropped() };
    } finally {
      try {
        this.module.FS.unlink(path);
      } catch {
        // file may not exist if write failed
      }
    }
  }

  analyzeTestShapeDetailed(name: string): AnalysisResult {
    const ok = this.analyzer.loadTestShape(name);
    if (!ok) {
      throw new Error(
        this.analyzer.getLastError() || "Failed to create test shape"
      );
    }
    const analysis = this.analyzer.getAnalysis();
    return { analysis, issues: buildIssues(analysis) };
  }

  weldVertices(epsilon: number = 1e-6): WeldResult {
    if (!this.analyzer.isLoaded()) {
      throw new Error("No mesh loaded");
    }
    return this.analyzer.weldVertices(epsilon);
  }

  removeDegenerates(minArea: number = 1e-10): RemoveDegeneratesResult {
    if (!this.analyzer.isLoaded()) {
      throw new Error("No mesh loaded");
    }
    return this.analyzer.removeDegenerates(minArea);
  }

  fixNormals(): FixNormalsResult {
    if (!this.analyzer.isLoaded()) {
      throw new Error("No mesh loaded");
    }
    return this.analyzer.fixNormals();
  }

  fillHoles(maxEdges: number = 100): FillHolesResult {
    if (!this.analyzer.isLoaded()) {
      throw new Error("No mesh loaded");
    }
    return this.analyzer.fillHoles(maxEdges);
  }

  splitVertices(): SplitVerticesResult {
    if (!this.analyzer.isLoaded()) {
      throw new Error("No mesh loaded");
    }
    return this.analyzer.splitVertices();
  }

  repair(options?: RepairOptions, onProgress?: (event: ProgressEvent) => void): RepairResult {
    if (!this.analyzer.isLoaded()) {
      throw new Error("No mesh loaded");
    }
    const weldEpsilon = options?.weldEpsilon ?? 1e-6;
    const minArea = options?.minArea ?? 1e-10;
    const maxHoleEdges = options?.maxHoleEdges ?? 100;

    const totalSteps = 5;
    const verticesBefore = this.analyzer.getVertexCount();
    const facesBefore = this.analyzer.getFaceCount();

    const progress = (step: ProgressEvent["step"], stepIndex: number) => {
      if (onProgress) onProgress({ step, stepIndex, totalSteps });
    };

    progress("weld", 0);
    const weld = this.analyzer.weldVertices(weldEpsilon);

    // Only remove degenerates if mesh is not watertight — removing
    // faces from a closed surface tears holes that may not fill cleanly.
    const midAnalysis = this.analyzer.getAnalysis();
    progress("removeDegenerates", 1);
    const removeDegenerates = midAnalysis.isWatertight
      ? null
      : this.analyzer.removeDegenerates(minArea);

    progress("splitVertices", 2);
    const splitVertices = this.analyzer.splitVertices();

    progress("fillHoles", 3);
    const fillHoles = this.analyzer.fillHoles(maxHoleEdges);

    progress("fixNormals", 4);
    const fixNormals = this.analyzer.fixNormals();

    return {
      weld,
      removeDegenerates: removeDegenerates as RemoveDegeneratesResult,
      splitVertices,
      fillHoles,
      fixNormals,
      verticesBefore,
      verticesAfter: this.analyzer.getVertexCount(),
      facesBefore,
      facesAfter: this.analyzer.getFaceCount(),
    };
  }

  reanalyze(): AnalysisResult {
    if (!this.analyzer.isLoaded()) {
      throw new Error("No mesh loaded");
    }
    const analysis = this.analyzer.getAnalysis();
    return { analysis, issues: buildIssues(analysis) };
  }

  exportMesh(format: ExportFormat = "stl"): ArrayBuffer {
    if (!this.analyzer.isLoaded()) {
      throw new Error("No mesh loaded");
    }
    const path = `/tmp/export.${format}`;
    try {
      const ok = this.analyzer.exportMesh(path);
      if (!ok) {
        throw new Error(this.analyzer.getLastError() || "Failed to export mesh");
      }
      const data = this.module.FS.readFile(path);
      return (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength);
    } finally {
      try {
        this.module.FS.unlink(path);
      } catch {
        // file may not exist if export failed
      }
    }
  }

  /** @deprecated Use exportMesh("stl") instead */
  exportSTL(): ArrayBuffer {
    return this.exportMesh("stl");
  }

  scale(factor: number): void {
    if (!this.analyzer.isLoaded()) {
      throw new Error("No mesh loaded");
    }
    const ok = this.analyzer.scale(factor);
    if (!ok) {
      throw new Error(this.analyzer.getLastError() || "Failed to scale mesh");
    }
  }

  colorsDropped(): boolean {
    return this.analyzer.colorsDropped();
  }

  toRenderData(): RenderData {
    if (!this.analyzer.isLoaded()) {
      throw new Error("No mesh loaded");
    }
    const path = "/tmp/render.bin";
    try {
      const ok = this.analyzer.writeRenderData(path);
      if (!ok) {
        throw new Error(this.analyzer.getLastError() || "Failed to write render data");
      }
      const data = this.module.FS.readFile(path);
      const buf = (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength);
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
    } finally {
      try {
        this.module.FS.unlink(path);
      } catch {
        // file may not exist if write failed
      }
    }
  }

  dispose(): void {
    this.analyzer.delete();
  }
}
