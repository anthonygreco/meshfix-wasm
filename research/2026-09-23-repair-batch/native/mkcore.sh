#!/bin/bash
# usage: mkcore.sh <bindings.cpp> <out.inc> [check]  — strips the Embind block; "check" adds meshRef()
sed -e '/#include <emscripten\/bind.h>/d' -e '/using namespace emscripten;/d' "$1" | sed '/^EMSCRIPTEN_BINDINGS/,$d' > "$2"
if [ "$3" = check ]; then
  python3 - "$2" <<'PY'
import sys,re
p=sys.argv[1]; s=open(p).read()
# add meshRef() accessor right after 'class MeshAnalyzer {' public section: insert before 'bool auditConnectivity('
s=s.replace("    int getVertexCount() const {","    const pmp::SurfaceMesh& meshRef() const { return mesh_; }\n    int getVertexCount() const {",1)
open(p,'w').write(s)
PY
fi
