# Firmware UI Simulator Skill

Use this skill when changing StackChan firmware LVGL display code, avatar skins, avatar modifiers, status/chat bubble UI, or anything that should be visually checked before flashing an M5Stack.

## Purpose

The desktop UI simulator gives a fast macOS check for the 320x240 StackChan avatar surface. It reuses the firmware `DefaultAvatar`, `BreathModifier`, and `BlinkModifier`, while keeping production ESP-IDF firmware builds isolated from SDL and desktop CMake settings.

## Clean Environment Rules

- Do not run `sudo`.
- Do not run `brew install`, `brew upgrade`, or `brew link`.
- Do not run global `pip install` or `npm install -g`.
- Do not edit `~/.zshrc`, `~/.bashrc`, `~/.profile`, `~/.config`, or other user-global settings.
- Keep simulator build output in `firmware/tools/ui_sim/build*`.
- Keep fallback fetched dependencies in `firmware/tools/ui_sim/.deps`.
- Do not change ESP-IDF global state or production `sdkconfig` for simulator work.

## Common Commands

Visible window:

```bash
./scripts/run-ui-sim.sh
```

Scenario playback:

```bash
./scripts/run-ui-sim.sh --scenario firmware/tools/ui_sim/scenarios/avatar_smoke.json
```

Headless smoke test:

```bash
./scripts/run-ui-sim.sh --headless \
  --scenario firmware/tools/ui_sim/scenarios/avatar_smoke.json \
  --screenshot /tmp/stackchan-ui-smoke.ppm
```

Clean outputs:

```bash
./scripts/clean-ui-sim.sh
```

## Recommended Flow Before Flashing

1. Run the headless smoke test and confirm it exits successfully.
2. If a GUI is available, run visible scenario playback and inspect avatar layout, breath/blink motion, emotion changes, chat bubble, and status indicator.
3. Run production firmware build if ESP-IDF is available:

```bash
cd firmware
idf.py build
```

4. Flash hardware only after simulator and firmware build checks are clean.

## Hardware-Only Checks

The simulator cannot validate LCD panel drivers, real touch input, backlight/PMIC behavior, camera, audio, servo motion, IMU/head-pet gestures, physical LEDs, Wi-Fi provisioning, or WebSocket runtime behavior.

## Troubleshooting

- If SDL2 is missing, use `--headless`; visible mode requires SDL2 via `pkg-config`.
- If CMake is missing, report it and do not install it from the agent.
- If Japanese text renders as missing glyphs, treat it as a known font coverage limitation unless the task is specifically about fonts.
- If a simulator change requires editing production display code, keep it minimal and verify `idf.py build`.

## Production Build Safety

Never include `firmware/tools/ui_sim/CMakeLists.txt` from ESP-IDF CMake. Simulator-specific LVGL config, SDL usage, and HAL stubs must remain under `firmware/tools/ui_sim/`.
