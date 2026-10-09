"""Host-only reboot-chain regressions using current production C++ function bodies.

Only platform/dependency stubs and assertions are modeled below. The actual USB
ACK/dispatch, HAL markers/dedup, bridge/Application scheduling, Application reboot
and AudioService stop bodies are extracted on every run, then compiled together.
The fake main-task pump chooses core 0; it is NOT Application::Run coverage.
esp_restart throws a terminal sentinel: no ESP-IDF, port, service or live API is
used. Stubbed USB drain, NVS, protocol/timers/events and queues cannot reproduce
ESP32 watchdogs, task exit/join timing, real socket/I2S shutdown or physical LCD/SD.
"""

from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]

# Ignore braces in comments, ordinary string/character literals and C++ raw
# strings. Match the ENTIRE function, including nested scopes and lambdas, rather
# than selecting a hand-copied reboot branch or using a brittle next-name slice.
CPP_TOKENS = re.compile(
    r'//[^\n]*|/\*.*?\*/|R"(?P<delimiter>[^ ()\\\t\r\n]{0,16})\(.*?\)(?P=delimiter)"'
    r'|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|[{}]',
    re.DOTALL,
)


def extract_function(source, signature):
    if source.count(signature) != 1:
        raise ValueError(f"expected exactly one production definition: {signature}")
    start = source.index(signature)
    depth = 0
    opened = False
    for token in CPP_TOKENS.finditer(source, start + len(signature)):
        if token.group() == "{":
            opened = True
            depth += 1
        elif token.group() == "}" and opened:
            depth -= 1
            if depth == 0:
                return source[start:token.end()]
    raise ValueError(f"unterminated production function: {signature}")


def production_function(path, signature):
    source = (ROOT / path).read_text(encoding="utf-8")
    function = extract_function(source, signature)
    line = source[:source.index(signature)].count("\n") + 1
    return f'#line {line} "{path}"\n{function}\n'


def production_declarations(path, names):
    source = (ROOT / path).read_text(encoding="utf-8")
    result = []
    for name in names:
        matches = list(re.finditer(r'^static\s+[^\n;]*\b' + re.escape(name) + r'\b[^\n;]*;',
                                  source, re.MULTILINE))
        if len(matches) != 1:
            raise ValueError(f"expected one production declaration: {name}")
        match = matches[0]
        line = source[:match.start()].count("\n") + 1
        result.append(f'#line {line} "{path}"\n{match.group()}\n')
    return "".join(result)


STUBS = r'''
#include "diagnostics.h"
#include <atomic>
#include <cassert>
#include <cstdio>
#include <cstring>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>
#define CONFIG_BOARD_TYPE_M5STACK_STACK_CHAN 1
#define CONFIG_BOARD_TYPE_M5STACK_CORE_S3 0
#define ESP_LOGI(...) ((void)0)
#define ESP_LOGW(...) ((void)0)
constexpr int ESP_OK = 0;
constexpr int ESP_FAIL = -1;
constexpr int MAIN_EVENT_SCHEDULE = 1;
constexpr int AS_EVENT_AUDIO_TESTING_RUNNING = 2;
constexpr int AS_EVENT_WAKE_WORD_RUNNING = 4;
constexpr int AS_EVENT_AUDIO_PROCESSOR_RUNNING = 8;
constexpr int pdMS_TO_TICKS(int ms) { return ms; }
int current_core = 1; // Synthetic USB task, not a physical processor.
struct Event { std::string name; int core; };
std::vector<Event> events;
std::mutex trace_mutex;
void record(std::string name) {
    std::lock_guard<std::mutex> guard(trace_mutex);
    events.push_back({std::move(name), current_core});
}
int xPortGetCoreID() { return current_core; }
unsigned uxTaskGetStackHighWaterMark(void*) { return 4096; }
void* main_task = nullptr;
void* usb_task = nullptr;
const char* TAG = "host";
namespace mclog {
template<class Tag, class... Args> void tagInfo(const Tag&, const char*, Args...) {}
}
using Key = std::pair<std::string, std::string>;
std::map<Key, int> nvs;
struct Settings {
    std::string ns;
    bool writable;
    Settings(const char* name, bool write) : ns(name), writable(write) {}
    int GetInt(const char* key, int fallback) {
        auto it = nvs.find({ns, key}); return it == nvs.end() ? fallback : it->second;
    }
    void SetInt(const char* key, int value) {
        assert(writable);
        nvs[{ns, key}] = value;
        record("nvs:" + ns + "/" + key + "=" + std::to_string(value));
    }
    std::string GetString(const char*, const char* fallback) { return fallback; }
};
struct Restart {}; // Terminal fake restart; never calls any real reset primitive.
[[noreturn]] void esp_restart() { record("restart"); throw Restart{}; }
void vTaskDelay(int ticks) { record("rtos_delay:" + std::to_string(ticks)); }
int timer_result = ESP_OK;
int esp_timer_stop(int timer) {
    assert(timer == 3); record("audio_timer_stop"); return timer_result;
}
int audio_bits = 0;
int xEventGroupSetBits(int group, int bits) {
    if (group == 1) { assert(bits == MAIN_EVENT_SCHEDULE); record("schedule_wake"); }
    else { assert(group == 2); audio_bits = bits; record("audio_wake:" + std::to_string(bits)); }
    return bits;
}
struct TrackedQueue {
    std::string name;
    bool* stopped;
    std::vector<int> values{1, 2};
    void clear() {
        assert(*stopped && audio_bits == 14);
        record("clear:" + name); values.clear();
    }
};
struct TrackedCv { void notify_all() { record("audio_notify"); } };
struct AudioService {
    int audio_power_timer_ = 3, event_group_ = 2;
    bool service_stopped_ = false;
    std::mutex audio_queue_mutex_;
    TrackedQueue audio_encode_queue_{"encode", &service_stopped_}, audio_decode_queue_{"decode", &service_stopped_};
    TrackedQueue audio_playback_queue_{"playback", &service_stopped_}, audio_testing_queue_{"testing", &service_stopped_};
    TrackedCv audio_queue_cv_;
    void Stop();
};
struct Protocol {
    bool open;
    explicit Protocol(bool opened) : open(opened) {}
    bool IsAudioChannelOpened() { record("protocol_query"); return open; }
    void CloseAudioChannel() { record("protocol_close"); open = false; }
    ~Protocol() { record("protocol_reset"); }
};
struct Application {
    std::unique_ptr<Protocol> protocol_;
    AudioService audio_service_;
    std::mutex mutex_;
    std::vector<std::function<void()>> main_tasks_;
    int event_group_ = 1;
    static inline int instance_calls = 0;
    static Application& GetInstance() {
        ++instance_calls; record("runtime_access"); static Application app; return app;
    }
    void Schedule(std::function<void()>&& callback);
    void Reboot();
    void StartListening() { assert(false && "unexpected listening action"); }
    void StopListening() { assert(false && "unexpected listening action"); }
};
namespace hal_bridge {
bool mode = false;
bool is_hermes_mode() { return mode; }
void schedule_hermes_reboot(std::function<void()> before_reboot);
}
enum class WifiStatus { None };
struct Hal {
    bool _launcher_return_boot_marker = false;
    void requestLauncherReturnReboot();
    void requestSkipNextBootSdConfigAutoload();
    void consumeLauncherReturnRebootMarker();
    void delay(int ms) { record("hal_delay:" + std::to_string(ms)); }
    WifiStatus getWifiStatus() { return WifiStatus::None; }
};
Hal& GetHAL() { static Hal hal; return hal; }
// These APIs are deliberately forbidden even though compilation can resolve
// common names. Any new unstubbed LVGL/SD/runtime dependency fails compilation.
struct LvglLockGuard { LvglLockGuard() { assert(false && "LVGL forbidden"); } };
struct DisplayLockGuard { DisplayLockGuard() { assert(false && "LCD forbidden"); } };
int sdmmc_card_init(...) { assert(false && "SD forbidden"); return ESP_FAIL; }
int esp_lcd_panel_draw_bitmap(...) { assert(false && "LCD forbidden"); return ESP_FAIL; }
class AppLauncher { public:
    bool diagnosticsOpenApp(const char*) { assert(false); return false; }
};
class AppSetup { public:
    bool diagnosticsSdPromptActive() { assert(false); return false; }
    bool isDiagnosticsOpen() { assert(false); return false; }
    bool diagnosticsShowSdPrompt() { assert(false); return false; }
    bool diagnosticsRequestSdRead() { assert(false); return false; }
    void diagnosticsCancelSdRead() { assert(false); }
};
AppLauncher* launcher_app = nullptr;
AppSetup* setup_app = nullptr;
bool pending_sd_prompt = false;
long long prompt_deadline = 0;
long long esp_timer_get_time() { return 0; }
struct Description { const char* version = "host"; unsigned char app_elf_sha256[32]{}; };
const Description* esp_app_get_description() { static Description desc; return &desc; }
int esp_get_free_heap_size() { return 0; }
int esp_reset_reason() { return 0; }
struct Partition { const char* label = "host"; unsigned address = 0; };
const Partition* esp_ota_get_running_partition() { static Partition part; return &part; }
using esp_ota_img_states_t = int;
int esp_ota_get_state_partition(const Partition*, int* state) { *state = 2; return ESP_OK; }

// cJSON is a tiny serialization stub, not a reimplementation of sendReply.
// Full production allocation/print/lock/write/drain/unlock control flow is used.
struct cJSON { std::map<std::string, std::string> fields; };
bool allocation_ok = true, print_ok = true, drain_ok = true;
int write_delta = 0;
bool write_error = false;
int write_calls = 0, drain_calls = 0, locks = 0;
std::string wire;
cJSON* cJSON_CreateObject() {
    record("json_create"); return allocation_ok ? new cJSON : nullptr;
}
void cJSON_AddNumberToObject(cJSON* obj, const char* key, double value) {
    obj->fields[key] = std::to_string(value);
}
void cJSON_AddStringToObject(cJSON* obj, const char* key, const char* value) { obj->fields[key] = value; }
void cJSON_AddBoolToObject(cJSON* obj, const char* key, bool value) { obj->fields[key] = value ? "true" : "false"; }
cJSON* cJSON_AddObjectToObject(cJSON* obj, const char*) { return obj; }
bool cJSON_PrintPreallocated(cJSON* obj, char* output, int capacity, bool formatted) {
    assert(!formatted); record("json_print");
    assert(obj->fields["command"] == "reboot-to-launcher");
    assert(obj->fields["result"] == "rebooting_to_launcher" && obj->fields["ok"] == "true");
    assert(obj->fields["state"] == (hal_bridge::mode ? "Hermes" : "Launcher"));
    if (!print_ok) return false;
    auto payload = "{\"command\":\"" + obj->fields["command"] + "\",\"result\":\""
                   + obj->fields["result"] + "\"}";
    return std::snprintf(output, capacity, "%s", payload.c_str()) < capacity;
}
void cJSON_Delete(cJSON* obj) { record("json_delete"); delete obj; }
void host_flockfile(FILE* file) { assert(file == stdout && locks == 0); ++locks; record("stdout_lock"); }
void host_funlockfile(FILE* file) { assert(file == stdout && locks == 1); --locks; record("stdout_unlock"); }
#define flockfile host_flockfile
#define funlockfile host_funlockfile
int usb_serial_jtag_write_bytes(const void* bytes, size_t length, int ticks) {
    assert(locks == 1 && ticks == 250); ++write_calls; record("usb_write");
    wire.assign(static_cast<const char*>(bytes), length);
    return write_error ? -1 : static_cast<int>(length) + write_delta;
}
int usb_serial_jtag_wait_tx_done(int ticks) {
    assert(locks == 1 && ticks == 250); ++drain_calls; record("usb_drain");
    return drain_ok ? ESP_OK : ESP_FAIL;
}
using namespace diagnostics;
std::atomic<bool> hermes{false}, listen_pending{false};
constexpr size_t kMaxReply = 1024;
const char* deviceStateName() { return "unavailable"; }
'''

CHECKS = r'''
std::vector<std::string> names() {
    std::vector<std::string> result;
    for (const auto& event : events) result.push_back(event.name);
    return result;
}
size_t count(const char* name) {
    size_t result = 0;
    for (const auto& event : events) result += event.name == name;
    return result;
}
void configure_hermes() {
    hal_bridge::mode = true; hermes.store(true);
    // Existing manual-import state must be cleared by the production skip helper.
    nvs[{SD_BOOT_IMPORT_NS, SD_BOOT_IMPORT_PENDING_KEY}] = 1;
    nvs[{SD_BOOT_IMPORT_NS, SD_BOOT_SKIP_NEXT_AUTOLOAD_KEY}] = 0;
}
void check_no_return() {
    assert(!_launcher_return_reboot_requested.load());
    assert(nvs.empty() && Application::instance_calls == 0 && locks == 0);
    assert(count("restart") == 0 && count("schedule_wake") == 0);
}
void check_markers(int core) {
    assert((nvs[Key{_launcher_return_nvs_ns, _launcher_return_pending_key}] == 1));
    assert((nvs[Key{SD_BOOT_IMPORT_NS, SD_BOOT_IMPORT_PENDING_KEY}] == 0));
    assert((nvs[Key{SD_BOOT_IMPORT_NS, SD_BOOT_SKIP_NEXT_AUTOLOAD_KEY}] == 1));
    int writes = 0;
    for (const auto& event : events) if (event.name.rfind("nvs:", 0) == 0) {
        assert(event.core == core); ++writes;
    }
    assert(writes == 3);
}
std::vector<std::string> ack_names() {
    return {"json_create", "json_print", "json_delete", "stdout_lock",
            "usb_write", "usb_drain", "stdout_unlock"};
}
std::vector<std::string> marker_names() {
    return {"nvs:launcher_ret/pending=1", "nvs:sd_config/boot_import=0", "nvs:sd_config/skip_next=1"};
}
std::vector<std::string> audio_names() {
    return {"audio_timer_stop", "audio_wake:14", "clear:encode", "clear:decode",
            "clear:playback", "clear:testing", "audio_notify"};
}
void check_audio_stopped(const AudioService& audio) {
    assert(audio.service_stopped_ && audio_bits == 14);
    assert(audio.audio_encode_queue_.values.empty() && audio.audio_decode_queue_.values.empty());
    assert(audio.audio_playback_queue_.values.empty() && audio.audio_testing_queue_.values.empty());
}
// Synthetic dispatch boundary only. Schedule itself is the production body;
// the real FreeRTOS Application main event loop is not simulated or claimed.
void pump_on_main_core(Application& app) {
    assert(app.main_tasks_.size() == 1); current_core = 0;
    auto callback = std::move(app.main_tasks_.front()); app.main_tasks_.clear();
    try { callback(); assert(false && "mock esp_restart must be terminal"); }
    catch (const Restart&) {}
}
void check_hermes_shutdown(int protocol_kind, bool usb) {
    if (usb) {
        handle(Command::Reboot, true);
        assert(write_calls == 1 && drain_calls == 1 && locks == 0);
        assert(wire.rfind("SC_DIAG_REPLY ", 0) == 0 && wire.back() == '\n');
        assert(wire.find("rebooting_to_launcher") != std::string::npos);
    } else GetHAL().requestLauncherReturnReboot();
    assert(_launcher_return_reboot_requested.load());
    assert(Application::instance_calls == 1 && count("schedule_wake") == 1);
    auto prefix = usb ? ack_names() : std::vector<std::string>{};
    prefix.push_back("runtime_access"); prefix.push_back("schedule_wake");
    assert(names() == prefix); // TX drain + stdout unlock precede any runtime access.
    for (const auto& event : events) assert(event.core == 1);
    assert(count("restart") == 0 && count("audio_timer_stop") == 0);
    // Markers are deliberately NOT committed in the USB/caller task.
    assert(nvs.find({_launcher_return_nvs_ns, _launcher_return_pending_key}) == nvs.end());
    for (const auto& event : events) assert(event.name.rfind("nvs:", 0) != 0);
    auto& app = Application::GetInstance();
    if (protocol_kind >= 0) app.protocol_ = std::make_unique<Protocol>(protocol_kind == 1);
    const size_t before = events.size();
    pump_on_main_core(app);
    check_markers(0);
    check_audio_stopped(app.audio_service_);
    assert(!app.protocol_ && count("restart") == 1);
    auto expected = marker_names(); expected.push_back("runtime_access");
    if (protocol_kind >= 0) {
        expected.push_back("protocol_query");
        if (protocol_kind == 1) expected.push_back("protocol_close");
        expected.push_back("protocol_reset");
    }
    const auto audio = audio_names(); expected.insert(expected.end(), audio.begin(), audio.end());
    expected.push_back("rtos_delay:1000"); expected.push_back("restart");
    std::vector<std::string> tail;
    for (size_t i = before; i < events.size(); ++i) {
        assert(events[i].core == 0); tail.push_back(events[i].name);
    }
    assert(tail == expected);
}
void check_launcher(bool usb) {
    nvs[{SD_BOOT_IMPORT_NS, SD_BOOT_IMPORT_PENDING_KEY}] = 1;
    try {
        if (usb) handle(Command::Reboot, false);
        else GetHAL().requestLauncherReturnReboot();
        assert(false && "direct launcher restart must be terminal");
    } catch (const Restart&) {}
    check_markers(1);
    assert(Application::instance_calls == 0 && count("schedule_wake") == 0);
    assert(count("audio_timer_stop") == 0 && count("rtos_delay:1000") == 0);
    auto expected = usb ? ack_names() : std::vector<std::string>{};
    const auto markers = marker_names(); expected.insert(expected.end(), markers.begin(), markers.end());
    expected.push_back("hal_delay:150"); expected.push_back("restart");
    assert(names() == expected); // No marker/restart may run before ACK drain/unlock.
    if (usb) {
        assert(write_calls == 1 && drain_calls == 1 && locks == 0);
        assert(wire.rfind("SC_DIAG_REPLY ", 0) == 0 && wire.back() == '\n');
        assert(wire.find("rebooting_to_launcher") != std::string::npos);
    }
    for (const auto& event : events) assert(event.core == 1);
    const auto before = events.size(); GetHAL().requestLauncherReturnReboot();
    assert(events.size() == before && count("restart") == 1);
}
int main(int argc, char** argv) {
    assert(argc == 2 || argc == 3); const std::string test = argv[1];
    if (argc == 3) {
        assert(std::string(argv[2]) == "Hermes");
        hal_bridge::mode = true; hermes.store(true);
    }
    if (test == "usb_partial" || test == "usb_error" || test == "usb_oversized"
        || test == "usb_drain_timeout" || test == "usb_alloc_failure" || test == "usb_print_failure") {
        if (test == "usb_partial") write_delta = -1;
        if (test == "usb_error") write_error = true;
        if (test == "usb_oversized") write_delta = 1;
        if (test == "usb_drain_timeout") drain_ok = false;
        if (test == "usb_alloc_failure") allocation_ok = false;
        if (test == "usb_print_failure") print_ok = false;
        handle(Command::Reboot, true);
        check_no_return();
        const bool wrote = allocation_ok && print_ok;
        assert(write_calls == static_cast<int>(wrote));
        assert(drain_calls == static_cast<int>(test == "usb_drain_timeout"));
        assert(count("stdout_lock") == static_cast<size_t>(wrote));
        assert(count("stdout_unlock") == static_cast<size_t>(wrote));
        assert(count("json_delete") == static_cast<size_t>(allocation_ok));
    } else if (test == "hermes_usb_open" || test == "hermes_closed" || test == "hermes_none"
               || test == "hermes_marker_affinity") {
        configure_hermes();
        const int kind = test == "hermes_closed" ? 0 : test == "hermes_none" ? -1 : 1;
        check_hermes_shutdown(kind, test == "hermes_usb_open");
    } else if (test == "hermes_usb_dedup" || test == "hermes_concurrent_dedup") {
        configure_hermes();
        if (test == "hermes_usb_dedup") {
            handle(Command::Reboot, true); handle(Command::Reboot, true);
            assert(write_calls == 2 && drain_calls == 2);
        } else {
            std::vector<std::thread> threads;
            for (int i = 0; i < 16; ++i) threads.emplace_back([] { GetHAL().requestLauncherReturnReboot(); });
            for (auto& thread : threads) thread.join();
        }
        assert(Application::instance_calls == 1 && count("schedule_wake") == 1);
        assert(count("restart") == 0 && nvs.size() == 2);
        auto& app = Application::GetInstance(); pump_on_main_core(app);
        check_markers(0); assert(count("restart") == 1);
        const auto before = events.size(); GetHAL().requestLauncherReturnReboot();
        assert(events.size() == before && app.main_tasks_.empty());
    } else if (test == "audio_stop" || test == "audio_stop_timer_error") {
        AudioService audio;
        if (test == "audio_stop_timer_error") timer_result = ESP_FAIL;
        audio.Stop(); check_audio_stopped(audio); assert(names() == audio_names());
        // An already-stopped service is safe to stop again, without queue joins.
        audio.Stop(); check_audio_stopped(audio);
        assert(count("audio_notify") == 2 && count("restart") == 0);
        assert(Application::instance_calls == 0);
    } else if (test == "launcher_usb" || test == "launcher_direct") {
        check_launcher(test == "launcher_usb");
    } else if (test == "consume_marker") {
        nvs[{_launcher_return_nvs_ns, _launcher_return_pending_key}] = 1;
        auto& hal = GetHAL(); hal.consumeLauncherReturnRebootMarker();
        assert(hal._launcher_return_boot_marker);
        assert((nvs[Key{_launcher_return_nvs_ns, _launcher_return_pending_key}] == 0));
        assert(events.size() == 1 && events[0].name == "nvs:launcher_ret/pending=0");
        hal.consumeLauncherReturnRebootMarker();
        assert(!hal._launcher_return_boot_marker && events.size() == 1);
        assert(Application::instance_calls == 0 && count("restart") == 0);
    } else assert(false && "unknown host scenario");
}
'''


def harness_source():
    hal = "firmware/main/hal/hal.cpp"
    sd = "firmware/main/hal/hal_sdcard.cpp"
    app = "firmware/xiaozhi-esp32/main/application.cc"
    diagnostic = "firmware/main/hal/diagnostics.cpp"
    return "\n".join([
        STUBS,
        production_declarations(hal, ("_tag", "_launcher_return_nvs_ns",
                                     "_launcher_return_pending_key", "_launcher_return_reboot_requested")),
        production_declarations(sd, ("SD_BOOT_IMPORT_NS", "SD_BOOT_IMPORT_PENDING_KEY",
                                    "SD_BOOT_SKIP_NEXT_AUTOLOAD_KEY")),
        production_function(hal, "static void mark_launcher_return_reboot_marker()"),
        production_function(sd, "void Hal::requestSkipNextBootSdConfigAutoload()"),
        production_function(hal, "void Hal::consumeLauncherReturnRebootMarker()"),
        production_function("firmware/xiaozhi-esp32/main/audio/audio_service.cc", "void AudioService::Stop()"),
        production_function(app, "void Application::Schedule(std::function<void()>&& callback)"),
        production_function(app, "void Application::Reboot()"),
        "namespace hal_bridge {",
        production_function("firmware/main/hal/board/hal_bridge.cc",
                            "void schedule_hermes_reboot(std::function<void()> before_reboot)"),
        "}",
        production_function(hal, "void Hal::requestLauncherReturnReboot()"),
        production_function(diagnostic, "bool sendReply(Command command, bool ok, const char* result, bool status = false)"),
        production_function(diagnostic, "void handle(Command command, bool runtime)"),
        '#line 1 "host-reboot-assertions"',
        CHECKS,
    ])


class SourceExtractionTests(unittest.TestCase):
    def test_balances_nested_scopes_comments_and_literals(self):
        source = r'''void target() {
            // { ignored
            const char* a = "} \\\" {"; /* } ignored */
            const char b = '}';
            const char* raw = R"tag({ " } )tag";
            auto callback = []() { if (true) { action(); } };
        }
        void next() {}'''
        result = extract_function(source, "void target()")
        self.assertTrue(result.endswith("}"))
        self.assertIn("auto callback", result)
        self.assertNotIn("void next", result)

    def test_missing_ambiguous_or_unterminated_functions_fail_closed(self):
        for source in ("void other() {}", "void target() {}\nvoid target() {}",
                       'void target() { const char* braces = "}";'):
            with self.subTest(source=source), self.assertRaises(ValueError):
                extract_function(source, "void target()")


@unittest.skipUnless(shutil.which("g++"), "host g++ unavailable")
class ProductionRebootChainTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="stackchan-reboot-host-")
        cls.addClassCleanup(cls.temporary.cleanup)
        directory = Path(cls.temporary.name)
        source = directory / "reboot.cpp"
        cls.executable = directory / "reboot-test"
        source.write_text(harness_source(), encoding="utf-8")
        subprocess.run(["g++", "-std=c++17", "-Wall", "-Wextra", "-Werror", "-pthread",
                        "-I", str(ROOT / "firmware/main/hal"), str(source),
                        "-o", str(cls.executable)], check=True, timeout=60)

    def scenario(self, name):
        subprocess.run([str(self.executable), name], check=True, timeout=5)

    def ack_failure_in_both_modes(self, name):
        for mode in ("Launcher", "Hermes"):
            with self.subTest(name=name, mode=mode):
                arguments = [str(self.executable), name]
                if mode == "Hermes":
                    arguments.append(mode)
                subprocess.run(arguments, check=True, timeout=5)

    def test_usb_success_ack_precedes_queued_restart(self):
        self.scenario("hermes_usb_open")

    def test_usb_short_error_or_oversized_write_never_reboots_or_drains(self):
        for name in ("usb_partial", "usb_error", "usb_oversized"):
            self.ack_failure_in_both_modes(name)

    def test_usb_drain_timeout_unlocks_and_never_reboots(self):
        self.ack_failure_in_both_modes("usb_drain_timeout")

    def test_usb_allocation_or_serialization_failure_never_reboots(self):
        for name in ("usb_alloc_failure", "usb_print_failure"):
            self.ack_failure_in_both_modes(name)

    def test_duplicate_acknowledged_hermes_requests_queue_one_return(self):
        self.scenario("hermes_usb_dedup")

    def test_concurrent_hermes_requests_atomically_deduplicate(self):
        self.scenario("hermes_concurrent_dedup")

    def test_closed_protocol_resets_without_close_then_stops_audio_and_restarts(self):
        self.scenario("hermes_closed")

    def test_missing_protocol_still_stops_audio_delays_and_restarts(self):
        self.scenario("hermes_none")

    def test_marker_affinity_and_order_are_owned_by_main_queue(self):
        self.scenario("hermes_marker_affinity")

    def test_audio_stop_sets_wake_bits_clears_all_queues_and_notifies(self):
        for name in ("audio_stop", "audio_stop_timer_error"):
            with self.subTest(name=name):
                self.scenario(name)

    def test_launcher_ack_then_nvs_only_without_runtime_lvgl_or_sd(self):
        self.scenario("launcher_usb")

    def test_launcher_direct_return_and_terminal_restart_deduplicate(self):
        self.scenario("launcher_direct")

    def test_consumed_launcher_marker_is_cleared_once(self):
        self.scenario("consume_marker")


if __name__ == "__main__":
    unittest.main()
