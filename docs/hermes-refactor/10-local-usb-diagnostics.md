# 10. Safe local USB diagnostic/control protocol

## Scope and safety contract

The ESP32-S3 physical **USB Serial/JTAG** port accepts a small diagnostic protocol.
It does not read UART/stdin, expose a network listener, shell/eval, arbitrary NVS
access, credentials, SSIDs, full URLs, transcripts, or raw request echo/logging.
Use ESP-IDF 5.5.4 with `CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y`; the USB driver is
shared with console output. No diagnostic command performs LCD direct drawing,
SPI probing, or SD mounting. Physical USB access is privileged: an attached local
host can open apps, schedule SD import, explicitly start/stop runtime listening,
and restart the device. Listening controls can enable the microphone/send audio;
use them only with explicit operator permission in the intended quiet environment.

### Bridge conversation pause for unattended diagnostics

Before opening HERMES for fixture playback or control-only checks, set
`STACKCHAN_DIAGNOSTIC_VOICE_PAUSED=true` on the existing bridge and restart it.
The flag defaults to false and is sampled once per Session. It discards audio
before buffering/decoding/STT, ignores listen controls, rejects queued prompts,
and skips fast-ack synthesis. Hello, MCP robot controls and heartbeat remain usable.
After hello, `/internal/status` reports `diagnosticVoicePaused:true`,
`readyForPrompt:false` and `reason:"diagnostic_voice_paused"`.

**This does not disable the physical microphone or firmware capture/transmission.**
The firmware startup WebSocket probe can enter Listening independently of the
bridge's auto-resume setting. Request `listen stop` and require a fresh
`device_state:"idle"` before audible checks; its ACK alone is not completion.
Keep the bridge pause enabled throughout fixture playback. To finish, return to
Launcher and verify fresh status before removing the flag (or setting false)
and restarting the existing bridge. Editing the environment does not change an
already-created Session. Do not use synthetic prompts against the children's
production conversation API to test this gate.

Requests are exact ASCII lines, at most **128 bytes excluding CR/LF**:

```text
SC_DIAG status
SC_DIAG reboot-to-launcher
SC_DIAG open setup
SC_DIAG open hermes
SC_DIAG sd prompt
SC_DIAG sd read
SC_DIAG listen start
SC_DIAG listen stop
```

Only lines starting at column zero with `SC_DIAG ` are interpreted. CR, LF and
CRLF delimit lines. Unknown commands, extra arguments, non-ASCII/control bytes,
and marked overflowing lines fail safely without echoing input. Overflow is
fully discarded until the next delimiter. Unmarked input is silently ignored.
A four-entry command queue limits memory; overload replies `queue_full`.

Replies are a single bounded JSON line prefixed with `SC_DIAG_REPLY `, e.g.:

```text
SC_DIAG_REPLY {"protocol_version":1,"command":"status","ok":true,"result":"status","state":"Launcher","app_version":"1.0","free_heap":123456,"task_stack_low_water_bytes":{"app_main":2048,"sc_diag_usb":4096},"network":{"connected":false,"scheme":"wss","host":"example.invalid"},"sd_confirmation_active":false}
```

`state` describes UI ownership (`Launcher` includes Mooncake apps, not necessarily
the Launcher screen). It changes to `Hermes` **before teardown**. Network
`connected` is Wi-Fi connectivity, not WebSocket connection health. Endpoint
metadata contains only validated scheme and hostname/address, never userinfo,
port, path, query or fragment. Invalid endpoint metadata is empty. Stack low-water
values are ESP-IDF bytes, limited to the two known live task handles; this is not
a task dump. The additive `boot` object reports an ELF SHA-256 prefix, the
ESP-IDF numeric reset-reason enum, uptime in milliseconds, the replying core,
running partition label/app offset, and the OTA state enum when available.
These identify the installed build/reset generation without reading NVS or exposing
credentials. The optional additive `device_state` field on status is a static enum:
`unavailable`, `unknown`, `starting`, `wifi_configuring`, `idle`, `connecting`,
`listening`, `speaking`, `upgrading`, `activating`, `audio_testing`, `fatal_error`.
Launcher/Setup and pre-runtime handoff/initialization report `unavailable`;
UI ownership alone is not runtime readiness. A separate acquire/release readiness
gate is published only after `Application::Initialize()` returns; status and
listening controls do not even access the lazy Application singleton before then. Older status replies without this field remain valid.
It is an atomic device-state snapshot, not bridge/WebSocket health or evidence
that an audio turn completed. Status itself does not prove that the physical LCD is healthy.

## Command outcomes

- `status`: read-only status in both ownership modes.
- `reboot-to-launcher`: replies `rebooting_to_launcher`, drains USB TX (bounded
  timeout), then calls `GetHAL().requestLauncherReturnReboot()`. If reply delivery
  fails, the diagnostic path does not request reboot. The HAL path must remain
  safe without synchronously manipulating an LVGL overlay from the input task.
  In Hermes mode it schedules marker persistence and the existing graceful runtime
  reboot on the Application main queue: close/reset protocol, stop audio, then
  restart. In Launcher mode it retains the direct marker/restart path. The ACK
  proves acceptance only; reacquire USB and require fresh Launcher status before
  treating the return as successful.
- `open setup` / `open hermes`: replies `open_requested` on accepted Launcher
  routing. Mooncake's normal close/sleep/open sequence owns activation; this is
  **not** proof of Hermes readiness/startup. Existing app configuration checks
  still apply. An unrelated active app/pending launch returns `ui_busy`.
- `sd prompt`: opens Setup through the same Launcher sequence if needed, creates
  the existing insertion-confirmation screen, then replies
  `sd_confirmation_active`. No SD probe occurs. Active unrelated Setup workers
  are not replaced. Pending navigation is bounded to three seconds.
- `sd read`: requires that Setup's insertion-confirmation screen is currently
  active (`sd_confirmation_required` otherwise). It reserves **the same Read
  button flag** on the existing `SdConfigWorker`, then drains the reply
  `boot_import_requested_restart_required` before the next mainloop update can
  consume it. Failed reply delivery cancels the reserved flag. The next worker update calls
  the existing `requestSdConfigBootImport()` path. There is no separate importer
  or normal-boot autoload. The response acknowledges scheduling, **not import
  success**. Import occurs before LCD initialization on the scheduled boot and
  restarts again after any SD attempt, including errors. Inspect the redacted
  boot result/status and physically verify Launcher after reconnecting.

- `listen start` / `listen stop`: explicit USB-only runtime controls, not public
  MCP tools. Launcher/Setup refuse with `requires_hermes` and never instantiate
  Application or start audio. Hermes handoff/initialization, provisioning,
  activation, audio-testing, upgrading and fatal/unknown states refuse with
  `runtime_not_ready`. Only runtime `idle`, `connecting`, `listening`, `speaking`
  snapshots are eligible. Accepted requests use Application's app_main schedule
  queue and public event-based `StartListening()` / `StopListening()` APIs;
  no blocking audio/channel stop or LVGL operation runs in the USB task.
  Readiness is rechecked by the scheduled callback before posting the event.
  One outstanding scheduled listen callback is allowed (`listen_busy` otherwise),
  so a stalled app_main cannot accumulate unbounded USB jobs. This guard releases
  after event posting, **not** after the requested state transition completes.
  ACK results `listen_start_requested` / `listen_stop_requested` mean only
  **request accepted**, never "listening started/stopped" or conversation success.
  Existing Application event semantics apply: start may open/connect a channel or
  interrupt speaking; an inapplicable start/stop may be a no-op. Stop is not a
  guarantee of socket teardown, reconnect cancellation, or pending-turn cancellation.
  Stop may finish a captured utterance and send it through normal STT/Hermes/TTS;
  these controls do not bypass or isolate the production conversation pipeline.
  State can change between acceptance, callback and event processing. Observe
  subsequent status `device_state` and bridge/device state, without logging audio,
  transcripts, credentials or injecting a synthetic children conversation.

In Hermes ownership status/reboot and eligible listen requests are accepted;
all UI/SD requests return `requires_launcher`. Reboot to Launcher before requesting
UI actions again.
Never retry a control automatically after a timeout/disconnect: its outcome can
be unknown. Ordinary console/ROM/panic output can corrupt a reply; the helper
ignores logs and requires a valid matching JSON response.

## Mainloop ownership

- `diagnostics::init(AppLauncher*, AppSetup*)`: called by app_main after app
  installation; installs/reuses the USB driver and starts the bounded input task.
  Failure disables diagnostics without preventing boot. No UART fallback exists.
- `diagnostics::process()`: once per mainloop iteration outside the LVGL lock;
  consumes at most one action (or advances one pending SD-prompt transition).
  App methods acquire their own LVGL lock where necessary.
- `diagnostics::markHermesHandoff()`: called before app destruction; invalidates
  borrowed UI pointers and transfers queue service to the USB task. That task
  serves status/reboot, schedules eligible listen controls on Application's
  app_main queue and rejects all UI commands. No listen API is called while
  holding an LVGL lock. Its read blocks for
  50 ms and yields at least 10 ms even under sustained traffic, rather than
  busy-spinning on default nonblocking console input.

Do not call the UI APIs or `process()` from another task. Launcher-return boot
markers suppress optional Hermes autostart for that boot even if autostart is
later enabled explicitly.

## Dependency-free Linux CLI

Close `idf.py monitor` and any other serial consumers first. Use one exclusive
host owner. The stdlib helper validates an Espressif USB Serial/JTAG `303a:1001`
`ttyACM` device (or its by-id symlink); UART adapters and pseudo-terminals are
rejected. It uses `termios`, `select`, advisory/exclusive tty locking and bounded
reads. It never issues DTR/RTS toggles, BREAK or bootloader reset sequences, and
keeps HUPCL off on close. OS USB enumeration/open behavior is outside its control;
verify the actual cable/device once before autonomous use. Prefer the device's
`/dev/serial/by-id/…` symlink for reboot/import workflows: USB re-enumeration can
change its `ttyACM` number. Resolve that symlink again on the next explicit CLI
invocation after reconnecting; the helper never reconnects or retries controls
automatically. If re-enumeration interrupts terminal-setting restoration after a
valid acknowledgement, cleanup tolerates the disconnect and always closes the
file descriptor without discarding that acknowledgement. Terminal errors before
an acknowledgement instead produce the sanitized outcome-unknown failure.

```bash
python3 scripts/stackchan_usb_diag.py --port /dev/ttyACM0 status
python3 scripts/stackchan_usb_diag.py --port /dev/ttyACM0 'reboot-to-launcher'
# After reconnecting and obtaining Launcher status:
python3 scripts/stackchan_usb_diag.py --port /dev/ttyACM0 'sd prompt'
# Explicit local acknowledgement that the intended card is inserted:
python3 scripts/stackchan_usb_diag.py --port /dev/ttyACM0 'sd read'
# Separate, explicitly approved runtime-state experiment only after Hermes is ready:
python3 scripts/stackchan_usb_diag.py --port /dev/ttyACM0 'listen start'
python3 scripts/stackchan_usb_diag.py --port /dev/ttyACM0 status
python3 scripts/stackchan_usb_diag.py --port /dev/ttyACM0 'listen stop'
python3 scripts/stackchan_usb_diag.py --port /dev/ttyACM0 status
```

Only structured matching replies are printed, never mixed serial logs. Exit
codes: 0 accepted/ok, 2 structured device rejection, 1 transport/protocol failure
with outcome unknown. Timeout defaults to five seconds (allowed range 0.1–30).
No retry, flash, reset, monitor subprocess or network action is implicit.

## Scoped verification

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/tests -p 'test_stackchan_usb_diag.py' -v
```

Tests include pure firmware parser/redaction compiled with host g++ (no ESP-IDF
build), CLI framing/matching, bounded log discard, USB-only validation and no
modem-control/HUPCL reset behavior. Listen tests compile the production handler
against synthetic host app/USB stubs: exact command parsing, Launcher/Setup and
not-ready refusal, deferred app_main API calls, one-pending-job backpressure,
readiness revocation and guard release. CLI tests check additive status, static
acceptance/refusal schema, fragmented ACKs, outcome-unknown failures and no retries.
Optional stack metadata accepts only status dictionaries with the static
`app_main`/`sc_diag_usb` labels and integer byte values from zero through 1 MiB;
unknown labels, arbitrary nested text, booleans and control-ACK metadata are rejected.
These tests do not execute real audio, USB, bridge or a firmware image.
Firmware build/flash and real serial/LCD/SD
validation are deliberately left to the parent/operator. Physical validation:
status in Launcher; rejection of SD read without prompt; visible insertion prompt
without SD access; Read acknowledgment before restart; import/restart/Launcher
recovery; Hermes handoff/status; UI rejections in Hermes; reboot return with no
stale overlays/autostart. Include overflow/queue saturation checks, no-card SD
failure, and actual LCD inspection per document 09. Never infer LCD success from
serial logs alone.

## Continuous, bounded panic evidence

For diagnostics that must retain panic evidence across requests/ACKs, use the
[continuous observer](../../scripts/stackchan_usb_observer.py). Its CLI only sends
an initial and final `status`; it never opens Hermes, enables listening, plays
sound, reads SD, restarts firmware, or contacts a conversation/profile API:

```bash
python3 scripts/stackchan_usb_observer.py --port /dev/ttyACM0 --duration 10
```

Select the actual USB Serial/JTAG port; the shared exclusive transport verifies
303a:1001 and retains its no-DTR/RTS/BREAK and HUPCL-off behavior. Duration is
bounded to 0..300 seconds. Input is read continuously without per-request input
flush. Both the complete ACK chunk and later passive input are parsed, so a hook
fragment following an ACK is not discarded. The imported single-owner API also
supports explicit Hermes/listening/Home controls, but no SD/Setup commands. Panic,
disconnect or an unknown request outcome blocks further commands in that owner;
there is no automatic retry/reset. Passive observation can still collect later
hook evidence after a panic/timeout. Controls retain the normal audio-production
and acceptance-not-completion limitations described above.

Only static saturated marker counters, allowlisted overflow-task labels and
sanitized numeric/state/boot snapshots escape the parser. General status text,
network host, arbitrary task names and raw console/error output are omitted.
Unknown overflow-task names become `unknown`; `main` maps to `app_main`, and the
15-character `encode_wake_wor` maps to the static `encode_wake_word` label. No task
handle lookup or extra firmware task-stack scanning is added. Partial log lines
are bounded to 512 bytes, protocol replies to 4096; oversized lines are discarded
until newline. No raw logs are persisted. Absence of a marker is not proof of no
panic: oversized/incomplete lines, disconnects and messages outside the fixed
allowlist can still lose evidence.

The firmware protocol has no request nonce. An ACK matching a command name is
not proof that it belongs to the latest request; buffered replies from an older
owner are a limitation. Do not replace the owner to automatically retry an
unknown control outcome. Establish actual device state/boot identity separately
before any subsequent explicit control experiment. This is another reason the
CLI stays read-only.

Exit 0 means the passive observation completed, 2 means recognized panic evidence
was retained and final status was skipped, and 1 means a sanitized unknown-outcome
failure. Neither exit 0 nor status proves physical LCD/audio health. The
[22 mocked observer tests](../../scripts/tests/test_stackchan_usb_observer.py)
cover fragmented hooks across ACKs, continued evidence after panic, bounded
storage/counters, static redaction, unknown-outcome command suppression,
read-readiness races and passive-only CLI writes; they perform no hardware/audio
or production-service calls.
