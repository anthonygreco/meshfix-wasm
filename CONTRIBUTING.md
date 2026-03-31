# Contributing

## Prerequisites

- [CMake](https://cmake.org/) 3.16+
- [Node.js](https://nodejs.org/) 18+
- Git (with submodule support)

## Setup

```bash
# Clone with submodules
git clone --recursive https://github.com/anthonygreco/meshfix-wasm.git
cd meshfix-wasm

# Install Node dependencies
npm install

# Install Emscripten SDK (one-time, ~1.7 GB)
bash scripts/install-emsdk.sh
```

## Building

```bash
# Full build (WASM + TypeScript)
npm run build

# Or build separately:
bash scripts/build-wasm.sh   # C++ → dist/meshfix-core.js + .wasm
npm run build:ts              # TypeScript → dist/*.js + *.d.ts

# Clean rebuild (needed when C++ compile flags change)
rm -rf build && bash scripts/build-wasm.sh
```

## Testing

Tests are browser-based HTML pages, not Node.js scripts.

```bash
npm run serve
# Open http://localhost:8080/tests/index.html
```

- `tests/main-tests.html` — automated main-thread tests
- `tests/worker-tests.html` — automated Web Worker tests
- `tests/demo.html` — interactive demo with 3D viewport

## Project Structure

- `cpp/bindings.cpp` — all C++ logic (Embind bindings, I/O, analysis, repairs)
- `src/` — TypeScript source (compiled to `dist/`)
- `third_party/pmp-library/` — PMP Library git submodule (v3.0.0, C++20)
- `scripts/` — build scripts
- `tests/` — browser-based test pages

## Key Details

- PMP Library v3.0.0 requires **C++20**
- Emscripten 5.0.1 is installed locally at `./emsdk/` (gitignored)
- `-fexceptions` must be on both compile and link flags
- The worker script (`src/worker.ts`) must not use `import`/`export` statements (classic worker)
