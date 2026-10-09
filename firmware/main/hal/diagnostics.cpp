#include "diagnostics.h"
#include "hal.h"
#include "board/hal_bridge.h"
#include <application.h>
#include <apps/app_launcher/app_launcher.h>
#include <apps/app_setup/app_setup.h>
#include <cJSON.h>
#include <esp_app_desc.h>
#include <esp_ota_ops.h>
#include <esp_log.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <settings.h>
#include <sdkconfig.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#include <atomic>
#include <cstdio>
#include <driver/usb_serial_jtag.h>
#include <driver/usb_serial_jtag_vfs.h>

namespace diagnostics {
namespace {
QueueHandle_t actions = nullptr;
TaskHandle_t usb_task = nullptr;
TaskHandle_t main_task = nullptr;
AppLauncher* launcher_app = nullptr;
AppSetup* setup_app = nullptr;
std::atomic<bool> hermes{false};
// Bound the otherwise unbounded Application schedule queue to one USB listen job.
std::atomic<bool> listen_pending{false};
bool pending_sd_prompt = false; // Only touched by app_main.
int64_t prompt_deadline = 0;
constexpr unsigned kQueueDepth = 4;
constexpr size_t kMaxReply = 1024;

const char* deviceStateName()
{
    // Never instantiate Application from USB before main-thread initialization completes.
    if (!hermes.load() || !hal_bridge::is_hermes_mode() ||
        !hal_bridge::is_hermes_runtime_initialized()) return "unavailable";
    // GetDeviceState is an atomic read. Return only our static allowlist, no payloads.
    switch (Application::GetInstance().GetDeviceState()) {
    case kDeviceStateStarting: return "starting";
    case kDeviceStateWifiConfiguring: return "wifi_configuring";
    case kDeviceStateIdle: return "idle";
    case kDeviceStateConnecting: return "connecting";
    case kDeviceStateListening: return "listening";
    case kDeviceStateSpeaking: return "speaking";
    case kDeviceStateUpgrading: return "upgrading";
    case kDeviceStateActivating: return "activating";
    case kDeviceStateAudioTesting: return "audio_testing";
    case kDeviceStateFatalError: return "fatal_error";
    default: return "unknown";
    }
}

// Fixed output size and bounded transport wait. Lock stdout to avoid ordinary ESP log
// writes splitting our marker/JSON. ROM/panic output may still interrupt a reply.
bool sendReply(Command command, bool ok, const char* result, bool status = false)
{
    cJSON* root = cJSON_CreateObject();
    if (!root) return false;
    cJSON_AddNumberToObject(root, "protocol_version", kProtocolVersion);
    cJSON_AddStringToObject(root, "command", commandName(command));
    cJSON_AddBoolToObject(root, "ok", ok);
    cJSON_AddStringToObject(root, "result", result);
    cJSON_AddStringToObject(root, "state", hermes.load() ? "Hermes" : "Launcher");
    if (status) {
        cJSON_AddStringToObject(root, "device_state", deviceStateName());
        const auto* description = esp_app_get_description();
        cJSON_AddStringToObject(root, "app_version", description->version);
        cJSON_AddNumberToObject(root, "free_heap", esp_get_free_heap_size());
        cJSON* boot = cJSON_AddObjectToObject(root, "boot");
        if (boot) {
            char elf_prefix[17];
            for (size_t i = 0; i < 8; ++i) {
                std::snprintf(elf_prefix + i * 2, 3, "%02x", static_cast<unsigned>(description->app_elf_sha256[i]));
            }
            cJSON_AddStringToObject(boot, "elf_sha256_prefix", elf_prefix);
            cJSON_AddNumberToObject(boot, "reset_reason", static_cast<int>(esp_reset_reason()));
            cJSON_AddNumberToObject(boot, "uptime_ms", esp_timer_get_time() / 1000);
            cJSON_AddNumberToObject(boot, "reply_core", xPortGetCoreID());
            const auto* partition = esp_ota_get_running_partition();
            if (partition) {
                cJSON_AddStringToObject(boot, "running_partition", partition->label);
                cJSON_AddNumberToObject(boot, "app_offset", partition->address);
                esp_ota_img_states_t image_state;
                if (esp_ota_get_state_partition(partition, &image_state) == ESP_OK) {
                    cJSON_AddNumberToObject(boot, "ota_state", static_cast<int>(image_state));
                }
            }
        }
        cJSON* stacks = cJSON_AddObjectToObject(root, "task_stack_low_water_bytes");
        if (stacks) {
            // ESP-IDF reports these values in bytes, unlike upstream FreeRTOS.
            cJSON_AddNumberToObject(stacks, "app_main", uxTaskGetStackHighWaterMark(main_task));
            cJSON_AddNumberToObject(stacks, "sc_diag_usb", uxTaskGetStackHighWaterMark(usb_task));
        }
        Settings settings("websocket", false);
        auto url = settings.GetString("url_override", "");
        if (url.empty()) url = settings.GetString("url", "");
        const auto endpoint = redactedEndpoint(url);
        cJSON* network = cJSON_AddObjectToObject(root, "network");
        if (network) {
            cJSON_AddBoolToObject(network, "connected", GetHAL().getWifiStatus() != WifiStatus::None);
            cJSON_AddStringToObject(network, "scheme", endpoint.scheme.c_str());
            cJSON_AddStringToObject(network, "host", endpoint.host.c_str());
        }
        if (!hermes.load()) cJSON_AddBoolToObject(root, "sd_confirmation_active", setup_app->diagnosticsSdPromptActive());
    }
    char output[kMaxReply];
    constexpr char prefix[] = "SC_DIAG_REPLY ";
    std::memcpy(output, prefix, sizeof(prefix) - 1);
    const bool printed = cJSON_PrintPreallocated(root, output + sizeof(prefix) - 1,
                                               sizeof(output) - sizeof(prefix) - 2, false);
    cJSON_Delete(root);
    if (!printed) return false;
    const size_t length = std::strlen(output);
    output[length] = '\n';
    flockfile(stdout);
    const int written = usb_serial_jtag_write_bytes(output, length + 1, pdMS_TO_TICKS(250));
    const bool drained = written == static_cast<int>(length + 1) &&
                        usb_serial_jtag_wait_tx_done(pdMS_TO_TICKS(250)) == ESP_OK;
    funlockfile(stdout);
    return drained;
}

void handle(Command command, bool runtime)
{
    if (command == Command::Overflow || command == Command::Invalid || command == Command::Unknown) {
        sendReply(command, false, command == Command::Overflow ? "line_too_long" :
                                  command == Command::Invalid ? "invalid_line" : "unknown_command");
        return;
    }
    if (command == Command::Status) {
        sendReply(command, true, "status", true);
        return;
    }
    if (command == Command::Reboot) {
        // No reboot unless its structured acknowledgement was delivered before reset.
        if (sendReply(command, true, "rebooting_to_launcher")) GetHAL().requestLauncherReturnReboot();
        return;
    }
    if (command == Command::ListenStart || command == Command::ListenStop) {
        if (const char* refusal = listenRefusal(runtime, deviceStateName())) {
            sendReply(command, false, refusal);
            return;
        }
        if (listen_pending.exchange(true)) {
            sendReply(command, false, "listen_busy");
            return;
        }
        // Schedule only from USB, outside every LVGL lock. Recheck readiness
        // before posting the event; the Application event handler owns execution.
        Application::GetInstance().Schedule([command]() {
            if (!listenRefusal(hermes.load(), deviceStateName())) {
                auto& app = Application::GetInstance();
                if (command == Command::ListenStart) app.StartListening();
                else app.StopListening();
            }
            listen_pending.store(false);
        });
        // Acceptance only: the callback/event may be a no-op or state may change.
        // Lost ACK means outcome unknown; there is deliberately no automatic retry.
        sendReply(command, true, command == Command::ListenStart ? "listen_start_requested" : "listen_stop_requested");
        return;
    }
    if (runtime) {
        sendReply(command, false, "requires_launcher");
        return;
    }
    switch (command) {
    case Command::OpenSetup:
    case Command::OpenHermes: {
        bool opened = command == Command::OpenSetup && setup_app->isDiagnosticsOpen();
        if (!opened) opened = launcher_app->diagnosticsOpenApp(command == Command::OpenSetup ? "SETUP" : "HERMES");
        sendReply(command, opened, opened ? "open_requested" : "ui_busy");
        break;
    }
    case Command::SdPrompt:
        if (setup_app->isDiagnosticsOpen()) {
            bool shown = setup_app->diagnosticsShowSdPrompt();
            sendReply(command, shown, shown ? "sd_confirmation_active" : "ui_busy");
        } else if (launcher_app->diagnosticsOpenApp("SETUP")) {
            pending_sd_prompt = true;
            prompt_deadline = esp_timer_get_time() + 3000000;
        } else sendReply(command, false, "ui_busy");
        break;
    case Command::SdRead:
        // Reserve the same Read flag under the UI lock before acknowledging. Only
        // app_main can consume it, on its NEXT iteration, after USB TX has drained.
        if (!setup_app->diagnosticsRequestSdRead()) sendReply(command, false, "sd_confirmation_required");
        else if (!sendReply(command, true, "boot_import_requested_restart_required")) {
            setup_app->diagnosticsCancelSdRead(); // No unacknowledged diagnostic restart.
        }
        break;
    default: break;
    }
}

void usbInput(void*)
{
    LineParser parser;
    unsigned char bytes[64];
    while (true) {
        // Direct USB driver only, never stdin/UART. Timeout also services runtime actions.
        const int count = usb_serial_jtag_read_bytes(bytes, sizeof(bytes), pdMS_TO_TICKS(50));
        for (int i = 0; i < count; ++i) {
            const Command command = parser.push(bytes[i]);
            if (command != Command::None && xQueueSend(actions, &command, 0) != pdTRUE) {
                sendReply(command, false, "queue_full");
            }
        }
        if (hermes.load()) {
            Command command;
            if (xQueueReceive(actions, &command, 0) == pdTRUE) handle(command, true);
        }
        // Bound CPU use under sustained input too; no nonblocking-read busy spin.
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}
} // namespace

bool init(AppLauncher* launcher, AppSetup* setup)
{
#if !CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG_ENABLED
    return false; // Never fall back to UART or network.
#else
    if (actions) return true;
    if (!launcher || !setup) return false;
    if (!usb_serial_jtag_is_driver_installed()) {
        usb_serial_jtag_driver_config_t config = { .tx_buffer_size = 2048, .rx_buffer_size = 256 };
        if (usb_serial_jtag_driver_install(&config) != ESP_OK) return false;
    }
    // Console and diagnostic replies must share the driver's TX ring, not race over FIFO.
    usb_serial_jtag_vfs_use_driver();
    actions = xQueueCreate(kQueueDepth, sizeof(Command));
    if (!actions) return false;
    main_task = xTaskGetCurrentTaskHandle();
    launcher_app = launcher;
    setup_app = setup;
    if (xTaskCreate(usbInput, "sc_diag_usb", 6144, nullptr, 2, &usb_task) != pdPASS) {
        vQueueDelete(actions);
        actions = nullptr;
        return false;
    }
    return true;
#endif
}

void process()
{
    if (!actions || hermes.load()) return;
    if (pending_sd_prompt) {
        if (setup_app->isDiagnosticsOpen()) {
            const bool shown = setup_app->diagnosticsShowSdPrompt();
            sendReply(Command::SdPrompt, shown, shown ? "sd_confirmation_active" : "ui_busy");
            pending_sd_prompt = false;
        } else if (esp_timer_get_time() >= prompt_deadline) {
            sendReply(Command::SdPrompt, false, "ui_timeout");
            pending_sd_prompt = false;
        }
        return;
    }
    Command command;
    if (xQueueReceive(actions, &command, 0) == pdTRUE) handle(command, false);
}

void markHermesHandoff()
{
    // Clear borrowed UI pointers before allowing the USB consumer to run. Runtime
    // handler cannot access them, even when a UI request was queued before teardown.
    if (pending_sd_prompt) sendReply(Command::SdPrompt, false, "requires_launcher");
    pending_sd_prompt = false;
    launcher_app = nullptr;
    setup_app = nullptr;
    hermes.store(true);
}
} // namespace diagnostics
