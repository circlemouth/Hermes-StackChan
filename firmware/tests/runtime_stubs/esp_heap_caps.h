#pragma once
#include <cstdlib>
constexpr unsigned MALLOC_CAP_INTERNAL = 1;
constexpr unsigned MALLOC_CAP_8BIT = 2;
extern bool fail_eof_allocation;
inline void* heap_caps_malloc(size_t bytes, unsigned) { return fail_eof_allocation ? nullptr : std::malloc(bytes); }
inline void heap_caps_free(void* pointer) { std::free(pointer); }
