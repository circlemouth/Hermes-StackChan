"""Structural guards for critical production wiring; not a hardware/LVGL test."""
from pathlib import Path
import unittest

FIRMWARE = Path(__file__).resolve().parents[1]


def source(relative):
    return (FIRMWARE / relative).read_text(encoding="utf-8")


def body(text, signature):
    start = text.index("{", text.index(signature))
    level = 1
    end = start + 1
    while level:
        level += (text[end] == "{") - (text[end] == "}")
        end += 1
    return text[start + 1:end - 1]


class FirmwareRuntimeContracts(unittest.TestCase):
    def test_hal_guard_really_unlocks_and_init_has_one_owner(self):
        hal = source("main/hal/hal.cpp")
        self.assertEqual(body(hal, "void Hal::lvglUnlock()").strip(), "hal_bridge::disply_lvgl_unlock();")
        init = body(hal, "void Hal::lvgl_init()")
        self.assertIn("LvglLockGuard", init)
        self.assertIn("if (!lock) return", init)
        self.assertNotIn("disply_lvgl_unlock", init)
        bridge = source("main/hal/board/hal_bridge.cc")
        self.assertIn("display->LvglUnlock()", body(bridge, "void disply_lvgl_unlock()"))

    def test_home_is_not_gated_on_network_and_escape_is_not_main_scheduled(self):
        hal = source("main/hal/hal.cpp")
        update = body(hal, "static void _stackchan_update_task")
        self.assertLess(update.index("PollVolumeLease"), update.index("LvglLockGuard"))
        self.assertIn("create_home_indicator", update)
        self.assertNotIn("is_hermes_ready", update[:update.index("create_home_indicator")])
        escape = body(hal, "void Hal::requestLauncherReturnReboot()")
        self.assertIn("xTaskCreate", escape)
        self.assertIn("esp_restart", escape)
        self.assertNotIn("Schedule", escape)

    def test_tts_reset_precedes_admission_and_main_never_waits_for_drain(self):
        app = source("xiaozhi-esp32/main/application.cc")
        start = app[app.index('strcmp(state->valuestring, "start")'):app.index('strcmp(state->valuestring, "stop")')]
        self.assertLess(start.index("ResetDecoder()"), start.index("Admit(generation)"))
        self.assertLess(start.index("Admit(generation)"), start.index("Schedule"))
        self.assertNotIn("WaitForPlaybackQueueEmpty", app)
        audio = app[app.index("protocol_->OnIncomingAudio"):app.index("protocol_->OnAudioChannelOpened")]
        self.assertLess(audio.index("PlaybackGeneration()"), audio.index("tts_admission_.accepts()"))
        self.assertIn("false, generation", audio)
        drain = body(source("xiaozhi-esp32/main/audio/audio_service.cc"), "bool AudioService::IsPlaybackDrained()")
        self.assertIn("decode_in_flight_", drain)
        self.assertIn("playback_in_flight_", drain)
        service = source("xiaozhi-esp32/main/audio/audio_service.cc")
        self.assertIn("if (!stale) ret = esp_opus_dec_decode", service)

    def test_lcd_spi_and_reset_sequence_are_preserved(self):
        board = source("main/hal/board/stackchan.cc")
        self.assertRegex(board, r"io_config\.pclk_hz\s*=\s*20 \* 1000 \* 1000")
        self.assertRegex(board, r"io_config\.trans_queue_depth\s*=\s*2")
        self.assertLess(board.index("esp_lcd_panel_reset(panel)"), board.index("aw9523_->ResetIli9342()"))
        self.assertLess(board.index("aw9523_->ResetIli9342()"), board.index("esp_lcd_panel_init(panel)"))
        self.assertRegex(source("main/hal/board/stackchan_display.cc"), r"\.swap_bytes\s*=\s*1")
        self.assertNotIn("esp_lcd_panel_draw_bitmap", source("main/main.cpp"))

    def test_worker_is_bounded_and_ui_effects_are_deferred(self):
        mcp = source("xiaozhi-esp32/main/mcp_server.cc")
        self.assertIn("xQueueCreate(1", mcp)
        self.assertIn("xQueueSend(work_queue_, &work, 0)", mcp)
        self.assertIn("10000", mcp)
        preview = source("main/hal/hal_mcp.cpp")
        self.assertIn("DeferWorkCompletion", preview)
        self.assertIn("TrySetPreviewImageForDuration", preview)
        camera = source("main/hal/board/stackchan_camera.cc")
        self.assertNotIn("encoder_thread_", camera)
        self.assertIn("ValidateDequeuedBuffer(buf)", camera)
        self.assertIn("DeferWorkCompletion", camera)
        self.assertIn("pdMS_TO_TICKS(750)", source("patches/esp-video-bounded-dequeue.patch"))

    def test_touch_failure_publishes_release(self):
        touch = body(source("main/hal/board/stackchan.cc"), "void PollTouchpad()")
        failure = body(touch, "if (!ft6336_->UpdateTouchPoint())")
        self.assertIn("set_touch_point(0, -1, -1)", failure)
        self.assertIn("return;", failure)

    def test_legacy_image_tools_cannot_bypass_worker_or_limits(self):
        mcp = source("xiaozhi-esp32/main/mcp_server.cc")
        slow = mcp[mcp.index("const bool slow"):mcp.index("if (slow)")]
        self.assertIn('"self.screen.snapshot"', slow)
        self.assertIn('"self.screen.preview_image"', slow)
        preview = mcp[mcp.index('AddUserOnlyTool("self.screen.preview_image"'):mcp.index("#endif // CONFIG_LV_USE_SNAPSHOT")]
        self.assertIn('"self.screen.preview_image_url"', preview)
        self.assertNotIn("CreateHttp", preview)
        self.assertNotIn("LvglAllocatedImage", preview)
        snapshot = mcp[mcp.index('AddUserOnlyTool("self.screen.snapshot"'):mcp.index('AddUserOnlyTool("self.screen.preview_image"')]
        self.assertIn("SetTimeout(3000)", snapshot)
        self.assertIn("ScopeExit", snapshot)
        self.assertIn("WorkCancelled()", snapshot)
        self.assertIn("8192", snapshot)
        self.assertNotIn("ReadAll", snapshot)
        self.assertNotIn("url.c_str()", snapshot)
        parser = body(mcp, "void McpServer::ParseMessage(const std::string& message)")
        self.assertIn("ContainsJsonNul", parser)
        self.assertIn("cJSON_ParseWithLength", parser)
        self.assertNotIn("message.c_str()", parser)
        jpeg = body(source("xiaozhi-esp32/main/display/lvgl_display/lvgl_display.cc"), "bool LvglDisplay::SnapshotToJpeg")
        self.assertIn("ScopeExit", jpeg)
        self.assertIn("output.failed", jpeg)
        self.assertIn("2 * 1024 * 1024", jpeg)

    def test_restart_required_and_unified_endpoint_contracts(self):
        self.assertIn("Save (Restart Required)", source("main/apps/app_setup/workers/ai_agent.cpp"))
        self.assertIn('"power_settings_apply", "next_restart"', source("main/hal/hal_mcp.cpp"))
        for file in ("main/apps/app_ai_agent/app_ai_agent.cpp", "main/hal/hal_mcp.cpp", "xiaozhi-esp32/main/application.cc", "xiaozhi-esp32/main/protocols/websocket_protocol.cc"):
            self.assertIn("GetEffectiveWebsocketUrl()", source(file), file)


if __name__ == "__main__":
    unittest.main()
