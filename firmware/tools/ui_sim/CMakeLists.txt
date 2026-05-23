cmake_minimum_required(VERSION 3.20)

project(stackchan_ui_sim LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)

option(UI_SIM_HEADLESS "Build without SDL and use the offscreen framebuffer display" OFF)

set(UI_SIM_ROOT "${CMAKE_CURRENT_LIST_DIR}")
set(REPO_ROOT "${UI_SIM_ROOT}/../../..")
set(FIRMWARE_ROOT "${REPO_ROOT}/firmware")
set(FIRMWARE_MAIN "${FIRMWARE_ROOT}/main")

set(CONFIG_LV_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_BUILD_DEMOS OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_USE_THORVG_INTERNAL OFF CACHE BOOL "" FORCE)
set(LV_BUILD_CONF_PATH "${UI_SIM_ROOT}/lv_conf.h" CACHE PATH "" FORCE)
set(LV_BUILD_SET_CONFIG_OPTS OFF CACHE BOOL "" FORCE)

if(UI_SIM_HEADLESS)
    set(UI_SIM_USE_SDL_VALUE 0)
else()
    set(UI_SIM_USE_SDL_VALUE 1)
endif()

set(LVGL_LOCAL_DIR "${FIRMWARE_ROOT}/managed_components/lvgl__lvgl")
if(EXISTS "${LVGL_LOCAL_DIR}/CMakeLists.txt")
    message(STATUS "Using repository LVGL: ${LVGL_LOCAL_DIR}")
    add_subdirectory("${LVGL_LOCAL_DIR}" "${CMAKE_BINARY_DIR}/lvgl")
else()
    include(FetchContent)
    set(FETCHCONTENT_BASE_DIR "${UI_SIM_ROOT}/.deps" CACHE PATH "" FORCE)
    FetchContent_Declare(
        lvgl
        GIT_REPOSITORY https://github.com/lvgl/lvgl.git
        GIT_TAG v9.4.0
        GIT_SHALLOW TRUE
    )
    FetchContent_MakeAvailable(lvgl)
endif()

target_compile_definitions(lvgl PUBLIC UI_SIM_USE_SDL=${UI_SIM_USE_SDL_VALUE})

if(NOT UI_SIM_HEADLESS)
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(SDL2 REQUIRED IMPORTED_TARGET sdl2)
    target_link_libraries(lvgl PUBLIC PkgConfig::SDL2)
endif()

set(SMOOTH_UI_TOOLKIT_BUILD_EXAMPLE OFF CACHE BOOL "" FORCE)
set(SMOOTH_UI_TOOLKIT_BUILD_TEST OFF CACHE BOOL "" FORCE)
set(SMOOTH_UI_TOOLKIT_ENABLE_DEFAULT_HAL ON CACHE BOOL "" FORCE)
add_subdirectory("${FIRMWARE_ROOT}/components/smooth_ui_toolkit" "${CMAKE_BINARY_DIR}/smooth_ui_toolkit")

add_library(ArduinoJson INTERFACE)
target_include_directories(ArduinoJson INTERFACE "${FIRMWARE_ROOT}/components/ArduinoJson/src")

set(STACKCHAN_AVATAR_SOURCES
    "${FIRMWARE_MAIN}/stackchan/stackchan.cpp"
    "${FIRMWARE_MAIN}/stackchan/addons/neon_light/neon_light.cpp"
    "${FIRMWARE_MAIN}/stackchan/motion/motion.cpp"
    "${FIRMWARE_MAIN}/stackchan/motion/servo.cpp"
    "${FIRMWARE_MAIN}/stackchan/avatar/skins/default/default.cpp"
    "${FIRMWARE_MAIN}/stackchan/avatar/skins/default/eyes.cpp"
    "${FIRMWARE_MAIN}/stackchan/avatar/skins/default/mouth.cpp"
    "${FIRMWARE_MAIN}/stackchan/avatar/skins/default/speech_bubble.cpp"
    "${FIRMWARE_MAIN}/stackchan/avatar/skins/default/assets/default_bubble_arrow.c"
)

add_executable(stackchan_ui_sim
    main.cpp
    hal_stub.cpp
    avatar_scene.cpp
    scenario_runner.cpp
    ${STACKCHAN_AVATAR_SOURCES}
)

target_compile_definitions(stackchan_ui_sim PRIVATE UI_SIM_USE_SDL=${UI_SIM_USE_SDL_VALUE})
target_include_directories(stackchan_ui_sim
    PRIVATE
        "${UI_SIM_ROOT}"
        "${UI_SIM_ROOT}/stubs"
        "${FIRMWARE_MAIN}"
)
target_link_libraries(stackchan_ui_sim
    PRIVATE
        lvgl
        smooth_ui_toolkit
        ArduinoJson
)

target_compile_options(stackchan_ui_sim PRIVATE
    -Wall
    -Wextra
    -Wno-delete-non-abstract-non-virtual-dtor
    -Wno-mismatched-tags
    -Wno-sign-compare
    -Wno-unused-lambda-capture
    -Wno-unused-parameter
    -Wno-unused-const-variable
    -Wno-vla-cxx-extension
)
