add_executable(meshfix-core bindings.cpp)

target_link_libraries(meshfix-core PRIVATE pmp)
target_include_directories(meshfix-core PRIVATE
    ${CMAKE_SOURCE_DIR}/third_party/pmp-library/src
    ${CMAKE_SOURCE_DIR}/third_party/happly
)

if(EMSCRIPTEN)
    set_target_properties(meshfix-core PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/dist"
        SUFFIX ".js"
    )

    target_compile_options(meshfix-core PRIVATE -fexceptions)
    target_link_options(meshfix-core PRIVATE
        -fexceptions
        -lembind
        -sINITIAL_MEMORY=33554432
        -sMODULARIZE=1
        -sEXPORT_NAME=createMeshFixCore
        -sALLOW_MEMORY_GROWTH=1
        -sFORCE_FILESYSTEM=1
        -sEXPORT_EXCEPTION_HANDLING_HELPERS=1
        "SHELL:-sEXPORTED_RUNTIME_METHODS=['FS','getExceptionMessage']"
        -O2
    )
endif()
