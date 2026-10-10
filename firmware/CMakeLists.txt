# The following five lines of boilerplate have to be in your project's
# CMakeLists in this exact order for cmake to work correctly
cmake_minimum_required(VERSION 3.16)

set(PROJECT_VER "1.4.1")
add_definitions(-DFIRMWARE_VERSION=\"${PROJECT_VER}\")

# Add this line to disable the specific warning
add_compile_options(-Wno-missing-field-initializers)

# Auto-load a local sdkconfig overlay (git-ignored) when present. Lets
# self-hosted / custom deployments pin CONFIG_STACKCHAN_SERVER_URL,
# CONFIG_OTA_URL, etc. without touching committed defaults.
# Manual equivalent: SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.local" idf.py build
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/sdkconfig.defaults.local")
    set(SDKCONFIG_DEFAULTS
        "${CMAKE_CURRENT_SOURCE_DIR}/sdkconfig.defaults;${CMAKE_CURRENT_SOURCE_DIR}/sdkconfig.defaults.local"
        CACHE STRING "ESP-IDF sdkconfig default files (auto-extended with local overlay)" FORCE)
    message(STATUS "StackChan: detected sdkconfig.defaults.local, applying overlay")
endif()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(stack-chan)

include("${CMAKE_SOURCE_DIR}/cmake/apply_managed_component_patch.cmake")
set(ESP_ML307_PATCH "${CMAKE_SOURCE_DIR}/patches/esp-ml307-tcp-shutdown.patch")
set(ESP_ML307_COMPONENT_DIR "${CMAKE_SOURCE_DIR}/managed_components/78__esp-ml307")
set(ESP_LVGL_PORT_PATCH "${CMAKE_SOURCE_DIR}/patches/esp-lvgl-port-rgb565-swap-buffer.patch")
set(ESP_LVGL_PORT_COMPONENT_DIR "${CMAKE_SOURCE_DIR}/managed_components/espressif__esp_lvgl_port")
set(ESP_WIFI_CONNECT_PATCH "${CMAKE_SOURCE_DIR}/patches/esp-wifi-connect-station-stability.patch")
set(ESP_WIFI_CONNECT_COMPONENT_DIR "${CMAKE_SOURCE_DIR}/managed_components/78__esp-wifi-connect")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${ESP_ML307_PATCH}")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${ESP_LVGL_PORT_PATCH}")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${ESP_WIFI_CONNECT_PATCH}")
stackchan_apply_managed_component_patch(
    "${ESP_ML307_COMPONENT_DIR}" "${ESP_ML307_PATCH}" "esp-ml307 TCP shutdown")
stackchan_apply_managed_component_patch(
    "${ESP_WIFI_CONNECT_COMPONENT_DIR}" "${ESP_WIFI_CONNECT_PATCH}" "esp-wifi-connect station stability")
stackchan_apply_managed_component_patch(
    "${ESP_LVGL_PORT_COMPONENT_DIR}" "${ESP_LVGL_PORT_PATCH}" "esp_lvgl_port RGB565 swap buffer")

set(ESP_VIDEO_PATCH "${CMAKE_SOURCE_DIR}/patches/esp-video-bounded-dequeue.patch")
set(ESP_VIDEO_COMPONENT_DIR "${CMAKE_SOURCE_DIR}/managed_components/espressif__esp_video")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${ESP_VIDEO_PATCH}")
stackchan_apply_managed_component_patch(
    "${ESP_VIDEO_COMPONENT_DIR}" "${ESP_VIDEO_PATCH}" "esp_video bounded dequeue")

set(ESP_CODEC_IO_PATCH "${CMAKE_SOURCE_DIR}/patches/esp-codec-complete-io.patch")
set(ESP_CODEC_COMPONENT_DIR "${CMAKE_SOURCE_DIR}/managed_components/espressif__esp_codec_dev")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${ESP_CODEC_IO_PATCH}")
stackchan_apply_managed_component_patch(
    "${ESP_CODEC_COMPONENT_DIR}" "${ESP_CODEC_IO_PATCH}" "esp_codec_dev complete PCM transfers")

set(ESP_CODEC_CONTROL_PATCH "${CMAKE_SOURCE_DIR}/patches/esp-codec-control-errors.patch")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${ESP_CODEC_CONTROL_PATCH}")
stackchan_apply_managed_component_patch(
    "${ESP_CODEC_COMPONENT_DIR}" "${ESP_CODEC_CONTROL_PATCH}" "esp_codec_dev verified codec controls")
