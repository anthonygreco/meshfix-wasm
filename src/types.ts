export interface MeshStats {
  vertexCount: number;
  faceCount: number;
  edgeCount: number;
  bboxMinX: number;
  bboxMinY: number;
  bboxMinZ: number;
  bboxMaxX: number;
  bboxMaxY: number;
  bboxMaxZ: number;
  dimX: number;
  dimY: number;
  dimZ: number;
  surfaceArea: number;
  volume: number;
  boundaryEdges: number;
  isTriangleMesh: boolean;
  skippedFaces: number;
}

export interface MeshAnalysis extends MeshStats {
  // Topology
  isManifold: boolean;
  isWatertight: boolean;
  eulerCharacteristic: number;
  genus: number;
  connectedComponents: number;
  boundaryLoops: number;
  // Issue counts
  nonManifoldVertexCount: number;
  nonManifoldEdgeCount: number;
  flippedNormalCount: number;
  degenerateTriangleCount: number;
  holeCount: number;
  duplicateFaceCount: number;
  isolatedVertexCount: number;
}

export interface WeldResult {
  verticesBefore: number;
  verticesAfter: number;
  verticesMerged: number;
  facesBefore: number;
  facesAfter: number;
  facesRemoved: number;
  degenerateFaces: number;
  skippedFaces: number;
}

export interface RemoveDegeneratesResult {
  facesBefore: number;
  facesAfter: number;
  degenerateRemoved: number;
  duplicateRemoved: number;
  isolatedVerticesRemoved: number;
}

export interface FixNormalsResult {
  totalComponents: number;
  componentsFlipped: number;
  facesFlipped: number;
  skippedOpen: number;
  skippedFaces: number;
}

export interface FillHolesResult {
  holesFound: number;
  holesFilled: number;
  holesFailed: number;
  holesSkipped: number;
  facesAdded: number;
}

export interface SplitVerticesResult {
  verticesBefore: number;
  verticesAfter: number;
  nonManifoldVerticesFound: number;
  verticesAdded: number;
  facesBefore: number;
  facesAfter: number;
  skippedFaces: number;
}

export interface RepairResult {
  weld: WeldResult;
  removeDegenerates: RemoveDegeneratesResult | null;
  splitVertices: SplitVerticesResult;
  fixNormals: FixNormalsResult;
  fillHoles: FillHolesResult;
  verticesBefore: number;
  verticesAfter: number;
  facesBefore: number;
  facesAfter: number;
}

export interface RepairOptions {
  weldEpsilon?: number;
  minArea?: number;
  maxHoleEdges?: number;
}

export interface RenderData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  faceFlags: Uint8Array;
}

export type IssueSeverity = "error" | "warning" | "info";

export type IssueType =
  | "non_manifold_vertices"
  | "non_manifold_edges"
  | "flipped_normals"
  | "degenerate_triangles"
  | "holes"
  | "duplicate_faces"
  | "isolated_vertices"
  | "not_watertight"
  | "multiple_components";

export interface MeshIssue {
  type: IssueType;
  severity: IssueSeverity;
  count: number;
  message: string;
}

export interface MeshAnalyzerInstance {
  loadFromFile(path: string): boolean;
  loadTestShape(name: string): boolean;
  getStats(): MeshStats;
  getAnalysis(): MeshAnalysis;
  weldVertices(epsilon: number): WeldResult;
  removeDegenerates(minArea: number): RemoveDegeneratesResult;
  fixNormals(): FixNormalsResult;
  fillHoles(maxEdges: number): FillHolesResult;
  splitVertices(): SplitVerticesResult;
  repair(weldEpsilon: number, minArea: number, maxHoleEdges: number): RepairResult;
  getVertexCount(): number;
  getFaceCount(): number;
  isLoaded(): boolean;
  exportMesh(path: string): boolean;
  scale(factor: number): boolean;
  colorsDropped(): boolean;
  writeRenderData(path: string): boolean;
  getLastError(): string;
  delete(): void;
}

export interface MeshFixCoreModule {
  MeshAnalyzer: new () => MeshAnalyzerInstance;
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
    mkdir(path: string): void;
  };
  getExceptionMessage(ex: unknown): string[];
}

export type RepairStep = "weld" | "removeDegenerates" | "splitVertices" | "fillHoles" | "fixNormals";

export type ImportFormat = "stl" | "obj" | "off" | "ply";

export interface ProgressEvent {
  step: RepairStep;
  stepIndex: number;
  totalSteps: number;
}

declare function createMeshFixCore(): Promise<MeshFixCoreModule>;
