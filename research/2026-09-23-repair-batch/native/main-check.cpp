#include "core-check.inc"
#include <chrono>
#include <csignal>
#include <unistd.h>
static const char* g_step = "init";
static void watchdog(int) { fprintf(stderr, "WATCHDOG: stuck in %s\n", g_step); fflush(stderr); _exit(124); }
// Structural audit of the half-edge mesh. Every loop is guarded so it can run on a corrupt mesh.
static std::string checkMesh(const pmp::SurfaceMesh& m) {
    int badRing = 0, badFaceRef = 0, badPrevNext = 0, badOpp = 0, badBoundaryLoop = 0, badRot = 0, badVHandle = 0, badIdx = 0;
    std::string first;
    const size_t nh = m.halfedges_size(), nv = m.vertices_size(), nf = m.faces_size();
    for (auto f : m.faces()) {
        auto h0 = m.halfedge(f); auto h = h0; int g = 0; bool ok = true;
        if (!h0.is_valid() || (size_t)h0.idx() >= nh) { ++badIdx; continue; }
        do { if ((size_t)h.idx() >= nh) { ok = false; break; } if (m.face(h) != f) { ++badFaceRef; if (first.empty()) first = "face " + std::to_string(f.idx()) + " ring halfedge " + std::to_string(h.idx()) + " has face " + std::to_string(m.face(h).idx()); } h = m.next_halfedge(h); if (++g > 1000) { ok = false; break; } } while (h != h0);
        if (!ok) { ++badRing; if (first.empty()) first = "face " + std::to_string(f.idx()) + " ring does not close"; }
    }
    for (auto h : m.halfedges()) {
        auto n = m.next_halfedge(h); if (!n.is_valid() || (size_t)n.idx() >= nh) { ++badIdx; continue; }
        if (m.prev_halfedge(n) != h) ++badPrevNext;
        if (m.opposite_halfedge(m.opposite_halfedge(h)) != h) ++badOpp;
        auto v = m.to_vertex(h); if (!v.is_valid() || (size_t)v.idx() >= nv) ++badVHandle;
    }
    { std::vector<char> seen(nh, 0);
      for (auto h : m.halfedges()) { if (!m.is_boundary(h) || seen[h.idx()]) continue; auto c = h; int g = 0; bool ok = true; do { seen[c.idx()] = 1; c = m.next_halfedge(c); if (!c.is_valid() || (size_t)c.idx() >= nh || ++g > (int)nh + 1) { ok = false; break; } } while (c != h); if (!ok) ++badBoundaryLoop; } }
    for (auto v : m.vertices()) {
        auto h0 = m.halfedge(v); if (!h0.is_valid()) continue; if ((size_t)h0.idx() >= nh) { ++badIdx; continue; }
        auto h = h0; int g = 0; bool ok = true; bool anyB = false;
        do { if (m.is_boundary(h)) anyB = true; h = m.cw_rotated_halfedge(h); if (!h.is_valid() || (size_t)h.idx() >= nh || ++g > 100000) { ok = false; break; } } while (h != h0);
        if (!ok) ++badRot; else if (anyB && !m.is_boundary(h0)) { ++badRot; if (first.empty()) first = "vertex " + std::to_string(v.idx()) + " has a boundary halfedge but halfedge(v) is interior"; }
    }
    char b[400]; snprintf(b, sizeof b, "faces=%zu he=%zu | badRing=%d badFaceRef=%d badPrevNext=%d badOpp=%d badBoundaryLoop=%d badVertexRot=%d badVHandle=%d badIdx=%d %s", nf, nh, badRing, badFaceRef, badPrevNext, badOpp, badBoundaryLoop, badRot, badVHandle, badIdx, first.c_str());
    return b;
}
int main(int argc, char** argv) {
    int limit = argc > 2 ? atoi(argv[2]) : 120; signal(SIGALRM, watchdog); alarm(limit);
    MeshAnalyzer a;
    auto step = [&](const char* name, auto fn) { g_step = name; fn(); g_step = "check"; fprintf(stderr, "after %-18s %s\n", name, checkMesh(a.meshRef()).c_str()); };
    step("load", [&]{ a.loadFromFile(argv[1]); });
    MeshAnalysis mid{};
    step("analyze", [&]{ mid = a.getAnalysis(); });
    fprintf(stderr, "   before: nmV=%d nmE(skipped)=%d holes=%d degen=%d dup=%d comps=%d wt=%d\n", mid.nonManifoldVertexCount, mid.nonManifoldEdgeCount, mid.holeCount, mid.degenerateTriangleCount, mid.duplicateFaceCount, mid.connectedComponents, (int)mid.isWatertight);
    step("weld", [&]{ a.weldVertices(1e-6f); });
    step("midanalyze", [&]{ mid = a.getAnalysis(); });
    if (!mid.isWatertight) step("removeDegenerates", [&]{ auto r = a.removeDegenerates(1e-10f); fprintf(stderr, "   removed degen=%d dup=%d\n", r.degenerateRemoved, r.duplicateRemoved); });
    step("splitVertices", [&]{ auto r = a.splitVertices(); fprintf(stderr, "   split found=%d added=%d skipped=%d\n", r.nonManifoldVerticesFound, r.verticesAdded, r.skippedFaces); });
    step("fillHoles", [&]{ auto r = a.fillHoles(100); fprintf(stderr, "   fill found=%d filled=%d failed=%d\n", r.holesFound, r.holesFilled, r.holesFailed); });
    step("fixNormals", [&]{ a.fixNormals(); });
    step("reanalyze", [&]{ a.getAnalysis(); });
    return 0;
}
