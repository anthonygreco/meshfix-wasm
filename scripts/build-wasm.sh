#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$ROOT_DIR/build"
EMSDK_DIR="$ROOT_DIR/emsdk"

# Check prerequisites
if ! command -v cmake &>/dev/null; then
    echo "ERROR: cmake not found. Install with: sudo apt install cmake"
    exit 1
fi

if [ ! -f "$EMSDK_DIR/emsdk_env.sh" ]; then
    echo "ERROR: emsdk not found. Run: bash scripts/install-emsdk.sh"
    exit 1
fi

source "$EMSDK_DIR/emsdk_env.sh"

if ! command -v emcc &>/dev/null; then
    echo "ERROR: emcc not found after sourcing emsdk_env.sh"
    exit 1
fi

echo "Using cmake: $(cmake --version | head -1)"
echo "Using emcc: $(emcc --version | head -1)"

# Patch PMP's CMakeLists.txt to remove --no-heap-copy (deprecated in Emscripten 5.x)
PMP_CMAKE="$ROOT_DIR/third_party/pmp-library/CMakeLists.txt"
if grep -q -- '--no-heap-copy' "$PMP_CMAKE" 2>/dev/null; then
    echo ""
    echo "=== Patching PMP: removing deprecated --no-heap-copy flag ==="
    sed -i 's/.*--no-heap-copy.*//' "$PMP_CMAKE"
fi

# Configure
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

echo ""
echo "=== Configuring ==="
emcmake cmake "$ROOT_DIR" -DCMAKE_BUILD_TYPE=Release

echo ""
echo "=== Building ==="
emmake make -j$(nproc) VERBOSE=1

echo ""
echo "=== Verifying output ==="
if [ -f "$ROOT_DIR/dist/meshfix-core.js" ] && [ -f "$ROOT_DIR/dist/meshfix-core.wasm" ]; then
    JS_SIZE=$(stat -c%s "$ROOT_DIR/dist/meshfix-core.js")
    WASM_SIZE=$(stat -c%s "$ROOT_DIR/dist/meshfix-core.wasm")
    echo "SUCCESS!"
    echo "  dist/meshfix-core.js   ($JS_SIZE bytes)"
    echo "  dist/meshfix-core.wasm ($WASM_SIZE bytes)"
else
    echo "ERROR: Expected output files not found in dist/"
    ls -la "$ROOT_DIR/dist/" 2>/dev/null || echo "  dist/ directory does not exist"
    exit 1
fi
