# Isolated latency baseline

These are component measurements, **not** end-to-end voice-turn latency, real-child
speech accuracy, or cold-start results. No OS/model caches were flushed. The first
request/process in a sequence must not be called a cold start.

## Repeatable standalone ASR measurement

From the repository root, with the native Sano CLI/assets already present and the
standalone Whisper endpoint already running:

```bash
env -i PATH=/usr/bin:/bin node ai-server/scripts/benchmark_asr.cjs
```

[benchmark_asr.cjs](../../ai-server/scripts/benchmark_asr.cjs) uses only the literal
`http://127.0.0.1:8792/v1/audio/transcriptions` endpoint and `whisper-v3:turbo`.
It does not start/stop services, read dotenv files, import bridge/profile clients,
contact children/personal/LLM/history APIs, record a microphone, or play audio.
Native synthesis also inherits only a fixed `PATH`; no credentials or configuration
from the caller are forwarded. Existing runtime files under `ai-server/.sanotts`
are used without downloads or setup changes.

The public fixture `public-ja-weather-walk-v1` is fixed in the script:
「今日は良い天気ですね。明日は公園で散歩をします。」
It is synthesized once by the native Sano CLI, then the same WAV is submitted in
three sequential ASR calls. Each call has a 15-second whole-request/response
deadline and a streamed response limit of 64 KiB; redirects and non-200 responses
fail closed. Native synthesis has a separate 30-second deadline. A unique private
temporary directory (0700) and WAV (0600) are removed only after checking the
original absolute directory target and identity. Signals abort pending work and
cleanup waits for the native process to exit.

Output is JSON metadata only: fixture ID, synthesis/request elapsed milliseconds,
WAV size/duration, and similarity score. No recognized text, response/error body,
URL, profile, transcript, credentials, or filesystem path is logged. Failures emit
a fixed sanitized error code and exit nonzero. Missing runtime/service does not
trigger a fallback.

Similarity is `100 × (1 − Levenshtein distance / max(normalized lengths))`, using
Unicode code points after NFKC normalization, lowercasing, and punctuation/spacing
removal. This synthetic-fixture score is not a general ASR accuracy metric.
Request timing covers multipart submission through bounded JSON response parsing;
synthesis, similarity calculation, LLM, VAD, firmware, networking to the device,
TTS response, and playback are outside ASR elapsed time.

### Current script run

Recorded during this implementation using the fixture above and the already
running standalone endpoint:

| Metric | Measurement |
| --- | ---: |
| Fixture synthesis + WAV read | 70.83 ms |
| WAV | 130,604 bytes / 2.961 seconds |
| First ASR request | 358.65 ms |
| Repeated ASR requests | 365.93 / 366.49 ms |
| Repeated mean | 366.21 ms |
| Similarity | 95.45% for all 3 calls |

## Historical component observations (different sequences)

- Native Sano one-shot eight-call warm-cache sequence: first 40.42 ms; repeated
  median 37.82 ms, range 36.28–42.94 ms; WAV 54,316 bytes / 1.231 seconds. Scope is
  process launch, synthesis and WAV read, excluding LLM/playback/VAD. See
  [benchmark_sanotts.cjs](../../ai-server/scripts/benchmark_sanotts.cjs).
- Earlier standalone Whisper three-call synthetic sequence: WAV 97,836 bytes /
  2.218 seconds; first 398 ms, repeats 336 / 340 ms, repeated mean 338 ms;
  similarity at least 75% in 3/3 calls. Its fixture is unknown, so the new script
  does **not** reproduce that exact audio, score, or timing sequence.

VAD's 650 ms setting remains unchanged; it is not measured by either component
benchmark. Do not add these timings together and present them as a measured
end-to-end turn.

## Firmware status is separate

A spontaneous AFE queue assertion (`uxItemSize` invalid) was captured before Home.
It is distinct from a deliberate graceful Home reboot. Component ASR/TTS timings
neither establish a firmware fix nor explain the device/session disappearance.

Controlled application-only comparisons preserved NVS, OTA metadata and the
existing assets partition. The stable processor-off image was retained for
rollback. All windows below are bounded observations, not long-term reliability
or real-child conversation tests:

| Configuration | Observed result |
| --- | --- |
| Processor off, wake AFE retained; ELF `538ad9bbb0fa95b8` | 65.124 s observed, 56.085 s connected, bridge readiness seen, no panic/reset captured. A separate healthy-session USB Home-equivalent request reached a fresh Launcher in 4.176 s with software reset reason 3; a later status remained Launcher after approximately seven minutes. |
| Original wake + voice AFE, light heap poisoning; ELF `8dce4489359bbe12` | 65.034 s observed, repeated approximately 10 s disconnects/reconnects, no bridge readiness. No panic/corruption marker captured, but conversational operation was not reached and voice-processing execution was not established. This changes heap layout and does not exclude memory corruption. |
| Wake disabled with a runtime selection guard, voice AFE retained, normal heap settings; ELF `4c820afb594808ad` | Ready at approximately 8.561 s; 65 s window ended in native `listening`, same reset reason and increasing uptime, with the wake-disabled marker and no captured panic. The first explicit USB `listen stop` was followed by a panic before stop/resume cycles or Home could be validated. |

The last comparison changes two normalized configuration keys relative to the
saved original AFE configuration (`CONFIG_WAKE_WORD_DISABLED` and
`CONFIG_USE_AFE_WAKE_WORD`). It also includes the new selection guard and USB
controls, so it is not a code/heap-identical comparison. Configuration flags alone
were insufficient: the retained assets contain wake models, and the old
`AudioService::SetModelsList()` selected wake detection from those models regardless
of the disabled flag. The guard makes disabled wake detection take precedence,
without changing assets. Model-free host tests compile the actual selection
method for disabled, S3, P4 and other-target cases; they do not test ESP-SR itself.

The last panic's filtered PCs were symbolized against its matching immutable ELF:
`panic_abort` → `esp_system_abort` → `vApplicationStackOverflowHook` →
`vTaskSwitchContext` → `_frxt_dispatch` → `_frxt_int_exit`. The overflowing task name
was not retained. This is a stack-overflow-hook invocation, not the earlier
`xQueueSemaphoreTake` assertion, and does not prove an AFE reset/fetch race or a
multi-instance library bug. Startup stability alone is insufficient to ship this
voice-AFE configuration. The exact previously stable processor-off application
and configuration were restored after this failure.

USB ACKs report acceptance, not completion; physical Home touch, precise LCD colors,
JBL audibility and child end-to-end response/naturalness still require separate
verification. Processor-off operation loses device noise reduction/local VAD and
is a workaround, not an AFE root-cause fix. The children's 650 ms host VAD pause
allowance remains unchanged.

Earlier parent regression run: bridge build and 158 Node tests passed, including
17 new mocked explicit-stop cases. A healthy host VAD with no detected utterance
now discards Opus/pre-roll capture on explicit stop and remains idle without
ASR/Hermes/TTS; detected speech and disabled/uncertain VAD keep their established
behavior. The children's 650 ms normal VAD end is tested unchanged. This is not a
profile-isolated microphone diagnostic mode: legitimate detected speech still
uses the normal conversation pipeline. The tested bridge was restarted while the
device was in Launcher; its loopback status endpoint subsequently reported
`no_device_session` with no service restart loop.

24 USB-helper tests passed, including bounded status-only numeric stack metadata
and production-extracted initialization-gate
publication and handler checks. The previous 7 firmware Python tests (including
four model-selection variants) and both native host CTest targets passed. The
updated USB controls were also built with the exact saved processor-off
configuration, without changing global firmware defaults. Firmware builds and
bounded hardware observations remain separate from hardware-free tests.

### Updated stable diagnostics on hardware

The latest installed image uses that saved processor-off configuration; ELF
prefix `69c01a28ed4f1f63`, application SHA-256
`8f7d117fc60cf462d7bdba03f5c3785a6da8f989a9df41d25f6d16ecc0bc0c1c`.
The application-only flash was hash-verified. Launcher rejected `listen start`;
manual Hermes open then ran for 65.004 seconds with bridge readiness observed,
unchanged reset reason/partition, and no captured assert, Guru Meditation,
stack-overflow, stack-canary, abort or heap-corruption marker. Two quiet explicit
stop/start cycles each reached native idle + bridge `state_idle`, then native
listening + bridge `ready`. Minimum observed stack headroom was 3308 bytes for
app_main and 3216 bytes for sc_diag_usb. USB Home-equivalent ACK returned to
Launcher in 3641 ms with software reset reason 3, the same ELF/ota_0/app offset,
and OTA state 2; bridge status became `no_device_session`.

A contemporaneous external-webcam capture was visually inspected: the physical
LCD showed a complete two-eye/mouth face on a blue background, with no visible
bottom HERMES label or app-icon remnant. Bright face elements remain clipped,
so this verifies shape/handoff, not precise colors. Camera controls were not
changed. Neither this bounded run nor the host tests establish lifetime
stability or resolve the voice-only AFE stop panic. Physical Home touch, actual
children's speech/noise robustness, JBL audibility and end-to-end naturalness
remain unverified; no synthetic production children conversation was created.

### Next AFE stop investigation

Before another voice-AFE comparison, retain the overflowing task identity using
one continuous, bounded USB observer rather than enlarging stacks or adding
unsafe global task dumps. The IDF hook grammar is
`***ERROR*** A stack overflow in task <name> has been detected.` Keep only an
allowlisted static identity/counter, or `unknown`, never arbitrary task/log text.
The real app_main task name is `main`; `audio_communication` is truncated to
`audio_communica` by the current 16-byte task-name limit. Querying the untruncated
name with `xTaskGetHandle()` would assert. The current CLI's per-request input
flush and log discard can lose evidence; an observer must retain all incoming
bytes through commands and ACKs before applying bounded parsing.

Keep the two existing persistent-task headroom measurements for the first
comparison. Name lookup followed by stack scanning does not protect dynamic
handles from deletion; `AudioService::Stop()` during reboot/upgrade cooperatively
requests worker exit; workers self-delete, and Stop is not a task join. Ordinary
listen start/stop preserves these tasks. Failed
upgrades can recreate these tasks. General audio-task metadata would need an owner-side,
lifecycle-synchronized numeric snapshot, not raw public handles. High-water
values represent historical untouched stack bytes, not instantaneous free space;
a canary failure does not distinguish exhaustion from overwrite. Collect just
before the first stop, halt controls on panic/disconnect, and test Home only after
startup/activation settles. Pre-init scheduling safely defers until Run, but it
does not itself prove startup teardown/activation concurrency safe.

### Continuous observer implementation and passive check

The [continuous host observer](../../scripts/stackchan_usb_observer.py) is now
implemented, with [22 hardware-free tests](../../scripts/tests/test_stackchan_usb_observer.py)
in addition to the 24 USB-helper tests. It retains bounded static panic/task
counters across ACKs without input flush or raw-log persistence, and prohibits
later commands after recognized panic, disconnect or unknown request outcome.
Its CLI only requests status and passively observes; it does not enable audio,
create conversations, or flash/restart the device. See
[the safety contract](10-local-usb-diagnostics.md#continuous-bounded-panic-evidence).

A separate 3-second passive check on the unchanged stable firmware reported
Launcher/unavailable before and after, ELF `69c01a28ed4f1f63`, reset reason 3,
ota_0/app offset 0x20000/OTA state 2, and uptime increasing from 3,855,129 to
3,858,139 ms. Both snapshots reported 8,124,040 free-heap bytes and task headroom
4812/5072 bytes for app_main/sc_diag_usb. No allowlisted panic marker or overflow
hook was retained. This is a passive evidence-path smoke check, not a new AFE
experiment or proof that the old panic's task identity is known. No speaker,
microphone, display/configuration, firmware image, or service setting was changed.

### Earlier bridge cancellation verification and deployment

The parent independently rebuilt the bridge, strict-typechecked the new
cancellation/explicit-stop tests and passed all 216 Node tests. The 19
[Sano/session cancellation mocks](../../ai-server/test/session_sanotts_cancel.test.ts)
guard turn/playback ownership, late completion and fast-ack warmup lifetime.
Another 39 mocked local-output cases cover
[process cancellation and bounds](../../ai-server/test/local_audio_cancel.test.ts)
and [M5 volume ownership/ACK ordering](../../ai-server/test/session_local_audio_cancel.test.ts).
All new cases mock native processes, audio, timers and services; no synthetic
children's production conversation or real JBL playback was performed. The
combined USB-helper/observer regression run passed 46 Python tests. The staged
Sano submodule/index entries and vendor patch were preserved, and the installed
stable processor-off configuration remained byte-identical to the saved baseline.

Local target resolution uses the playback signal and bounds each `wpctl` command
to 3 seconds/64 KiB stdout. `pw-play` uses a numeric target and nonempty WAV input
bounded to 8 MiB, defaults to a 60-second deadline (clamped 1..120 seconds), and
SIGKILLs on abort/deadline while awaiting close/reap. Diagnostics are static and
stderr is discarded. An aborted/late resolver cannot mute M5 or start old audio.
Mute/restore operations are serialized through their MCP ACK/deadline; the owner
is recorded before issuing mute, and cancellation queues restore independently
of pending synthesis/process settlement. Old completion/restore cannot change a
new playback owner's volume, and a new M5 fallback waits for earlier volume ACKs.
No permanent volume/NVS change is introduced.

Limitations: closed/unavailable WebSocket or failed restore ACK cannot guarantee
physical M5 volume restoration; late outgoing commands are suppressed after close.
At this checkpoint playback still piped RIFF/WAVE bytes to raw stdin and retained
legacy `EPIPE` handling. The JBL return below exposed and replaced this incorrect
container-input behavior. Process close code is not proof of audibility. Actual
speaker-drop/reconnect behavior and child response latency/naturalness were still
pending. Hermes-selected TTS retains its existing provider API;
turn guards discard stale results, without claiming remote synthesis cancellation.

The reviewed build was deployed by restarting the existing user bridge service
while the device remained in Launcher. Its loopback status returned HTTP 200,
`success: true`, `connected: false`, `reason: no_device_session`; service state was
active/running with NRestarts 0 and ExecMainStatus 0. The stable firmware was not
flashed again. At this checkpoint JBL remained unavailable, so no further speaker
probing or experimental AFE flash was performed.

### JBL return: WAV container playback correction

After the user reconnected JBL, its PipeWire sink was detected; the bridge was
active/running with no restart/error count, and the unchanged device was still in
Launcher (ELF `69c01a28ed4f1f63`, reset 3, uptime 49,347,550 ms). Fixed Japanese
speech was synthesized locally while M5 remained in Launcher; no fixture was
submitted to the children's production conversation API.

This exposed a real format bug: `pw-play --target <numeric> -` treats stdin as raw
PCM with defaults 48 kHz/stereo/s16, not as a RIFF/WAVE container. The first Sano
fixture was 135,212 bytes, 22,050 Hz/mono/PCM16 (~3.065 s); the old stdin path
finished in 828.99 ms. Passing the same container as a WAV file took 3169.83 ms.
The user reported a very quiet, short utterance; subjective speed/naturalness
confirmation was still pending. This is a roughly 4.35x raw-frame duration
mismatch, not evidence that model synthesis was slow.

[The playback helper](../../ai-server/src/local_audio_output.ts) now snapshots
bounded RIFF/WAVE bytes into a generated private directory (0700) and fixed WAV
file (0600, exclusive create), then gives `pw-play` that absolute filename with
stdin ignored. libsndfile reads the source rate/channels/format without guesses.
No target-serial or M5 queue/ownership change was made. Every awaited setup step
rechecks cancellation. The process is SIGKILLed on abort/deadline and close/reap
is awaited before removal; the absolute generated prefix/parent is checked before
every delete. Diagnostics are static; file setup and cleanup do not expose audio,
text or filesystem paths. The obsolete raw-stdin/EPIPE policy is removed.

The process deadline still starts at spawn (default 60 s, clamp 1..120 s), not at
filesystem setup. Non-abortable setup and cleanup operations are awaited; aborted
setup cannot later spawn a player. A cleanup failure is reported as a static
error and may leave audio in its private directory for OS/admin cleanup. Process
exit 0 still cannot establish audibility, and physical M5 restoration after a
closed socket/failed ACK remains unproven.

Both scoped test files mock filesystem, OS temp location, child processes and
HTTP. They cover unchanged container bytes, private modes, setup cancellation,
mutation isolation, unsafe cleanup paths, reap-before-delete, cleanup errors and
M5 restoration/new playback during a pending file write. Parent-independent build,
strict typecheck of all four cancellation/explicit-stop tests, full 236 Node tests
and scoped whitespace checks passed; frozen source/test hashes matched the review.
The corrected build was deployed by restarting the existing bridge service in
Launcher. Loopback status again returned HTTP 200/success/no_device_session;
service active/running, NRestarts 0, ExecMainStatus 0. No firmware flash was needed.

A longer fixed 301,612-byte fixture (~6.838 s, same PCM format) was replayed at
55% JBL volume with file input (6978.72 ms), then through the corrected helper
(9040.25 ms, concurrent regression build/test load). These are whole-process
completion timings, not first-audio or child end-to-end latency. Volume 55% is a
live test setting at that checkpoint; the configured value was still 35% pending
user feedback. The stable processor-off firmware was retained throughout.

The user subsequently requested immediate replays and gave provisional positive
feedback (「よさそう」「わるくはない」). One immediate attempt failed with a static
error whose stage was not retained; no root cause is claimed. A fresh status
check confirmed no device session and a JBL sink with numeric ID 73 (previously
107). The bounded retry completed in 6978.08 ms; another requested replay also
completed successfully at 55%. IDs are resolved anew for each playback.

The local configured output volume was then changed from 35% to 55%. With no
device session, the existing bridge was restarted successfully: active/running,
NRestarts 0, ExecMainStatus 0, HTTP 200/success/no_device_session. This feedback
accepts the isolated speaker test provisionally, not a completed child conversation
or a measured end-to-end latency target. M5 route mute/restore, sustained natural
conversation and speech-to-reply latency remain pending. No device start/listen
command was issued at that checkpoint; connected listening acceptance was deferred
while the user was away. The user's later unattended-diagnostics authorization
permits bounded audio tests, but never fixture speech/prompts into the children's
production conversation.

### Unattended isolated synthesis/encoding baseline

Three sequential local-only runs per public fixture used Sano's CLI and the
whole-WAV Opus encoder with **explicit zero lead silence**. No environment file,
STT, LLM, children profile/API or speaker playback was used. Values include
subprocess completion and checked temporary-file cleanup; zero private temporary
directories remained afterwards.

| Fixture | WAV bytes / duration / Opus frames | Synthesis ms (3 runs) | Encoding ms (3 runs) | Combined ms (3 runs) |
| --- | --- | --- | --- | --- |
| 「はい。」 | 17,452 / 394.74 ms / 7 | 44.13, 23.92, 22.16 | 17.85, 5.77, 4.83 | 61.98, 29.69, 26.98 |
| 「今日は何をして遊んだの？」 | 68,140 / 1544.13 ms / 26 | 42.96, 44.42, 44.62 | 17.64, 16.90, 16.90 | 60.60, 61.32, 61.51 |
| Previously documented public JBL fixture, 58 characters | 301,612 / 6838.28 ms / 114 | 138.10, 139.54, 139.42 | 67.22, 65.42, 68.41 | 205.32, 204.97, 207.83 |

These tiny samples establish component timings only, not cold-start guarantees,
physical JBL onset/drain, sustained conversation, percentiles or child end-to-end
latency. [Session synthesis](../../ai-server/src/session.ts) still synchronously
encodes the complete WAV before playback. Cached fast acknowledgements use
`STACKCHAN_TTS_PREROLL_MS`, unlike this zero-lead benchmark, and complete before
Hermes LLM submission. The configured lead silence, VAD end delay, STT, serialized
ACK playback and LLM response time remain separate parts of the conversational
latency budget; fast ACK sound is not proof that LLM processing has started.
The live settings at this checkpoint are VAD end 650 ms, TTS lead 600 ms,
fast ACK enabled, auto-resume listening enabled and barge-in disabled. They were
not retuned based on this artificial zero-lead component benchmark.

### Explicit volume ACK validation

[The firmware getter](../../firmware/main/hal/board/stackchan.cc) previously mapped
codec volume `0` to reported `10`. Inspection confirmed the CoreS3 codec setter
accepts zero: the observed `10` was a **reporting error**, not proof that physical
mute failed. Both getter paths now clamp to 0..100 and retain legitimate zero.
Temporary setter/NVS preservation, vendor startup handling of stored nonpositive
volume, LCD reset order/SPI settings and processor-off configuration are unchanged.
A first compile caught ESP-IDF's `int32_t`/`int` template mismatch in the NVS
fallback; explicit `std::clamp<int32_t>` fixed it. The subsequent build passed,
with sdkconfig byte-for-byte unchanged.

[The bounded pure ACK parser](../../ai-server/src/speaker_volume_ack.ts) accepts
explicit integer volume objects, JSON strings and single-text MCP wrappers. It
rejects generic boolean success, missing/malformed/noninteger/out-of-range/error
or ambiguous results; unwrapping is limited to six levels and 4096 cumulative
string characters. [Session output setup](../../ai-server/src/session.ts) requires
an ACK reporting exactly zero before enabling native playback. Unverified mute
attempts the existing queued M5 restoration/fallback; restore success is logged
only for the configured volume. There is no blind retry, result-content logging,
HTTP/MCP protocol change or change to cancellation/identity ownership.

The realistic MCP volume fixture and new nonempty Opus fallback/restore/parser
regressions add 11 mocked tests. Independent validation passed bridge build,
all **257 Node tests** and **46 Python USB tests**; strict scoped typechecking of
ACK, pause and cancellation tests passed. A broad all-test strict typecheck still
reports three unrelated existing test errors (one deferred void resolve argument,
two asynchronous mocks of the synchronous Opus decoder); production compilation
and runtime tests pass. No test executed real audio or a conversation/profile API.

The verified 3,764,864-byte app (`c7c09817d660dbae` SHA-256 prefix; ELF
`87b01ca64539b609`) was flashed only at confirmed `ota_0` offset `0x20000`.
Esptool verified its data hash; NVS, partition table, bootloader and assets were
not written. Fresh USB status verified the new ELF, Launcher/unavailable state,
autostart off during subsequent runtime status and successful Listening-to-Idle
control under the live diagnostic gate. The isolated JBL sink was unavailable
at the current check; no repeated Bluetooth reconnect was attempted, and no new
Client→Node→Link route proof or JBL first-audio/physical-mute claim is made.

The final gated hardware run confirmed actual Listening, then fresh Idle before
speaker controls. Real MCP temporary mute ACK **0** and independent status
readback **0** now agree; restore ACK **62** and readback **62** agree. Host matches
the configured LAN bridge, SD error is false and autostart is false. One bounded
native M5 tone (440 Hz, 200 ms, amplitude 1200; 4800 frames at 24 kHz) completed
only in verified Idle with conversation ingress paused. The codec reported input
already enabled and output initially disabled; the tone kept output enabled for
its final zero tail. Idle/host gating is not a claim that physical mic capture was
stopped. No speech fixture or prompt entered the production children's pipeline.
Volume remained 62 after the tone.

Launcher return acceptance was followed by fresh Launcher/unavailable status:
reset reason 3, new ELF prefix unchanged, `ota_0` still valid (state 2), approximately
8.13 MB free heap; a later independent read-only check also passed. The continuous
successful experiment observed no panic/assert/stack-overflow markers. An earlier
preflight had wrong expected status casing/key (no control issued); another run
rejected unexported firmware tool names at HTTP before any mute or tone. These
were corrected to `Launcher`, `elf_sha256_prefix` and public `stackchan_*` names.
After that earlier software return, initial and independent read-only status
requests timed out without observed panic markers. Mutating controls were not
blindly retried; one separately authorized esptool hardware reset, without any
flash write, re-established identity before the final successful experiment.
The earlier return showed reset reason 7 rather than 3; its cause is **unproven**,
and the final success does not establish that all future returns are stable.

Manual webcam exposures were tested with saved/restored controls and settled
stream frames; restoration reported no errors and auto mode returned to 3. One
low-exposure frame was almost black, and the moderate frames show a small lit LCD
but are too distant/clipped to validate glyphs, color accuracy, avatar geometry or
absence of old icon remnants. Neither the dark capture nor serial success proves
LCD failure/success. No LCD, SPI, SD or AFE tuning was made to compensate for
camera limitations. Final cleanup removed the temporary diagnostic-pause override
and restarted the **existing** bridge in verified Launcher state. The loopback
control endpoint returned success, disconnected / `no_device_session`, and the
unit reported active/running, exit status 0, no automatic restarts. Firmware
autostart remains off, so normal use still starts by explicitly opening HERMES.

### Cached native ACK: eliminate the M5-only silent-prefix wait

A further [session review](../../ai-server/src/session.ts) found that ordinary
native segments already encode with zero preroll, but cached ACKs reused the
M5 cache containing the configured 600 ms prefix. The native WAV has no such
prefix. Even while M5 was muted, streaming those extra silent avatar frames kept
`trySpeakFastAck` waiting before the LLM request and delayed mouth synchronization.

Warmup now synthesizes each ACK **once**, caches both M5-prerolled and zero-lead
native frame arrays from the same complete WAV, and publishes only a complete,
non-aborted cache. The native variant is selected **after** sink setup and verified
mute ACK 0. An absent sink or unverified mute keeps the original M5 frame array
and its configured prefix. No cached frame array is truncated/mutated. Cancellation,
process close/reap/cleanup, restoration ACK and serial ACK-before-LLM barriers
remain unchanged; no concurrent Hermes request or tool execution was introduced.
The configured VAD/preroll values and provider-switch behavior were not retuned.

A fresh offline Sano/Opus-only measurement for 「はい。」 yielded 17,452 WAV bytes:
600 ms lead produced **17 frames / 1020 ms** scheduled stream (encoding 18.54 ms);
zero lead produced **7 frames / 420 ms** (encoding 7.75 ms). Neither production
configuration nor a conversation/profile API was loaded, and no audio was played.
The eliminated difference is 10×60 ms of frame scheduling, **not a guaranteed
600 ms end-to-end gain**: native process duration/cleanup and volume ACK latency
still bound completion, and real JBL first-audio/drain is unmeasured here.
The extra encoding occurs once at cache warmup, not once per utterance.

Five additional fully mocked tests cover matching native frames, missing-sink and
unverified-mute M5 prefixes, same-WAV dual encoding without extra synthesis, and
abort during native-cache encoding preventing partial publication. The existing
nonempty Opus/native-close/cleanup/restore and stale-generation regressions still
pass. Independent bridge build, all **262 Node tests**, and scoped strict ACK/
pause/cancellation typechecking passed. Current passive checks still report no
JBL sink; no Bluetooth reconnect loop, speech fixture injection or physical
latency claim was made.

### Exceptional Launcher reset: source-supported limits

A read-only trace of the installed IDF and current firmware distinguishes reset
reason **3 (software reset)** from **7 (other watchdog)**; classified interrupt
and task watchdog reasons are 5 and 6. The S3 low-level `esp_restart_noos` path
arms a one-second RTC watchdog with flash-boot protection before the normal CPU
reset. A reset/boot watchdog fallback is a plausible explanation for 7 without
captured panic output, **not an established diagnosis** of the earlier incident.
A fresh Launcher uptime proves a reset already happened; subsequent read-only
status timeouts are separate postboot responsiveness/transport evidence, not
proof of a preceding shutdown deadlock.

The intended Hermes path is delivered/drained USB ACK → deduplicated Application
queue → NVS-only Launcher/skip-SD markers → protocol close/reset → cooperative
AudioService Stop → one-second RTOS delay → restart. Stop wakes and clears queues
but does not join worker tasks; socket shutdown also has receive-task timeout/
lifetime assumptions. These deserve deterministic tests, not speculative AFE,
LCD/SPI or watchdog retuning. The preceding successful reason-3 return plus a
new passive status at uptime **1,918,539 ms**, unchanged ELF and heap 8,124,056,
no observed panic/overflow markers, proves prolonged responsiveness of this boot,
not why the previous reason-7 boot became unresponsive.

After the cached-ACK build, the existing normal bridge was restarted in this
verified Launcher state; diagnostic pause remained absent/default false. An
immediate HTTP read raced listener startup and returned connection refused.
A later independent read succeeded with disconnected / `no_device_session`;
service state was active/running, exit status 0, automatic restart count 0.
No second restart, firmware write, mutating USB retry or conversation fixture
was needed, and staged submodules/vendor patch plus the retained stash were
verified unchanged.

A new [host reboot-chain regression](../../scripts/tests/test_stackchan_launcher_reboot.py)
extracts and compiles ten complete current production C++ bodies, including USB
reply/dispatch, HAL marker/dedup/skip-SD, Application scheduling/reboot and actual
AudioService Stop. Fifteen new tests (23 bounded host scenarios plus extraction
checks) cover failed ACK/drain causing no reboot, sequential/concurrent dedup,
queued-only caller behavior, NVS-only marker ordering, open/closed/no protocol,
audio wake/queue-clear/notification and both Launcher and Hermes restart branches.
The parent independently reran these together with the existing 46 USB tests:
**61 passed**, exit 0. Host `esp_restart` is a terminal exception, and USB/NVS/
protocol/timers are stubs. Main-queue dispatch/core choice is synthetic, not
Application Run/task-pinning coverage. Neither host success nor this source trace
proves task joins, physical socket/I2S shutdown, NVS persistence/failure handling,
LCD safety, watchdog-free reboot or the cause of reset reason 7.

### Reproducible production-helper / Opus component check

The existing [Sano diagnostic](../../ai-server/scripts/benchmark_sanotts.cjs) now
retains its original native-CLI mode and adds `--pipeline`; `npm run benchmark:tts
-- --iterations 5` from the bridge directory builds and selects that mode. Three
fixed public fixtures are synthesized with the actual
[Sano helper](../../ai-server/src/sanotts_audio.ts), including process close,
WAV read and private-directory cleanup, then encoded with the actual
[Opus implementation](../../ai-server/src/audio.ts) at zero and 600 ms lead from
the same WAV. Encoder order alternates to expose first-call/cache bias. No
microphone, playback, device control or conversation/profile API is used; no
environment file is loaded. Inherited runtime/codec environment overrides still apply.
The 600 ms comparison is fixed diagnostic input, not a service-setting change.

Fresh five-process-per-fixture observations, with OS caches **not flushed**:

| Public fixture | Repeated synthesis median, including cleanup | Zero-lead encode median | Median synthesis + zero-lead encode component sum | Zero / 600 ms lead frames |
| --- | ---: | ---: | ---: | ---: |
| ACK 「はい。」 | 23.74 ms | 5.37 ms | 29.88 ms | 7 / 17 |
| Short question | 48.56 ms | 16.51 ms | 64.02 ms | 26 / 36 |
| Existing long JBL-check text | 147.39 ms | 63.78 ms | 210.52 ms | 114 / 124 |

The ACK's first helper call was 37.96 ms and first zero-lead encode 18.96 ms;
these are not proven cold-start values. The report's component sum uses each
sample's two component durations (not the sum of independent medians). Module
loading, STT, LLM, sink resolution, mute/restore ACKs, native launch/close/drain,
network frame transport and physical audio are excluded. Scheduled 60 ms frames
are not acoustic duration or proof of silence. Dual-cache sums include both
encodings but do not reproduce cache-warmup ordering on every iteration.

Iterations are bounded to 1–10, the CLI has a 60-second aggregate deadline and
signal cancellation, and only a complete report is printed. WAV size/signature,
nonempty Buffer frames, pre/post-synthesis and encoding abort checks, import-side-effect freedom,
alternating same-WAV encoding, missing repeated median and monotonic timings have
**eight mocked tests**. Independent bridge build, all **270 Node tests**, and
focused strict cancellation/diagnostic typechecking passed. The normal bridge
has no new runtime path from this diagnostic and did not require a restart.

A read-only streaming review found possible one-ahead reuse only for a single
already-received event exposing multiple new stable sentences. It was **not
implemented**: [hello handling](../../ai-server/src/session.ts#L860-L878) can
change provider during playback, and the current Hermes-TTS path lacks the
playback abort signal. Generic reuse would advance Hermes helper/tool requests;
an entry-only Sano guard would not guarantee otherwise. A per-prefetch Sano
predicate could constrain new tool overlap but still changes when a future
segment's provider is selected. Synchronous encoding also occupies the event
loop (about 64 ms for the long fixture here), so prefetch is not evidence of
zero-gap playback. Current stream consumption, provider-switch semantics,
ACK-before-LLM and native close/cleanup/restore barriers were left unchanged.

### Fresh physical capture: identify the Launcher screensaver

Another passive USB observation returned the same installed ELF prefix, reset
reason 3, Launcher state and no panic/overflow markers at uptime **4,827,251 →
4,828,259 ms** (over 80 minutes). Heap remained 8,124,056 and the two reported
stack low-water values remained 4,812/5,072 bytes. This is responsiveness of one
boot, not a deterministic reboot or general stability guarantee.

The optional `v4l2-ctl` binary was unavailable; installed FFmpeg successfully
listed video-only MJPEG/YUYV modes up to 1280×960 without installing anything.
Fresh 1280×960 automatic and three manual-exposure captures show a large panel
outline and a smaller moving, color-changing rectangle. Reading the current
[Launcher screensaver](../../firmware/main/apps/app_launcher/view/screensaver.cpp)
identifies that rectangle as the expected **64×48 colored face on a 320×240 black
screen**, not the entire LCD. Its locations and cyan/magenta/yellow appearance
change between frames, supporting **live physical display updates** rather than
serial-only success. The earlier tiny luminous rectangle should not by itself
have been interpreted as the whole panel or as an icon fragment.

Gain was temporarily 0; requested exposures 5/15/30 read back 10/20/35 after
stream startup, so the requested number alone is not the actual capture setting.
Saved exposure/gain values were restored and automatic exposure mode **3** plus
original dimensions/fourcc/frame interval were checked after cleanup. No camera
microphone, firmware change, SD access or conversation fixture was used. The
images still clip bright fills and do not resolve the small eye/mouth details
reliably. They do **not** prove glyph legibility, calibrated RGB565 colors,
full-screen tear freedom or a clean Hermes avatar handoff. Final passive host
checks retain three sinks with **no JBL sink**, active/running bridge, exit status
0, no automatic restarts and no device session; no reconnect loop was attempted.

### Guarded Hermes avatar / Launcher return: fresh physical evidence

A subsequent explicit USB experiment started in Launcher at uptime **7,314,590
ms** (over 121 minutes), with the same installed ELF prefix
`87b01ca64539b609`. A temporary **user-service runtime drop-in** set
`STACKCHAN_DIAGNOSTIC_VOICE_PAUSED=true`; no environment file or credential was
edited. The existing bridge service was reloaded/restarted, not replaced.

The single continuous USB owner then:

1. Accepted `open hermes`, observed actual firmware **Listening** with network
   connected at uptime 7,322,688 ms, and checked live bridge
   `diagnosticVoicePaused=true`, `readyForPrompt=false`,
   `reason=diagnostic_voice_paused`, **`ttsProvider=sanotts`**.
2. Accepted `listen stop` only after that gate/state proof and observed fresh
   firmware **Idle** at 7,322,903 ms. No synthetic speech/conversation was sent.
3. Kept parsing USB panic evidence while taking two video-only 1280×960 frames.
   The automatic-exposure frame shows the physical **two eyes and horizontal
   mouth** across the panel. There is no obvious retained Launcher icon or
   `HERMES` label in that captured idle frame. This is physical avatar evidence,
   not an inference from `SetupUI` logging. Its SHA-256 is
   `47b0d4b11d28e5483ae074461611b32344ba7ff696b232334328a1973a746559`.
4. Rechecked actual Idle and the gate, accepted `reboot-to-launcher` once, and
   observed fresh **Launcher**, **reset reason 3**, uptime **1,765 ms**, unchanged
   ELF and disconnected bridge. No recognized panic/overflow markers were seen.
5. Removed only the verified diagnostic runtime drop-in and reloaded/restarted
   the original service. Its normal drop-in remains; the persistent environment
   file has no diagnostic-pause assignment. HTTP reports `no_device_session`.
   A later passive USB check returned Launcher at uptime **404,619 → 405,630 ms**,
   heap 8,124,056, stack low-water 4,812/5,072 and no recognized markers.

The manual-low frame is **underexposed**, not evidence of an LCD blackout:
requested exposure 3 read back 8 after streaming, gain 0, while the successful
automatic frame read back 664/gain 131. Camera control settings were restored;
automatic mode, original geometry/fourcc and frame interval were checked. No
camera microphone, playback/tone, SD access or flash occurred. The gate does not
physically stop the M5 microphone; actual Listening then Idle was verified
separately. This is one observed successful handoff/return, not a proof of every
emotion, small glyph, calibrated color, cold boot or deterministic reset case.

JBL still did not appear among the three host sinks. Actual JBL playback and
natural end-to-end speech latency remain unverified for the current route. The
three staged object identities and retained recovery stash were checked again
and unchanged.

### Isolated local STT component measurement

A bounded readiness GET to loopback `127.0.0.1:8792/v1/models` returned HTTP 200
in 1.55 ms and advertised `whisper-v3:turbo`. This is readiness, not recognition
latency. A separate diagnostic synthesized the same fixed public Japanese
question once through the production Sano helper (**50.37 ms**), converted it
with installed FFmpeg to **16 kHz / mono / PCM16**, and used the production
`pcmToWav` wrapper. The result was 49,458 bytes and **1,544 ms** of clean synthetic
speech. Conversion uses no microphone and is not the M5 capture/Opus path.

Exactly three serial POSTs went **only** to the local transcription endpoint,
with Japanese language and `whisper-v3:turbo`, redirects refused, credentials
omitted, 20-second request deadlines and a 1 MiB response cap. HTTP plus complete
response-read times were **266.00 / 297.78 / 291.03 ms**; the last-two median was
**294.40 ms**. All three matched the public fixture after NFKC, whitespace and
punctuation normalization. Reports emitted only fixture ID, sizes, timings,
character counts, match booleans and scope, not transcript text.

No children chat API, personal Hermes API, environment-file loader, recording,
M5 control, audio playback, server restart or cache flush was used. In particular,
this did not insert a synthetic fixture into a production children's
conversation. This probes one clean Sano voice, not recognition accuracy for
children, noise, barge-in or microphone acoustics, and is not a cold-start test.

Together with the earlier short Sano+Opus measurements (~30–64 ms), this places
an additional measured component beside the configured 650 ms VAD endpoint wait.
Do not add these independent medians and call the sum end-to-end latency: real
capture/transport, queueing, ACK sequencing, LLM, device mute/restore, player
startup and acoustic onset are unmeasured. VAD/streaming concurrency was not
changed on this evidence alone.

The existing credential-free standalone diagnostic was also rerun using its
unchanged weather/walk fixture and native 22.05 kHz WAV (130,604 bytes / 2.961 s).
Synthesis+read was **72.73 ms**; ASR was **322.57 / 311.23 / 346.69 ms**, repeated
mean **328.96 ms**, similarity **95.45%** in all three runs. This complements,
rather than replaces, the shorter 16 kHz question probe and the earlier baseline;
different duration/format, cache state and host load prevent treating their
difference as an optimization result. The existing standalone command remains
the repeatable diagnostic, with its stricter 15-second / 64 KiB request bounds.

### Latest JBL readiness and remaining verification

The existing bridge remains active/running, exit status 0, no automatic restarts,
normal drop-ins only and no device session. Read-only BlueZ inspection identified
the already paired JBL Flip 3 as **disconnected**. One explicitly bounded
reconnection attempt used the existing pairing (8-second CLI limit / 10-second
process limit), then checked actual device state and PipeWire independently.
Although the Bluetooth CLI exited **0**, it remained **disconnected**, with
**three sinks and no JBL target**. CLI success was not treated as connection or
playback proof. No audio was played and no reconnect loop was started.

This condition was also present in the preceding two goal rounds. Remaining
current-route verification needs the JBL to become connected with a real output
target: prove the player PID → client → node/link → JBL sink chain, check audible
output, then measure a real consenting conversation without adding diagnostic
fixtures to the children's history. The earlier accepted JBL WAV trial and
unit/isolated timings are useful evidence but do not substitute for that final
live-route/end-to-end check. Do not report the whole objective complete yet.

Fresh final validation: `npm run build` and all **270 Node tests** passed;
ESP-IDF 5.5.4 `idf.py build` passed, with the 0x397280-byte application fitting its
0x580000 partition. Built ELF/BIN hashes still match the installed baseline; no
flash was performed. Passive USB status returned Launcher at **2,416,859 →
2,417,870 ms** (~40 minutes after Home), unchanged ELF/reset reason 3, heap
8,124,056 and stack low-water 4,812/5,072, with no recognized panic/overflow
markers. The three staged object IDs, vendor-patch worktree hash and retained
stash were checked unchanged. This final passive observation is still not a
cold-boot or indefinite-stability guarantee.

### JBL reconnected: fresh native playback proof

After the user reported reconnecting the speaker, PipeWire exposed **JBL Flip 3
sink 108**. Fresh USB showed Launcher at uptime 6,034,259 ms, unchanged ELF,
reset reason 3 and no recognized panic markers; the bridge had no device session.
A temporary verified user-service runtime diagnostic-pause drop-in protected
against conversation ingress during the public output fixture. The existing
service was restarted with that guard; no persistent environment file changed.
The M5 remained Launcher, so this was not a live firmware speech turn or a live
session-level verification of the pause flag.

One production Sano helper synthesis of the fixed public long JBL fixture
produced **301,612 bytes / 6,838 ms** of native WAV. The production target resolver
set **55% and unmuted** the named JBL sink; its identity was independently
checked before playback. The production complete-file player finished, reaped
and cleaned up in **6,971.26 ms**. A real spawn observer (no replacement/mock
player) sampled PipeWire during playback and proved:

- Player **PID 1,636,264** → PipeWire **client 74** → output **node 85**.
- Active links **81 and 86**, both **85 → JBL sink 108**.
- Volume readback **0.55**, no mute marker; the player was no longer running
  after the helper completed.

No microphone, STT, LLM or children conversation API was used. This establishes
fresh host routing and bounded native completion, not listener-confirmed
acoustics, physical onset latency, M5 mute/restore integration or whole-conversation
latency. Unlike the earlier disconnected snapshot, this current route is usable.
Fresh USB then confirmed Launcher at uptime **6,361,030 ms**, unchanged identity
and no recognized panic/overflow markers. Only the exact verified runtime guard
was removed; daemon reload/restart returned the original bridge to active/running,
exit status 0, with the normal drop-in only. No firmware flash, SD access or M5
speaker setting change occurred. Await listener confirmation before asserting
that the current playback sounded correct.

### Unattended M5 check and revised completion scope

The user authorized continuing while away. With the temporary diagnostic guard
again active, a single USB open-Hermes request reached actual **Listening** at
uptime **9,077,995 ms**. Live bridge status proved connected, diagnostic voice
paused, reason `diagnostic_voice_paused`, and provider **Sano**. A single stop
request followed by an actual USB status proved **Idle** at **9,078,426 ms**.
The public firmware status tool returned speaker volume **62** over real MCP.

The combined native-output diagnostic then aborted before target resolution
completed: there was no target ID, synthesis/encoding result or mute attempt.
Its final assertion intentionally failed rather than claiming a successful
playback/restoration test. Independent PipeWire/BlueZ inspection confirmed
**no JBL sink / disconnected / still paired**. Thus the first successful output
proof above remains valid, but is not proof of continuous connectivity. No M5
volume mutation or second clip occurred in this attempt.

Actual Idle was confirmed again, and one Home request reached fresh Launcher at
**3,272 ms**, reset reason 3 and the same ELF prefix, with no recognized
panic/overflow markers. The exact runtime pause drop-in was removed and the
original bridge restored active/running with exit status 0 and only its normal
drop-in. A single bounded reconnect attempt returned CLI status 0 but actual
BlueZ remained disconnected and PipeWire had no JBL sink; no retry loop followed.
Power, distance and automatic shutoff are possibilities, not established causes.

The user then explicitly changed the goal to **finish work other than JBL use**.
JBL connection, output, listener confirmation and JBL latency are now outside
completion scope; no further JBL operations are needed. Remaining acceptance is
non-JBL implementation/configuration, manual M5-to-bridge connection, preserved
changes, diagnostics/docs, builds/tests and normal-operation restoration. A real
human/child spoken turn and whole-conversation latency, cold-boot behavior and
indefinite stability remain unmeasured limits, not claimed successes. Public
fixtures were not submitted to the children conversation API.

Final validation for that revised non-JBL scope passed:

- Bridge build and **270/270 Node tests**; USB/Launcher **61/61 Python tests**.
- ESP-IDF 5.5.4 firmware build, same ELF/BIN hashes and partition fit; no new flash.
- Passive Launcher status **538,729 → 539,739 ms**, reset reason 3, unchanged ELF,
  heap 8,124,060 and stack low-water 4,812/5,072; no recognized panic/overflow.
- Original user service active/running, diagnostic pause removed; no device
  session while deliberately left at Launcher, not a failed Hermes connection.
- Three staged objects, Sano submodule HEAD, vendor-patch worktree hash and the
  retained stash unchanged. Scoped document/source whitespace checks pass;
  pre-existing vendor-patch whitespace remains untouched.

The revised non-JBL goal is complete within these explicit measurement limits.
JBL work is excluded rather than silently marked successful. Real spoken-turn
latency and listening quality still require a person for later acceptance.

### Pre-commit reproducibility check

The committed firmware defaults still enabled `CONFIG_USE_AUDIO_PROCESSOR`,
whereas the physically validated device used the passthrough path after failed
AFE queue/stack trials. Defaults now explicitly disable the processor to match
that device; the AFE wake-word selection is unchanged. A regression test prevents
fresh builds from silently re-enabling it. This does not overwrite an existing
local sdkconfig or claim a new cold-start hardware trial. Firmware host tests
also cover managed-component patch application, model-selection gating, motion
math and the real passthrough implementation. Python caches are ignored; model
weights, local environment/configuration and build output are not committed.
The updated defaults passed **8 firmware Python tests**, and the host build
passed both CTest targets. ESP-IDF build passed again with the existing validated
sdkconfig; no flash or JBL operation was performed for this pre-commit check.
