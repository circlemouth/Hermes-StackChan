# The following five lines of boilerplate have to be in your project's
# CMakeLists in this exact order for cmake to work correctly
cmake_minimum_required(VERSION 3.16)

set(PROJECT_VER "1.4.1")
add_definitions(-DFIRMWARE_VERSION=\"${PROJECT_VER}\")

# Add this line to disable the specific warning
add_compile_options(-Wno-missing-field-initializers)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(stack-chan)

set(ESP_ML307_PATCH "${CMAKE_SOURCE_DIR}/patches/esp-ml307-tcp-shutdown.patch")
set(ESP_ML307_COMPONENT_DIR "${CMAKE_SOURCE_DIR}/managed_components/78__esp-ml307")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${ESP_ML307_PATCH}")
if(EXISTS "${ESP_ML307_COMPONENT_DIR}/CMakeLists.txt" AND EXISTS "${ESP_ML307_PATCH}")
    execute_process(
        COMMAND git apply --check "${ESP_ML307_PATCH}"
        WORKING_DIRECTORY "${ESP_ML307_COMPONENT_DIR}"
        RESULT_VARIABLE ESP_ML307_PATCH_CHECK
        OUTPUT_QUIET
        ERROR_QUIET
    )
    if(ESP_ML307_PATCH_CHECK EQUAL 0)
        execute_process(
            COMMAND git apply "${ESP_ML307_PATCH}"
            WORKING_DIRECTORY "${ESP_ML307_COMPONENT_DIR}"
            COMMAND_ERROR_IS_FATAL ANY
        )
        message(STATUS "Applied esp-ml307 TCP shutdown patch")
    else()
        execute_process(
            COMMAND git apply --reverse --check "${ESP_ML307_PATCH}"
            WORKING_DIRECTORY "${ESP_ML307_COMPONENT_DIR}"
            RESULT_VARIABLE ESP_ML307_PATCH_REVERSE_CHECK
            OUTPUT_QUIET
            ERROR_QUIET
        )
        if(ESP_ML307_PATCH_REVERSE_CHECK EQUAL 0)
            message(STATUS "esp-ml307 TCP shutdown patch already applied")
        else()
            message(FATAL_ERROR "esp-ml307 TCP shutdown patch cannot be applied")
        endif()
    endif()
endif()
