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
  /** Skipped for exceeding maxEdges. */
  holesSkipped: number;
  facesAdded: number;
  /**
   * Left alone because the loop looks like deliberate geometry (a bore, a slot,
   * or the outer edge of an open shell) rather than damage. Show these to the
   * user — describeHoles() explains each one — and offer fillHoles({ fillFeatures: true }).
   */
  holesSkippedAsFeature: number;
}

/** Per-boundary-loop measurements behind the holesSkippedAsFeature decision. */
export interface HoleInfo {
  edges: number;
  /** Largest distance between any two vertices on the loop. */
  diameter: number;
  /** Max distance from the loop's best-fit plane, over diameter. */
  planarDeviation: number;
  /** Coefficient of variation of in-plane radius; ~0 is a circle. */
  radiusVariation: number;
  /** Coefficient of variation of edge length. Reported only — see looksDeliberate(). */
  edgeVariation: number;
  looksDeliberate: boolean;
}

export interface DecimateOptions {
  /** Exact target vertex count. Exactly one of targetVertices / targetFaces / targetRatio must be set. */
  targetVertices?: number;
  /** Target face count → converted to vertices via V = ceil((F + 4) / 2). */
  targetFaces?: number;
  /** Fraction (0–1 exclusive) of current vertex count to keep. */
  targetRatio?: number;
  /** Minimum triangle aspect ratio constraint (0 = off). */
  aspectRatio?: number;
  /** Maximum face-normal deviation in degrees (0 = off). */
  normalDeviation?: number;
  /** Maximum deviation from original surface in model units — the print-tolerance bound (0 = off). */
  hausdorffError?: number;
}

export interface DecimateResult {
  verticesBefore: number;
  verticesAfter: number;
  facesBefore: number;
  facesAfter: number;
  /**
   * Faces dropped because decimation left them referencing vertices that no
   * longer exist. Normally 0; a non-zero value means the mesh was rebuilt to
   * keep it traversable. See connectivityIsValid() in bindings.cpp.
   */
  facesDropped: number;
  /** True if verticesAfter <= resolved target. False means constraints stopped decimation early. */
  reachedTarget: boolean;
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
  fillHolesEx(maxEdges: number, fillFeatures: boolean): FillHolesResult;
  /** JSON array of HoleInfo, one entry per boundary loop. */
  describeHoles(): string;
  splitVertices(): SplitVerticesResult;
  repair(weldEpsilon: number, minArea: number, maxHoleEdges: number): RepairResult;
  getVertexCount(): number;
  getFaceCount(): number;
  isLoaded(): boolean;
  exportMesh(path: string): boolean;
  scale(factor: number): boolean;
  decimate(targetVertices: number, aspectRatio: number, normalDeviation: number, hausdorffError: number): { success: boolean; verticesBefore: number; verticesAfter: number; facesBefore: number; facesAfter: number; facesDropped: number };
  colorsDropped(): boolean;
  nonFiniteFacesRemoved(): number;
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
