# Firmware host regressions

From the repository root, after fetching the pinned Xiaozhi source:

```sh
cmake -S firmware/tests -B firmware/tests/build -DCMAKE_BUILD_TYPE=Debug
cmake --build firmware/tests/build -j2
ctest --test-dir firmware/tests/build --output-on-failure
```

Requires a C++17 compiler, CMake, Git, Python 3.9+, and threads. No ESP-IDF or device is needed for these tests. ESP-IDF v5.5.4 is required separately for the actual firmware build.

## Audit validation result

The integrated audit fixes pass all 12 CTest targets with Debug assertions enabled, strict codec compilation (`-Wall -Wextra -Werror`), and codec ASan/UBSan with leak detection. The ESP-IDF v5.5.4 build also passes. ELF inspection places the EOF ISR, `__atomic_fetch_add_4`, and its native S32C1I implementation in IRAM; the four-byte counter is allocated separately in internal RAM. This verifies compilation/placement, not physical ISR/DMA/analog timing.

## Coverage and limits

- The existing motion and passthrough tests exercise production motion arithmetic and the real no-audio-processor implementation.
- [Runtime safety tests](<runtime_safety_test.cpp>) exercise the production admission/epoch helper, cancellation races, lock ownership, image/frame bounds, binary-audio framing, credential whitespace/NUL rejection, and URL precedence/redaction.
- [I2C tests](<i2c_runtime_test.cpp>) compile the real I2C runtime with fault-injected drivers. They cover finite retry/timeout behavior, zeroing failed reads, task-owned read-modify-write denial, and recovery.
- [Codec tests](<codec_runtime_test.cpp>) compile the real base audio codec and CoreS3 runtime methods. Only hardware constructors and driver interfaces are fixtures. Tests cover admission epochs, cached hardware mute before first open/reopen, seven post-fence TX EOFs before restore, nonblocking polling and bounded drain retries, partial/failed PCM, open/gain/volume/close errors, verified cleanup before reopen, lease renewal/expiry/disconnect/permanent override, and concurrent PCM/diagnostic/volume serialization.
- [Endpoint resolver tests](<websocket_endpoint_test.cpp>) exercise the real settings resolver and shared URL validator, including invalid-override fail-closed behavior, one-time legacy migration, IPv4/IPv6/host/port/escaping, byte preservation, and safe host-only reporting.
- [Audio output epoch tests](<test_audio_output_epoch.py>) compile extracted production admission/reset/stop/output/testing methods and the decoder block with host codec/Opus/RTOS fixtures. Deterministic barriers cover admission during reset, admission-bound epoch propagation, stale decoder reconfiguration, full-queue producer wakeup, and PCM parked across codec retirement or Stop.
- [Codec control tests](<test_codec_control_errors.py>) apply the pinned managed control patch and compile real wrapper methods. Hardware/software volume, output mute, microphone gain/channel gain/mute, format/enable/software-open, and close errors propagate without caching failed changes. Close preserves opened ownership until codec/data/software cleanup all succeed; staged hardware mute survives output reopen. The installed dependency, if present, must match those tested method bodies.
- [I2S adapter tests](<test_codec_i2s_adapter.py>) apply the managed codec patch to a complete pinned original fixture, then compile and execute the real read/write/format/enable methods with fault-injected channel functions. They reject short, zero, oversized, failed, and reconfiguration-without-transfer results; unchanged normalized formats preserve duplex clocks. Directional enable/disable failures retain the first error and retry ownership, including pending peer reconfiguration. If the downloaded dependency exists, its method bodies must match the tested patched fixture byte-for-byte; run firmware configure first if that dependency is still unpatched. The target IDF 5.5 channel calls already use a finite 1000 ms timeout.
- [Production wiring checks](<test_firmware_runtime_contracts.py>) are structural regressions, not simulated application or LVGL execution. They protect HAL lock/unlock forwarding, offline home/independent reboot escape, TTS admission/drain wiring, LCD reset/SPI invariants, touch release, bounded/deferred worker image paths (including legacy user-only tools), and restart-required/canonical endpoint contracts.
- [Managed-patch tests](<test_managed_component_patches.py>) exercise real isolated patch application, idempotence, divergence rejection, and inherited Git-environment isolation.
- [Xiaozhi patch verification](<test_xiaozhi_patch.py>) archives pinned v2.2.4 into a private temporary fixture, checks forward/reverse application, and compares all modified generated files plus the new headers byte-for-byte. It never fetches or resets the active checkout.

The whole application, LVGL, actual Opus codec/RTOS scheduling, camera driver, PSRAM allocations, and physical codec/LCD/ISR timing are not executed by the host suite. An ESP-IDF build verifies target compilation, not physical behavior. Real-device verification remains necessary for offline boot/home escape, LCD colors/reset/shared-SPI flows, Wi-Fi and I2C faults, frozen camera dequeue/requeue, allocation pressure, first-frame TTS/drain timing, and sustained PCM/volume contention.

Work deadlines and connection generations prevent queued/deferred stale effects. Already-running bounded driver I/O cannot be forcibly interrupted; cancellation is checked before the next chunk/effect. A codec lock can delay lease restoration until its current operation finishes. Diagnostic tone duration is capped at three seconds of PCM, not a hard wall-clock bound; timed-out I/O or cleanup can outlast that and the worker deadline. Lease polling does not depend on successful LVGL acquisition.
