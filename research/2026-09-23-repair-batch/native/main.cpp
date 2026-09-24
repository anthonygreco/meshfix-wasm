// Native pipeline harness: mirrors the site's worker `repair` case with a watchdog.
#include "core.inc"
#include <chrono>
#include <csignal>
#include <unistd.h>
#include <cstdlib>
static const char* g_step = "init";
static void watchdog(int) { fprintf(stderr, "WATCHDOG: stuck in %s\n", g_step); fflush(stderr); _exit(124); }
int main(int argc, char** argv) {
    if (argc < 2) { fprintf(stderr, "usage: harness file.stl [limitSeconds] [guard=1]\n"); return 2; }
    int limit = argc > 2 ? atoi(argv[2]) : 120; int guard = argc > 3 ? atoi(argv[3]) : 1;
    signal(SIGALRM, watchdog); alarm(limit);
    MeshAnalyzer a; std::string out = "{\"file\":\"" + std::string(argv[1]) + "\"";
    auto t0 = std::chrono::steady_clock::now();
    auto step = [&](const char* name, auto fn) { g_step = name; auto s = std::chrono::steady_clock::now(); fn(); auto ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - s).count(); out += ",\"" + std::string(name) + "_ms\":" + std::to_string((int)ms); };
    bool ok = true; MeshAnalysis before{}, mid{}, after{};
    step("load", [&]{ ok = a.loadFromFile(argv[1]); });
    if (!ok) { printf("%s,\"outcome\":\"load_failed\",\"error\":\"%s\"}\n", out.c_str(), a.getLastError().c_str()); return 1; }
    step("analyze", [&]{ before = a.getAnalysis(); });
    WeldResult w{}; step("weld", [&]{ w = a.weldVertices(1e-6f); });
    step("midanalyze", [&]{ mid = a.getAnalysis(); });
    RemoveDegeneratesResult rd{}; if (!guard || !mid.isWatertight) step("removeDegenerates", [&]{ rd = a.removeDegenerates(1e-10f); });
    SplitVerticesResult sv{}; step("splitVertices", [&]{ sv = a.splitVertices(); });
    FillHolesResult fh{}; step("fillHoles", [&]{ fh = a.fillHoles(100); });
    FixNormalsResult fn{}; step("fixNormals", [&]{ fn = a.fixNormals(); });
    step("reanalyze", [&]{ after = a.getAnalysis(); });
    auto A = [](const char* k, const MeshAnalysis& x) { char b[600]; snprintf(b, sizeof b, ",\"%s\":{\"faces\":%d,\"verts\":%d,\"wt\":%d,\"comps\":%d,\"holes\":%d,\"nmV\":%d,\"nmE\":%d,\"degen\":%d,\"dup\":%d,\"flipped\":%d,\"iso\":%d,\"vol\":%.1f}", k, x.faceCount, x.vertexCount, x.isWatertight?1:0, x.connectedComponents, x.holeCount, x.nonManifoldVertexCount, x.nonManifoldEdgeCount, x.degenerateTriangleCount, x.duplicateFaceCount, x.flippedNormalCount, x.isolatedVertexCount, x.volume); return std::string(b); };
    out += A("before", before) + A("after", after);
    char b[400]; snprintf(b, sizeof b, ",\"weld\":{\"merged\":%d,\"facesRemoved\":%d,\"skipped\":%d},\"rd\":{\"degen\":%d,\"dup\":%d},\"split\":{\"found\":%d,\"added\":%d,\"skipped\":%d},\"fill\":{\"found\":%d,\"filled\":%d,\"failed\":%d,\"skipped\":%d,\"feature\":%d,\"facesAdded\":%d},\"fixn\":{\"flipped\":%d,\"skippedOpen\":%d}", w.verticesMerged, w.facesRemoved, w.skippedFaces, rd.degenerateRemoved, rd.duplicateRemoved, sv.nonManifoldVerticesFound, sv.verticesAdded, sv.skippedFaces, fh.holesFound, fh.holesFilled, fh.holesFailed, fh.holesSkipped, fh.holesSkippedAsFeature, fh.facesAdded, fn.componentsFlipped, fn.skippedOpen);
    out += b;
    auto total = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    printf("%s,\"total_ms\":%d,\"outcome\":\"completed\"}\n", out.c_str(), (int)total);
    return 0;
}
