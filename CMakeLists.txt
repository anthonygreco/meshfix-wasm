cmake_minimum_required(VERSION 3.16)
project(meshfix-wasm LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Static linking required for Emscripten
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)

# Disable PMP extras we don't need
set(PMP_BUILD_VIEWERS OFF CACHE BOOL "" FORCE)
set(PMP_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(PMP_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(PMP_BUILD_DOCS OFF CACHE BOOL "" FORCE)

add_subdirectory(third_party/pmp-library)
add_subdirectory(cpp)
