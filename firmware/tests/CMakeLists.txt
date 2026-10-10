cmake_minimum_required(VERSION 3.16)

project(stackchan_firmware_tests LANGUAGES CXX)

enable_testing()

add_executable(motion_math_test
    motion_math_test.cpp
    ../main/stackchan/motion/motion_math.cpp
)

target_include_directories(motion_math_test PRIVATE
    ../main
)

target_compile_features(motion_math_test PRIVATE cxx_std_17)

add_test(NAME motion_math_test COMMAND $<TARGET_FILE:motion_math_test>)

# Compile the real passthrough implementation with host-only interface fixtures.
# This target never includes or links ESP-IDF, FreeRTOS, models, or hardware APIs.
find_package(Threads REQUIRED)
add_executable(no_audio_processor_test
    no_audio_processor_test.cpp
    ../xiaozhi-esp32/main/audio/processors/no_audio_processor.cc
)
target_include_directories(no_audio_processor_test PRIVATE
    no_audio_processor_stubs
    ../xiaozhi-esp32/main/audio/processors
)
target_compile_features(no_audio_processor_test PRIVATE cxx_std_17)
target_link_libraries(no_audio_processor_test PRIVATE Threads::Threads)
add_test(NAME no_audio_processor_test COMMAND $<TARGET_FILE:no_audio_processor_test>)
set_tests_properties(no_audio_processor_test PROPERTIES TIMEOUT 30)

add_executable(runtime_safety_test runtime_safety_test.cpp)
add_executable(i2c_runtime_test i2c_runtime_test.cpp ../xiaozhi-esp32/main/boards/common/i2c_device.cc)
add_executable(codec_runtime_test codec_runtime_test.cpp
    ../xiaozhi-esp32/main/audio/audio_codec.cc
    ../main/hal/board/cores3_audio_codec_runtime.cc)
foreach(test runtime_safety_test i2c_runtime_test codec_runtime_test)
    target_include_directories(${test} PRIVATE runtime_stubs
        ../xiaozhi-esp32/main ../xiaozhi-esp32/main/audio
        ../xiaozhi-esp32/main/boards/common ../main/hal/board)
    target_compile_features(${test} PRIVATE cxx_std_17)
    target_compile_options(${test} PRIVATE -UNDEBUG)
    target_link_libraries(${test} PRIVATE Threads::Threads)
    add_test(NAME ${test} COMMAND $<TARGET_FILE:${test}>)
    set_tests_properties(${test} PROPERTIES TIMEOUT 30)
endforeach()

add_executable(websocket_endpoint_test websocket_endpoint_test.cpp)
target_include_directories(websocket_endpoint_test PRIVATE runtime_stubs ../xiaozhi-esp32/main)
target_compile_features(websocket_endpoint_test PRIVATE cxx_std_17)
target_compile_options(websocket_endpoint_test PRIVATE -UNDEBUG)
add_test(NAME websocket_endpoint_test COMMAND $<TARGET_FILE:websocket_endpoint_test>)
set_tests_properties(websocket_endpoint_test PROPERTIES TIMEOUT 30)

find_package(Python3 REQUIRED COMPONENTS Interpreter)
foreach(test test_firmware_runtime_contracts test_managed_component_patches test_xiaozhi_patch)
    add_test(NAME ${test} COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/${test}.py)
    set_tests_properties(${test} PROPERTIES TIMEOUT 30)
endforeach()
add_test(NAME test_codec_i2s_adapter COMMAND ${Python3_EXECUTABLE}
    ${CMAKE_CURRENT_SOURCE_DIR}/test_codec_i2s_adapter.py ${CMAKE_CXX_COMPILER})
set_tests_properties(test_codec_i2s_adapter PROPERTIES TIMEOUT 30)
foreach(test test_audio_output_epoch test_codec_control_errors)
    add_test(NAME ${test} COMMAND ${Python3_EXECUTABLE}
        ${CMAKE_CURRENT_SOURCE_DIR}/${test}.py ${CMAKE_CXX_COMPILER})
    set_tests_properties(${test} PROPERTIES TIMEOUT 30)
endforeach()
