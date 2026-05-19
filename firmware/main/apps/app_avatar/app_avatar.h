/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#pragma once
#include <mooncake.h>
#include <cstdint>

class AppAvatar : public mooncake::AppAbility {
public:
    AppAvatar();

    void onCreate() override;
    void onOpen() override;
    void onRunning() override;
    void onClose() override;
};
