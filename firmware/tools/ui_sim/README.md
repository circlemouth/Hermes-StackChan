# StackChan UI Simulator

This is a standalone desktop simulator for the StackChan LVGL avatar UI. It is separated from the ESP-IDF firmware build and does not change `sdkconfig`, global ESP-IDF state, Homebrew packages, shell profiles, or any user-wide configuration.

## What It Runs

- 320x240 LVGL display, matching M5Stack CoreS3 / StackChan.
- Existing `DefaultAvatar` skin from `firmware/main/stackchan/avatar/skins/default/`.
- Existing `BreathModifier` and `BlinkModifier`.
- Scenario-driven emotion, chat bubble, and status changes.
- Headless framebuffer smoke test with PPM screenshot output.

Production firmware HAL, LCD, I2C, SPI, PMIC, camera, touch, servo, and audio initialization are not linked into this simulator.

## Dependencies

Required:

- CMake 3.20 or newer
- A C/C++ compiler

Visible window mode additionally requires SDL2 discoverable by `pkg-config`.

Supported environment:

- macOS is the maintained and tested desktop target.
- Headless mode does not require SDL and is designed to be portable to Unix-like environments with CMake and a C++ compiler, but Linux and Windows desktop runs are not yet official support targets.

The scripts never run `sudo`, `brew install`, `pip install`, `npm install -g`, or shell profile edits. Missing tools are reported as errors. Build output stays under `firmware/tools/ui_sim/build*`; fallback fetched dependencies stay under `firmware/tools/ui_sim/.deps`.

The simulator uses the repository LVGL at `firmware/managed_components/lvgl__lvgl` when present. If that directory is missing, CMake fetches LVGL `v9.4.0` into `.deps`.

## Run

From the repository root:

```bash
./scripts/run-ui-sim.sh
```

Run a scenario:

```bash
./scripts/run-ui-sim.sh --scenario firmware/tools/ui_sim/scenarios/avatar_smoke.json
```

Run headless and save a smoke-test screenshot:

```bash
./scripts/run-ui-sim.sh --headless \
  --scenario firmware/tools/ui_sim/scenarios/avatar_smoke.json \
  --screenshot /tmp/stackchan-ui-smoke.ppm
```

The screenshot format is PPM (`P6`) to avoid adding image encoding dependencies. PNG output is a later TODO.

Clean simulator outputs:

```bash
./scripts/clean-ui-sim.sh
```

## Scenario Format

Scenarios are JSON arrays:

```json
[
  { "t": 0, "emotion": "neutral" },
  { "t": 1000, "chat": { "role": "assistant", "text": "こんにちは。StackChan UI simulatorです。" } },
  { "t": 2500, "emotion": "happy" },
  { "t": 4000, "status": "speaking" },
  { "t": 6000, "status": "standby" }
]
```

Supported emotions: `neutral`, `happy`, `laughing`, `angry`, `sad`, `crying`, `sleepy`, `doubtful`.

Supported status values: `speaking`, `listening`, `standby`. Unknown status text is shown in the speech bubble.

Additional regression scenarios live under `firmware/tools/ui_sim/scenarios/`:

- `emotion_cycle.json`: cycles all supported emotion strings.
- `chat_bubble_regression.json`: checks short, long, Japanese, empty, consecutive, and cleared chat bubbles.
- `status_cycle.json`: switches standby, listening, and speaking status in quick succession.
- `lifecycle_regression.json`: rebuilds the avatar scene during playback to catch duplicate setup or stale screen fragments.
- `hermes_app_launch_regression.json`: draws fake Launcher/HERMES app fragments, then loads a fresh Hermes avatar screen.
- `modifier_stability.json`: runs breath, blink, emotion, and speaking animation transitions for a longer smoke check.

Scenario events may also include `"clear_chat": true` to hide the speech bubble, `"reset_scene": true` to rebuild the simulator avatar scene, `"fake_launcher_screen": true` to draw stale app UI fragments, or `"launch_hermes_app": true` to simulate the Hermes app screen handoff.

## Troubleshooting

- `SDL2 development files were not found via pkg-config`: visible mode cannot build. Use `--headless`, or install SDL2 outside this script using your normal local development setup.
- `cmake is required but was not found`: install CMake outside this script.
- Japanese text may not render fully with the current built-in Montserrat font. This simulator checks layout and state transitions first; font coverage can be improved later.
- GUI cannot open in CI or a remote Codex session: use the headless command and inspect the generated PPM.

## Still Requires Hardware

The simulator does not validate LCD panel drivers, touch input, PMIC/backlight behavior, camera preview/capture, microphone/speaker audio, servo movement, IMU/head-pet gestures, LED hardware timing, Wi-Fi provisioning, or WebSocket runtime behavior. Confirm those on a flashed M5Stack after desktop UI checks pass.

## Production Firmware Safety

Keep simulator CMake and dependencies under `firmware/tools/ui_sim/`. Do not include simulator SDL settings from ESP-IDF CMake files, do not edit `sdkconfig` for simulator needs, and do not link production HAL into this desktop target.
