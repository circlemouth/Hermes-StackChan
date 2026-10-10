"""Apply the pinned control patch; exercise actual wrapper methods with failures."""
from pathlib import Path
import os
import subprocess
import sys
import tempfile
import unittest

FIRMWARE = Path(__file__).resolve().parents[1]
PATCH = FIRMWARE / "patches/esp-codec-control-errors.patch"
VENDOR = FIRMWARE / "managed_components/espressif__esp_codec_dev/esp_codec_dev.c"
COMPILER = sys.argv.pop(1) if len(sys.argv) > 1 else "c++"
SIGNATURES = (
    "static bool _verify_codec_ready(codec_dev_t *dev)",
    "static bool _verify_drv_ready(codec_dev_t *dev, bool playback)",
    "static int _verify_codec_setting(codec_dev_t *dev, bool playback)",
    "int esp_codec_dev_set_out_vol(esp_codec_dev_handle_t handle, int volume)",
    "int esp_codec_dev_set_out_mute(esp_codec_dev_handle_t handle, bool mute)",
    "int esp_codec_dev_set_in_gain(esp_codec_dev_handle_t handle, float db)",
    "int esp_codec_dev_set_in_channel_gain(esp_codec_dev_handle_t handle, uint16_t channel_mask, float db)",
    "int esp_codec_dev_set_in_mute(esp_codec_dev_handle_t handle, bool mute)",
    "static int _update_codec_setting(codec_dev_t *dev)",
    "int esp_codec_dev_close(esp_codec_dev_handle_t handle)",
    "int esp_codec_dev_open(esp_codec_dev_handle_t handle, esp_codec_dev_sample_info_t *fs)",
)


def method(text, signature):
    start = text.index(signature)
    opening = text.index("{", start)
    level = 1
    end = opening + 1
    while level:
        level += (text[end] == "{") - (text[end] == "}")
        end += 1
    return text[start:end]


FIXTURE = r'''
#include <cassert>
#include <cstdint>
#include <cstddef>
#include <initializer_list>
#define ESP_LOGI(...) ((void)0)
#define ESP_LOGE(...) ((void)0)
constexpr int ESP_CODEC_DEV_OK=0,ESP_CODEC_DEV_INVALID_ARG=-1,ESP_CODEC_DEV_WRONG_STATE=-2;
constexpr int ESP_CODEC_DEV_NOT_SUPPORT=-3,ESP_CODEC_DEV_DRV_ERR=-4;
constexpr int ESP_CODEC_DEV_TYPE_IN=1,ESP_CODEC_DEV_TYPE_OUT=2,VOL_TRANSITION_TIME=50;
using esp_codec_dev_handle_t=void*;
struct esp_codec_dev_sample_info_t {};
struct audio_codec_if_t {
    bool (*is_open)(const audio_codec_if_t*);
    int (*set_fs)(const audio_codec_if_t*,esp_codec_dev_sample_info_t*);
    int (*enable)(const audio_codec_if_t*,bool);
    int (*set_vol)(const audio_codec_if_t*,float);
    int (*mute)(const audio_codec_if_t*,bool);
    int (*set_mic_gain)(const audio_codec_if_t*,int);
    int (*set_mic_channel_gain)(const audio_codec_if_t*,uint16_t,int);
    int (*mute_mic)(const audio_codec_if_t*,bool);
};
struct audio_codec_data_if_t {
    bool (*is_open)(const audio_codec_data_if_t*);
    int (*write)(const audio_codec_data_if_t*,uint8_t*,int);
    int (*read)(const audio_codec_data_if_t*,uint8_t*,int);
    int (*set_fmt)(const audio_codec_data_if_t*,int,esp_codec_dev_sample_info_t*);
    int (*enable)(const audio_codec_data_if_t*,int,bool);
};
struct audio_codec_vol_if_t {
    int (*open)(const audio_codec_vol_if_t*,esp_codec_dev_sample_info_t*,int);
    int (*set_vol)(const audio_codec_vol_if_t*,float);
    int (*close)(const audio_codec_vol_if_t*);
};
struct Curve {};
struct codec_dev_t {
    const audio_codec_if_t* codec_if=nullptr;
    const audio_codec_data_if_t* data_if=nullptr;
    const audio_codec_vol_if_t* sw_vol=nullptr;
    int dev_caps=ESP_CODEC_DEV_TYPE_OUT;
    bool input_opened=false,output_opened=false,disable_when_closed=true;
    int volume=30;
    float mic_gain=0;
    bool muted=false,mic_muted=false,sw_vol_alloced=false;
    Curve vol_curve;
};
int volume_result=0,mute_result=0,close_calls=0,mic_gain_result=0,mic_mute_result=0;
int format_result=0,data_enable_result=0,codec_format_result=0,codec_enable_result=0,software_open_result=0;
bool hardware_mute=false,require_muted_open=false,hardware_ready=true;
float _get_vol_db(Curve*,int volume) { return static_cast<float>(volume); }
int esp_codec_dev_set_out_vol(esp_codec_dev_handle_t,int);
int esp_codec_dev_set_out_mute(esp_codec_dev_handle_t,bool);
int esp_codec_dev_set_in_gain(esp_codec_dev_handle_t,float);
int esp_codec_dev_set_in_mute(esp_codec_dev_handle_t,bool);
int codec_close_result=0,data_close_result=0,software_close_result=0;
int esp_codec_dev_close(esp_codec_dev_handle_t);
bool HardwareReady(const audio_codec_if_t*) { return hardware_ready; }
int SetVolume(const audio_codec_if_t*,float) { return volume_result; }
int SetMute(const audio_codec_if_t*,bool mute) { if (!mute_result) hardware_mute=mute; return mute_result; }
int Enable(const audio_codec_if_t*,bool enable) { if (enable && require_muted_open) assert(hardware_mute); return enable ? codec_enable_result : codec_close_result; }
int CodecFormat(const audio_codec_if_t*,esp_codec_dev_sample_info_t*) { return codec_format_result; }
int DataFormat(const audio_codec_data_if_t*,int,esp_codec_dev_sample_info_t*) { return format_result; }
int DataEnable(const audio_codec_data_if_t*,int,bool enable) { if (!enable) ++close_calls; return enable ? data_enable_result : data_close_result; }
int Write(const audio_codec_data_if_t*,uint8_t*,int) { return 0; }
int MicrophoneGain(const audio_codec_if_t*,int) { return mic_gain_result; }
int MicrophoneChannelGain(const audio_codec_if_t*,uint16_t,int) { return mic_gain_result; }
int MicrophoneMute(const audio_codec_if_t*,bool) { return mic_mute_result; }
int SoftwareVolume(const audio_codec_vol_if_t*,float) { return volume_result; }
int SoftwareOpen(const audio_codec_vol_if_t*,esp_codec_dev_sample_info_t*,int) { return software_open_result; }
int SoftwareClose(const audio_codec_vol_if_t*) { return software_close_result; }
audio_codec_vol_if_t software{SoftwareOpen,SoftwareVolume,SoftwareClose};
const audio_codec_vol_if_t* audio_codec_new_sw_vol() { return &software; }
__METHODS__
int main() {
    audio_codec_if_t codec{HardwareReady,CodecFormat,Enable,SetVolume,SetMute,MicrophoneGain,MicrophoneChannelGain,MicrophoneMute};
    audio_codec_data_if_t data{nullptr,Write,Write,DataFormat,DataEnable};
    codec_dev_t dev; dev.codec_if=&codec; dev.data_if=&data;
    assert(esp_codec_dev_set_out_vol(nullptr,5)==ESP_CODEC_DEV_INVALID_ARG);
    assert(esp_codec_dev_set_out_mute(nullptr,true)==ESP_CODEC_DEV_INVALID_ARG);
    volume_result=-42;
    assert(esp_codec_dev_set_out_vol(&dev,5)==-42 && dev.volume==30);
    volume_result=0;
    assert(esp_codec_dev_set_out_vol(&dev,5)==0 && dev.volume==5);
    mute_result=-43;
    assert(esp_codec_dev_set_out_mute(&dev,true)==-43 && !dev.muted && !hardware_mute);
    mute_result=0;
    // Underlying AW88298 remains configured while output is disabled. Stage the
    // wrapper's mute cache as well as hardware mute BEFORE reopening queued DMA.
    assert(!dev.output_opened);
    assert(esp_codec_dev_set_out_mute(&dev,true)==0 && dev.muted && hardware_mute);
    require_muted_open=true;
    esp_codec_dev_sample_info_t fs;
    assert(esp_codec_dev_open(&dev,&fs)==0 && hardware_mute && dev.output_opened);
    assert(esp_codec_dev_set_out_mute(&dev,false)==0 && !dev.muted && !hardware_mute);
    require_muted_open=false;
    for (int mode : {0,1}) {
        dev.output_opened=false;
        volume_result=mode==0 ? -44 : 0;
        mute_result=mode==1 ? -45 : 0;
        const int previous=close_calls;
        assert(esp_codec_dev_open(&dev,&fs)==(mode==0 ? -44 : -45));
        assert(!dev.output_opened && close_calls==previous+1);
    }
    volume_result=mute_result=0;
    for (int* failure : {&format_result,&data_enable_result,&codec_format_result,&codec_enable_result}) {
        *failure=-51;
        const int before=close_calls;
        assert(esp_codec_dev_open(&dev,&fs)==-51 && !dev.output_opened && close_calls==before+1);
        *failure=0;
    }
    dev.sw_vol=&software;
    software_open_result=-52;
    const int before_software=close_calls;
    assert(esp_codec_dev_open(&dev,&fs)==-52 && !dev.output_opened && close_calls==before_software+1);
    software_open_result=0;
    volume_result=-46;
    assert(esp_codec_dev_set_out_vol(&dev,99)==-46 && dev.volume==5);
    dev.output_opened=true;
    auto no_mute_codec=codec; no_mute_codec.mute=nullptr; dev.codec_if=&no_mute_codec;
    assert(esp_codec_dev_set_out_mute(&dev,true)==-46 && !dev.muted);
    volume_result=0;
    assert(esp_codec_dev_set_out_mute(&dev,true)==0 && dev.muted);
    dev.output_opened=false;
    assert(esp_codec_dev_set_out_mute(&dev,false)==ESP_CODEC_DEV_WRONG_STATE && dev.muted);
    dev.dev_caps=ESP_CODEC_DEV_TYPE_IN;
    assert(esp_codec_dev_set_out_vol(&dev,99)==ESP_CODEC_DEV_NOT_SUPPORT);
    assert(esp_codec_dev_set_out_mute(&dev,true)==ESP_CODEC_DEV_NOT_SUPPORT);
    dev.codec_if=&codec;
    mic_gain_result=-48;
    assert(esp_codec_dev_set_in_gain(&dev,11.5f)==-48 && dev.mic_gain==0);
    assert(esp_codec_dev_set_in_channel_gain(&dev,1,11.5f)==-48);
    assert(esp_codec_dev_set_in_channel_gain(&dev,0,11.5f)==ESP_CODEC_DEV_INVALID_ARG);
    int previous=close_calls;
    assert(esp_codec_dev_open(&dev,&fs)==-48 && !dev.input_opened && close_calls==previous+1);
    mic_gain_result=0; mic_mute_result=-49;
    assert(esp_codec_dev_set_in_mute(&dev,true)==-49 && !dev.mic_muted);
    previous=close_calls;
    assert(esp_codec_dev_open(&dev,&fs)==-49 && !dev.input_opened && close_calls==previous+1);
    mic_mute_result=0;
    assert(esp_codec_dev_set_in_gain(&dev,11.5f)==0 && dev.mic_gain==11.5f);
    assert(esp_codec_dev_set_in_channel_gain(&dev,1,11.5f)==0);
    assert(esp_codec_dev_set_in_mute(&dev,true)==0 && dev.mic_muted);
    dev.dev_caps=ESP_CODEC_DEV_TYPE_OUT; hardware_ready=false;
    assert(esp_codec_dev_set_out_vol(&dev,99)==ESP_CODEC_DEV_WRONG_STATE);
    assert(esp_codec_dev_set_out_mute(&dev,true)==ESP_CODEC_DEV_WRONG_STATE);
    for (int* failure : {&codec_close_result,&data_close_result,&software_close_result}) {
        dev.output_opened=true; *failure=-53;
        assert(esp_codec_dev_close(&dev)==-53 && dev.output_opened);
        *failure=0;
        assert(esp_codec_dev_close(&dev)==0 && !dev.output_opened);
    }
    dev.output_opened=true;
    codec_close_result=-54; data_close_result=-55; software_close_result=-56;
    assert(esp_codec_dev_close(&dev)==-54 && dev.output_opened);
    codec_close_result=data_close_result=software_close_result=0;
    assert(esp_codec_dev_close(&dev)==0 && !dev.output_opened);
}
'''


class CodecControlErrorsTest(unittest.TestCase):
    def test_clean_patch_and_real_control_error_propagation(self):
        env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull, GIT_ATTR_NOSYSTEM="1")
        with tempfile.TemporaryDirectory(prefix="stackchan-codec-control-test-") as directory:
            root = Path(directory).resolve()
            self.assertEqual(root.parent, Path(tempfile.gettempdir()).resolve())
            self.assertTrue(root.name.startswith("stackchan-codec-control-test-"))
            target = root / "esp_codec_dev.c"
            target.write_bytes((FIRMWARE / "tests/runtime_stubs/esp_codec_control_unpatched.c").read_bytes())
            def git(*args):
                subprocess.run(["git", *args], cwd=root, env=env, check=True, capture_output=True)
            git("init", "--quiet")
            git("apply", "--check", str(PATCH))
            git("apply", str(PATCH))
            git("apply", "--reverse", "--check", str(PATCH))
            patched = target.read_text()
            methods = "\n".join(method(patched, signature) for signature in SIGNATURES)
            if VENDOR.exists():
                vendor = VENDOR.read_text()
                for signature in SIGNATURES:
                    self.assertEqual(method(patched, signature), method(vendor, signature), signature)
            source = root / "control.cpp"
            binary = root / "control"
            source.write_text(FIXTURE.replace("__METHODS__", methods))
            subprocess.run([COMPILER, "-std=c++17", "-UNDEBUG", "-Wall", "-Wextra", str(source), "-o", str(binary)],
                           check=True, timeout=20)
            subprocess.run([str(binary)], check=True, timeout=10)
            git("apply", "--reverse", str(PATCH))
            git("apply", "--check", str(PATCH))


if __name__ == "__main__":
    unittest.main()
