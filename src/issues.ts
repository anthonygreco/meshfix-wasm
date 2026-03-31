import type { MeshAnalysis, MeshIssue } from "./types.js";

export function buildIssues(a: MeshAnalysis): MeshIssue[] {
  const issues: MeshIssue[] = [];

  if (a.nonManifoldVertexCount > 0) {
    issues.push({
      type: "non_manifold_vertices",
      severity: "error",
      count: a.nonManifoldVertexCount,
      message: `${a.nonManifoldVertexCount} non-manifold vertex(es) found`,
    });
  }

  if (a.nonManifoldEdgeCount > 0) {
    issues.push({
      type: "non_manifold_edges",
      severity: "error",
      count: a.nonManifoldEdgeCount,
      message: `${a.nonManifoldEdgeCount} non-manifold edge(s) detected (faces skipped during import)`,
    });
  }

  if (a.flippedNormalCount > 0) {
    issues.push({
      type: "flipped_normals",
      severity: "warning",
      count: a.flippedNormalCount,
      message: `${a.flippedNormalCount} face(s) with flipped normals (inverted winding)`,
    });
  }

  if (a.degenerateTriangleCount > 0) {
    issues.push({
      type: "degenerate_triangles",
      severity: "warning",
      count: a.degenerateTriangleCount,
      message: `${a.degenerateTriangleCount} degenerate triangle(s) with near-zero area`,
    });
  }

  if (a.holeCount > 0) {
    issues.push({
      type: "holes",
      severity: "warning",
      count: a.holeCount,
      message: `${a.holeCount} hole(s) (boundary loops) found`,
    });
  }

  if (a.duplicateFaceCount > 0) {
    issues.push({
      type: "duplicate_faces",
      severity: "warning",
      count: a.duplicateFaceCount,
      message: `${a.duplicateFaceCount} duplicate face(s) found`,
    });
  }

  if (a.isolatedVertexCount > 0) {
    issues.push({
      type: "isolated_vertices",
      severity: "info",
      count: a.isolatedVertexCount,
      message: `${a.isolatedVertexCount} isolated vertex(es) not connected to any face`,
    });
  }

  if (!a.isWatertight) {
    issues.push({
      type: "not_watertight",
      severity: "info",
      count: a.boundaryEdges,
      message: `Mesh is not watertight (${a.boundaryEdges} boundary edges)`,
    });
  }

  if (a.connectedComponents > 1) {
    issues.push({
      type: "multiple_components",
      severity: "info",
      count: a.connectedComponents,
      message: `Mesh has ${a.connectedComponents} disconnected components`,
    });
  }

  return issues;
}
