# StackChan UI Simulator

This is a standalone desktop simulator for the StackChan LVGL avatar UI. It is separated from the ESP-IDF firmware build and does not change `sdkconfig`, global ESP-IDF state, Homebrew packages, shell profiles, or any user-wide configuration.

## What It Runs

- 320x240 LVGL display, matching M5Stack CoreS3 / StackChan.
- Existing `DefaultAvatar` skin from `firmware/main/stackchan/avatar/skins/default/`.
- Existing `BreathModifier` and `BlinkModifier`.
- Scenario-driven emotion, chat bubble, and status changes.
- Simulator-only preview, notification, HERMES app readiness, and screen-handoff debug states.
- Headless scenario assertions for framebuffer/layout regressions.
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
- `preview_image_regression.json`: checks simulator preview overlay visibility, foreground behavior, and clear/expiry.
- `notification_regression.json`: checks short and long notification display plus auto hide.
- `app_not_ready_regression.json`: checks HERMES app not-ready screens for missing bridge URL and Wi-Fi.
- `combined_overlay_regression.json`: checks status, chat, preview, and notification stacking.
- `modifier_stability.json`: runs breath, blink, emotion, and speaking animation transitions for a longer smoke check.

Scenario events may also include `"clear_chat": true` to hide the speech bubble, `"reset_scene": true` to rebuild the simulator avatar scene, `"fake_launcher_screen": true` to draw stale app UI fragments, or `"launch_hermes_app": true` to simulate the Hermes app screen handoff.

Simulator-only debug events:

```json
[
  { "t": 0, "preview_image": { "duration_ms": 900 } },
  { "t": 1000, "notification": { "text": "Notice", "duration_ms": 1000 } },
  { "t": 2200, "app_ready_state": "missing_url" }
]
```

Supported `app_ready_state` values are `ready`, `missing_url`, and `wifi_missing`. `ready` runs the Hermes avatar handoff path. `clear_preview` and `clear_notification` remove simulator overlays explicitly.

For the suspected "HERMES app opens but the face is not drawn" regression, run:

```bash
./scripts/run-ui-sim.sh --headless \
  --scenario firmware/tools/ui_sim/scenarios/hermes_app_launch_regression.json \
  --screenshot /tmp/stackchan-ui-hermes-launch.ppm
```

That scenario first draws fake Launcher/HERMES fragments, then runs the Hermes avatar screen handoff and asserts that the avatar face pixels are present in the central 320x240 surface while stale app fragments are gone.

Headless scenarios may include `assert` as a string, object, or array. Supported assertion types are `non_black`, `face_visible`, `no_text_fragment`, `bbox_within`, `bubble_hidden`, `preview_visible`, `preview_hidden`, `notification_visible`, and `notification_hidden`.

```json
{
  "t": 1000,
  "assert": [
    "non_black",
    { "type": "bbox_within", "target": "notification", "x_min": 0, "y_min": 0, "x_max": 319, "y_max": 239 }
  ]
}
```

## Troubleshooting

- `SDL2 development files were not found via pkg-config`: visible mode cannot build. Use `--headless`, or install SDL2 outside this script using your normal local development setup.
- `cmake is required but was not found`: install CMake outside this script.
- Japanese text may not render fully with the current built-in Montserrat font. This simulator checks layout and state transitions first; font coverage can be improved later.
- GUI cannot open in CI or a remote Codex session: use the headless command and inspect the generated PPM.

## Still Requires Hardware

The simulator does not validate LCD panel drivers, touch input, PMIC/backlight behavior, camera preview/capture, microphone/speaker audio, servo movement, IMU/head-pet gestures, LED hardware timing, Wi-Fi provisioning, or WebSocket runtime behavior. Confirm those on a flashed M5Stack after desktop UI checks pass.

## Production Firmware Safety

Keep simulator CMake and dependencies under `firmware/tools/ui_sim/`. Do not include simulator SDL settings from ESP-IDF CMake files, do not edit `sdkconfig` for simulator needs, and do not link production HAL into this desktop target.
