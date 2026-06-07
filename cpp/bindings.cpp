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

static int read_stl_robust(pmp::SurfaceMesh& mesh, const std::string& filepath) {
    std::array<char, 100> line;
    uint32_t i, nT(0);
    pmp::vec3 p;
    pmp::Vertex v;
    std::vector<pmp::Vertex> vertices(3);
    int skipped = 0;

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
            for (i = 0; i < 3; ++i) {
                tfread(in, p);
                vertices[i] = add_vertex(p);
            }
            try_add_face(vertices);
            n_items = fread(line.data(), 1, 2, in); // skip attribute
            --nT;
        }
    } else {
        char* c{nullptr};
        while (in && !feof(in) && fgets(line.data(), 100, in)) {
            for (c = line.data(); isspace(*c) && *c != '\0'; ++c) {}
            if ((strncmp(c, "outer", 5) == 0) || (strncmp(c, "OUTER", 5) == 0)) {
                for (i = 0; i < 3; ++i) {
                    c = fgets(line.data(), 100, in);
                    if (!c) break;
                    for (c = line.data(); isspace(*c) && *c != '\0'; ++c) {}
                    sscanf(c + 6, "%f %f %f", &p[0], &p[1], &p[2]);
                    vertices[i] = add_vertex(p);
                }
                try_add_face(vertices);
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

        std::vector<pmp::Vertex> verts;
        verts.reserve(xs.size());
        for (size_t i = 0; i < xs.size(); ++i) {
            verts.push_back(mesh.add_vertex(pmp::Point(xs[i], ys[i], zs[i])));
        }

        // Read faces
        std::vector<std::vector<int>> faces;
        if (plyIn.hasElement("face")) {
            faces = plyIn.getElement("face").getListProperty<int>("vertex_indices");
        }

        for (auto& f : faces) {
            if (f.size() < 3) continue;
            // Triangulate if needed (fan triangulation)
            for (size_t i = 1; i + 1 < f.size(); ++i) {
                std::vector<pmp::Vertex> tri = { verts[f[0]], verts[f[i]], verts[f[i+1]] };
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
};

struct DecimateResult {
    bool success;
    int verticesBefore;
    int verticesAfter;
    int facesBefore;
    int facesAfter;
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

class MeshAnalyzer {
public:
    MeshAnalyzer() : loaded_(false), skippedFaces_(0), colorsDropped_(false) {}

    bool colorsDropped() const { return colorsDropped_; }

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

            if (ext == ".stl") {
                // Use our fault-tolerant STL reader
                skippedFaces_ = read_stl_robust(mesh_, path);
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
            }

            loaded_ = mesh_.n_vertices() > 0;
            if (!loaded_) {
                lastError_ = "File read produced empty mesh";
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

    MeshAnalysis getAnalysis() {
        MeshAnalysis a{};
        if (!loaded_) return a;

        try {
            fillGeometry(a);

            int V = a.vertexCount;
            int E = a.edgeCount;
            int F = a.faceCount;

            // (a) Non-manifold vertices
            int nmvCount = 0;
            for (auto v : mesh_.vertices()) {
                if (!mesh_.is_manifold(v)) {
                    ++nmvCount;
                }
            }
            a.nonManifoldVertexCount = nmvCount;
            a.isManifold = (nmvCount == 0);

            // (b) Non-manifold edges = skipped faces from reader
            a.nonManifoldEdgeCount = skippedFaces_;

            // (c) Watertight, Euler, genus
            a.isWatertight = (a.boundaryEdges == 0);
            a.eulerCharacteristic = V - E + F;

            // (d) Connected components via BFS + flipped normals
            auto compId = mesh_.add_face_property<int>("f:component", -1);
            int numComponents = 0;
            int flippedCount = 0;

            for (auto f : mesh_.faces()) {
                if (compId[f] >= 0) continue;
                int cid = numComponents++;

                // BFS
                std::queue<pmp::Face> q;
                q.push(f);
                compId[f] = cid;
                float compVolume = 0.0f;
                int compFaceCount = 0;
                bool compHasBoundary = false;

                while (!q.empty()) {
                    auto cur = q.front(); q.pop();
                    ++compFaceCount;

                    // Compute signed volume contribution for this face
                    auto verts = mesh_.vertices(cur);
                    auto vit = verts.begin();
                    auto vend = verts.end();
                    if (vit != vend) {
                        auto p0 = mesh_.position(*vit); ++vit;
                        if (vit != vend) {
                            auto pPrev = mesh_.position(*vit); ++vit;
                            while (vit != vend) {
                                auto pCur = mesh_.position(*vit); ++vit;
                                compVolume += dot(p0, cross(pPrev, pCur)) / 6.0f;
                                pPrev = pCur;
                            }
                        }
                    }

                    // Visit neighbors via halfedges
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

                // Flipped = closed component with negative signed volume
                if (!compHasBoundary && compVolume < 0.0f) {
                    flippedCount += compFaceCount;
                }
            }
            mesh_.remove_face_property(compId);

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
                for (auto h : mesh_.halfedges()) {
                    if (mesh_.is_boundary(h) && !visited[h]) {
                        ++loopCount;
                        auto cur = h;
                        do {
                            visited[cur] = true;
                            cur = mesh_.next_halfedge(cur);
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

    RemoveDegeneratesResult removeDegenerates(float minArea) {
        RemoveDegeneratesResult result{};
        if (!loaded_) return result;

        try {
            result.facesBefore = static_cast<int>(mesh_.n_faces());

            if (minArea <= 0.0f) minArea = 1e-10f;

            // Phase A: Remove duplicate faces
            int dupRemoved = 0;
            {
                std::set<std::vector<pmp::IndexType>> faceSet;
                for (auto f : mesh_.faces()) {
                    std::vector<pmp::IndexType> vids;
                    for (auto v : mesh_.vertices(f)) {
                        vids.push_back(v.idx());
                    }
                    std::sort(vids.begin(), vids.end());
                    auto ins = faceSet.insert(vids);
                    if (!ins.second) {
                        mesh_.delete_face(f);
                        ++dupRemoved;
                    }
                }
            }
            result.duplicateRemoved = dupRemoved;

            // Phase B: Remove degenerate faces (near-zero area)
            int degenRemoved = 0;
            for (auto f : mesh_.faces()) {
                if (pmp::face_area(mesh_, f) < minArea) {
                    mesh_.delete_face(f);
                    ++degenRemoved;
                }
            }
            result.degenerateRemoved = degenRemoved;

            // Phase C: Count isolated vertices before GC
            int isoCount = 0;
            for (auto v : mesh_.vertices()) {
                if (mesh_.is_isolated(v)) {
                    ++isoCount;
                }
            }
            result.isolatedVerticesRemoved = isoCount;

            // Phase D: Compact the mesh
            mesh_.garbage_collection();
            skippedFaces_ = 0;

            // Phase E: Populate result
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
            // Phase A: BFS to find components, compute signed volumes
            struct CompInfo {
                float signedVolume;
                int faceCount;
                bool hasBoundary;
            };

            auto compId = mesh_.add_face_property<int>("f:comp", -1);
            int numComponents = 0;
            std::vector<CompInfo> components;

            for (auto f : mesh_.faces()) {
                if (compId[f] >= 0) continue;
                int cid = numComponents++;
                CompInfo info{0.0f, 0, false};

                std::queue<pmp::Face> q;
                q.push(f);
                compId[f] = cid;

                while (!q.empty()) {
                    auto cur = q.front(); q.pop();
                    ++info.faceCount;

                    // Signed volume contribution
                    auto verts = mesh_.vertices(cur);
                    auto vit = verts.begin();
                    auto vend = verts.end();
                    if (vit != vend) {
                        auto p0 = mesh_.position(*vit); ++vit;
                        if (vit != vend) {
                            auto pPrev = mesh_.position(*vit); ++vit;
                            while (vit != vend) {
                                auto pCur = mesh_.position(*vit); ++vit;
                                info.signedVolume += dot(p0, cross(pPrev, pCur)) / 6.0f;
                                pPrev = pCur;
                            }
                        }
                    }

                    // Visit neighbors
                    for (auto h : mesh_.halfedges(cur)) {
                        if (mesh_.is_boundary(mesh_.edge(h))) {
                            info.hasBoundary = true;
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

                components.push_back(info);
            }

            result.totalComponents = numComponents;

            // Phase B: Identify flipped components
            std::vector<bool> needsFlip(numComponents, false);
            for (int i = 0; i < numComponents; ++i) {
                if (components[i].hasBoundary) {
                    ++result.skippedOpen;
                } else if (components[i].signedVolume < 0.0f) {
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

        } catch (const std::exception& e) {
            lastError_ = std::string("Error fixing normals: ") + e.what();
        } catch (...) {
            lastError_ = "Unknown error fixing normals";
        }

        return result;
    }

    FillHolesResult fillHoles(int maxEdges) {
        FillHolesResult result{};
        if (!loaded_) return result;

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

                // Simple fan triangulation from first vertex.
                // PMP's fill_hole() does Delaunay refinement + fairing which can
                // crash (WASM trap) on complex boundaries from damaged meshes.
                // Fan fill is simpler, always safe, and good enough for repair.
                int facesAdded = 0;
                bool anyFailed = false;
                for (size_t i = 1; i + 1 < loopVerts.size(); ++i) {
                    try {
                        std::vector<pmp::Vertex> tri = {loopVerts[0], loopVerts[i], loopVerts[i + 1]};
                        mesh_.add_face(tri);
                        ++facesAdded;
                    } catch (...) {
                        anyFailed = true;
                    }
                }

                if (facesAdded > 0) {
                    ++result.holesFilled;
                } else {
                    ++result.holesFailed;
                }
            }

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

            // Phase A: Find non-manifold vertices
            std::vector<pmp::Vertex> nmVerts;
            for (auto v : mesh_.vertices()) {
                if (!mesh_.is_manifold(v)) {
                    nmVerts.push_back(v);
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

            // Phase A2: Fan identification for each non-manifold vertex
            for (auto v : nmVerts) {
                // Walk halfedges around v to identify fans separated by boundary halfedges
                // PMP guarantees halfedge(v) is a boundary halfedge for boundary vertices
                std::vector<std::vector<pmp::Face>> fans;
                std::vector<pmp::Face> currentFan;

                // Use the halfedge circulator: walk all halfedges around v
                auto hStart = mesh_.halfedge(v);
                auto hCur = hStart;

                do {
                    // If this halfedge's face is valid (not boundary), add to current fan
                    if (!mesh_.is_boundary(hCur)) {
                        currentFan.push_back(mesh_.face(hCur));
                    } else {
                        // Boundary halfedge = fan separator
                        if (!currentFan.empty()) {
                            fans.push_back(std::move(currentFan));
                            currentFan.clear();
                        }
                    }
                    // Rotate CW: opposite(prev(h))
                    hCur = mesh_.opposite_halfedge(mesh_.prev_halfedge(hCur));
                } while (hCur != hStart);

                // Don't forget the last fan
                if (!currentFan.empty()) {
                    fans.push_back(std::move(currentFan));
                }

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

        try { result.weld = weldVertices(weldEpsilon); }
        catch (const std::exception& e) { warnings += "weld: " + std::string(e.what()) + "; "; }
        catch (...) { warnings += "weld: unknown error; "; }

        try { result.removeDegenerates = removeDegenerates(minArea); }
        catch (const std::exception& e) { warnings += "removeDegenerates: " + std::string(e.what()) + "; "; }
        catch (...) { warnings += "removeDegenerates: unknown error; "; }

        try { result.splitVertices = splitVertices(); }
        catch (const std::exception& e) { warnings += "splitVertices: " + std::string(e.what()) + "; "; }
        catch (...) { warnings += "splitVertices: unknown error; "; }

        try { result.fillHoles = fillHoles(maxHoleEdges); }
        catch (const std::exception& e) { warnings += "fillHoles: " + std::string(e.what()) + "; "; }
        catch (...) { warnings += "fillHoles: unknown error; "; }

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
        DecimateResult result{false, 0, 0, 0, 0};
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
                    float compVolume = 0.0f;
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
                                while (vit != vend) {
                                    auto pCur = mesh_.position(*vit); ++vit;
                                    compVolume += dot(p0, cross(pPrev, pCur)) / 6.0f;
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

                    if (!compHasBoundary && compVolume < 0.0f) {
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
        float totalVolume = 0.0f;
        for (auto f : mesh_.faces()) {
            auto vertices = mesh_.vertices(f);
            auto vit = vertices.begin();
            auto end = vertices.end();
            if (vit == end) continue;
            auto p0 = mesh_.position(*vit); ++vit;
            if (vit == end) continue;
            auto pPrev = mesh_.position(*vit); ++vit;

            while (vit != end) {
                auto pCur = mesh_.position(*vit); ++vit;
                auto e1 = pPrev - p0;
                auto e2 = pCur - p0;
                auto crossProduct = cross(e1, e2);
                totalArea += norm(crossProduct) * 0.5f;
                totalVolume += dot(p0, cross(pPrev, pCur)) / 6.0f;
                pPrev = pCur;
            }
        }
        a.surfaceArea = totalArea;
        a.volume = std::abs(totalVolume);

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
        .field("facesAfter", &DecimateResult::facesAfter);

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
        .field("facesAdded", &FillHolesResult::facesAdded);

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
        .function("writeRenderData", &MeshAnalyzer::writeRenderData);
}
