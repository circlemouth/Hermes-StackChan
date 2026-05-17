/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include "secret_logic.h"

namespace secret_logic {

__attribute__((weak)) std::string generate_handshake_token(std::string_view data)
{
    (void)data;
    return "hi-stack-chan";
}

}  // namespace secret_logic
