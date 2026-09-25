// Count zero-area triangles in an STL (binary or ASCII) two ways, straight from the file, no mesh structure:
// PMP's face_area formula (0.5*|sum cross(q,r)| over the 3 edges, in float) and the double edge-vector formula.
#include <cstdio>
#include <cstring>
#include <cmath>
#include <vector>
#include <string>
#include <fstream>
#include <sstream>
struct V { float x, y, z; };
int main(int argc, char** argv) {
  std::ifstream in(argv[1], std::ios::binary); std::vector<char> buf((std::istreambuf_iterator<char>(in)), {});
  std::vector<V> t;
  bool bin = buf.size() >= 84; unsigned n = 0; if (bin) { memcpy(&n, &buf[80], 4); bin = buf.size() == 84 + 50ull * n; }
  if (bin) { for (unsigned i = 0; i < n; ++i) { const char* p = &buf[84 + 50 * i + 12]; for (int k = 0; k < 3; ++k) { V v; memcpy(&v, p + 12 * k, 12); t.push_back(v); } } }
  else { std::string s(buf.begin(), buf.end()); std::istringstream ss(s); std::string w; while (ss >> w) { if (w == "vertex") { V v; ss >> v.x >> v.y >> v.z; t.push_back(v); } } t.resize(t.size() / 3 * 3); }
  int pmpZero = 0, robustZero = 0;
  for (size_t i = 0; i + 2 < t.size(); i += 3) {
    const V* p = &t[i]; float sx = 0, sy = 0, sz = 0;
    for (int k = 0; k < 3; ++k) { const V& q = p[k]; const V& r = p[(k + 1) % 3]; sx += q.y * r.z - q.z * r.y; sy += q.z * r.x - q.x * r.z; sz += q.x * r.y - q.y * r.x; }
    float pa = 0.5f * std::sqrt(sx * sx + sy * sy + sz * sz); if (pa < 1e-10f) ++pmpZero;
    double ax = p[1].x - p[0].x, ay = p[1].y - p[0].y, az = p[1].z - p[0].z, bx = p[2].x - p[0].x, by = p[2].y - p[0].y, bz = p[2].z - p[0].z;
    double cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx; if (0.5 * std::sqrt(cx * cx + cy * cy + cz * cz) < 1e-10) ++robustZero;
  }
  printf("%s faces=%zu pmpZero=%d robustZero=%d\n", argv[1], t.size() / 3, pmpZero, robustZero); return 0; }
