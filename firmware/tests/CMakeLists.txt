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
