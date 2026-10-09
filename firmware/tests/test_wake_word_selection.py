"""Compile the production model-selection method against model-free host fixtures.

Only this method is extracted; no ESP library, model, task, device or assets are
loaded. In particular, stale MN/WN assets must not override disabled wake words.
"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


FIXTURE = r'''
#include <cassert>
#include <functional>
#include <memory>
#include <string>
#define ESP_MN_PREFIX "mn"
#define ESP_WN_PREFIX "wn"
#define ESP_LOGI(tag, ...) ((void)(tag))
[[maybe_unused]] constexpr const char* TAG = "AudioService";
struct srmodel_list_t { bool mn; bool wn; };
static int filters = 0;
const char* esp_srmodel_filter(srmodel_list_t* models, const char* prefix, const char*) {
    ++filters;
    return (std::string(prefix) == "mn" ? models->mn : models->wn) ? "public-model" : nullptr;
}
enum class Kind { Custom, Afe, Esp };
struct WakeWord {
    explicit WakeWord(Kind value) : kind(value) {}
    virtual ~WakeWord() = default;
    void OnWakeWordDetected(std::function<void(const std::string&)> value) { callback = std::move(value); }
    Kind kind;
    std::function<void(const std::string&)> callback;
};
struct CustomWakeWord : WakeWord { CustomWakeWord() : WakeWord(Kind::Custom) {} };
struct AfeWakeWord : WakeWord { AfeWakeWord() : WakeWord(Kind::Afe) {} };
struct EspWakeWord : WakeWord { EspWakeWord() : WakeWord(Kind::Esp) {} };
struct AudioService {
    srmodel_list_t* models_list_ = nullptr;
    std::unique_ptr<WakeWord> wake_word_;
    struct { std::function<void(const std::string&)> on_wake_word_detected; } callbacks_;
    void SetModelsList(srmodel_list_t* models);
};
'''
MAIN = r'''
int main() {
    for (bool mn : {false, true}) for (bool wn : {false, true}) {
        srmodel_list_t models{mn, wn};
        AudioService service;
        bool detected = false;
        service.callbacks_.on_wake_word_detected = [&](const std::string& word) { detected = word == "test"; };
        filters = 0;
        service.SetModelsList(&models);
        assert(service.models_list_ == &models); // VC still needs the borrowed catalog.
#if CONFIG_WAKE_WORD_DISABLED
        assert(!service.wake_word_);
        assert(filters == 0); // Disabled even when old assets contain both MN and WN.
#elif CONFIG_IDF_TARGET_ESP32S3 || CONFIG_IDF_TARGET_ESP32P4
        assert(bool(service.wake_word_) == (mn || wn));
        if (service.wake_word_) assert(service.wake_word_->kind == (mn ? Kind::Custom : Kind::Afe));
#else
        assert(bool(service.wake_word_) == wn);
        if (service.wake_word_) assert(service.wake_word_->kind == Kind::Esp);
#endif
        if (service.wake_word_) {
            service.wake_word_->callback("test");
            assert(detected);
        } else assert(!detected);
    }
}
'''


class WakeWordSelectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.compiler = shutil.which('c++')
        if cls.compiler is None:
            raise unittest.SkipTest('Host C++ compiler is unavailable')
        source = (Path(__file__).resolve().parents[1] / 'xiaozhi-esp32/main/audio/audio_service.cc').read_text()
        start = source.index('void AudioService::SetModelsList(')
        end = source.index('\nbool AudioService::IsAfeWakeWord()', start)
        cls.method = source[start:end]

    def compile_and_run(self, *, disabled, s3, p4):
        with tempfile.TemporaryDirectory(prefix='stackchan-wake-selection-') as directory:
            root = Path(directory)
            self.assertEqual(root.resolve(), root)
            self.assertEqual(root.parent, Path(tempfile.gettempdir()).resolve())
            self.assertTrue(root.name.startswith('stackchan-wake-selection-'))
            identity = root.stat()
            cpp = root / 'fixture.cpp'
            cpp.write_text(FIXTURE + self.method + MAIN)
            os.chmod(cpp, 0o600)
            executable = root / 'fixture'
            result = subprocess.run([
                self.compiler, '-std=c++17', '-Wall', '-Wextra', '-Werror',
                f'-DCONFIG_WAKE_WORD_DISABLED={disabled}',
                f'-DCONFIG_IDF_TARGET_ESP32S3={s3}', f'-DCONFIG_IDF_TARGET_ESP32P4={p4}',
                str(cpp), '-o', str(executable),
            ], capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run([str(executable)], capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            # Verify the exact owned temporary directory before automatic cleanup.
            self.assertEqual(root.resolve(), root)
            current = root.stat()
            self.assertEqual((current.st_dev, current.st_ino), (identity.st_dev, identity.st_ino))

    def test_disabled_ignores_stale_models(self):
        self.compile_and_run(disabled=1, s3=1, p4=0)

    def test_enabled_s3_preserves_selection_and_callback(self):
        self.compile_and_run(disabled=0, s3=1, p4=0)

    def test_enabled_p4_preserves_selection_and_callback(self):
        self.compile_and_run(disabled=0, s3=0, p4=1)

    def test_enabled_other_target_preserves_selection_and_callback(self):
        self.compile_and_run(disabled=0, s3=0, p4=0)


class ValidatedDefaultsTest(unittest.TestCase):
    def test_fresh_build_keeps_validated_passthrough_audio(self):
        defaults = (Path(__file__).resolve().parents[1] / 'sdkconfig.defaults').read_text()
        values = [line for line in defaults.splitlines()
                  if line.startswith('CONFIG_USE_AUDIO_PROCESSOR=')]
        self.assertEqual(values, ['CONFIG_USE_AUDIO_PROCESSOR=n'])


if __name__ == '__main__':
    unittest.main()
