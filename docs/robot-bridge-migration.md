# robot-bridge Migration Notes

This note records what was adapted from the local `robot-bridge` reference and what was intentionally left out.

## Adopted Ideas

- Barge-in: while StackChan is receiving TTS audio, `ai-server` can decode incoming microphone Opus frames with a stricter local RMS VAD. Sustained user speech stops the current TTS stream, sends one `tts stop`, interrupts only the dedicated StackChan Hermes session, and returns to listening.
- Sentence-level TTS: Hermes replies remain final text from Dashboard `/api/ws`, but speech text is split into sentence-sized segments before calling the existing Hermes TTS helper. The first sentence can be synthesized and streamed before later sentences are processed.
- LED state display: `ai-server` sends subtle automatic LED colors for listening, thinking, speaking, and idle. Explicit `stackchan_set_led_color` calls from Hermes are treated as manual intent and temporarily suppress automatic LED updates.

## Not Migrated

- SenseVoiceSmall ASR.
- Sherpa-ONNX TTS.
- Webhook-driven conversation delivery.
- Face registration, face recognition, and per-person memory.
- Continuous camera monitoring.

Hermes-StackChan continues to use Hermes Dashboard/TUI `/api/ws`, Hermes STT/TTS helper modules, and the existing TypeScript WebSocket bridge.

## Firmware Note

Server-side barge-in works only if firmware continues sending microphone Opus frames while TTS is playing. In the currently fetched xiaozhi source, `kDeviceStateSpeaking` disables voice processing unless realtime listening/AEC mode is active, while incoming TTS audio is still decoded for playback. That means the `ai-server` detector is implemented, but hardware behavior must be checked for the selected listening/AEC mode; if no mic frames arrive during speaking, there is nothing to evaluate. Any persistent firmware-side change should be made in `firmware/main/` or captured in `firmware/patches/xiaozhi-esp32.patch`; fetched xiaozhi-esp32 dependency files should not be edited as the final source of truth.

## Future Consideration

Face tracking may be useful later as a short, explicit tool rather than as always-on identity infrastructure. A safer design would:

- Track only face position for a bounded duration.
- Avoid face registration, identity labels, and persistent storage.
- Require low-frequency camera frames from firmware while the tool is active.
- Keep person registration disabled by default, especially in clinic, visitor, or other privacy-sensitive environments.
