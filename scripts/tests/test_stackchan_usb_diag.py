import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("diag", ROOT / "scripts/stackchan_usb_diag.py")
diag = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diag)


def reply(command="status", **extra):
    return {"protocol_version": 1, "command": command, "ok": True, "result": "status", "state": "Launcher", **extra}


@contextlib.contextmanager
def mocked_usb():
    """Exercise the real context manager without opening any device."""
    attrs = [0, 0, diag.termios.HUPCL, 0, 0, 0, [0] * 32]
    with contextlib.ExitStack() as stack:
        stack.enter_context(mock.patch.object(diag, "verify_usb_jtag", return_value=Path("/dev/ttyACM0")))
        opened = stack.enter_context(mock.patch.object(diag.os, "open", return_value=42))
        closed = stack.enter_context(mock.patch.object(diag.os, "close"))
        stack.enter_context(mock.patch.object(diag.fcntl, "flock"))
        ioctl = stack.enter_context(mock.patch.object(diag.fcntl, "ioctl"))
        stack.enter_context(mock.patch.object(diag.termios, "tcgetattr", side_effect=lambda _: [*attrs[:6], list(attrs[6])]))
        setattrs = stack.enter_context(mock.patch.object(diag.termios, "tcsetattr"))
        yield opened, closed, ioctl, setattrs


class ProtocolTests(unittest.TestCase):
    def test_fixed_allowlist(self):
        for command in diag.COMMANDS:
            self.assertEqual(diag.encode_command(command), ("SC_DIAG " + command + "\n").encode())
        for command in ("status\nreboot-to-launcher", "eval", "wifi secret", "status extra"):
            with self.assertRaises(ValueError):
                diag.encode_command(command)

    def test_listen_allowlist_is_explicit_and_exact(self):
        for command in ("listen start", "listen stop"):
            self.assertIn(command, diag.COMMANDS)
            self.assertEqual(diag.encode_command(command), ("SC_DIAG " + command + "\n").encode())
        for command in ("listen", "listen toggle", "listen START", "listen start extra",
                        "listen stop;status", "listen start\nlisten stop", " listen start"):
            with self.subTest(command=command), self.assertRaises(ValueError):
                diag.encode_command(command)

    def test_additive_device_state_and_legacy_status(self):
        for state in diag.DEVICE_STATES:
            good = reply(state="Hermes", device_state=state)
            self.assertEqual(diag.parse_reply(diag.PREFIX + json.dumps(good).encode(), "status"), good)
        launcher = reply(device_state="unavailable")
        self.assertEqual(diag.parse_reply(diag.PREFIX + json.dumps(launcher).encode(), "status"), launcher)
        self.assertEqual(diag.parse_reply(diag.PREFIX + json.dumps(reply()).encode(), "status"), reply())
        for state in (None, True, 1, {}, [], "private transcript", "Idle", "listening\nsecret"):
            with self.subTest(state=state):
                self.assertIsNone(diag.parse_reply(diag.PREFIX + json.dumps(reply(state="Hermes", device_state=state)).encode(), "status"))
        self.assertIsNone(diag.parse_reply(diag.PREFIX + json.dumps(reply(device_state="listening")).encode(), "status"))

    def test_listen_ack_and_refusal_are_static_and_matched(self):
        for command, accepted in (("listen start", "listen_start_requested"), ("listen stop", "listen_stop_requested")):
            outcomes = ((True, accepted, "Hermes"), (False, "requires_hermes", "Launcher"),
                        (False, "runtime_not_ready", "Hermes"), (False, "listen_busy", "Hermes"),
                        (False, "queue_full", "Launcher"), (False, "queue_full", "Hermes"))
            for ok, result, state in outcomes:
                with self.subTest(command=command, result=result, state=state):
                    good = reply(command=command, ok=ok, result=result, state=state)
                    self.assertEqual(diag.parse_reply(diag.PREFIX + json.dumps(good).encode(), command), good)
                    reader = diag.ReplyReader()
                    found = []
                    for byte in b"PRIVATE_CONSOLE_SENTINEL\n" + diag.PREFIX + json.dumps(good).encode() + b"\r\n":
                        found.extend(reader.feed(bytes([byte]), command))
                    self.assertEqual(found, [good])

    def test_listen_reply_rejects_completion_claims_and_payloads(self):
        for command, accepted in (("listen start", "listen_start_requested"), ("listen stop", "listen_stop_requested")):
            good = reply(command=command, result=accepted, state="Hermes")
            bad_updates = ({"ok": 1}, {"protocol_version": True}, {"state": "Launcher"},
                           {"state": "private transcript"}, {"result": "listening"}, {"result": "stopped"},
                           {"result": "PRIVATE_TRANSCRIPT_SENTINEL"}, {"result": "listen_stop_requested" if command == "listen start" else "listen_start_requested"},
                           {"text": "secret"}, {"app_version": "secret"}, {"device_state": "listening"},
                           {"ok": False, "result": "requires_hermes"},
                           {"ok": False, "result": "runtime_not_ready", "state": "Launcher"},
                           {"ok": False, "result": "listen_busy", "state": "Launcher"},
                           {"ok": False, "result": None}, {"ok": False, "result": {}},
                           {"command": "status"})
            for update in bad_updates:
                with self.subTest(command=command, update=update):
                    self.assertIsNone(diag.parse_reply(diag.PREFIX + json.dumps({**good, **update}).encode(), command))
            for missing in good:
                self.assertIsNone(diag.parse_reply(diag.PREFIX + json.dumps({k: v for k, v in good.items() if k != missing}).encode(), command))

    def test_listen_request_ignores_invalid_ack_and_writes_once(self):
        for command, accepted in (("listen start", "listen_start_requested"), ("listen stop", "listen_stop_requested")):
            good = reply(command=command, result=accepted, state="Hermes")
            invalid = reply(command=command, result="PRIVATE_TRANSCRIPT_SENTINEL", state="Hermes")
            first = b"PRIVATE_CONSOLE_SENTINEL\n" + diag.PREFIX + json.dumps(invalid).encode() + b"\n"
            second = diag.PREFIX + json.dumps(good).encode() + b"\n"
            with self.subTest(command=command), \
                 mock.patch.object(diag.termios, "tcflush") as flushed, \
                 mock.patch.object(diag.time, "monotonic", return_value=0), \
                 mock.patch.object(diag.select, "select", side_effect=[([], [42], []), ([42], [], []), ([42], [], [])]), \
                 mock.patch.object(diag.os, "write", side_effect=lambda _, payload: len(payload)) as written, \
                 mock.patch.object(diag.os, "read", side_effect=[first, second]) as read, \
                 mock.patch.object(diag.os, "open") as opened:
                self.assertEqual(diag.request(42, command, 5.0), good)
                written.assert_called_once_with(42, diag.encode_command(command))
                flushed.assert_called_once_with(42, diag.termios.TCIFLUSH)
                self.assertEqual(read.call_count, 2)
                opened.assert_not_called()

    def test_listen_cli_acceptance_and_refusal_never_retry(self):
        for command, accepted in (("listen start", "listen_start_requested"), ("listen stop", "listen_stop_requested")):
            for ok in (True, False):
                with self.subTest(command=command, ok=ok), mocked_usb() as (_, closed, _, _):
                    good = reply(command=command, ok=ok, result=accepted if ok else "requires_hermes", state="Hermes" if ok else "Launcher")
                    output, errors = io.StringIO(), io.StringIO()
                    with mock.patch.object(diag, "request", return_value=good) as requested, \
                         contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                        self.assertEqual(diag.main(["--port", "test", command]), 0 if ok else 2)
                    requested.assert_called_once_with(42, command, 5.0)
                    closed.assert_called_once_with(42)
                    self.assertEqual(json.loads(output.getvalue()), good)
                    self.assertEqual(errors.getvalue(), "")

    def test_listen_cli_failure_is_outcome_unknown_without_retry(self):
        for command in ("listen start", "listen stop"):
            with self.subTest(command=command), mocked_usb() as (_, closed, _, _):
                output, errors = io.StringIO(), io.StringIO()
                with mock.patch.object(diag, "request", side_effect=TimeoutError("PRIVATE_TRANSCRIPT_SENTINEL")) as requested, \
                     contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                    self.assertEqual(diag.main(["--port", "test", command]), 1)
                requested.assert_called_once_with(42, command, 5.0)
                closed.assert_called_once_with(42)
                self.assertEqual(output.getvalue(), "")
                self.assertEqual(json.loads(errors.getvalue()), {"ok": False, "result": "usb_diagnostic_failed_outcome_unknown"})

    def test_listen_cli_unknown_command_does_not_open_usb(self):
        with mock.patch.object(diag, "usb_port") as opened, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as exited:
                diag.main(["--port", "test", "listen toggle"])
            self.assertEqual(exited.exception.code, 2)
            opened.assert_not_called()

    def test_fragmented_reply_ignores_logs(self):
        reader = diag.ReplyReader()
        raw = b"secret console text\nSC_DIAG_REPLY " + json.dumps(reply()).encode() + b"\r\n"
        found = []
        for byte in raw:
            found.extend(reader.feed(bytes([byte]), "status"))
        self.assertEqual(found, [reply()])

    def test_wrong_or_malformed_reply(self):
        for raw in (b"SC_DIAG_REPLY not-json", b"SC_DIAG_REPLY []", b"SC_DIAG_REPLY " + json.dumps(reply(command="sd read")).encode(),
                    b"SC_DIAG_REPLY " + json.dumps(reply(password="secret")).encode()):
            self.assertIsNone(diag.parse_reply(raw, "status"))

    def test_only_safe_network_metadata(self):
        good = reply(network={"connected": True, "scheme": "wss", "host": "example.invalid"})
        self.assertEqual(diag.parse_reply(diag.PREFIX + json.dumps(good).encode(), "status"), good)
        for network in ({"connected": True, "scheme": "ws", "host": "user:pass@host/path"},
                        {"connected": True, "scheme": "ws", "host": "host", "ssid": "secret"}):
            self.assertIsNone(diag.parse_reply(diag.PREFIX + json.dumps(reply(network=network)).encode(), "status"))

    def test_bounded_stack_metadata_fragmentation_and_legacy(self):
        self.assertEqual(diag.parse_reply(diag.PREFIX + json.dumps(reply()).encode(), "status"), reply())
        for stacks in ({}, {"app_main": 0}, {"sc_diag_usb": 1024 * 1024},
                       {"app_main": 3308, "sc_diag_usb": 3216}):
            with self.subTest(stacks=stacks):
                good = reply(task_stack_low_water_bytes=stacks)
                raw = diag.PREFIX + json.dumps(good).encode() + b"\r\n"
                self.assertEqual(diag.parse_reply(raw, "status"), good)
                reader = diag.ReplyReader()
                found = []
                for byte in raw:
                    found.extend(reader.feed(bytes([byte]), "status"))
                self.assertEqual(found, [good])

    def test_stack_metadata_rejects_untrusted_names_types_and_controls(self):
        invalid = [None, [], "PRIVATE_STACK_TEXT", {"PRIVATE_TASK": 1}]
        invalid.extend({"app_main": value} for value in
                       (True, False, 1.0, "PRIVATE_STACK_TEXT", None, {}, [], -1, 1024 * 1024 + 1))
        for stacks in invalid:
            with self.subTest(stacks=stacks):
                raw = diag.PREFIX + json.dumps(reply(task_stack_low_water_bytes=stacks)).encode()
                self.assertIsNone(diag.parse_reply(raw, "status"))
        for command in diag.COMMANDS:
            if command == "status":
                continue
            base = reply(command=command)
            if command in ("listen start", "listen stop"):
                base.update(state="Hermes", result="listen_start_requested" if command == "listen start"
                            else "listen_stop_requested")
            self.assertEqual(diag.parse_reply(diag.PREFIX + json.dumps(base).encode(), command), base)
            raw = diag.PREFIX + json.dumps({**base, "task_stack_low_water_bytes": {}}).encode()
            self.assertIsNone(diag.parse_reply(raw, command))

    def test_bounded_boot_metadata_and_legacy_reply(self):
        boot = {"elf_sha256_prefix": "0123456789abcdef", "reset_reason": 3,
                "uptime_ms": 1234, "reply_core": 0,
                "running_partition": "ota_0", "app_offset": 0x20000, "ota_state": 2}
        good = reply(boot=boot)
        self.assertEqual(diag.parse_reply(diag.PREFIX + json.dumps(good).encode(), "status"), good)
        self.assertEqual(diag.parse_reply(diag.PREFIX + json.dumps(reply()).encode(), "status"), reply())
        bad_updates = ({"token": "secret"}, {"elf_sha256_prefix": "secret"},
                       {"reply_core": True}, {"reply_core": 2}, {"uptime_ms": -1},
                       {"uptime_ms": float("nan")}, {"reset_reason": 128},
                       {"running_partition": "secret/path"}, {"app_offset": 0x20001},
                       {"app_offset": True}, {"ota_state": 42}, {"ota_state": True})
        for update in bad_updates:
            with self.subTest(update=update):
                raw = diag.PREFIX + json.dumps(reply(boot={**boot, **update})).encode()
                self.assertIsNone(diag.parse_reply(raw, "status"))
        for bad in ({}, None, "secret", {k: v for k, v in boot.items() if k != "app_offset"}):
            self.assertIsNone(diag.parse_reply(diag.PREFIX + json.dumps(reply(boot=bad)).encode(), "status"))

    def test_overflow_discards_entire_line_then_recovers(self):
        reader = diag.ReplyReader()
        self.assertEqual(reader.feed(b"x" * 100000, "status"), [])
        self.assertLessEqual(len(reader.buffer), diag.MAX_REPLY_LINE)
        raw = diag.PREFIX + json.dumps(reply()).encode() + b"\n"
        self.assertEqual(reader.feed(raw, "status"), [])
        self.assertEqual(reader.feed(raw, "status"), [reply()])

    def test_non_usb_path_rejected_without_open(self):
        with mock.patch.object(diag.os, "open") as opened:
            with self.assertRaises((OSError, ValueError)):
                with diag.usb_port("/dev/null"):
                    pass
            opened.assert_not_called()

    def test_port_configuration_never_toggles_dtr_rts(self):
        attrs = [0, 0, diag.termios.HUPCL, 0, 0, 0, [0] * 32]
        with mock.patch.object(diag, "verify_usb_jtag", return_value=Path("/dev/ttyACM0")), \
             mock.patch.object(diag.os, "open", return_value=42), \
             mock.patch.object(diag.os, "close"), \
             mock.patch.object(diag.fcntl, "flock"), \
             mock.patch.object(diag.fcntl, "ioctl") as ioctl, \
             mock.patch.object(diag.termios, "tcgetattr", side_effect=lambda _: [*attrs[:6], list(attrs[6])]), \
             mock.patch.object(diag.termios, "tcsetattr") as setattrs:
            with diag.usb_port("test") as fd:
                self.assertEqual(fd, 42)
            ioctl.assert_called_once_with(42, diag.termios.TIOCEXCL)
            for call in setattrs.call_args_list:
                self.assertEqual(call.args[2][2] & diag.termios.HUPCL, 0)

    def test_reboot_ack_survives_disconnect_during_restore(self):
        for error_type in (OSError, diag.termios.error):
            with self.subTest(error_type=error_type), mocked_usb() as (opened, closed, ioctl, setattrs):
                setattrs.side_effect = [None, error_type(5, "Input/output error: private detail")]
                acknowledged = reply(command="reboot-to-launcher", result="rebooting_to_launcher")
                output, errors = io.StringIO(), io.StringIO()
                with mock.patch.object(diag, "request", return_value=acknowledged) as request, \
                     contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                    result = diag.main(["--port", "test", "reboot-to-launcher"])
                self.assertEqual(result, 0)
                self.assertEqual(json.loads(output.getvalue()), acknowledged)
                self.assertEqual(errors.getvalue(), "")
                opened.assert_called_once()
                request.assert_called_once_with(42, "reboot-to-launcher", 5.0)
                closed.assert_called_once_with(42)
                ioctl.assert_called_once_with(42, diag.termios.TIOCEXCL)
                for call in setattrs.call_args_list:
                    self.assertEqual(call.args[2][2] & diag.termios.HUPCL, 0)

    def test_termios_errors_are_sanitized_without_retry(self):
        for phase in ("setup", "request"):
            with self.subTest(phase=phase), mocked_usb() as (opened, closed, ioctl, setattrs):
                private_error = diag.termios.error(5, "Input/output error: private detail")
                if phase == "setup":
                    setattrs.side_effect = [private_error, None]
                output, errors = io.StringIO(), io.StringIO()
                with mock.patch.object(diag, "request", side_effect=private_error) as request, \
                     contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                    result = diag.main(["--port", "test", "reboot-to-launcher"])
                self.assertEqual(result, 1)
                self.assertEqual(output.getvalue(), "")
                self.assertEqual(json.loads(errors.getvalue()), {"ok": False, "result": "usb_diagnostic_failed_outcome_unknown"})
                opened.assert_called_once()
                self.assertEqual(request.call_count, 0 if phase == "setup" else 1)
                closed.assert_called_once_with(42)
                ioctl.assert_called_once_with(42, diag.termios.TIOCEXCL)

    def test_unexpected_restore_error_still_closes_fd(self):
        with mocked_usb() as (_, closed, _, setattrs):
            setattrs.side_effect = [None, RuntimeError("unexpected cleanup error")]
            with self.assertRaises(RuntimeError):
                with diag.usb_port("test"):
                    pass
            closed.assert_called_once_with(42)

    @unittest.skipUnless(shutil.which("g++"), "host g++ unavailable")
    def test_firmware_listen_parser_policy_and_main_queue(self):
        # Compile production readiness lookup and handler with synthetic app/USB/IDF
        # stubs, not a firmware image. No ESP-IDF, device, network or audio.
        source = (ROOT / "firmware/main/hal/diagnostics.cpp").read_text()
        state_lookup = source[source.index("const char* deviceStateName()"):source.index("// Fixed output size")]
        handler = source[source.index("void handle(Command command, bool runtime)"):source.index("void usbInput(void*)")]
        harness = r'''
#include "diagnostics.h"
#include <atomic>
#include <cassert>
#include <functional>
#include <utility>
#include <vector>
using namespace diagnostics;
struct Reply { Command command; bool ok; std::string result; };
std::vector<Reply> replies;
std::atomic<bool> hermes{false}, listen_pending{false};
std::string runtime_state = "unavailable";
namespace hal_bridge {
std::atomic<bool> mode{false}, initialized{false};
bool is_hermes_mode() { return mode.load(); }
bool is_hermes_runtime_initialized() { return initialized.load(std::memory_order_acquire); }
}
enum DeviceState {
    kDeviceStateStarting, kDeviceStateWifiConfiguring, kDeviceStateIdle, kDeviceStateConnecting,
    kDeviceStateListening, kDeviceStateSpeaking, kDeviceStateUpgrading, kDeviceStateActivating,
    kDeviceStateAudioTesting, kDeviceStateFatalError
};
bool sendReply(Command command, bool ok, const char* result, bool = false) {
    replies.push_back({command, ok, result}); return true;
}
struct Application {
    static inline int instance_calls = 0, starts = 0, stops = 0;
    static inline std::vector<std::function<void()>> queue;
    static Application& GetInstance() { ++instance_calls; static Application app; return app; }
    int GetDeviceState() {
        const char* states[] = {"starting", "wifi_configuring", "idle", "connecting", "listening", "speaking",
                                "upgrading", "activating", "audio_testing", "fatal_error"};
        for (int i = 0; i < 10; ++i) if (runtime_state == states[i]) return i;
        return -1;
    }
    void Schedule(std::function<void()>&& callback) { queue.push_back(std::move(callback)); }
    void StartListening() { ++starts; }
    void StopListening() { ++stops; }
    static void drain() {
        auto tasks = std::move(queue); queue.clear();
        for (auto& task : tasks) task();
    }
};
struct Hal { void requestLauncherReturnReboot() { assert(false); } };
Hal& GetHAL() { static Hal hal; return hal; }
class AppLauncher { public: bool diagnosticsOpenApp(const char*) { assert(false); return false; } };
class AppSetup { public:
    bool isDiagnosticsOpen() { assert(false); return false; }
    bool diagnosticsShowSdPrompt() { assert(false); return false; }
    bool diagnosticsRequestSdRead() { assert(false); return false; }
    void diagnosticsCancelSdRead() { assert(false); }
};
AppLauncher* launcher_app = nullptr;
AppSetup* setup_app = nullptr;
bool pending_sd_prompt = false;
long long prompt_deadline = 0;
long long esp_timer_get_time() { assert(false); return 0; }
'''
        checks = r'''
Command parse(const std::string& input) {
    LineParser parser; Command result = Command::None;
    for (unsigned char byte : input) {
        auto next = parser.push(byte); if (next != Command::None) result = next;
    }
    return result;
}
int main() {
    for (auto command : {Command::ListenStart, Command::ListenStop}) {
        assert(parse(std::string("SC_DIAG ") + commandName(command) + "\r\n") == command);
        assert(parse(std::string("SC_DIAG ") + commandName(command) + " extra\n") == Command::Unknown);
        // Ownership, pre-mode handoff and initialization are independent gates.
        // Even an already-idle Application must not be lazily touched before publication.
        runtime_state = "idle";
        const bool gates[][3] = {{false, false, false}, {false, true, true},
                                {true, false, false}, {true, false, true}, {true, true, false}};
        for (const auto& gate : gates) {
            hermes.store(gate[0]); hal_bridge::mode.store(gate[1]); hal_bridge::initialized.store(gate[2]);
            Application::instance_calls = 0;
            assert(std::string(deviceStateName()) == "unavailable");
            handle(command, gate[0]);
            assert(!replies.back().ok && replies.back().result ==
                   (gate[0] ? "runtime_not_ready" : "requires_hermes"));
            assert(Application::instance_calls == 0 && Application::queue.empty() && !listen_pending.load());
        }
        hal_bridge::mode.store(true); hal_bridge::initialized.store(true);
        for (const char* state : {"unavailable", "unknown", "starting", "wifi_configuring", "idle", "connecting",
                                 "listening", "speaking", "upgrading", "activating", "audio_testing", "fatal_error", "private"}) {
            const bool ready = std::string(state) == "idle" || std::string(state) == "connecting" ||
                               std::string(state) == "listening" || std::string(state) == "speaking";
            runtime_state = state; hermes.store(false); Application::instance_calls = 0;
            handle(command, false); // Launcher/Setup, even with stale ready state.
            assert(!replies.back().ok && replies.back().result == "requires_hermes");
            assert(Application::instance_calls == 0 && Application::queue.empty());
            const int starts = Application::starts, stops = Application::stops;
            hermes.store(true); handle(command, true);
            assert(Application::starts == starts && Application::stops == stops); // USB never calls audio APIs.
            assert(replies.back().command == command);
            if (!ready) {
                assert(!replies.back().ok && replies.back().result == "runtime_not_ready");
                assert(Application::queue.empty() && !listen_pending.load()); continue;
            }
            assert(replies.back().ok && replies.back().result ==
                   (command == Command::ListenStart ? "listen_start_requested" : "listen_stop_requested"));
            assert(Application::queue.size() == 1 && listen_pending.load());
            handle(command == Command::ListenStart ? Command::ListenStop : Command::ListenStart, true);
            assert(!replies.back().ok && replies.back().result == "listen_busy");
            assert(Application::queue.size() == 1);
            const auto reply_count = replies.size();
            Application::drain();
            assert(!listen_pending.load() && replies.size() == reply_count); // No completion ACK.
            assert(Application::starts == starts + (command == Command::ListenStart));
            assert(Application::stops == stops + (command == Command::ListenStop));
            handle(command, true); // Guard releases after posting the event.
            runtime_state = "audio_testing"; // Readiness revoked before callback.
            const int executed = Application::starts + Application::stops;
            Application::drain();
            assert(Application::starts + Application::stops == executed && !listen_pending.load());
             runtime_state = "idle";
             handle(command, true);
             assert(replies.back().ok && Application::queue.size() == 1);
             const int instance_calls = Application::instance_calls;
             const auto replies_before_revoke = replies.size();
             hal_bridge::initialized.store(false); // Initialization gate revoked before callback.
             Application::drain();
             assert(Application::instance_calls == instance_calls);
             assert(Application::starts + Application::stops == executed && !listen_pending.load());
             assert(replies.size() == replies_before_revoke);
             hal_bridge::initialized.store(true);
        }
    }
    assert(std::string(listenRefusal(true, nullptr)) == "runtime_not_ready");
    for (const char* input : {"SC_DIAG listen\n", "SC_DIAG listen toggle\n", "SC_DIAG listen START\n",
                              "SC_DIAG listen stop;status\n"}) assert(parse(input) == Command::Unknown);
    assert(parse("SC_DIAG listen start\t\n") == Command::Invalid);
    assert(parse("SC_DIAG listen " + std::string(128, 'x') + "\n") == Command::Overflow);
}
'''
        with tempfile.TemporaryDirectory(prefix="stackchan-listen-host-") as temporary:
            source_path = Path(temporary) / "listen-test.cpp"
            executable = Path(temporary) / "listen-test"
            source_path.write_text(harness + state_lookup + handler + checks)
            subprocess.run(["g++", "-std=c++17", "-Wall", "-Wextra", "-Werror", "-I", str(ROOT / "firmware/main/hal"),
                            str(source_path), "-o", str(executable)], check=True)
            subprocess.run([str(executable)], check=True)

    @unittest.skipUnless(shutil.which("g++"), "host g++ unavailable")
    def test_firmware_initialization_gate_publication_and_reset(self):
        # Compile only production gate/mode/start functions against a synthetic app.
        # Verify publication ordering without building firmware or starting runtime.
        source = (ROOT / "firmware/main/hal/board/hal_bridge.cc").read_text()
        declarations = source[source.index("static std::mutex _mutex;"):source.index("void lock()")]
        mode_start = source.index("bool is_hermes_mode()")
        mode = source[mode_start:source.index("\n/*", mode_start)]
        startup = source[source.index("void start_hermes_app()"):source.index("HermesRuntimeConfig_t get_hermes_config()")]
        self.assertIn("bool is_hermes_runtime_initialized();",
                      (ROOT / "firmware/main/hal/board/hal_bridge.h").read_text())
        harness = r'''
#include <atomic>
#include <cassert>
#include <mutex>
#define ESP_LOGI(tag, ...) ((void)(tag))
#define ESP_LOGE(tag, ...) ((void)(tag))
static const char* _tag = "host";
namespace hal_bridge {
struct Data_t { bool isHermesMode = false; };
bool is_hermes_mode();
bool is_hermes_runtime_initialized();
void set_hermes_mode(bool);
}
struct InitFailure {};
struct RunEntered {};
struct Application {
    static inline bool fail_initialize = false;
    static inline int instance_calls = 0, initialize_calls = 0, run_calls = 0;
    int initialized_value = 0;
    static Application& GetInstance() {
        assert(hal_bridge::is_hermes_mode());
        assert(!hal_bridge::is_hermes_runtime_initialized());
        ++instance_calls; static Application app; return app;
    }
    void Initialize() {
        assert(hal_bridge::is_hermes_mode());
        assert(!hal_bridge::is_hermes_runtime_initialized());
        ++initialize_calls;
        if (fail_initialize) throw InitFailure{};
        initialized_value = 42;
        assert(!hal_bridge::is_hermes_runtime_initialized());
    }
    void Run() {
        assert(hal_bridge::is_hermes_runtime_initialized());
        assert(initialized_value == 42);
        ++run_calls;
        throw RunEntered{}; // Stop the synthetic non-returning loop here.
    }
};
'''
        checks = r'''
int main() {
    using namespace hal_bridge;
    assert(!is_hermes_mode() && !is_hermes_runtime_initialized());
    set_hermes_mode(true); // Ownership alone never publishes initialization.
    assert(is_hermes_mode() && !is_hermes_runtime_initialized());
    Application::fail_initialize = true;
    try { start_hermes_app(); assert(false); } catch (const InitFailure&) {}
    assert(is_hermes_mode() && !is_hermes_runtime_initialized());
    assert(Application::run_calls == 0);
    Application::fail_initialize = false;
    try { start_hermes_app(); assert(false); } catch (const RunEntered&) {}
    assert(is_hermes_mode() && is_hermes_runtime_initialized());
    assert(Application::run_calls == 1);
    set_hermes_mode(true); // An unchanged ready ownership must not clear readiness.
    assert(is_hermes_runtime_initialized());
    Application::fail_initialize = true; // Re-entry revokes old readiness before GetInstance/Initialize.
    try { start_hermes_app(); assert(false); } catch (const InitFailure&) {}
    assert(is_hermes_mode() && !is_hermes_runtime_initialized());
    assert(Application::run_calls == 1);
    Application::fail_initialize = false;
    try { start_hermes_app(); assert(false); } catch (const RunEntered&) {}
    assert(is_hermes_runtime_initialized() && Application::run_calls == 2);
    set_hermes_mode(false);
    assert(!is_hermes_mode() && !is_hermes_runtime_initialized());
    set_hermes_mode(true);
    assert(is_hermes_mode() && !is_hermes_runtime_initialized());
    assert(Application::instance_calls == 4 && Application::initialize_calls == 4);
}
'''
        with tempfile.TemporaryDirectory(prefix="stackchan-ready-host-") as temporary:
            source_path = Path(temporary) / "ready-test.cpp"
            executable = Path(temporary) / "ready-test"
            source_path.write_text(harness + "namespace hal_bridge {\n" + declarations + mode + startup + "\n}\n" + checks)
            subprocess.run(["g++", "-std=c++17", "-Wall", "-Wextra", "-Werror", "-pthread",
                            str(source_path), "-o", str(executable)], check=True)
            subprocess.run([str(executable)], check=True)

    @unittest.skipUnless(shutil.which("g++"), "host g++ unavailable")
    def test_firmware_pure_parser_and_redaction(self):
        # Host-only pure parser test; no ESP-IDF build, firmware, USB, reset or flashing.
        with tempfile.TemporaryDirectory(prefix="stackchan-parser-") as temporary:
            executable = Path(temporary) / "parser-test"
            subprocess.run(["g++", "-std=c++17", "-Wall", "-Wextra", "-Werror", "-I", str(ROOT / "firmware/main/hal"),
                            str(ROOT / "scripts/tests/diagnostics_parser_test.cpp"), "-o", str(executable)], check=True)
            subprocess.run([str(executable)], check=True)


if __name__ == "__main__":
    unittest.main()
