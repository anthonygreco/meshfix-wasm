#include <emscripten/bind.h>
#include <pmp/surface_mesh.h>
#include <pmp/io/io.h>
#include <pmp/algorithms/shapes.h>
#include <pmp/algorithms/differential_geometry.h>
#include <pmp/algorithms/normals.h>
#include <pmp/algorithms/decimation.h>
#include <pmp/algorithms/triangulation.h>
#include "happly.h"
#include <string>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <map>
#include <unordered_map>
#include <vector>
#include <limits>
#include <algorithm>
#include <cctype>
#include <queue>
#include <set>
#include <array>

using namespace emscripten;

// --- Fault-tolerant STL reader (based on PMP's read_stl.cpp) ---
// PMP's reader throws TopologyException on non-manifold faces, aborting the
// entire read. This version wraps each add_face in try-catch, skipping bad
// faces and reporting how many were skipped.

struct CompareVec3 {
    bool operator()(const pmp::vec3& v0, const pmp::vec3& v1) const {
        if (fabs(v0[0] - v1[0]) <= eps_) {
            if (fabs(v0[1] - v1[1]) <= eps_) {
                return (v0[2] < v1[2] - eps_);
            }
            return (v0[1] < v1[1] - eps_);
        }
        return (v0[0] < v1[0] - eps_);
    }
    pmp::Scalar eps_{std::numeric_limits<pmp::Scalar>::min()};
};

template <typename T>
static void tfread(FILE* fp, T& t) {
    [[maybe_unused]] auto n = fread(&t, 1, sizeof(t), fp);
}

// A coordinate that is NaN or infinite has to be rejected before it reaches
// vertex_map below. CompareVec3 orders with `<`, and every comparison against
// NaN is false, so a NaN key compares equivalent to whatever it meets on the
// way down the tree: std::map's ordering requirement is violated, the lookup
// for an unrelated position can terminate on the NaN node, and vertices that
// share no coordinates get welded together. Observed effect on a sphere with
// NaN on one triangle in 23: the whole model collapsed to a single vertex and
// zero faces, reported as a successful load.
//
// Non-finite coordinates also survive repair and export intact, giving the
// downloaded file an infinite bounding box that slicers reject as larger than
// the build volume.
static inline bool is_finite_point(const pmp::vec3& p) {
    return std::isfinite(p[0]) && std::isfinite(p[1]) && std::isfinite(p[2]);
}

// `nonFinite` receives the number of triangles dropped for having a NaN or
// infinite coordinate. The return value remains the non-manifold skip count.
static int read_stl_robust(pmp::SurfaceMesh& mesh, const std::string& filepath,
                           int& nonFinite) {
    std::array<char, 100> line;
    uint32_t i, nT(0);
    pmp::vec3 p;
    pmp::Vertex v;
    std::vector<pmp::Vertex> vertices(3);
    std::array<pmp::vec3, 3> corners;
    int skipped = 0;
    nonFinite = 0;

    CompareVec3 comp;
    std::map<pmp::vec3, pmp::Vertex, CompareVec3> vertex_map(comp);

    FILE* in = fopen(filepath.c_str(), "r");
    if (!in)
        throw std::runtime_error("Failed to open file: " + filepath);

    // Determine if binary STL
    auto is_binary = [&]() {
        [[maybe_unused]] auto c = fgets(line.data(), 6, in);
        if ((strncmp(line.data(), "SOLID", 5) != 0) &&
            (strncmp(line.data(), "solid", 5) != 0)) {
            return true;
        }
        auto fp = fopen(filepath.c_str(), "rb");
        if (!fp)
            throw std::runtime_error("Failed to open file: " + filepath);
        [[maybe_unused]] auto n_items = fread(line.data(), 1, 80, fp);
        uint32_t n_triangles{0};
        tfread(fp, n_triangles);
        fseek(fp, 0L, SEEK_END);
        auto size = ftell(fp);
        size -= 84;
        fclose(fp);
        auto predicted = (4 * 12 + 2) * (long)n_triangles;
        return size == predicted;
    };

    auto add_vertex = [&](const pmp::vec3& pos) -> pmp::Vertex {
        auto it = vertex_map.find(pos);
        if (it == vertex_map.end()) {
            v = mesh.add_vertex((pmp::Point)pos);
            vertex_map[pos] = v;
            return v;
        }
        return it->second;
    };

    auto try_add_face = [&](std::vector<pmp::Vertex>& verts) {
        if ((verts[0] != verts[1]) && (verts[0] != verts[2]) &&
            (verts[1] != verts[2])) {
            try {
                mesh.add_face(verts);
            } catch (...) {
                ++skipped;
            }
        }
    };

    if (is_binary()) {
        fclose(in);
        in = fopen(filepath.c_str(), "rb");
        if (!in)
            throw std::runtime_error("Failed to open file: " + filepath);

        [[maybe_unused]] auto n_items = fread(line.data(), 1, 80, in);
        tfread(in, nT);

        while (nT) {
            n_items = fread(line.data(), 1, 12, in); // skip normal
            bool finite = true;
            for (i = 0; i < 3; ++i) {
                tfread(in, corners[i]);
                if (!is_finite_point(corners[i])) finite = false;
            }
            // Add nothing at all for a bad triangle: a non-finite position must
            // never reach vertex_map.
            if (finite) {
                for (i = 0; i < 3; ++i) vertices[i] = add_vertex(corners[i]);
                try_add_face(vertices);
            } else {
                ++nonFinite;
            }
            n_items = fread(line.data(), 1, 2, in); // skip attribute
            --nT;
        }
    } else {
        char* c{nullptr};
        while (in && !feof(in) && fgets(line.data(), 100, in)) {
            for (c = line.data(); isspace(*c) && *c != '\0'; ++c) {}
            if ((strncmp(c, "outer", 5) == 0) || (strncmp(c, "OUTER", 5) == 0)) {
                bool finite = true, complete = true;
                for (i = 0; i < 3; ++i) {
                    c = fgets(line.data(), 100, in);
                    if (!c) { complete = false; break; }
                    for (c = line.data(); isspace(*c) && *c != '\0'; ++c) {}
                    p = pmp::vec3(0, 0, 0);
                    // sscanf leaves p untouched on a malformed line, and "nan"
                    // and "inf" both parse cleanly with %f, so check the result
                    // rather than trusting the text.
                    sscanf(c + 6, "%f %f %f", &p[0], &p[1], &p[2]);
                    corners[i] = p;
                    if (!is_finite_point(p)) finite = false;
                }
                if (complete && finite) {
                    for (i = 0; i < 3; ++i) vertices[i] = add_vertex(corners[i]);
                    try_add_face(vertices);
                } else if (complete) {
                    ++nonFinite;
                }
            }
        }
    }

    fclose(in);
    return skipped;
}

// --- End STL reader ---

// --- PLY reader (via happly) ---
// Returns number of skipped (non-manifold) faces.
// Sets colorsDropped to true if the file has any vertex colour properties.
static int read_ply_robust(pmp::SurfaceMesh& mesh, const std::string& filepath, bool& colorsDropped) {
    colorsDropped = false;
    int skipped = 0;
    try {
        happly::PLYData plyIn(filepath);

        // Detect vertex colour properties (any of the standard names)
        bool hasColors = false;
        if (plyIn.hasElement("vertex")) {
            auto& el = plyIn.getElement("vertex");
            auto props = el.getPropertyNames();
            for (auto& p : props) {
                if (p == "red" || p == "green" || p == "blue" ||
                    p == "diffuse_red" || p == "diffuse_green" || p == "diffuse_blue" ||
                    p == "r" || p == "g" || p == "b") {
                    hasColors = true;
                    break;
                }
            }
        }
        colorsDropped = hasColors;

        // Read vertex positions
        std::vector<float> xs = plyIn.getElement("vertex").getProperty<float>("x");
        std::vector<float> ys = plyIn.getElement("vertex").getProperty<float>("y");
        std::vector<float> zs = plyIn.getElement("vertex").getProperty<float>("z");

        // A vertex with a non-finite coordinate gets no handle at all, so any
        // face referring to it is dropped below rather than carried into the
        // mesh. See is_finite_point().
        std::vector<pmp::Vertex> verts;
        verts.reserve(xs.size());
        const size_t nVerts = std::min({xs.size(), ys.size(), zs.size()});
        for (size_t i = 0; i < nVerts; ++i) {
            pmp::vec3 p(xs[i], ys[i], zs[i]);
            if (!is_finite_point(p)) {
                verts.push_back(pmp::Vertex());
                continue;
            }
            verts.push_back(mesh.add_vertex(pmp::Point(p)));
        }

        // Read faces
        std::vector<std::vector<int>> faces;
        if (plyIn.hasElement("face")) {
            faces = plyIn.getElement("face").getListProperty<int>("vertex_indices");
        }

        // A PLY may name a vertex index that does not exist; indexing `verts`
        // with it would read off the end of the vector.
        auto vertexAt = [&](int idx) -> pmp::Vertex {
            if (idx < 0 || static_cast<size_t>(idx) >= verts.size()) return pmp::Vertex();
            return verts[idx];
        };

        for (auto& f : faces) {
            if (f.size() < 3) continue;
            // Triangulate if needed (fan triangulation)
            for (size_t i = 1; i + 1 < f.size(); ++i) {
                std::vector<pmp::Vertex> tri = { vertexAt(f[0]), vertexAt(f[i]), vertexAt(f[i+1]) };
                if (!tri[0].is_valid() || !tri[1].is_valid() || !tri[2].is_valid()) {
                    ++skipped;
                    continue;
                }
                if (tri[0] == tri[1] || tri[0] == tri[2] || tri[1] == tri[2]) continue;
                try {
                    mesh.add_face(tri);
                } catch (...) {
                    ++skipped;
                }
            }
        }
    } catch (const std::exception& e) {
        throw std::runtime_error(std::string("PLY read error: ") + e.what());
    }
    return skipped;
}

// --- PLY writer (via happly) ---
static void write_ply_binary(pmp::SurfaceMesh& mesh, const std::string& filepath) {
    std::vector<float> xs, ys, zs;
    xs.reserve(mesh.n_vertices());
    ys.reserve(mesh.n_vertices());
    zs.reserve(mesh.n_vertices());

    // Build a contiguous index array from half-edge mesh
    std::map<pmp::Vertex, size_t> idx;
    size_t i = 0;
    for (auto v : mesh.vertices()) {
        auto p = mesh.position(v);
        xs.push_back(p[0]);
        ys.push_back(p[1]);
        zs.push_back(p[2]);
        idx[v] = i++;
    }

    std::vector<std::vector<int>> faces;
    faces.reserve(mesh.n_faces());
    for (auto f : mesh.faces()) {
        std::vector<int> tri;
        for (auto v : mesh.vertices(f)) {
            tri.push_back(static_cast<int>(idx[v]));
        }
        faces.push_back(std::move(tri));
    }

    happly::PLYData plyOut;
    plyOut.addElement("vertex", xs.size());
    plyOut.getElement("vertex").addProperty<float>("x", xs);
    plyOut.getElement("vertex").addProperty<float>("y", ys);
    plyOut.getElement("vertex").addProperty<float>("z", zs);
    plyOut.addElement("face", faces.size());
    plyOut.getElement("face").addListProperty<int>("vertex_indices", faces);
    plyOut.write(filepath, happly::DataFormat::Binary);
}

// --- End PLY reader/writer ---

struct GridCell {
    int64_t ix, iy, iz;
    bool operator==(const GridCell& o) const {
        return ix == o.ix && iy == o.iy && iz == o.iz;
    }
};

struct GridCellHash {
    size_t operator()(const GridCell& c) const {
        size_t h = std::hash<int64_t>{}(c.ix);
        h ^= std::hash<int64_t>{}(c.iy) + 0x9e3779b97f4a7c15ULL + (h << 6) + (h >> 2);
        h ^= std::hash<int64_t>{}(c.iz) + 0x9e3779b97f4a7c15ULL + (h << 6) + (h >> 2);
        return h;
    }
};

struct WeldResult {
    int verticesBefore;
    int verticesAfter;
    int verticesMerged;
    int facesBefore;
    int facesAfter;
    int facesRemoved;
    int degenerateFaces;
    int skippedFaces;
};

struct RemoveDegeneratesResult {
    int facesBefore;
    int facesAfter;
    int degenerateRemoved;
    int duplicateRemoved;
    int isolatedVerticesRemoved;
};

struct FixNormalsResult {
    int totalComponents;
    int componentsFlipped;
    int facesFlipped;
    int skippedOpen;
    int skippedFaces;
};

struct FillHolesResult {
    int holesFound;
    int holesFilled;
    int holesFailed;
    int holesSkipped;
    int facesAdded;
    // Loops left alone because they look like deliberate geometry rather than
    // damage. Reported separately from holesSkipped (which is the edge-count
    // cap) so the UI can offer to fill them anyway.
    int holesSkippedAsFeature;
    // Lone triangles that were their own component, whose only "hole" was
    // themselves, removed instead of being sealed into a zero-thickness pillow.
    int flapsRemoved;
};

struct DecimateResult {
    bool success;
    int verticesBefore;
    int verticesAfter;
    int facesBefore;
    int facesAfter;
    // Faces dropped by rebuildFromValidFaces() because decimation left them
    // referencing vertices that no longer exist. Normally 0.
    int facesDropped;
};

struct SplitVerticesResult {
    int verticesBefore;
    int verticesAfter;
    int nonManifoldVerticesFound;
    int verticesAdded;
    int facesBefore;
    int facesAfter;
    int skippedFaces;
};

struct RepairResult {
    WeldResult weld;
    RemoveDegeneratesResult removeDegenerates;
    SplitVerticesResult splitVertices;
    FixNormalsResult fixNormals;
    FillHolesResult fillHoles;
    int verticesBefore;
    int verticesAfter;
    int facesBefore;
    int facesAfter;
};

struct MeshStats {
    int vertexCount;
    int faceCount;
    int edgeCount;
    float bboxMinX, bboxMinY, bboxMinZ;
    float bboxMaxX, bboxMaxY, bboxMaxZ;
    float dimX, dimY, dimZ;
    float surfaceArea;
    float volume;
    int boundaryEdges;
    bool isTriangleMesh;
    int skippedFaces;
};

struct MeshAnalysis {
    // Geometry (same as MeshStats)
    int vertexCount;
    int faceCount;
    int edgeCount;
    float bboxMinX, bboxMinY, bboxMinZ;
    float bboxMaxX, bboxMaxY, bboxMaxZ;
    float dimX, dimY, dimZ;
    float surfaceArea;
    float volume;
    int boundaryEdges;
    bool isTriangleMesh;
    int skippedFaces;
    // Topology
    bool isManifold;
    bool isWatertight;
    int eulerCharacteristic;
    int genus;
    int connectedComponents;
    int boundaryLoops;
    // Issue counts
    int nonManifoldVertexCount;
    int nonManifoldEdgeCount;
    int flippedNormalCount;
    int degenerateTriangleCount;
    int holeCount;
    int duplicateFaceCount;
    int isolatedVertexCount;
};

// --- Boundary-loop classification ---
//
// fillHoles() used to fill every boundary loop under the edge cap, which is a
// size test, not an intent test. On a watertight solid that is harmless — a
// designed bore is closed geometry there and never appears as a boundary loop.
// On an open shell it is wrong: a designed bore IS a boundary loop, so bores,
// slots and the part's own outer perimeter all got sealed. That is the
// "it filled in the holes that were supposed to be there" report.
//
// The cost of guessing wrong runs both ways, and the two are not symmetric:
// filling a bore spoils the part, but refusing to fill real damage means the
// tool did not do its job. So this test is deliberately narrow — it only
// declines loops that are large, flat and round, which is what a machined
// opening looks like and what damage does not. Everything it declines is
// counted in holesSkippedAsFeature so the caller can say so and offer to fill
// it anyway; nothing is silently left behind.
//
// A missing triangle in a flat wall is flat and round too, which is why the
// edge-count floor matters: damage is on the scale of the local triangles,
// a designed opening is many triangles across.
struct LoopShape {
    int edges = 0;
    double planarDeviation = 1.0;  // max distance from best-fit plane / diameter
    double radiusVariation = 1.0;  // stddev/mean of in-plane radius
    double edgeVariation = 1.0;    // stddev/mean of edge length
    double diameter = 0.0;         // largest distance between any two loop vertices
    // How far the loop's own connected component reaches from the loop's plane,
    // over diameter. ~0 for a plate or any thin open shell; large for a solid
    // that is merely missing this face. Filled in by measureLoopWithDepth().
    double shellDepth = 0.0;
    // The volume the component would enclose if this loop were capped, over
    // (loop area x diameter): the mean thickness of the closed solid relative
    // to its width. ~0 for a plate (a capped plate is a zero-volume pillow);
    // a slab missing a face is as thick as the slab. Also from
    // measureLoopWithDepth().
    double shellThickness = 0.0;
    pmp::Point centroid{0, 0, 0};
    pmp::Point normal{0, 0, 0};    // unit plane normal (Newell), zero if degenerate
};

static LoopShape measureLoop(const std::vector<pmp::Point>& p) {
    LoopShape s;
    s.edges = static_cast<int>(p.size());
    if (p.size() < 3) return s;

    pmp::Point c(0, 0, 0);
    for (const auto& q : p) c += q;
    c /= static_cast<pmp::Scalar>(p.size());

    // Newell's method: robust plane normal for a polygon that is not perfectly
    // planar, which no real boundary loop is.
    pmp::Point n(0, 0, 0);
    for (size_t i = 0; i < p.size(); ++i) {
        const auto& a = p[i];
        const auto& b = p[(i + 1) % p.size()];
        n[0] += (a[1] - b[1]) * (a[2] + b[2]);
        n[1] += (a[2] - b[2]) * (a[0] + b[0]);
        n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const double nlen = std::sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
    if (!(nlen > 0) || !std::isfinite(nlen)) return s;
    n /= static_cast<pmp::Scalar>(nlen);
    s.centroid = c;
    s.normal = n;

    double diameter = 0;
    for (size_t i = 0; i < p.size(); ++i)
        for (size_t j = i + 1; j < p.size(); ++j)
            diameter = std::max(diameter, static_cast<double>(pmp::distance(p[i], p[j])));
    if (!(diameter > 0)) return s;

    double maxDev = 0, rSum = 0, rSq = 0, eSum = 0, eSq = 0;
    for (size_t i = 0; i < p.size(); ++i) {
        const auto d = p[i] - c;
        const double off = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
        maxDev = std::max(maxDev, std::fabs(off));

        const double dist2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        const double r = std::sqrt(std::max(0.0, dist2 - off * off));
        rSum += r; rSq += r * r;

        const double e = pmp::distance(p[i], p[(i + 1) % p.size()]);
        eSum += e; eSq += e * e;
    }
    const double count = static_cast<double>(p.size());
    const double rMean = rSum / count;
    const double eMean = eSum / count;

    s.diameter = diameter;
    s.planarDeviation = maxDev / diameter;
    if (rMean > 0) s.radiusVariation = std::sqrt(std::max(0.0, rSq / count - rMean * rMean)) / rMean;
    if (eMean > 0) s.edgeVariation = std::sqrt(std::max(0.0, eSq / count - eMean * eMean)) / eMean;
    return s;
}

// Thresholds are deliberately lopsided. The tool's job is repair, so leaving
// real damage unfilled is a worse failure than filling a feature — and filling
// every loop is exactly what this code did before the test existed, so any loop
// it declines is ground gained and any loop it fills is merely the status quo.
// A loop therefore has to be unmistakably a machined opening (large, flat,
// round, with margin) before it is left alone.
//
// edgeVariation is measured and reported but deliberately NOT used here. Where
// holes were made by deleting triangles from a regular grid, damage has
// perfectly uniform boundary edges and designed openings have ragged ones — the
// reverse of a CAD export, where the mesher lays an even ring of vertices around
// a bore. The signal changes sign with how the mesh was produced, so it cannot
// carry a decision.
//
// The case no geometry settles: a square torn patch and a square designed
// opening in a flat wall are the same shape. Those get filled, which is the
// safe direction; holesSkippedAsFeature and describeHoles() let the caller show
// what was kept and offer to fill it anyway.
// `meshDiagonal` is the bounding-box diagonal of the whole model; pass 0 to
// skip the outer-boundary test and the size floor.
static bool looksDeliberate(const LoopShape& s, double meshDiagonal, int /*loopCount*/) {
    // An open shell — a plate, a scanned surface, anything not closed — has its
    // own outer edge as a boundary loop, and sealing that is never a repair: it
    // turns a plate into a pillow. A loop spanning most of the model is a
    // candidate for that outer edge: damage sits well inside the part, the
    // widest tear in the corpus spanning 47% of the diagonal against 100% for
    // a perimeter.
    //
    // Span alone is not enough, though. A closed solid that has lost one face
    // — a box or prism with an end cap dropped by a boolean, the commonest
    // export failure this tool exists for — has a loop spanning most of its
    // diagonal too, and it must be filled. What separates the two is where
    // the rest of the surface is: a shell lies in the loop's plane, a solid
    // reaches away from it. Measured on nine loops (research/2026-09-23):
    // genuine open shells reach 0.01–0.08 of the loop diameter from its
    // plane, solids missing a face 0.15–0.31. The cut is at 0.10.
    //
    // This deliberately does not require a second loop to be present. An
    // undamaged open shell has exactly one boundary loop — its perimeter — and
    // that is the case that must not be sealed.
    //
    // Reach alone is fooled by a long slab missing a long face: a 10 x 10 x
    // 100 bar without one side reaches only 10 from a loop 100 wide, the same
    // ratio as a gently curved shell. So the enclosed thickness is required to
    // be near zero as well — capping a plate encloses nothing, capping the bar
    // encloses the bar.
    if (meshDiagonal > 0 && s.diameter >= 0.60 * meshDiagonal &&
        s.shellDepth <= 0.10 && s.shellThickness <= 0.02)
        return true;

    // A designed opening is many triangles across and big enough to matter.
    // Without the size floor, a finely tessellated 64-edge circle a tenth of
    // a unit wide — the tip of a cone, the end of a wire — counts as a bore
    // and the mesh is left open (Thingiverse 66375, 1038441, 601643).
    const bool bigEnough = meshDiagonal <= 0 || s.diameter >= 0.02 * meshDiagonal;
    return s.edges >= 16              // damage spans a few triangles; an opening spans many
        && bigEnough
        && s.planarDeviation <= 0.05  // a machined opening lies in a plane
        && s.radiusVariation <= 0.08; // ... and is round, with margin to spare
}

// --- Connectivity integrity ---
//
// pmp::decimate() can return normally having left faces that reference vertices
// its final garbage_collection() already removed. PMP catches that with
// assert(idx < data_.size()) inside PropertyArray::operator[], but this module
// ships -O2 with NDEBUG, so the assert is gone and the next traversal to read a
// vertex position — face_area() in getAnalysis(), face_normal() in
// writeRenderData(), the exporters — indexes past the end of the property
// array. When the stale index lands outside linear memory that is a WASM trap,
// which aborts the whole module: every later call on this instance fails and
// the engine is dead until the page reloads.
//
// So: never hand a mesh to a traversal without checking it first. Both helpers
// below bounds-check every handle before dereferencing it, and therefore stay
// safe on exactly the meshes that are already corrupt.
//
// Decimation is not the only producer. pmp::add_face() accepts a triangle whose
// vertices repeat (v, w, v) without throwing and links a face whose halfedge
// ring never closes; pmp::delete_face() on a mesh that is not manifold can
// leave halfedges pointing at vertices garbage_collection() then removes.
// Either state hangs the next face-vertex circulator (fixNormals, getAnalysis)
// or traps on the next position read, which is the 300s repair timeout and the
// "memory access out of bounds" seen in production. So every repair operation
// runs this audit when it finishes and rebuilds from the valid faces if it
// fails (see MeshAnalyzer::auditConnectivity()).

// True if every face's halfedge ring is walkable and lands only on live
// vertices, every halfedge's prev/next and opposite links are mutually
// consistent, and every boundary chain closes. `badFaces`, when given,
// collects the faces whose rings fail.
static bool connectivityIsValid(const pmp::SurfaceMesh& mesh,
                                std::vector<pmp::Face>* badFaces = nullptr) {
    const size_t nv = mesh.vertices_size();
    const size_t nh = mesh.halfedges_size();
    const size_t nf = mesh.faces_size();
    bool ok = true;

    // Halfedge links. A ring that never closes always shows up here too, but
    // this catches the case where the face rings are fine and only the
    // boundary chain is broken.
    for (auto h : mesh.halfedges()) {
        if (static_cast<size_t>(h.idx()) >= nh) { ok = false; break; }
        auto n = mesh.next_halfedge(h);
        auto o = mesh.opposite_halfedge(h);
        if (!n.is_valid() || static_cast<size_t>(n.idx()) >= nh ||
            !o.is_valid() || static_cast<size_t>(o.idx()) >= nh) { ok = false; break; }
        if (mesh.prev_halfedge(n) != h) { ok = false; break; }
        if (mesh.opposite_halfedge(o) != h) { ok = false; break; }
        auto v = mesh.to_vertex(h);
        if (!v.is_valid() || static_cast<size_t>(v.idx()) >= nv || mesh.is_deleted(v)) { ok = false; break; }
    }
    if (!ok && !badFaces) return false;

    // Vertex rotations: circling a vertex with cw_rotated_halfedge() must
    // return to the start. Every vertex circulator in PMP (find_halfedge,
    // is_manifold, is_collapse_ok, ...) assumes this and spins if it fails.
    if (ok) {
        for (auto v : mesh.vertices()) {
            auto h0 = mesh.halfedge(v);
            if (!h0.is_valid()) continue;
            if (static_cast<size_t>(h0.idx()) >= nh) { ok = false; break; }
            auto h = h0;
            size_t guard = 0;
            do {
                h = mesh.cw_rotated_halfedge(h);
                if (!h.is_valid() || static_cast<size_t>(h.idx()) >= nh || ++guard > nh) { ok = false; break; }
            } while (h != h0);
            if (!ok) break;
        }
        if (!ok && !badFaces) return false;
    }

    // Boundary chains: following next from a boundary halfedge must return to
    // it within the halfedge count.
    if (ok) {
        std::vector<char> seen(nh, 0);
        for (auto h : mesh.halfedges()) {
            if (!mesh.is_boundary(h) || seen[h.idx()]) continue;
            auto cur = h;
            size_t guard = 0;
            do {
                seen[cur.idx()] = 1;
                cur = mesh.next_halfedge(cur);
                if (!cur.is_valid() || static_cast<size_t>(cur.idx()) >= nh || ++guard > nh) { ok = false; break; }
            } while (cur != h);
            if (!ok) break;
        }
        if (!ok && !badFaces) return false;
    }

    for (auto f : mesh.faces()) {
        bool faceOk = true;
        if (static_cast<size_t>(f.idx()) >= nf) {
            faceOk = false;
        } else {
            auto h0 = mesh.halfedge(f);
            auto h = h0;
            int guard = 0;
            if (!h0.is_valid() || static_cast<size_t>(h0.idx()) >= nh) {
                faceOk = false;
            } else {
                do {
                    if (!h.is_valid() || static_cast<size_t>(h.idx()) >= nh) { faceOk = false; break; }
                    auto v = mesh.to_vertex(h);
                    if (!v.is_valid() || static_cast<size_t>(v.idx()) >= nv) { faceOk = false; break; }
                    if (mesh.is_deleted(v)) { faceOk = false; break; }
                    h = mesh.next_halfedge(h);
                    // A ring that will not close is corrupt however long we walk.
                    if (++guard > 100000) { faceOk = false; break; }
                } while (h != h0);
            }
        }
        if (!faceOk) {
            ok = false;
            if (!badFaces) return false;
            badFaces->push_back(f);
        }
    }
    return ok;
}

// Rebuild `mesh` from the faces that survive connectivityIsValid(), dropping
// the rest. Returns the number of faces dropped, or -1 if the result is still
// not valid (in which case `mesh` is left untouched and the caller must give
// up on it).
//
// Called only when the audit has failed, which is rare, so the temporary copy
// is an acceptable cost.
static int rebuildFromValidFaces(pmp::SurfaceMesh& mesh) {
    const size_t nv = mesh.vertices_size();
    const size_t nh = mesh.halfedges_size();

    pmp::SurfaceMesh rebuilt;
    std::vector<pmp::Vertex> remap(nv, pmp::Vertex());
    int dropped = 0;

    for (auto f : mesh.faces()) {
        // Collect the ring with the same bounds checks used above; anything
        // that fails them is dropped rather than dereferenced.
        std::vector<pmp::Vertex> ring;
        bool faceOk = true;
        auto h0 = mesh.halfedge(f);
        auto h = h0;
        int guard = 0;
        if (!h0.is_valid() || static_cast<size_t>(h0.idx()) >= nh) {
            faceOk = false;
        } else {
            do {
                if (!h.is_valid() || static_cast<size_t>(h.idx()) >= nh) { faceOk = false; break; }
                auto v = mesh.to_vertex(h);
                if (!v.is_valid() || static_cast<size_t>(v.idx()) >= nv || mesh.is_deleted(v)) {
                    faceOk = false;
                    break;
                }
                ring.push_back(v);
                h = mesh.next_halfedge(h);
                if (++guard > 100000) { faceOk = false; break; }
            } while (h != h0);
        }

        if (!faceOk || ring.size() < 3) { ++dropped; continue; }

        std::vector<pmp::Vertex> tri;
        tri.reserve(ring.size());
        for (auto v : ring) {
            if (!remap[v.idx()].is_valid()) {
                remap[v.idx()] = rebuilt.add_vertex(mesh.position(v));
            }
            tri.push_back(remap[v.idx()]);
        }

        bool degenerate = false;
        for (size_t i = 0; i < tri.size() && !degenerate; ++i)
            for (size_t j = i + 1; j < tri.size(); ++j)
                if (tri[i] == tri[j]) { degenerate = true; break; }
        if (degenerate) { ++dropped; continue; }

        try {
            rebuilt.add_face(tri);
        } catch (...) {
            ++dropped;
        }
    }

    if (!connectivityIsValid(rebuilt)) return -1;

    mesh = std::move(rebuilt);
    return dropped;
}

// Split a boundary loop that visits a vertex more than once into simple loops
// (each vertex once). Walking the loop, the second visit to a vertex closes the
// stretch since its first visit as a loop of its own; what remains continues
// as the outer loop. Stretches shorter than a triangle (a dangling edge walked
// there and back) are dropped.
static void splitPinchedLoop(const std::vector<pmp::Vertex>& loop,
                             std::vector<std::vector<pmp::Vertex>>& out) {
    std::unordered_map<pmp::IndexType, size_t> firstSeen;
    std::vector<pmp::Vertex> cur;
    for (auto v : loop) {
        auto it = firstSeen.find(v.idx());
        if (it != firstSeen.end()) {
            std::vector<pmp::Vertex> sub(cur.begin() + static_cast<long>(it->second), cur.end());
            for (auto s : sub) firstSeen.erase(s.idx());
            cur.erase(cur.begin() + static_cast<long>(it->second), cur.end());
            if (sub.size() >= 3) out.push_back(std::move(sub));
        }
        firstSeen[v.idx()] = cur.size();
        cur.push_back(v);
    }
    if (cur.size() >= 3) out.push_back(std::move(cur));
}

// Minimum-weight triangulation of a simple boundary loop (Barequet & Sharir's
// dynamic programme, O(n^3) for n loop vertices). Weight is triangle area plus
// a small chord-length term, with a large penalty for a near-zero-area
// triangle and for a chord that already exists as an interior edge — the fan
// this replaces failed whenever a chord from its apex was already an edge,
// and produced a zero-area triangle whenever three loop vertices were
// collinear. Returns index triples into `lv`.
static std::vector<std::array<int, 3>> minWeightTriangulation(const pmp::SurfaceMesh& mesh,
                                                              const std::vector<pmp::Vertex>& lv) {
    const int n = static_cast<int>(lv.size());
    std::vector<pmp::Point> P(n);
    for (int i = 0; i < n; ++i) P[i] = mesh.position(lv[i]);

    double diam = 0.0, edgeSum = 0.0;
    for (int i = 0; i < n; ++i) {
        edgeSum += pmp::distance(P[i], P[(i + 1) % n]);
        for (int j = i + 1; j < n; ++j) diam = std::max(diam, static_cast<double>(pmp::distance(P[i], P[j])));
    }
    const double edgeMean = edgeSum / n;
    const double degenerateArea = 1e-6 * diam * diam;
    const double BIG = 1e12;

    auto chordIsInteriorEdge = [&](int i, int j) {
        if (j == i + 1 || (i == 0 && j == n - 1)) return false;  // a loop edge
        auto h = mesh.find_halfedge(lv[i], lv[j]);
        if (!h.is_valid()) return false;
        return !(mesh.is_boundary(h) || mesh.is_boundary(mesh.opposite_halfedge(h)));
    };

    std::vector<std::vector<double>> W(n, std::vector<double>(n, 0.0));
    std::vector<std::vector<int>> K(n, std::vector<int>(n, -1));
    for (int len = 2; len < n; ++len) {
        for (int i = 0; i + len < n; ++i) {
            const int j = i + len;
            double best = std::numeric_limits<double>::max();
            int bestK = -1;
            for (int k = i + 1; k < j; ++k) {
                const double area = 0.5 * pmp::norm(pmp::cross(P[k] - P[i], P[j] - P[i]));
                double w = W[i][k] + W[k][j] + area +
                           0.05 * edgeMean * static_cast<double>(pmp::distance(P[i], P[j]));
                if (area < degenerateArea) w += BIG;
                if (chordIsInteriorEdge(i, k) || chordIsInteriorEdge(k, j) || chordIsInteriorEdge(i, j)) w += BIG;
                if (w < best) { best = w; bestK = k; }
            }
            W[i][j] = best;
            K[i][j] = bestK;
        }
    }

    std::vector<std::array<int, 3>> out;
    std::vector<std::pair<int, int>> stack{{0, n - 1}};
    while (!stack.empty()) {
        auto [i, j] = stack.back();
        stack.pop_back();
        if (j - i < 2) continue;
        const int k = K[i][j];
        if (k < 0) continue;
        out.push_back({i, k, j});
        stack.push_back({i, k});
        stack.push_back({k, j});
    }
    return out;
}

class MeshAnalyzer {
public:
    MeshAnalyzer() : loaded_(false), skippedFaces_(0), colorsDropped_(false) {}

    bool colorsDropped() const { return colorsDropped_; }

    // Faces removed at load for carrying a NaN or infinite coordinate.
    int nonFiniteFacesRemoved() const { return nonFiniteFaces_; }

    bool loadFromFile(const std::string& path) {
        try {
            mesh_ = pmp::SurfaceMesh();
            skippedFaces_ = 0;
            colorsDropped_ = false;
            lastError_.clear();

            // Check file extension
            auto dot = path.rfind('.');
            std::string ext = (dot != std::string::npos) ? path.substr(dot) : "";
            std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);

            nonFiniteFaces_ = 0;

            if (ext == ".stl") {
                // Use our fault-tolerant STL reader
                skippedFaces_ = read_stl_robust(mesh_, path, nonFiniteFaces_);
                if (skippedFaces_ > 0) {
                    lastError_ = std::to_string(skippedFaces_) +
                        " non-manifold face(s) skipped during import";
                }
            } else if (ext == ".ply") {
                // Use happly-based PLY reader
                skippedFaces_ = read_ply_robust(mesh_, path, colorsDropped_);
                if (skippedFaces_ > 0) {
                    lastError_ = std::to_string(skippedFaces_) +
                        " non-manifold face(s) skipped during import";
                }
            } else {
                // Use PMP's reader for other formats (OBJ, OFF, etc.)
                pmp::read(mesh_, path);
                // PMP's readers do no finite check, so sweep afterwards. The
                // STL and PLY readers reject bad vertices at source instead,
                // which is what keeps NaN out of the STL weld map.
                nonFiniteFaces_ = dropNonFiniteVertices();
            }

            loaded_ = mesh_.n_faces() > 0;
            if (!loaded_) {
                lastError_ = nonFiniteFaces_ > 0
                    ? "Every face in this file had an invalid (NaN or infinite) coordinate"
                    : "File read produced empty mesh";
                return false;
            }
            connectivityRebuilds_ = 0;
            facesDroppedByAudit_ = 0;
            if (!auditConnectivity("Loading")) return false;
            if (nonFiniteFaces_ > 0) {
                lastError_ = std::to_string(nonFiniteFaces_) +
                    " face(s) with invalid (NaN or infinite) coordinates removed during import";
            }
            return loaded_;
        } catch (const std::exception& e) {
            lastError_ = e.what();
            loaded_ = false;
            return false;
        } catch (...) {
            lastError_ = "Unknown error reading file";
            loaded_ = false;
            return false;
        }
    }

    bool loadTestShape(const std::string& name) {
        try {
            mesh_ = pmp::SurfaceMesh();
            skippedFaces_ = 0;
            nonFiniteFaces_ = 0;
            lastError_.clear();
            if (name == "icosphere" || name.rfind("icosphere", 0) == 0) {
                // "icosphere" = level 3; "icosphere5"/"icosphere6"/"icosphere7" for high-poly
                int level = 3;
                if (name.length() > 9) {
                    int parsed = std::stoi(name.substr(9));
                    level = std::max(0, std::min(7, parsed));
                }
                mesh_ = pmp::icosphere(level);
            } else if (name == "torus") {
                mesh_ = pmp::torus();
            } else if (name == "tetrahedron") {
                mesh_ = pmp::tetrahedron();
            } else if (name == "bowtie") {
                // Two open triangle fans sharing vertex 0 — creates a bowtie (non-manifold vertex)
                // PMP's add_face requires v0 to remain a boundary vertex, so fans must be open.
                auto v0 = mesh_.add_vertex(pmp::Point(0, 0, 0));
                // Fan 1: two triangles sharing edge v0-v2
                auto v1 = mesh_.add_vertex(pmp::Point(1, 0, 0));
                auto v2 = mesh_.add_vertex(pmp::Point(0.5, 1, 0));
                auto v3 = mesh_.add_vertex(pmp::Point(0, 1, 0.5));
                mesh_.add_face({v0, v1, v2});
                mesh_.add_face({v0, v2, v3});
                // Fan 2: two triangles sharing edge v0-v5
                auto v4 = mesh_.add_vertex(pmp::Point(-1, 0, 0));
                auto v5 = mesh_.add_vertex(pmp::Point(-0.5, -1, 0));
                auto v6 = mesh_.add_vertex(pmp::Point(0, -1, -0.5));
                mesh_.add_face({v0, v4, v5});
                mesh_.add_face({v0, v5, v6});
            } else {
                lastError_ = "Unknown shape: " + name;
                loaded_ = false;
                return false;
            }
            loaded_ = true;
            return true;
        } catch (const std::exception& e) {
            lastError_ = e.what();
            loaded_ = false;
            return false;
        }
    }

    MeshStats getStats() {
        MeshStats stats{};
        if (!loaded_) return stats;

        try {
            MeshAnalysis a{};
            fillGeometry(a);
            stats.vertexCount = a.vertexCount;
            stats.faceCount = a.faceCount;
            stats.edgeCount = a.edgeCount;
            stats.bboxMinX = a.bboxMinX; stats.bboxMinY = a.bboxMinY; stats.bboxMinZ = a.bboxMinZ;
            stats.bboxMaxX = a.bboxMaxX; stats.bboxMaxY = a.bboxMaxY; stats.bboxMaxZ = a.bboxMaxZ;
            stats.dimX = a.dimX; stats.dimY = a.dimY; stats.dimZ = a.dimZ;
            stats.surfaceArea = a.surfaceArea;
            stats.volume = a.volume;
            stats.boundaryEdges = a.boundaryEdges;
            stats.isTriangleMesh = a.isTriangleMesh;
            stats.skippedFaces = a.skippedFaces;
        } catch (const std::exception& e) {
            lastError_ = std::string("Error computing stats: ") + e.what();
        } catch (...) {
            lastError_ = "Unknown error computing stats";
        }

        return stats;
    }

    struct ComponentInfo {
        double signedVolume = 0.0;  // relative to a point on the component, in double
        double area = 0.0;
        int faceCount = 0;
        bool hasBoundary = false;
        pmp::Point bbMin{0, 0, 0}, bbMax{0, 0, 0};
        pmp::Vertex seed;           // a vertex on the component
    };

    // Label every face with its connected component (in `compId`, which the
    // caller creates as a face property initialised to -1) and measure each
    // component. The signed volume is summed in double about a point on the
    // component itself: a closed sheet folded on itself has volume ~0 but
    // its faces sit at coordinates whose cubes dwarf that, and summed in
    // float about the origin the result was pure rounding noise — sign
    // included, which is how fixNormals "flipped" 3 components of one model
    // and the analysis afterwards still found 2 of them "flipped".
    std::vector<ComponentInfo> analyzeComponents(pmp::FaceProperty<int>& compId) {
        std::vector<ComponentInfo> comps;
        for (auto f : mesh_.faces()) {
            if (compId[f] >= 0) continue;
            const int cid = static_cast<int>(comps.size());
            ComponentInfo info;
            std::queue<pmp::Face> q;
            q.push(f);
            compId[f] = cid;
            bool first = true;
            pmp::Point origin(0, 0, 0);
            while (!q.empty()) {
                auto cur = q.front();
                q.pop();
                ++info.faceCount;
                std::vector<pmp::Point> fp;
                int ringGuard = 0;
                for (auto v : mesh_.vertices(cur)) {
                    if (++ringGuard > 4096) break;  // capped: a broken ring must not spin
                    const auto p = mesh_.position(v);
                    if (first) {
                        origin = p;
                        info.bbMin = info.bbMax = p;
                        info.seed = v;
                        first = false;
                    }
                    for (int k = 0; k < 3; ++k) {
                        info.bbMin[k] = std::min(info.bbMin[k], p[k]);
                        info.bbMax[k] = std::max(info.bbMax[k], p[k]);
                    }
                    fp.push_back(p);
                }
                for (size_t i = 1; i + 1 < fp.size(); ++i) {
                    const pmp::Point a = fp[0] - origin, b = fp[i] - origin, c = fp[i + 1] - origin;
                    info.signedVolume += static_cast<double>(pmp::dot(a, pmp::cross(b, c))) / 6.0;
                    info.area += 0.5 * static_cast<double>(pmp::norm(pmp::cross(fp[i] - fp[0], fp[i + 1] - fp[0])));
                }
                for (auto h : mesh_.halfedges(cur)) {
                    if (mesh_.is_boundary(mesh_.edge(h))) info.hasBoundary = true;
                    auto opp = mesh_.opposite_halfedge(h);
                    if (mesh_.is_boundary(opp)) continue;
                    auto neighbor = mesh_.face(opp);
                    if (compId[neighbor] < 0) {
                        compId[neighbor] = cid;
                        q.push(neighbor);
                    }
                }
            }
            comps.push_back(info);
        }
        return comps;
    }

    // Möller–Trumbore in double. Returns true and sets t on a hit in front of
    // the origin.
    static bool rayHitsTriangle(const pmp::Point& o, const pmp::Point& d,
                                const pmp::Point& p0, const pmp::Point& p1, const pmp::Point& p2,
                                double& t) {
        const double e1[3] = {p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]};
        const double e2[3] = {p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]};
        const double h[3] = {d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]};
        const double det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
        if (std::fabs(det) < 1e-18) return false;
        const double inv = 1.0 / det;
        const double sv[3] = {o[0] - p0[0], o[1] - p0[1], o[2] - p0[2]};
        const double u = inv * (sv[0] * h[0] + sv[1] * h[1] + sv[2] * h[2]);
        if (u < 0.0 || u > 1.0) return false;
        const double qv[3] = {sv[1] * e1[2] - sv[2] * e1[1], sv[2] * e1[0] - sv[0] * e1[2], sv[0] * e1[1] - sv[1] * e1[0]};
        const double v = inv * (d[0] * qv[0] + d[1] * qv[1] + d[2] * qv[2]);
        if (v < 0.0 || u + v > 1.0) return false;
        t = inv * (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]);
        return t > 1e-12;
    }

    // Which components are wound the wrong way. A closed component with
    // negative signed volume is inside out — unless it is an internal cavity:
    // a hollow part's inner shell is closed, faces inward, and has negative
    // volume by design. dugout-bottom.stl is one: flipping its 2,450-face
    // cavity outward added 22% to the volume and would print it solid, and
    // 13 of 50 wild models where fixNormals flipped something contained such
    // a shell. So a negative component that sits inside another closed
    // component (ray parity from one of its vertices, bounding-box
    // prefiltered) is left alone.
    //
    // Components whose volume is negligible against their size — closed
    // sheets folded on themselves — have no meaningful orientation; their
    // sign is rounding, and they are neither counted nor flipped.
    std::vector<char> orientationWrong(const std::vector<ComponentInfo>& comps,
                                       const pmp::FaceProperty<int>& compId) {
        std::vector<char> wrong(comps.size(), 0);
        std::vector<int> candidates;
        for (size_t i = 0; i < comps.size(); ++i) {
            const auto& c = comps[i];
            if (c.hasBoundary || c.signedVolume >= 0.0) continue;
            const double diag = static_cast<double>(pmp::norm(c.bbMax - c.bbMin));
            if (!(diag > 0) || c.area <= 0.0) continue;
            // Mean enclosed thickness must be more than 1e-6 of the size.
            if (std::fabs(c.signedVolume) / c.area <= 1e-6 * diag) continue;
            candidates.push_back(static_cast<int>(i));
        }
        if (candidates.empty()) return wrong;

        // Faces of every closed component, for the parity test.
        std::vector<pmp::Face> closedFaces;
        std::vector<char> isClosed(comps.size(), 0);
        for (size_t i = 0; i < comps.size(); ++i) isClosed[i] = comps[i].hasBoundary ? 0 : 1;
        for (auto f : mesh_.faces()) if (isClosed[compId[f]]) closedFaces.push_back(f);

        const pmp::Point dir(0.5773502692, 0.5885, 0.5658);  // no axis-aligned coincidences
        for (int i : candidates) {
            const auto& c = comps[i];
            if (!c.seed.is_valid()) { wrong[i] = 1; continue; }
            const pmp::Point o = mesh_.position(c.seed);
            // Only components whose box contains the start can enclose it.
            std::vector<char> relevant(comps.size(), 0);
            bool any = false;
            for (size_t j = 0; j < comps.size(); ++j) {
                if (static_cast<int>(j) == i || !isClosed[j]) continue;
                const auto& b = comps[j];
                if (o[0] >= b.bbMin[0] && o[0] <= b.bbMax[0] && o[1] >= b.bbMin[1] && o[1] <= b.bbMax[1] &&
                    o[2] >= b.bbMin[2] && o[2] <= b.bbMax[2]) { relevant[j] = 1; any = true; }
            }
            int hits = 0;
            if (any) {
                for (auto f : closedFaces) {
                    if (!relevant[compId[f]]) continue;
                    std::vector<pmp::Point> fp;
                    int ringGuard = 0;
                    for (auto v : mesh_.vertices(f)) { if (++ringGuard > 4096) break; fp.push_back(mesh_.position(v)); }
                    for (size_t k = 1; k + 1 < fp.size(); ++k) {
                        double t;
                        if (rayHitsTriangle(o, dir, fp[0], fp[k], fp[k + 1], t)) ++hits;
                    }
                }
            }
            wrong[i] = (hits % 2 == 0) ? 1 : 0;  // odd = inside something = a cavity
        }
        return wrong;
    }

    // Which vertices are non-manifold. PMP's is_manifold(v) counts the
    // boundary halfedges met while circling v from halfedge(v) — but circling
    // only visits the fan that halfedge(v) belongs to. A vertex where two
    // sheets touch at a point can have a second fan the rotation never
    // reaches: every PMP circulator, is_manifold() included, then reports the
    // vertex as an ordinary manifold one. That hidden fan is what left a
    // boundary loop passing through one vertex twice (Thingiverse 197005) and
    // what made a collapse beside it leave live halfedges pointing at the
    // removed vertex (1344061, 697602, 73177). The test that sees it is
    // global: count the halfedges into each vertex over the whole mesh and
    // compare with how many one rotation reaches.
    std::vector<char> nonManifoldVertexMask() {
        const size_t nv = mesh_.vertices_size();
        std::vector<int> incoming(nv, 0);
        for (auto h : mesh_.halfedges()) {
            auto v = mesh_.to_vertex(h);
            if (v.is_valid() && static_cast<size_t>(v.idx()) < nv) ++incoming[v.idx()];
        }
        std::vector<char> mask(nv, 0);
        const size_t cap = mesh_.halfedges_size() + 1;
        for (auto v : mesh_.vertices()) {
            auto h0 = mesh_.halfedge(v);
            if (!h0.is_valid()) continue;
            int reached = 0;
            auto h = h0;
            size_t guard = 0;
            bool closes = true;
            do {
                ++reached;
                h = mesh_.cw_rotated_halfedge(h);
                if (!h.is_valid() || ++guard > cap) { closes = false; break; }
            } while (h != h0);
            if (!closes || reached != incoming[v.idx()] || !mesh_.is_manifold(v)) mask[v.idx()] = 1;
        }
        return mask;
    }

    MeshAnalysis getAnalysis() {
        MeshAnalysis a{};
        if (!loaded_) return a;

        try {
            fillGeometry(a);

            int V = a.vertexCount;
            int E = a.edgeCount;
            int F = a.faceCount;

            // (a) Non-manifold vertices (see nonManifoldVertexMask())
            int nmvCount = 0;
            {
                auto mask = nonManifoldVertexMask();
                for (auto v : mesh_.vertices()) if (mask[v.idx()]) ++nmvCount;
            }
            a.nonManifoldVertexCount = nmvCount;
            a.isManifold = (nmvCount == 0);

            // (b) Non-manifold edges = skipped faces from reader
            a.nonManifoldEdgeCount = skippedFaces_;

            // (c) Watertight, Euler, genus
            a.isWatertight = (a.boundaryEdges == 0);
            a.eulerCharacteristic = V - E + F;

            // (d) Connected components + wrongly wound ones (see
            // analyzeComponents() and orientationWrong())
            int numComponents = 0;
            int flippedCount = 0;
            {
                auto compId = mesh_.add_face_property<int>("f:component", -1);
                auto comps = analyzeComponents(compId);
                auto wrong = orientationWrong(comps, compId);
                mesh_.remove_face_property(compId);
                numComponents = static_cast<int>(comps.size());
                for (size_t i = 0; i < comps.size(); ++i) if (wrong[i]) flippedCount += comps[i].faceCount;
            }

            a.connectedComponents = numComponents;
            a.flippedNormalCount = flippedCount;

            // Genus: only meaningful for closed surfaces
            if (a.isWatertight) {
                a.genus = (2 * numComponents - a.eulerCharacteristic) / 2;
            } else {
                a.genus = -1;
            }

            // (e) Boundary loops
            int loopCount = 0;
            if (a.boundaryEdges > 0) {
                auto visited = mesh_.add_halfedge_property<bool>("h:visited", false);
                const int walkCap = static_cast<int>(mesh_.n_halfedges()) + 1;
                for (auto h : mesh_.halfedges()) {
                    if (mesh_.is_boundary(h) && !visited[h]) {
                        ++loopCount;
                        auto cur = h;
                        int steps = 0;
                        do {
                            visited[cur] = true;
                            cur = mesh_.next_halfedge(cur);
                            if (++steps > walkCap) break;  // broken chain; never spin
                        } while (cur != h);
                    }
                }
                mesh_.remove_halfedge_property(visited);
            }
            a.boundaryLoops = loopCount;
            a.holeCount = loopCount;

            // (f) Degenerate triangles
            int degenCount = 0;
            for (auto f : mesh_.faces()) {
                if (pmp::face_area(mesh_, f) < 1e-10f) {
                    ++degenCount;
                }
            }
            a.degenerateTriangleCount = degenCount;

            // (g) Duplicate faces
            int dupCount = 0;
            {
                std::set<std::vector<pmp::IndexType>> faceSet;
                for (auto f : mesh_.faces()) {
                    std::vector<pmp::IndexType> vids;
                    for (auto v : mesh_.vertices(f)) {
                        vids.push_back(v.idx());
                    }
                    std::sort(vids.begin(), vids.end());
                    auto result = faceSet.insert(vids);
                    if (!result.second) {
                        ++dupCount;
                    }
                }
            }
            a.duplicateFaceCount = dupCount;

            // (h) Isolated vertices
            int isoCount = 0;
            for (auto v : mesh_.vertices()) {
                if (mesh_.is_isolated(v)) {
                    ++isoCount;
                }
            }
            a.isolatedVertexCount = isoCount;

        } catch (const std::exception& e) {
            lastError_ = std::string("Error computing analysis: ") + e.what();
        } catch (...) {
            lastError_ = "Unknown error computing analysis";
        }

        return a;
    }

    WeldResult weldVertices(float epsilon) {
        WeldResult result{};
        if (!loaded_) return result;

        try {
            if (epsilon <= 0.0f) epsilon = 1e-6f;

            int V = static_cast<int>(mesh_.n_vertices());
            int F = static_cast<int>(mesh_.n_faces());
            result.verticesBefore = V;
            result.facesBefore = F;
            result.verticesAfter = V;
            result.facesAfter = F;

            // A closed surface has no gap to close. The only thing welding can
            // do to it is merge two interior vertices that happen to sit
            // within epsilon, which creates a pinch that add_face() then
            // refuses — the faces are dropped and the mesh is torn open
            // (organizer.stl: one merge, six faces lost, watertight → open).
            bool open = false;
            for (auto e : mesh_.edges()) {
                if (mesh_.is_boundary(e)) { open = true; break; }
            }
            if (!open) {
                // The rebuild this replaces reset the import-time skipped-face
                // count (those faces are gone either way); keep that.
                skippedFaces_ = 0;
                return result;
            }

            // Build flat arrays
            std::vector<pmp::Point> positions(V);
            std::vector<int> vertexMap(V);
            for (auto v : mesh_.vertices()) {
                int i = static_cast<int>(v.idx());
                positions[i] = mesh_.position(v);
                vertexMap[i] = i;
            }

            // Spatial hash grid
            float invEps = 1.0f / epsilon;
            std::unordered_map<GridCell, std::vector<int>, GridCellHash> grid;

            for (int i = 0; i < V; ++i) {
                auto& p = positions[i];
                GridCell cell{
                    static_cast<int64_t>(std::floor(p[0] * invEps)),
                    static_cast<int64_t>(std::floor(p[1] * invEps)),
                    static_cast<int64_t>(std::floor(p[2] * invEps))
                };
                grid[cell].push_back(i);
            }

            // For each vertex, check 27 neighbor cells for merge candidates
            for (int i = 0; i < V; ++i) {
                if (vertexMap[i] != i) continue; // already merged

                auto& pi = positions[i];
                GridCell cell{
                    static_cast<int64_t>(std::floor(pi[0] * invEps)),
                    static_cast<int64_t>(std::floor(pi[1] * invEps)),
                    static_cast<int64_t>(std::floor(pi[2] * invEps))
                };

                for (int64_t dx = -1; dx <= 1; ++dx) {
                    for (int64_t dy = -1; dy <= 1; ++dy) {
                        for (int64_t dz = -1; dz <= 1; ++dz) {
                            GridCell neighbor{cell.ix + dx, cell.iy + dy, cell.iz + dz};
                            auto it = grid.find(neighbor);
                            if (it == grid.end()) continue;

                            for (int j : it->second) {
                                if (j <= i) continue;
                                if (vertexMap[j] != j) continue;

                                auto diff = positions[j] - pi;
                                float dist2 = dot(diff, diff);
                                if (dist2 <= epsilon * epsilon) {
                                    vertexMap[j] = i;
                                }
                            }
                        }
                    }
                }
            }

            // Path compression (union-find style)
            for (int i = 0; i < V; ++i) {
                int root = i;
                while (vertexMap[root] != root) root = vertexMap[root];
                vertexMap[i] = root;
            }

            // Rebuild mesh
            pmp::SurfaceMesh newMesh;
            std::vector<pmp::Vertex> newVertexIds(V, pmp::Vertex());
            int uniqueCount = 0;

            for (int i = 0; i < V; ++i) {
                if (vertexMap[i] == i) {
                    newVertexIds[i] = newMesh.add_vertex(positions[i]);
                    ++uniqueCount;
                }
            }

            // Map merged vertices to their canonical new vertex
            for (int i = 0; i < V; ++i) {
                if (vertexMap[i] != i) {
                    newVertexIds[i] = newVertexIds[vertexMap[i]];
                }
            }

            int degenCount = 0;
            int skipCount = 0;
            for (auto f : mesh_.faces()) {
                std::vector<pmp::Vertex> verts;
                for (auto v : mesh_.vertices(f)) {
                    verts.push_back(newVertexIds[static_cast<int>(v.idx())]);
                }

                // Check for degenerate (any two mapped vertices identical)
                bool degenerate = false;
                for (size_t a = 0; a < verts.size() && !degenerate; ++a) {
                    for (size_t b = a + 1; b < verts.size() && !degenerate; ++b) {
                        if (verts[a] == verts[b]) degenerate = true;
                    }
                }
                if (degenerate) {
                    ++degenCount;
                    continue;
                }

                try {
                    newMesh.add_face(verts);
                } catch (...) {
                    ++skipCount;
                }
            }

            mesh_ = std::move(newMesh);
            skippedFaces_ = skipCount;
            auditConnectivity("Welding");

            result.verticesAfter = static_cast<int>(mesh_.n_vertices());
            result.verticesMerged = result.verticesBefore - result.verticesAfter;
            result.facesAfter = static_cast<int>(mesh_.n_faces());
            result.facesRemoved = result.facesBefore - result.facesAfter;
            result.degenerateFaces = degenCount;
            result.skippedFaces = skipCount;

        } catch (const std::exception& e) {
            lastError_ = std::string("Error welding vertices: ") + e.what();
        } catch (...) {
            lastError_ = "Unknown error welding vertices";
        }

        return result;
    }

    // Drop faces that repeat another face's vertex set, by rebuilding the mesh
    // from the survivors. Returns the number dropped; the mesh is untouched
    // when there are none.
    //
    // This used to delete_face() in place and garbage_collect(). On a mesh
    // that is not manifold — which is what a mesh with duplicate or
    // degenerate faces usually is — pmp::delete_face() can leave halfedges
    // pointing at vertices that garbage_collection() then removes. The stale
    // handle traps on the next position read (2 of 217 real Thingiverse
    // models in the 2026-09-23 study, 125 and 2 stale handles). Building a
    // fresh mesh with add_face() cannot produce that state, and it is the
    // path weld and split already take.
    int dropDuplicateFaces() {
        std::map<std::vector<pmp::IndexType>, pmp::Face> firstFace;
        auto drop = mesh_.add_face_property<bool>("f:dropDuplicate", false);
        int dupRemoved = 0;
        for (auto f : mesh_.faces()) {
            std::vector<pmp::IndexType> vids;
            for (auto v : mesh_.vertices(f)) vids.push_back(v.idx());
            std::sort(vids.begin(), vids.end());
            auto ins = firstFace.insert({vids, f});
            if (ins.second) continue;
            drop[f] = true;
            ++dupRemoved;
            // Two copies glued to each other along every edge are a
            // zero-thickness pillow: neither is part of any surface, and
            // keeping one would leave a flap with a 3-edge hole. Drop both.
            auto other = ins.first->second;
            bool pillow = true;
            for (auto h : mesh_.halfedges(f)) {
                auto o = mesh_.opposite_halfedge(h);
                if (mesh_.is_boundary(o) || mesh_.face(o) != other) { pillow = false; break; }
            }
            if (pillow && !drop[other]) { drop[other] = true; ++dupRemoved; }
        }
        if (dupRemoved == 0) {
            mesh_.remove_face_property(drop);
            return 0;
        }

        pmp::SurfaceMesh newMesh;
        std::vector<pmp::Vertex> vmap(mesh_.vertices_size());
        for (auto v : mesh_.vertices()) {
            vmap[v.idx()] = newMesh.add_vertex(mesh_.position(v));
        }
        int skipCount = 0;
        for (auto f : mesh_.faces()) {
            if (drop[f]) continue;
            std::vector<pmp::Vertex> verts;
            for (auto v : mesh_.vertices(f)) verts.push_back(vmap[v.idx()]);
            try {
                newMesh.add_face(verts);
            } catch (...) {
                ++skipCount;
            }
        }
        mesh_.remove_face_property(drop);
        mesh_ = std::move(newMesh);
        skippedFaces_ = skipCount;
        return dupRemoved;
    }

    RemoveDegeneratesResult removeDegenerates(float minArea) {
        RemoveDegeneratesResult result{};
        if (!loaded_) return result;

        try {
            result.facesBefore = static_cast<int>(mesh_.n_faces());
            result.facesAfter = result.facesBefore;

            if (minArea <= 0.0f) minArea = 1e-10f;

            bool rebuilt = false;
            int dupRemoved = dropDuplicateFaces();
            rebuilt = dupRemoved > 0;

            // --- Degenerate faces: collapse or flip, never delete. ---
            //
            // Deleting a zero-area face from a closed mesh opens a hole, and
            // from an open mesh opens more of them (one wild model went from
            // 23 holes to 113 that way). A zero-area triangle is a needle —
            // two vertices almost coincident — or a cap — a vertex sitting on
            // the segment between the other two, which is what a T-junction
            // seam looks like once fillHoles() has sealed it. A needle is
            // removed by collapsing its shortest edge: the two vertices were
            // as good as one. A cap is removed by flipping its longest edge:
            // the middle vertex is handed to the face across, both triangles
            // become real, and nothing moves. Collapsing a cap instead would
            // drag a vertex half an edge along the seam — lamp-mount.stl lost
            // 4% of its volume to one such collapse. When the flip is refused
            // (the new edge already exists), a collapse is allowed only if
            // the move would be invisible: shortest edge under 1e-4 of the
            // model. Whatever neither rule allows is left as it was; a
            // zero-area triangle in a closed mesh is cosmetic, a moved
            // vertex is not.
            //
            // Both PMP operations assume the vertices involved are manifold;
            // a collapse beside a bowtie broke the vertex rotation and the
            // next is_collapse_ok() spun forever (Thingiverse 1344061, 73177,
            // 697602). So a triangle touching a non-manifold vertex is left
            // alone, and each vertex is checked to circle cleanly before any
            // PMP circulator is asked about it.
            int degenRemoved = 0;
            const double tinyMove = 1e-4 * meshDiagonal();
            if (mesh_.is_triangle_mesh()) {
                for (int pass = 0; pass < 3; ++pass) {
                    std::vector<pmp::Face> degenerate;
                    for (auto f : mesh_.faces()) {
                        if (pmp::face_area(mesh_, f) < minArea) degenerate.push_back(f);
                    }
                    if (degenerate.empty()) break;

                    // Vertices PMP's collapse and flip are not safe beside:
                    // see nonManifoldVertexMask(). Recomputed each pass since
                    // every edit changes the neighbourhood.
                    auto unsafe = nonManifoldVertexMask();

                    int fixedThisPass = 0;
                    for (auto f : degenerate) {
                        if (mesh_.is_deleted(f)) continue;
                        if (pmp::face_area(mesh_, f) >= minArea) continue;

                        bool safe = true;
                        for (auto v : mesh_.vertices(f)) {
                            if (unsafe[v.idx()]) { safe = false; break; }
                        }
                        if (!safe) continue;

                        pmp::Halfedge shortest, longest;
                        double smin = std::numeric_limits<double>::max(), smax = -1.0;
                        for (auto h : mesh_.halfedges(f)) {
                            const double len = pmp::distance(mesh_.position(mesh_.from_vertex(h)),
                                                             mesh_.position(mesh_.to_vertex(h)));
                            if (len < smin) { smin = len; shortest = h; }
                            if (len > smax) { smax = len; longest = h; }
                        }
                        if (!shortest.is_valid() || !longest.is_valid()) continue;
                        const bool needle = smin <= 0.1 * smax;

                        auto tryCollapse = [&]() {
                            if (!mesh_.is_collapse_ok(shortest)) return false;
                            // The collapse also rewires the two vertices across
                            // from the edge; they must be safe as well.
                            auto o = mesh_.opposite_halfedge(shortest);
                            if (!mesh_.is_boundary(shortest) && unsafe[mesh_.to_vertex(mesh_.next_halfedge(shortest)).idx()]) return false;
                            if (!mesh_.is_boundary(o) && unsafe[mesh_.to_vertex(mesh_.next_halfedge(o)).idx()]) return false;
                            mesh_.collapse(shortest);
                            return true;
                        };
                        // A cap whose flip is refused (the edge the flip would
                        // create already exists) is resolved without moving
                        // anything: the face across the longest edge is
                        // re-triangulated through the cap's middle vertex, so
                        // both sides of the seam share it, and the cap itself
                        // goes. Preconditions are checked first; if adding
                        // back still fails, the two original faces are
                        // restored, so the mesh is never left short a face.
                        auto tryRetriangulate = [&]() {
                            auto o = mesh_.opposite_halfedge(longest);
                            if (mesh_.is_boundary(o)) return false;
                            auto A = mesh_.from_vertex(longest), B = mesh_.to_vertex(longest);
                            auto M = mesh_.to_vertex(mesh_.next_halfedge(longest));
                            auto D = mesh_.to_vertex(mesh_.next_halfedge(o));
                            if (M == D || unsafe[A.idx()] || unsafe[B.idx()] || unsafe[M.idx()] || unsafe[D.idx()]) return false;
                            if (mesh_.find_halfedge(M, D).is_valid()) return false;
                            auto across = mesh_.face(o);
                            if (!across.is_valid() || mesh_.is_deleted(across)) return false;
                            std::vector<pmp::Vertex> acrossRing;
                            for (auto v : mesh_.vertices(across)) acrossRing.push_back(v);
                            if (acrossRing.size() != 3) return false;
                            std::vector<pmp::Vertex> capRing = {A, M, B};
                            mesh_.delete_face(f);
                            mesh_.delete_face(across);
                            bool ok = false;
                            try {
                                // Across was (B, A, D) in its own winding: keep that
                                // winding for the two halves.
                                mesh_.add_face({B, M, D});
                                mesh_.add_face({M, A, D});
                                ok = true;
                            } catch (...) {}
                            if (!ok) {
                                // Put things back exactly as they were: drop the
                                // half that did get added, restore both originals.
                                try {
                                    auto half = findFace(B, M, D);
                                    if (half.is_valid()) mesh_.delete_face(half);
                                    mesh_.add_face(capRing);
                                    mesh_.add_face(acrossRing);
                                } catch (...) {}
                                return false;
                            }
                            return true;
                        };
                        auto tryFlip = [&]() {
                            auto e = mesh_.edge(longest);
                            if (mesh_.is_boundary(e) || !mesh_.is_flip_ok(e)) return false;
                            // The flipped edge's endpoints must be manifold too.
                            auto o = mesh_.opposite_halfedge(longest);
                            auto a = mesh_.to_vertex(mesh_.next_halfedge(longest));
                            auto b = mesh_.to_vertex(mesh_.next_halfedge(o));
                            if (unsafe[a.idx()] || unsafe[b.idx()]) return false;
                            mesh_.flip(e);
                            return true;
                        };
                        bool fixed;
                        if (needle) fixed = tryCollapse() || tryFlip() || tryRetriangulate();
                        else fixed = tryFlip() || tryRetriangulate() || (smin <= tinyMove && tryCollapse());
                        if (fixed) ++fixedThisPass;
                    }
                    degenRemoved += fixedThisPass;
                    if (fixedThisPass == 0) break;
                }
            }
            result.degenerateRemoved = degenRemoved;

            if (degenRemoved > 0) {
                mesh_.garbage_collection();
                // A collapse can leave two triangles on the same three
                // vertices — a zero-thickness sandwich. Drop those too.
                if (dropDuplicateFaces() > 0) rebuilt = true;
            }

            // Vertices no face uses. Isolated vertices only survive garbage
            // collection if they are marked deleted first.
            int isoCount = 0;
            for (auto v : mesh_.vertices()) {
                if (mesh_.is_isolated(v)) {
                    mesh_.delete_vertex(v);
                    ++isoCount;
                }
            }
            result.isolatedVerticesRemoved = isoCount;
            result.duplicateRemoved = dupRemoved;

            if (!rebuilt) skippedFaces_ = 0;  // as the in-place version did
            if (dupRemoved + degenRemoved + isoCount > 0) {
                mesh_.garbage_collection();
                auditConnectivity("Removing degenerate faces");
            }

            result.facesAfter = static_cast<int>(mesh_.n_faces());

        } catch (const std::exception& e) {
            lastError_ = std::string("Error removing degenerates: ") + e.what();
        } catch (...) {
            lastError_ = "Unknown error removing degenerates";
        }

        return result;
    }

    FixNormalsResult fixNormals() {
        FixNormalsResult result{};
        if (!loaded_) return result;

        try {
            // Phase A/B: components and which ones are wound the wrong way —
            // see analyzeComponents() and orientationWrong(); the analysis
            // reports flippedNormalCount from the same test, so what it
            // reports is what this fixes.
            auto compId = mesh_.add_face_property<int>("f:comp", -1);
            auto components = analyzeComponents(compId);
            const int numComponents = static_cast<int>(components.size());
            result.totalComponents = numComponents;
            auto wrong = orientationWrong(components, compId);
            std::vector<bool> needsFlip(numComponents, false);
            for (int i = 0; i < numComponents; ++i) {
                if (components[i].hasBoundary) {
                    ++result.skippedOpen;
                } else if (wrong[i]) {
                    needsFlip[i] = true;
                    ++result.componentsFlipped;
                    result.facesFlipped += components[i].faceCount;
                }
            }

            // Early return if nothing to flip
            if (result.componentsFlipped == 0) {
                mesh_.remove_face_property(compId);
                return result;
            }

            // Phase C: Rebuild mesh with selective flipping
            pmp::SurfaceMesh newMesh;
            int V = static_cast<int>(mesh_.n_vertices());

            // Copy all vertices
            for (auto v : mesh_.vertices()) {
                newMesh.add_vertex(mesh_.position(v));
            }

            // Add faces, reversing vertex order for flipped components
            int skipCount = 0;
            for (auto f : mesh_.faces()) {
                std::vector<pmp::Vertex> verts;
                for (auto v : mesh_.vertices(f)) {
                    verts.push_back(pmp::Vertex(v.idx()));
                }

                if (needsFlip[compId[f]]) {
                    std::reverse(verts.begin(), verts.end());
                }

                try {
                    newMesh.add_face(verts);
                } catch (...) {
                    ++skipCount;
                }
            }

            mesh_.remove_face_property(compId);
            mesh_ = std::move(newMesh);
            skippedFaces_ = skipCount;
            result.skippedFaces = skipCount;
            auditConnectivity("Fixing normals");

        } catch (const std::exception& e) {
            lastError_ = std::string("Error fixing normals: ") + e.what();
        } catch (...) {
            lastError_ = "Unknown error fixing normals";
        }

        return result;
    }

    // Per-loop measurements as JSON, so a caller can show the user what is
    // about to be filled and what is about to be left alone, and so the
    // thresholds in looksDeliberate() can be set against measurements rather
    // than intuition. Shape mirrors LoopShape.
    std::string describeHoles() {
        if (!loaded_) return "[]";
        std::string out = "[";
        bool first = true;
        try {
            auto loops = collectBoundaryLoops();
            const double diag = meshDiagonal();
            const int loopCount = static_cast<int>(loops.size());
            for (auto& loopVerts : loops) {
                if (loopVerts.size() < 3) continue;
                const LoopShape s = measureLoopWithDepth(loopVerts, diag);
                if (!first) out += ",";
                first = false;
                out += "{\"edges\":" + std::to_string(s.edges) +
                       ",\"diameter\":" + std::to_string(s.diameter) +
                       ",\"planarDeviation\":" + std::to_string(s.planarDeviation) +
                       ",\"radiusVariation\":" + std::to_string(s.radiusVariation) +
                       ",\"edgeVariation\":" + std::to_string(s.edgeVariation) +
                       ",\"shellDepth\":" + std::to_string(s.shellDepth) +
                       ",\"shellThickness\":" + std::to_string(s.shellThickness) +
                       ",\"looksDeliberate\":" + (looksDeliberate(s, diag, loopCount) ? "true" : "false") + "}";
            }
        } catch (...) {
            return "[]";
        }
        return out + "]";
    }

    // Triangulate one simple boundary loop (no vertex repeated) and add the
    // triangles. Returns the number of faces added; sets `anyFailed` if any
    // triangle was refused.
    //
    // Minimum-weight triangulation (see minWeightTriangulation()) for loops
    // up to 200 edges, a fan from the first vertex above that where the
    // O(n^3) programme would be felt. PMP's fill_hole() is not used: its
    // Delaunay refinement + fairing can trap on the boundaries of damaged
    // meshes. A triangle with a repeated vertex is never handed to
    // add_face(): PMP does not reject it and it corrupts the mesh (see
    // fillHolesEx()).
    // The face on exactly the vertices {a, b, c}, if one exists.
    pmp::Face findFace(pmp::Vertex a, pmp::Vertex b, pmp::Vertex c) const {
        for (auto h : {mesh_.find_halfedge(a, b), mesh_.find_halfedge(b, a)}) {
            if (!h.is_valid() || mesh_.is_boundary(h)) continue;
            auto f = mesh_.face(h);
            int n = 0;
            bool hasC = false;
            for (auto v : mesh_.vertices(f)) { ++n; if (v == c) hasC = true; }
            if (n == 3 && hasC) return f;
        }
        return pmp::Face();
    }
    bool faceExists(pmp::Vertex a, pmp::Vertex b, pmp::Vertex c) const { return findFace(a, b, c).is_valid(); }

    // A triangle none of whose edges is shared with another face: a lone flap
    // that is its own component. Its only "hole" is itself; it is junk.
    bool isIsolatedFlap(pmp::Face f) const {
        int n = 0;
        for (auto h : mesh_.halfedges(f)) {
            ++n;
            if (!mesh_.is_boundary(mesh_.opposite_halfedge(h))) return false;
        }
        return n == 3;
    }
    std::vector<pmp::Face> flapsToDrop_;

    int fillSimpleLoop(const std::vector<pmp::Vertex>& lv, bool& anyFailed) {
        int facesAdded = 0;
        std::vector<std::array<int, 3>> tris;
        if (lv.size() <= 200) {
            tris = minWeightTriangulation(mesh_, lv);
        } else {
            for (size_t i = 1; i + 1 < lv.size(); ++i) {
                tris.push_back({0, static_cast<int>(i), static_cast<int>(i + 1)});
            }
        }
        for (const auto& t : tris) {
            std::vector<pmp::Vertex> tri = {lv[t[0]], lv[t[1]], lv[t[2]]};
            if (tri[0] == tri[1] || tri[1] == tri[2] || tri[0] == tri[2]) {
                anyFailed = true;
                continue;
            }
            // A 3-edge loop around a lone flap: the "fill" would be the same
            // triangle again, wound the other way — a zero-thickness sandwich
            // that the analysis then reports as a duplicate face. Not a repair.
            // If the flap is a component of its own, it goes instead.
            auto existing = findFace(tri[0], tri[1], tri[2]);
            if (existing.is_valid()) {
                if (isIsolatedFlap(existing)) flapsToDrop_.push_back(existing);
                anyFailed = true;
                continue;
            }
            try {
                mesh_.add_face(tri);
                ++facesAdded;
            } catch (...) {
                anyFailed = true;
            }
        }
        return facesAdded;
    }

    FillHolesResult fillHoles(int maxEdges) { return fillHolesEx(maxEdges, false); }

    // fillFeatures=true overrides the deliberate-geometry test, for a caller
    // that has shown the user what was left behind and been told to fill it.
    FillHolesResult fillHolesEx(int maxEdges, bool fillFeatures) {
        FillHolesResult result{};
        if (!loaded_) return result;
        flapsToDrop_.clear();

        try {
            if (maxEdges <= 0) maxEdges = 100;

            int facesBefore = static_cast<int>(mesh_.n_faces());

            // Find all boundary loops
            struct LoopInfo {
                pmp::Halfedge start;
                int edgeCount;
            };
            std::vector<LoopInfo> loops;

            int maxHalfedges = static_cast<int>(mesh_.n_halfedges());
            auto visited = mesh_.add_halfedge_property<bool>("h:loopVisited", false);
            for (auto h : mesh_.halfedges()) {
                if (mesh_.is_boundary(h) && !visited[h]) {
                    LoopInfo loop;
                    loop.start = h;
                    loop.edgeCount = 0;
                    bool valid = true;
                    auto cur = h;
                    do {
                        visited[cur] = true;
                        ++loop.edgeCount;
                        if (loop.edgeCount > maxHalfedges) {
                            // Corrupted loop — bail out
                            valid = false;
                            break;
                        }
                        cur = mesh_.next_halfedge(cur);
                    } while (cur != h);
                    if (valid) {
                        loops.push_back(loop);
                    }
                }
            }
            mesh_.remove_halfedge_property(visited);

            result.holesFound = static_cast<int>(loops.size());

            // Measured once against the mesh as loaded: filling changes the
            // loop count, and every loop must be judged against the same scale.
            const double meshDiag = meshDiagonal();
            const int loopCount = static_cast<int>(loops.size());

            // Fill each loop
            for (auto& loop : loops) {
                // Safety: check if halfedge is still a boundary after previous fills
                if (!mesh_.is_boundary(loop.start)) {
                    continue;
                }

                if (loop.edgeCount > maxEdges) {
                    ++result.holesSkipped;
                    continue;
                }

                // Validate the boundary loop before filling — walk it again
                // and check that all vertices/faces around it are valid
                bool loopValid = true;
                {
                    auto cur = loop.start;
                    int count = 0;
                    do {
                        auto v = mesh_.to_vertex(cur);
                        if (!v.is_valid() || v.idx() >= static_cast<int>(mesh_.n_vertices())) {
                            loopValid = false;
                            break;
                        }
                        ++count;
                        if (count > loop.edgeCount + 1) {
                            loopValid = false;
                            break;
                        }
                        cur = mesh_.next_halfedge(cur);
                    } while (cur != loop.start);
                }
                if (!loopValid) {
                    ++result.holesFailed;
                    continue;
                }

                // Collect boundary loop vertices
                std::vector<pmp::Vertex> loopVerts;
                {
                    auto cur = loop.start;
                    do {
                        loopVerts.push_back(mesh_.to_vertex(cur));
                        cur = mesh_.next_halfedge(cur);
                    } while (cur != loop.start);
                }

                if (loopVerts.size() < 3) {
                    ++result.holesFailed;
                    continue;
                }

                // A boundary loop can pass through the same vertex twice: two
                // holes pinched together at a vertex whose second fan PMP's
                // rotation never reaches, so is_manifold() calls it manifold
                // and splitVertices() leaves it. A fan across such a loop
                // eventually asks add_face() for (v, w, v). PMP accepts that
                // without throwing and links a face whose ring never closes —
                // the next face circulator then spins forever (Thingiverse
                // 197005; the 300s repair timeout). Filling is done per simple
                // sub-loop instead, and fillSimpleLoop() refuses any triangle
                // with a repeated vertex.
                std::vector<std::vector<pmp::Vertex>> simpleLoops;
                splitPinchedLoop(loopVerts, simpleLoops);
                if (simpleLoops.empty()) {
                    ++result.holesFailed;
                    continue;
                }

                // Leave deliberate geometry alone unless told otherwise. See
                // looksDeliberate() for why the test is one-sided.
                if (!fillFeatures) {
                    if (looksDeliberate(measureLoopWithDepth(loopVerts, meshDiag), meshDiag, loopCount)) {
                        ++result.holesSkippedAsFeature;
                        continue;
                    }
                }

                int facesAdded = 0;
                bool anyFailed = false;
                for (auto& sub : simpleLoops) {
                    facesAdded += fillSimpleLoop(sub, anyFailed);
                }

                if (facesAdded > 0) {
                    ++result.holesFilled;
                } else {
                    ++result.holesFailed;
                }
            }

            // Lone flaps found above: delete_face() on a triangle with no
            // neighbours touches nothing else, and garbage collection then
            // compacts. Done after the loop because the loops above hold
            // halfedge handles that compaction would move.
            if (!flapsToDrop_.empty()) {
                for (auto f : flapsToDrop_) {
                    if (!mesh_.is_deleted(f) && isIsolatedFlap(f)) {
                        mesh_.delete_face(f);
                        ++result.flapsRemoved;
                    }
                }
                flapsToDrop_.clear();
                for (auto v : mesh_.vertices()) if (mesh_.is_isolated(v)) mesh_.delete_vertex(v);
                mesh_.garbage_collection();
            }

            auditConnectivity("Filling holes");
            result.facesAdded = static_cast<int>(mesh_.n_faces()) - facesBefore;

        } catch (const std::exception& e) {
            lastError_ = std::string("Error filling holes: ") + e.what();
        } catch (...) {
            lastError_ = "Unknown error filling holes";
        }

        return result;
    }

    SplitVerticesResult splitVertices() {
        SplitVerticesResult result{};
        if (!loaded_) return result;

        try {
            int V = static_cast<int>(mesh_.n_vertices());
            int F = static_cast<int>(mesh_.n_faces());
            result.verticesBefore = V;
            result.facesBefore = F;

            // Phase A: Find non-manifold vertices — PMP's test plus the
            // hidden-fan test, see nonManifoldVertexMask().
            std::vector<pmp::Vertex> nmVerts;
            {
                auto mask = nonManifoldVertexMask();
                for (auto v : mesh_.vertices()) {
                    if (mask[v.idx()]) nmVerts.push_back(v);
                }
            }

            result.nonManifoldVerticesFound = static_cast<int>(nmVerts.size());

            if (nmVerts.empty()) {
                result.verticesAfter = V;
                result.facesAfter = F;
                return result;
            }

            // Copy all vertex positions into a growable vector
            std::vector<pmp::Point> positions(V);
            for (auto v : mesh_.vertices()) {
                positions[v.idx()] = mesh_.position(v);
            }

            // faceVertexRemap[face_idx][original_vertex_idx] = new_vertex_idx
            std::unordered_map<pmp::IndexType, std::unordered_map<pmp::IndexType, int>> faceVertexRemap;

            // Every halfedge into a flagged vertex, gathered in one pass so
            // that fans a rotation cannot reach are included.
            std::unordered_map<pmp::IndexType, std::vector<pmp::Halfedge>> incomingAt;
            {
                std::vector<char> flagged(mesh_.vertices_size(), 0);
                for (auto v : nmVerts) flagged[v.idx()] = 1;
                for (auto h : mesh_.halfedges()) {
                    auto v = mesh_.to_vertex(h);
                    if (flagged[v.idx()]) incomingAt[v.idx()].push_back(h);
                }
            }

            // Phase A2: fan identification. Two faces at v belong to the same
            // fan when they share an edge at v; the fans are the connected
            // classes of that relation. This does not depend on walking the
            // rotation, so it sees every fan.
            for (auto v : nmVerts) {
                auto& incoming = incomingAt[v.idx()];
                std::vector<pmp::Face> faces;
                std::unordered_map<pmp::IndexType, int> faceSlot;
                for (auto h : incoming) {
                    if (mesh_.is_boundary(h)) continue;
                    auto f = mesh_.face(h);
                    if (!faceSlot.count(f.idx())) { faceSlot[f.idx()] = static_cast<int>(faces.size()); faces.push_back(f); }
                }
                if (faces.size() < 2) continue;

                std::vector<int> parent(faces.size());
                for (size_t i = 0; i < parent.size(); ++i) parent[i] = static_cast<int>(i);
                auto find = [&](int x) { while (parent[x] != x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
                for (auto h : incoming) {
                    auto o = mesh_.opposite_halfedge(h);
                    if (mesh_.is_boundary(h) || mesh_.is_boundary(o)) continue;
                    int a = find(faceSlot[mesh_.face(h).idx()]);
                    int b = find(faceSlot[mesh_.face(o).idx()]);
                    if (a != b) parent[a] = b;
                }

                std::unordered_map<int, std::vector<pmp::Face>> byRoot;
                for (size_t i = 0; i < faces.size(); ++i) byRoot[find(static_cast<int>(i))].push_back(faces[i]);
                std::vector<std::vector<pmp::Face>> fans;
                for (auto& kv : byRoot) fans.push_back(std::move(kv.second));

                // Guard: if fewer than 2 fans, skip (defensive)
                if (fans.size() < 2) continue;

                // Fan 0 keeps original vertex index
                // Fans 1+ each get a new vertex at same position
                pmp::IndexType origIdx = v.idx();
                for (size_t fi = 1; fi < fans.size(); ++fi) {
                    int newIdx = static_cast<int>(positions.size());
                    positions.push_back(mesh_.position(v));
                    for (auto face : fans[fi]) {
                        faceVertexRemap[face.idx()][origIdx] = newIdx;
                    }
                }
            }

            // Phase B: Mesh rebuild
            pmp::SurfaceMesh newMesh;

            // Add all vertices (original + duplicates)
            for (size_t i = 0; i < positions.size(); ++i) {
                newMesh.add_vertex(positions[i]);
            }

            // Add faces with remapping
            int skipCount = 0;
            for (auto f : mesh_.faces()) {
                std::vector<pmp::Vertex> verts;
                auto remapIt = faceVertexRemap.find(f.idx());

                for (auto v : mesh_.vertices(f)) {
                    int idx = static_cast<int>(v.idx());
                    if (remapIt != faceVertexRemap.end()) {
                        auto vRemap = remapIt->second.find(v.idx());
                        if (vRemap != remapIt->second.end()) {
                            idx = vRemap->second;
                        }
                    }
                    verts.push_back(pmp::Vertex(idx));
                }

                try {
                    newMesh.add_face(verts);
                } catch (...) {
                    ++skipCount;
                }
            }

            mesh_ = std::move(newMesh);
            skippedFaces_ = skipCount;
            auditConnectivity("Splitting vertices");

            result.verticesAfter = static_cast<int>(mesh_.n_vertices());
            result.verticesAdded = result.verticesAfter - result.verticesBefore;
            result.facesAfter = static_cast<int>(mesh_.n_faces());
            result.skippedFaces = skipCount;

        } catch (const std::exception& e) {
            lastError_ = std::string("Error splitting vertices: ") + e.what();
        } catch (...) {
            lastError_ = "Unknown error splitting vertices";
        }

        return result;
    }

    RepairResult repair(float weldEpsilon, float minArea, int maxHoleEdges) {
        RepairResult result{};
        if (!loaded_) return result;

        result.verticesBefore = static_cast<int>(mesh_.n_vertices());
        result.facesBefore = static_cast<int>(mesh_.n_faces());

        std::string warnings;

        // Order: weld → split → fill → removeDegenerates → fixNormals.
        // Degenerates go after the fill so the zero-area triangles a slit
        // seam is sealed with get collapsed (that is the T-junction stitch),
        // and fixNormals last so newly closed components get oriented.
        try { result.weld = weldVertices(weldEpsilon); }
        catch (const std::exception& e) { warnings += "weld: " + std::string(e.what()) + "; "; }
        catch (...) { warnings += "weld: unknown error; "; }

        try { result.splitVertices = splitVertices(); }
        catch (const std::exception& e) { warnings += "splitVertices: " + std::string(e.what()) + "; "; }
        catch (...) { warnings += "splitVertices: unknown error; "; }

        try { result.fillHoles = fillHoles(maxHoleEdges); }
        catch (const std::exception& e) { warnings += "fillHoles: " + std::string(e.what()) + "; "; }
        catch (...) { warnings += "fillHoles: unknown error; "; }

        try { result.removeDegenerates = removeDegenerates(minArea); }
        catch (const std::exception& e) { warnings += "removeDegenerates: " + std::string(e.what()) + "; "; }
        catch (...) { warnings += "removeDegenerates: unknown error; "; }

        try { result.fixNormals = fixNormals(); }
        catch (const std::exception& e) { warnings += "fixNormals: " + std::string(e.what()) + "; "; }
        catch (...) { warnings += "fixNormals: unknown error; "; }

        result.verticesAfter = static_cast<int>(mesh_.n_vertices());
        result.facesAfter = static_cast<int>(mesh_.n_faces());

        if (!warnings.empty()) {
            lastError_ = "Repair completed with errors: " + warnings;
        }

        return result;
    }

    bool exportMesh(const std::string& path) {
        if (!loaded_) {
            lastError_ = "No mesh loaded";
            return false;
        }
        try {
            // PLY handled by happly
            auto dot = path.rfind('.');
            std::string ext = (dot != std::string::npos) ? path.substr(dot) : "";
            std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);
            if (ext == ".ply") {
                write_ply_binary(mesh_, path);
                return true;
            }
            pmp::IOFlags flags;
            // STL requires face normals and binary for compact output
            if (ext == ".stl") {
                pmp::face_normals(mesh_);
                flags.use_binary = true;
            }
            pmp::write(mesh_, path, flags);
            return true;
        } catch (const std::exception& e) {
            lastError_ = e.what();
            return false;
        } catch (...) {
            lastError_ = "Unknown error exporting mesh";
            return false;
        }
    }

    bool scale(double factor) {
        if (!loaded_) {
            lastError_ = "No mesh loaded";
            return false;
        }
        if (factor <= 0.0) {
            lastError_ = "Scale factor must be positive";
            return false;
        }
        try {
            for (auto v : mesh_.vertices()) {
                auto& p = mesh_.position(v);
                p[0] = static_cast<pmp::Scalar>(p[0] * factor);
                p[1] = static_cast<pmp::Scalar>(p[1] * factor);
                p[2] = static_cast<pmp::Scalar>(p[2] * factor);
            }
            return true;
        } catch (const std::exception& e) {
            lastError_ = e.what();
            return false;
        } catch (...) {
            lastError_ = "Unknown error scaling mesh";
            return false;
        }
    }

    DecimateResult decimate(int targetVertices, double aspectRatio,
                            double normalDeviation, double hausdorffError) {
        DecimateResult result{false, 0, 0, 0, 0, 0};
        if (!loaded_) {
            lastError_ = "No mesh loaded";
            return result;
        }
        if (targetVertices < 4) {
            lastError_ = "Target vertex count must be at least 4";
            return result;
        }
        try {
            // Auto-triangulate quads (e.g. OBJ/OFF imports, pmp::torus())
            if (!mesh_.is_triangle_mesh()) {
                pmp::triangulate(mesh_);
            }
            result.verticesBefore = static_cast<int>(mesh_.n_vertices());
            result.facesBefore = static_cast<int>(mesh_.n_faces());

            // No-op short-circuit: already at or below target
            if (targetVertices >= result.verticesBefore) {
                result.verticesAfter = result.verticesBefore;
                result.facesAfter = result.facesBefore;
                result.success = true;
                return result;
            }

            pmp::decimate(mesh_,
                          static_cast<unsigned int>(targetVertices),
                          static_cast<pmp::Scalar>(aspectRatio),
                          /*edge_length=*/0,
                          /*max_valence=*/0,
                          static_cast<pmp::Scalar>(normalDeviation),
                          static_cast<pmp::Scalar>(hausdorffError));

            // pmp::decimate() returns normally on meshes it has corrupted, so
            // its return is not evidence the mesh is usable. Check before any
            // caller traverses it — getAnalysis(), writeRenderData() and the
            // exporters all read vertex positions and would trap.
            if (!connectivityIsValid(mesh_)) {
                int dropped = rebuildFromValidFaces(mesh_);
                if (dropped < 0) {
                    // Unsalvageable. Drop the mesh rather than leave a live
                    // handle to something that traps on the next traversal.
                    mesh_ = pmp::SurfaceMesh();
                    loaded_ = false;
                    lastError_ =
                        "Simplification produced an invalid mesh and it could not be recovered. "
                        "Please load the file again and try a less aggressive amount.";
                    return result;
                }
                result.facesDropped = dropped;
            }

            result.verticesAfter = static_cast<int>(mesh_.n_vertices());
            result.facesAfter = static_cast<int>(mesh_.n_faces());
            result.success = true;
            return result;
        } catch (const std::exception& e) {
            lastError_ = e.what();
            return result;
        } catch (...) {
            lastError_ = "Unknown error during decimation";
            return result;
        }
    }

    bool writeRenderData(const std::string& path) {
        if (!loaded_) {
            lastError_ = "No mesh loaded";
            return false;
        }
        try {
            // Compute vertex normals
            pmp::vertex_normals(mesh_);
            auto vnormals = mesh_.get_vertex_property<pmp::Normal>("v:normal");

            uint32_t nV = static_cast<uint32_t>(mesh_.n_vertices());
            uint32_t nF = static_cast<uint32_t>(mesh_.n_faces());
            uint32_t indexCount = nF * 3;

            // Buffer: header (2 × uint32) + positions (nV×3 × float) + normals (nV×3 × float)
            //       + indices (indexCount × uint32) + faceFlags (nF × uint8)
            size_t bufSize = 8 + nV * 3 * 4 + nV * 3 * 4 + indexCount * 4 + nF;
            std::vector<uint8_t> buf(bufSize);
            uint8_t* ptr = buf.data();

            // Header
            std::memcpy(ptr, &nV, 4); ptr += 4;
            std::memcpy(ptr, &indexCount, 4); ptr += 4;

            // Positions
            for (auto v : mesh_.vertices()) {
                auto p = mesh_.position(v);
                float x = p[0], y = p[1], z = p[2];
                std::memcpy(ptr, &x, 4); ptr += 4;
                std::memcpy(ptr, &y, 4); ptr += 4;
                std::memcpy(ptr, &z, 4); ptr += 4;
            }

            // Normals
            for (auto v : mesh_.vertices()) {
                pmp::Normal n(0, 0, 1);
                if (vnormals) n = vnormals[v];
                float nx = n[0], ny = n[1], nz = n[2];
                std::memcpy(ptr, &nx, 4); ptr += 4;
                std::memcpy(ptr, &ny, 4); ptr += 4;
                std::memcpy(ptr, &nz, 4); ptr += 4;
            }

            // Indices (3 per face, triangle mesh assumed)
            for (auto f : mesh_.faces()) {
                for (auto v : mesh_.vertices(f)) {
                    uint32_t idx = static_cast<uint32_t>(v.idx());
                    std::memcpy(ptr, &idx, 4); ptr += 4;
                }
            }

            // --- Per-face flags ---
            // Build duplicate face set
            std::set<std::vector<pmp::IndexType>> faceSet;
            std::vector<bool> isDuplicate(nF, false);
            {
                size_t fi = 0;
                for (auto f : mesh_.faces()) {
                    std::vector<pmp::IndexType> vids;
                    for (auto v : mesh_.vertices(f)) {
                        vids.push_back(v.idx());
                    }
                    std::sort(vids.begin(), vids.end());
                    if (!faceSet.insert(vids).second) {
                        isDuplicate[fi] = true;
                    }
                    ++fi;
                }
            }

            // BFS for connected components + signed volume (for flipped detection)
            auto compId = mesh_.add_face_property<int>("f:rendercomp", -1);
            std::vector<bool> compFlipped;
            {
                int numComp = 0;
                for (auto f : mesh_.faces()) {
                    if (compId[f] >= 0) continue;
                    int cid = numComp++;
                    compFlipped.push_back(false);

                    std::queue<pmp::Face> q;
                    q.push(f);
                    compId[f] = cid;
                    double compVolume = 0.0;
                    bool compHasBoundary = false;

                    while (!q.empty()) {
                        auto cur = q.front(); q.pop();

                        auto verts = mesh_.vertices(cur);
                        auto vit = verts.begin();
                        auto vend = verts.end();
                        if (vit != vend) {
                            auto p0 = mesh_.position(*vit); ++vit;
                            if (vit != vend) {
                                auto pPrev = mesh_.position(*vit); ++vit;
                                for (int ringGuard = 0; vit != vend && ringGuard < 4096; ++ringGuard) {  // capped: a broken ring must not spin
                                    auto pCur = mesh_.position(*vit); ++vit;
                                    compVolume += static_cast<double>(dot(p0, cross(pPrev, pCur))) / 6.0;
                                    pPrev = pCur;
                                }
                            }
                        }

                        for (auto h : mesh_.halfedges(cur)) {
                            if (mesh_.is_boundary(mesh_.edge(h))) {
                                compHasBoundary = true;
                            }
                            auto opp = mesh_.opposite_halfedge(h);
                            if (mesh_.is_boundary(opp)) continue;
                            auto neighbor = mesh_.face(opp);
                            if (compId[neighbor] < 0) {
                                compId[neighbor] = cid;
                                q.push(neighbor);
                            }
                        }
                    }

                    if (!compHasBoundary && compVolume < 0.0) {
                        compFlipped[cid] = true;
                    }
                }
            }

            // Write per-face flag bytes
            {
                size_t fi = 0;
                for (auto f : mesh_.faces()) {
                    uint8_t flags = 0;

                    // 0x01 = degenerate
                    if (pmp::face_area(mesh_, f) < 1e-10f) {
                        flags |= 0x01;
                    }

                    // 0x02 = duplicate
                    if (isDuplicate[fi]) {
                        flags |= 0x02;
                    }

                    // 0x04 = flipped normal (closed component with negative volume)
                    int cid = compId[f];
                    if (cid >= 0 && static_cast<size_t>(cid) < compFlipped.size() && compFlipped[cid]) {
                        flags |= 0x04;
                    }

                    // 0x08 = boundary face (has at least one boundary edge)
                    for (auto h : mesh_.halfedges(f)) {
                        if (mesh_.is_boundary(mesh_.edge(h))) {
                            flags |= 0x08;
                            break;
                        }
                    }

                    // 0x10 = non-manifold adjacent (face touches a non-manifold vertex)
                    for (auto v : mesh_.vertices(f)) {
                        if (!mesh_.is_manifold(v)) {
                            flags |= 0x10;
                            break;
                        }
                    }

                    *ptr = flags;
                    ++ptr;
                    ++fi;
                }
            }

            mesh_.remove_face_property(compId);

            // Write to file
            FILE* fp = std::fopen(path.c_str(), "wb");
            if (!fp) {
                lastError_ = "Failed to open file for writing: " + path;
                return false;
            }
            std::fwrite(buf.data(), 1, bufSize, fp);
            std::fclose(fp);
            return true;

        } catch (const std::exception& e) {
            lastError_ = std::string("Error writing render data: ") + e.what();
            return false;
        } catch (...) {
            lastError_ = "Unknown error writing render data";
            return false;
        }
    }

    int getVertexCount() const { return loaded_ ? static_cast<int>(mesh_.n_vertices()) : 0; }
    int getFaceCount() const { return loaded_ ? static_cast<int>(mesh_.n_faces()) : 0; }
    bool isLoaded() const { return loaded_; }
    std::string getLastError() const { return lastError_; }

    // How many times a repair operation left the half-edge structure invalid
    // and the mesh had to be rebuilt from its valid faces since the last load.
    // Zero on every mesh the operations handle correctly; a non-zero value is
    // a bug report waiting to be filed, not a normal outcome.
    int connectivityRebuilds() const { return connectivityRebuilds_; }
    // Faces lost to those rebuilds.
    int facesDroppedByAudit() const { return facesDroppedByAudit_; }

private:
    void fillGeometry(MeshAnalysis& a) {
        a.vertexCount = static_cast<int>(mesh_.n_vertices());
        a.faceCount = static_cast<int>(mesh_.n_faces());
        a.edgeCount = static_cast<int>(mesh_.n_edges());
        a.isTriangleMesh = mesh_.is_triangle_mesh();
        a.skippedFaces = skippedFaces_;

        // Bounding box
        pmp::Point bbMin(std::numeric_limits<float>::max(),
                         std::numeric_limits<float>::max(),
                         std::numeric_limits<float>::max());
        pmp::Point bbMax(std::numeric_limits<float>::lowest(),
                         std::numeric_limits<float>::lowest(),
                         std::numeric_limits<float>::lowest());

        for (auto v : mesh_.vertices()) {
            auto p = mesh_.position(v);
            for (int i = 0; i < 3; ++i) {
                bbMin[i] = std::min(bbMin[i], p[i]);
                bbMax[i] = std::max(bbMax[i], p[i]);
            }
        }

        a.bboxMinX = bbMin[0]; a.bboxMinY = bbMin[1]; a.bboxMinZ = bbMin[2];
        a.bboxMaxX = bbMax[0]; a.bboxMaxY = bbMax[1]; a.bboxMaxZ = bbMax[2];
        a.dimX = bbMax[0] - bbMin[0];
        a.dimY = bbMax[1] - bbMin[1];
        a.dimZ = bbMax[2] - bbMin[2];

        // Surface area and volume
        float totalArea = 0.0f;
        double totalVolume = 0.0;
        for (auto f : mesh_.faces()) {
            auto vertices = mesh_.vertices(f);
            auto vit = vertices.begin();
            auto end = vertices.end();
            if (vit == end) continue;
            auto p0 = mesh_.position(*vit); ++vit;
            if (vit == end) continue;
            auto pPrev = mesh_.position(*vit); ++vit;

            for (int ringGuard = 0; vit != end && ringGuard < 4096; ++ringGuard) {  // capped: a broken ring must not spin
                auto pCur = mesh_.position(*vit); ++vit;
                auto e1 = pPrev - p0;
                auto e2 = pCur - p0;
                auto crossProduct = cross(e1, e2);
                totalArea += norm(crossProduct) * 0.5f;
                totalVolume += static_cast<double>(dot(p0, cross(pPrev, pCur))) / 6.0;
                pPrev = pCur;
            }
        }
        a.surfaceArea = totalArea;
        a.volume = static_cast<float>(std::abs(totalVolume));

        // Boundary edges
        int boundary = 0;
        for (auto e : mesh_.edges()) {
            if (mesh_.is_boundary(e)) {
                ++boundary;
            }
        }
        a.boundaryEdges = boundary;
    }

    pmp::SurfaceMesh mesh_;
    bool loaded_;
    std::string lastError_;
    int skippedFaces_;
    bool colorsDropped_;
    int nonFiniteFaces_ = 0;
    int connectivityRebuilds_ = 0;
    int facesDroppedByAudit_ = 0;

    // Run after every operation that edits the mesh. If the half-edge
    // structure is broken, rebuild from the valid faces so that the next
    // traversal — which may be the caller's very next call — cannot spin or
    // trap. Returns false only when even the rebuild fails, in which case the
    // mesh is dropped and lastError_ says so.
    bool auditConnectivity(const char* op) {
        if (connectivityIsValid(mesh_)) return true;
        ++connectivityRebuilds_;
        int dropped = rebuildFromValidFaces(mesh_);
        if (dropped < 0) {
            mesh_ = pmp::SurfaceMesh();
            loaded_ = false;
            lastError_ = std::string(op) +
                " produced an invalid mesh and it could not be recovered. Please load the file again.";
            return false;
        }
        facesDroppedByAudit_ += dropped;
        return true;
    }

    // Bounding-box diagonal of the whole model — the scale a boundary loop is
    // judged against in looksDeliberate().
    double meshDiagonal() {
        if (mesh_.n_vertices() == 0) return 0.0;
        pmp::Point lo(std::numeric_limits<float>::max(),
                      std::numeric_limits<float>::max(),
                      std::numeric_limits<float>::max());
        pmp::Point hi(std::numeric_limits<float>::lowest(),
                      std::numeric_limits<float>::lowest(),
                      std::numeric_limits<float>::lowest());
        for (auto v : mesh_.vertices()) {
            const auto& p = mesh_.position(v);
            for (int i = 0; i < 3; ++i) {
                lo[i] = std::min(lo[i], p[i]);
                hi[i] = std::max(hi[i], p[i]);
            }
        }
        const double dx = hi[0] - lo[0], dy = hi[1] - lo[1], dz = hi[2] - lo[2];
        const double d = std::sqrt(dx * dx + dy * dy + dz * dz);
        return std::isfinite(d) ? d : 0.0;
    }

    // Walk every boundary loop once, returning each as its list of vertices.
    // Bounded by the halfedge count so a corrupt ring cannot spin forever.
    std::vector<std::vector<pmp::Vertex>> collectBoundaryLoops() {
        std::vector<std::vector<pmp::Vertex>> loops;
        const int maxHalfedges = static_cast<int>(mesh_.n_halfedges());
        auto visited = mesh_.add_halfedge_property<bool>("h:describeVisited", false);
        for (auto h : mesh_.halfedges()) {
            if (!mesh_.is_boundary(h) || visited[h]) continue;
            std::vector<pmp::Vertex> verts;
            auto cur = h;
            int guard = 0;
            bool valid = true;
            do {
                visited[cur] = true;
                verts.push_back(mesh_.to_vertex(cur));
                if (++guard > maxHalfedges) { valid = false; break; }
                cur = mesh_.next_halfedge(cur);
            } while (cur != h);
            if (valid) loops.push_back(std::move(verts));
        }
        mesh_.remove_halfedge_property(visited);
        return loops;
    }

    // Measure a loop, including how far its connected component reaches from
    // the loop's plane (LoopShape::shellDepth) and how thick the solid would
    // be if the loop were capped (LoopShape::shellThickness). The component
    // is walked face to face from the loop, so the cost is the component's
    // size; it is only paid for loops the outer-edge test would otherwise
    // exempt.
    LoopShape measureLoopWithDepth(const std::vector<pmp::Vertex>& loopVerts, double meshDiag) {
        std::vector<pmp::Point> pts;
        pts.reserve(loopVerts.size());
        for (auto v : loopVerts) pts.push_back(mesh_.position(v));
        LoopShape s = measureLoop(pts);
        if (s.diameter <= 0 || pmp::norm(s.normal) == 0) return s;
        if (!(meshDiag > 0 && s.diameter >= 0.60 * meshDiag)) return s;

        const pmp::Point c = s.centroid;

        // Signed volume with the loop centroid as origin: the cap's own
        // triangles (c, p_i, p_i+1) then contribute nothing, so summing the
        // component's faces alone gives the capped solid's volume.
        std::vector<char> seenF(mesh_.faces_size(), 0);
        std::vector<pmp::Face> stack;
        auto push = [&](pmp::Face f) {
            if (f.is_valid() && static_cast<size_t>(f.idx()) < seenF.size() && !seenF[f.idx()]) {
                seenF[f.idx()] = 1;
                stack.push_back(f);
            }
        };
        for (auto v : loopVerts) {
            for (auto h : mesh_.halfedges(v)) {
                if (!mesh_.is_boundary(h)) push(mesh_.face(h));
            }
        }
        double reach = 0.0, volume = 0.0;
        while (!stack.empty()) {
            auto f = stack.back();
            stack.pop_back();
            std::vector<pmp::Point> fp;
            for (auto v : mesh_.vertices(f)) {
                const auto p = mesh_.position(v);
                reach = std::max(reach, static_cast<double>(std::fabs(pmp::dot(p - c, s.normal))));
                fp.push_back(p);
            }
            for (size_t i = 1; i + 1 < fp.size(); ++i) {
                volume += static_cast<double>(pmp::dot(fp[0] - c, pmp::cross(fp[i] - c, fp[i + 1] - c))) / 6.0;
            }
            for (auto h : mesh_.halfedges(f)) {
                auto o = mesh_.opposite_halfedge(h);
                if (!mesh_.is_boundary(o)) push(mesh_.face(o));
            }
        }

        double loopArea = 0.0;
        for (size_t i = 0; i < pts.size(); ++i) {
            loopArea += 0.5 * pmp::norm(pmp::cross(pts[i] - c, pts[(i + 1) % pts.size()] - c));
        }

        s.shellDepth = reach / s.diameter;
        if (loopArea > 0) s.shellThickness = std::fabs(volume) / (loopArea * s.diameter);
        return s;
    }

    // Remove every vertex with a NaN or infinite position, and with it every
    // face that used one. Used for the formats PMP reads directly (OBJ, OFF);
    // the STL and PLY readers reject bad vertices before they are ever added.
    // Returns the number of faces removed.
    int dropNonFiniteVertices() {
        std::vector<pmp::Vertex> bad;
        for (auto v : mesh_.vertices()) {
            if (!is_finite_point(mesh_.position(v))) bad.push_back(v);
        }
        if (bad.empty()) return 0;

        int facesBefore = static_cast<int>(mesh_.n_faces());
        for (auto v : bad) {
            if (!mesh_.is_deleted(v)) mesh_.delete_vertex(v);
        }
        mesh_.garbage_collection();
        return facesBefore - static_cast<int>(mesh_.n_faces());
    }
};

EMSCRIPTEN_BINDINGS(meshfix_core) {
    value_object<MeshStats>("MeshStats")
        .field("vertexCount", &MeshStats::vertexCount)
        .field("faceCount", &MeshStats::faceCount)
        .field("edgeCount", &MeshStats::edgeCount)
        .field("bboxMinX", &MeshStats::bboxMinX)
        .field("bboxMinY", &MeshStats::bboxMinY)
        .field("bboxMinZ", &MeshStats::bboxMinZ)
        .field("bboxMaxX", &MeshStats::bboxMaxX)
        .field("bboxMaxY", &MeshStats::bboxMaxY)
        .field("bboxMaxZ", &MeshStats::bboxMaxZ)
        .field("dimX", &MeshStats::dimX)
        .field("dimY", &MeshStats::dimY)
        .field("dimZ", &MeshStats::dimZ)
        .field("surfaceArea", &MeshStats::surfaceArea)
        .field("volume", &MeshStats::volume)
        .field("boundaryEdges", &MeshStats::boundaryEdges)
        .field("isTriangleMesh", &MeshStats::isTriangleMesh)
        .field("skippedFaces", &MeshStats::skippedFaces);

    value_object<WeldResult>("WeldResult")
        .field("verticesBefore", &WeldResult::verticesBefore)
        .field("verticesAfter", &WeldResult::verticesAfter)
        .field("verticesMerged", &WeldResult::verticesMerged)
        .field("facesBefore", &WeldResult::facesBefore)
        .field("facesAfter", &WeldResult::facesAfter)
        .field("facesRemoved", &WeldResult::facesRemoved)
        .field("degenerateFaces", &WeldResult::degenerateFaces)
        .field("skippedFaces", &WeldResult::skippedFaces);

    value_object<DecimateResult>("DecimateResult")
        .field("success", &DecimateResult::success)
        .field("verticesBefore", &DecimateResult::verticesBefore)
        .field("verticesAfter", &DecimateResult::verticesAfter)
        .field("facesBefore", &DecimateResult::facesBefore)
        .field("facesAfter", &DecimateResult::facesAfter)
        .field("facesDropped", &DecimateResult::facesDropped);

    value_object<RemoveDegeneratesResult>("RemoveDegeneratesResult")
        .field("facesBefore", &RemoveDegeneratesResult::facesBefore)
        .field("facesAfter", &RemoveDegeneratesResult::facesAfter)
        .field("degenerateRemoved", &RemoveDegeneratesResult::degenerateRemoved)
        .field("duplicateRemoved", &RemoveDegeneratesResult::duplicateRemoved)
        .field("isolatedVerticesRemoved", &RemoveDegeneratesResult::isolatedVerticesRemoved);

    value_object<FixNormalsResult>("FixNormalsResult")
        .field("totalComponents", &FixNormalsResult::totalComponents)
        .field("componentsFlipped", &FixNormalsResult::componentsFlipped)
        .field("facesFlipped", &FixNormalsResult::facesFlipped)
        .field("skippedOpen", &FixNormalsResult::skippedOpen)
        .field("skippedFaces", &FixNormalsResult::skippedFaces);

    value_object<FillHolesResult>("FillHolesResult")
        .field("holesFound", &FillHolesResult::holesFound)
        .field("holesFilled", &FillHolesResult::holesFilled)
        .field("holesFailed", &FillHolesResult::holesFailed)
        .field("holesSkipped", &FillHolesResult::holesSkipped)
        .field("facesAdded", &FillHolesResult::facesAdded)
        .field("holesSkippedAsFeature", &FillHolesResult::holesSkippedAsFeature)
        .field("flapsRemoved", &FillHolesResult::flapsRemoved);

    value_object<SplitVerticesResult>("SplitVerticesResult")
        .field("verticesBefore", &SplitVerticesResult::verticesBefore)
        .field("verticesAfter", &SplitVerticesResult::verticesAfter)
        .field("nonManifoldVerticesFound", &SplitVerticesResult::nonManifoldVerticesFound)
        .field("verticesAdded", &SplitVerticesResult::verticesAdded)
        .field("facesBefore", &SplitVerticesResult::facesBefore)
        .field("facesAfter", &SplitVerticesResult::facesAfter)
        .field("skippedFaces", &SplitVerticesResult::skippedFaces);

    value_object<RepairResult>("RepairResult")
        .field("weld", &RepairResult::weld)
        .field("removeDegenerates", &RepairResult::removeDegenerates)
        .field("splitVertices", &RepairResult::splitVertices)
        .field("fixNormals", &RepairResult::fixNormals)
        .field("fillHoles", &RepairResult::fillHoles)
        .field("verticesBefore", &RepairResult::verticesBefore)
        .field("verticesAfter", &RepairResult::verticesAfter)
        .field("facesBefore", &RepairResult::facesBefore)
        .field("facesAfter", &RepairResult::facesAfter);

    value_object<MeshAnalysis>("MeshAnalysis")
        .field("vertexCount", &MeshAnalysis::vertexCount)
        .field("faceCount", &MeshAnalysis::faceCount)
        .field("edgeCount", &MeshAnalysis::edgeCount)
        .field("bboxMinX", &MeshAnalysis::bboxMinX)
        .field("bboxMinY", &MeshAnalysis::bboxMinY)
        .field("bboxMinZ", &MeshAnalysis::bboxMinZ)
        .field("bboxMaxX", &MeshAnalysis::bboxMaxX)
        .field("bboxMaxY", &MeshAnalysis::bboxMaxY)
        .field("bboxMaxZ", &MeshAnalysis::bboxMaxZ)
        .field("dimX", &MeshAnalysis::dimX)
        .field("dimY", &MeshAnalysis::dimY)
        .field("dimZ", &MeshAnalysis::dimZ)
        .field("surfaceArea", &MeshAnalysis::surfaceArea)
        .field("volume", &MeshAnalysis::volume)
        .field("boundaryEdges", &MeshAnalysis::boundaryEdges)
        .field("isTriangleMesh", &MeshAnalysis::isTriangleMesh)
        .field("skippedFaces", &MeshAnalysis::skippedFaces)
        .field("isManifold", &MeshAnalysis::isManifold)
        .field("isWatertight", &MeshAnalysis::isWatertight)
        .field("eulerCharacteristic", &MeshAnalysis::eulerCharacteristic)
        .field("genus", &MeshAnalysis::genus)
        .field("connectedComponents", &MeshAnalysis::connectedComponents)
        .field("boundaryLoops", &MeshAnalysis::boundaryLoops)
        .field("nonManifoldVertexCount", &MeshAnalysis::nonManifoldVertexCount)
        .field("nonManifoldEdgeCount", &MeshAnalysis::nonManifoldEdgeCount)
        .field("flippedNormalCount", &MeshAnalysis::flippedNormalCount)
        .field("degenerateTriangleCount", &MeshAnalysis::degenerateTriangleCount)
        .field("holeCount", &MeshAnalysis::holeCount)
        .field("duplicateFaceCount", &MeshAnalysis::duplicateFaceCount)
        .field("isolatedVertexCount", &MeshAnalysis::isolatedVertexCount);

    class_<MeshAnalyzer>("MeshAnalyzer")
        .constructor<>()
        .function("loadFromFile", &MeshAnalyzer::loadFromFile)
        .function("loadTestShape", &MeshAnalyzer::loadTestShape)
        .function("getStats", &MeshAnalyzer::getStats)
        .function("getAnalysis", &MeshAnalyzer::getAnalysis)
        .function("weldVertices", &MeshAnalyzer::weldVertices)
        .function("removeDegenerates", &MeshAnalyzer::removeDegenerates)
        .function("fixNormals", &MeshAnalyzer::fixNormals)
        .function("fillHoles", &MeshAnalyzer::fillHoles)
        .function("fillHolesEx", &MeshAnalyzer::fillHolesEx)
        .function("describeHoles", &MeshAnalyzer::describeHoles)
        .function("splitVertices", &MeshAnalyzer::splitVertices)
        .function("repair", &MeshAnalyzer::repair)
        .function("getVertexCount", &MeshAnalyzer::getVertexCount)
        .function("getFaceCount", &MeshAnalyzer::getFaceCount)
        .function("isLoaded", &MeshAnalyzer::isLoaded)
        .function("getLastError", &MeshAnalyzer::getLastError)
        .function("exportMesh", &MeshAnalyzer::exportMesh)
        .function("scale", &MeshAnalyzer::scale)
        .function("decimate", &MeshAnalyzer::decimate)
        .function("colorsDropped", &MeshAnalyzer::colorsDropped)
        .function("nonFiniteFacesRemoved", &MeshAnalyzer::nonFiniteFacesRemoved)
        .function("connectivityRebuilds", &MeshAnalyzer::connectivityRebuilds)
        .function("facesDroppedByAudit", &MeshAnalyzer::facesDroppedByAudit)
        .function("writeRenderData", &MeshAnalyzer::writeRenderData);
}
