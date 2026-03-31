#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
EMSDK_DIR="$ROOT_DIR/emsdk"

if [ -d "$EMSDK_DIR" ] && [ -f "$EMSDK_DIR/emsdk_env.sh" ]; then
    echo "emsdk already installed at $EMSDK_DIR"
    source "$EMSDK_DIR/emsdk_env.sh"
    emcc --version
    exit 0
fi

echo "Cloning emsdk..."
git clone https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"

cd "$EMSDK_DIR"
echo "Installing latest emsdk..."
./emsdk install latest
echo "Activating latest emsdk..."
./emsdk activate latest

source "$EMSDK_DIR/emsdk_env.sh"
echo ""
echo "Emscripten installed successfully:"
emcc --version
