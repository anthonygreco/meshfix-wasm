// Diagnostic harness: current pipeline order, compact analysis after every step, backtrace on watchdog.
#include "core-new3.inc"
#include <chrono>
#include <csignal>
#include <unistd.h>
#include <execinfo.h>
static const char* g_step = "init";
static void watchdog(int) { fprintf(stderr, "WATCHDOG: stuck in %s\n", g_step); void* bt[64]; int n = backtrace(bt, 64); backtrace_symbols_fd(bt, n, 2); fflush(stderr); _exit(124); }
int main(int argc, char** argv) {
    int limit = argc > 2 ? atoi(argv[2]) : 120; signal(SIGALRM, watchdog); alarm(limit);
    MeshAnalyzer a;
    auto show = [&](const char* name, double ms) { auto x = a.getAnalysis(); fprintf(stderr, "%-18s %6.0fms faces=%d wt=%d comps=%d holes=%d nmV=%d nmE(skipped)=%d degen=%d dup=%d flipped=%d iso=%d | rebuilds=%d dropped=%d\n", name, ms, x.faceCount, (int)x.isWatertight, x.connectedComponents, x.holeCount, x.nonManifoldVertexCount, x.nonManifoldEdgeCount, x.degenerateTriangleCount, x.duplicateFaceCount, x.flippedNormalCount, x.isolatedVertexCount, a.connectivityRebuilds(), a.facesDroppedByAudit()); };
    auto step = [&](const char* name, auto fn) { g_step = name; auto t = std::chrono::steady_clock::now(); fn(); double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t).count(); g_step = "analysis"; show(name, ms); };
    step("load", [&]{ a.loadFromFile(argv[1]); });
    step("weld", [&]{ auto r = a.weldVertices(1e-6f); fprintf(stderr, "   weld merged=%d facesRemoved=%d skipped=%d\n", r.verticesMerged, r.facesRemoved, r.skippedFaces); });
    step("splitVertices", [&]{ auto r = a.splitVertices(); fprintf(stderr, "   split found=%d added=%d skipped=%d\n", r.nonManifoldVerticesFound, r.verticesAdded, r.skippedFaces); });
    step("fillHoles", [&]{ auto r = a.fillHoles(100); fprintf(stderr, "   fill found=%d filled=%d failed=%d feature=%d facesAdded=%d\n", r.holesFound, r.holesFilled, r.holesFailed, r.holesSkippedAsFeature, r.facesAdded); });
    step("removeDegenerates", [&]{ auto r = a.removeDegenerates(1e-10f); fprintf(stderr, "   rd degen=%d dup=%d iso=%d\n", r.degenerateRemoved, r.duplicateRemoved, r.isolatedVerticesRemoved); });
    step("fixNormals", [&]{ auto r = a.fixNormals(); fprintf(stderr, "   fixn comps=%d flipped=%d facesFlipped=%d skippedOpen=%d skipped=%d\n", r.totalComponents, r.componentsFlipped, r.facesFlipped, r.skippedOpen, r.skippedFaces); });
    return 0;
}
