#include CORE
#include <cstdlib>
int main(int argc, char** argv) {
    MeshAnalyzer a; a.loadFromFile(argv[1]);
    auto P = [&](const char* n) { auto x = a.getAnalysis(); printf("%-18s faces=%d wt=%d comps=%d holes=%d nmV=%d degen=%d dup=%d iso=%d vol=%.1f rebuilds=%d dropped=%d\n", n, x.faceCount, (int)x.isWatertight, x.connectedComponents, x.holeCount, x.nonManifoldVertexCount, x.degenerateTriangleCount, x.duplicateFaceCount, x.isolatedVertexCount, x.volume, a.connectivityRebuilds(), a.facesDroppedByAudit()); };
    P("load"); a.weldVertices(1e-6f); P("weld"); a.splitVertices(); P("split"); a.fillHoles(100); P("fill"); auto r = a.removeDegenerates(1e-10f); P("removeDegenerates"); printf("   rd: degen=%d dup=%d iso=%d\n", r.degenerateRemoved, r.duplicateRemoved, r.isolatedVerticesRemoved); a.fixNormals(); P("fixNormals");
    return 0;
}
