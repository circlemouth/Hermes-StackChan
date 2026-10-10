#!/usr/bin/env python3
"""Apply the pinned codec patch and compile real I2S adapter methods with faults."""
from pathlib import Path
import os
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
FIRMWARE = HERE.parent
PATCH = FIRMWARE / "patches/esp-codec-complete-io.patch"
VENDOR = FIRMWARE / "managed_components/espressif__esp_codec_dev/platform/audio_codec_data_i2s.c"


def methods(text):
    return text[text.index("static int _i2s_data_read("):text.index("static int _i2s_data_close(")]


def format_methods(text):
    start = text.index("static int _i2s_data_enable(")
    return text[start:text.index("static int _i2s_data_read(")]


PRELUDE = r"""
#include <cassert>
#include <cstdint>
#include <cstring>
#include <algorithm>
#define ESP_IDF_VERSION_VAL(a,b,c) ((a)*10000+(b)*100+(c))
#define ESP_IDF_VERSION ESP_IDF_VERSION_VAL(5,5,4)
#define DEFAULT_WAIT_TIMEOUT 1000
constexpr int ESP_CODEC_DEV_OK=0, ESP_CODEC_DEV_INVALID_ARG=-1;
constexpr int ESP_CODEC_DEV_WRONG_STATE=-2, ESP_CODEC_DEV_DRV_ERR=-3;
using audio_codec_data_if_t=void;
using i2s_chan_handle_t=void*;
struct i2s_data_t { bool is_open; void* in_handle; void* out_handle; bool in_reconfig; bool out_reconfig; };
static size_t transfer=16;
static int driver_result=0, calls=0, sleeps=0, timeout=0;
static void esp_codec_dev_sleep(int ms) { assert(ms==10); ++sleeps; }
static int i2s_channel_read(void*, uint8_t* data, int size, size_t* count, int ms) {
    ++calls; timeout=ms; *count=transfer;
    std::memset(data, 0x11, std::min(transfer, static_cast<size_t>(size)));
    return driver_result;
}
static int i2s_channel_write(void*, uint8_t*, int, size_t* count, int ms) {
    ++calls; timeout=ms; *count=transfer; return driver_result;
}
"""
CASES = r"""
int main() {
    using Function=int(*)(const audio_codec_data_if_t*, uint8_t*, int);
    for (Function function : {_i2s_data_read, _i2s_data_write}) {
        uint8_t bytes[16];
        i2s_data_t adapter{false, nullptr, nullptr, false, false};
        assert(function(nullptr, bytes, sizeof(bytes))==ESP_CODEC_DEV_INVALID_ARG);
        assert(function(&adapter, bytes, sizeof(bytes))==ESP_CODEC_DEV_WRONG_STATE);
        adapter.is_open=true;
        assert(function(&adapter, bytes, sizeof(bytes))==ESP_CODEC_DEV_DRV_ERR);
        adapter.in_handle=adapter.out_handle=&adapter;
        driver_result=0;
        for (size_t count : {0u, 1u, 15u, 17u}) {
            transfer=count;
            assert(function(&adapter, bytes, sizeof(bytes))==ESP_CODEC_DEV_DRV_ERR);
            assert(timeout==1000);
        }
        transfer=sizeof(bytes);
        assert(function(&adapter, bytes, sizeof(bytes))==ESP_CODEC_DEV_OK);
        driver_result=1;
        assert(function(&adapter, bytes, sizeof(bytes))==ESP_CODEC_DEV_DRV_ERR);
        driver_result=0;
        adapter.in_reconfig=adapter.out_reconfig=true;
        const int previous=calls;
        std::memset(bytes, 0x77, sizeof(bytes));
        assert(function(&adapter, bytes, sizeof(bytes))==ESP_CODEC_DEV_WRONG_STATE);
        assert(calls==previous);
        if (function==_i2s_data_read) for (uint8_t byte : bytes) assert(byte==0);
    }
    assert(sleeps==2);
}
"""


FORMAT_PRELUDE = r"""
#include <cassert>
#include <cstdint>
#include <cstring>
#define ESP_IDF_VERSION_VAL(a,b,c) ((a)*10000+(b)*100+(c))
#define ESP_IDF_VERSION ESP_IDF_VERSION_VAL(5,5,4)
#define ESP_CODEC_DEV_MAKE_CHANNEL_MASK(i) (1u << (i))
#define SOC_I2S_HW_VERSION_1 1
#define ESP_LOGI(...) ((void)0)
constexpr int ESP_CODEC_DEV_OK=0,ESP_CODEC_DEV_INVALID_ARG=-1,ESP_CODEC_DEV_WRONG_STATE=-2,ESP_CODEC_DEV_NOT_SUPPORT=-3;
constexpr int ESP_CODEC_DEV_TYPE_IN=1,ESP_CODEC_DEV_TYPE_OUT=2,ESP_CODEC_DEV_TYPE_IN_OUT=3;
using esp_codec_dev_type_t=int;
using audio_codec_data_if_t=void;
struct esp_codec_dev_sample_info_t { int bits_per_sample,channel; uint16_t channel_mask; uint32_t sample_rate; int mclk_multiple; };
struct i2s_data_t {
    bool is_open=false,in_reconfig=false,out_reconfig=false,in_fmt_valid=false,out_fmt_valid=false;
    bool in_enable=false,out_enable=false,in_disable_pending=false,out_disable_pending=false;
    void* in_handle=nullptr;
    void* out_handle=nullptr;
    esp_codec_dev_sample_info_t in_fs{},out_fs{},fs{};
};
int locked=0,disables=0,compat_calls=0,sets=0,disable_error=0,compat_error=0,set_error=0;
void _i2s_lock(i2s_data_t*,const char*) { assert(locked==0); ++locked; }
void _i2s_unlock(i2s_data_t*) { assert(locked==1); --locked; }
bool _i2s_valid_fmt(esp_codec_dev_sample_info_t* fs) { return fs->sample_rate>0 && fs->channel>0 && fs->bits_per_sample>0; }
int out_error=0,in_error=0,enables=0;
int _i2s_drv_enable(i2s_data_t*,bool output,bool enable) {
    assert(locked==1); if (!enable) ++disables; else ++enables;
    return !enable && disable_error ? disable_error : (output ? out_error : in_error);
}
int check_fs_compatible(i2s_data_t* adapter,bool output,esp_codec_dev_sample_info_t* fs) {
    assert(locked==1); ++compat_calls;
    // A failed vendor reconfiguration can populate its cache before returning.
    (output ? adapter->out_fs : adapter->in_fs)=*fs;
    return compat_error;
}
int set_fs(i2s_data_t*,bool,bool) { assert(locked==1); ++sets; return set_error; }
i2s_data_t* get_paired(i2s_data_t* adapter,bool) { return adapter; }
"""
FORMAT_CASES = r"""
int main() {
    i2s_data_t adapter;
    esp_codec_dev_sample_info_t mono{16,1,0,24000,0};
    assert(_i2s_data_set_fmt(nullptr,ESP_CODEC_DEV_TYPE_OUT,&mono)==ESP_CODEC_DEV_INVALID_ARG);
    assert(_i2s_data_set_fmt(&adapter,ESP_CODEC_DEV_TYPE_OUT,nullptr)==ESP_CODEC_DEV_INVALID_ARG);
    assert(_i2s_data_set_fmt(&adapter,ESP_CODEC_DEV_TYPE_OUT,&mono)==ESP_CODEC_DEV_WRONG_STATE);
    adapter.is_open=true;
    assert(_i2s_data_set_fmt(&adapter,ESP_CODEC_DEV_TYPE_OUT,&mono)==0);
    assert(adapter.out_fmt_valid && adapter.out_fs.channel==2 && adapter.out_fs.channel_mask==1);
    assert(mono.channel==1 && mono.channel_mask==0 && disables==1 && compat_calls==1 && locked==0);
    auto input=adapter.out_fs;
    assert(_i2s_data_set_fmt(&adapter,ESP_CODEC_DEV_TYPE_IN,&input)==0);
    adapter.in_enable=true; adapter.out_enable=false;
    const int before=disables,previous=compat_calls;
    // Muted output reopen with a live microphone must leave TX clock running.
    assert(_i2s_data_set_fmt(&adapter,ESP_CODEC_DEV_TYPE_OUT,&mono)==0);
    assert(disables==before && compat_calls==previous && locked==0);
    auto changed=mono; changed.mclk_multiple=512;
    assert(_i2s_data_set_fmt(&adapter,ESP_CODEC_DEV_TYPE_OUT,&changed)==0 && disables==before+1);
    changed.bits_per_sample=32;
    assert(_i2s_data_set_fmt(&adapter,ESP_CODEC_DEV_TYPE_OUT,&changed)==0 && disables==before+2);
    changed.channel=4; changed.channel_mask=0;
    assert(_i2s_data_set_fmt(&adapter,ESP_CODEC_DEV_TYPE_OUT,&changed)==0 && adapter.out_fs.channel_mask==15);
    changed.channel_mask=3;
    assert(_i2s_data_set_fmt(&adapter,ESP_CODEC_DEV_TYPE_OUT,&changed)==0);
    changed.sample_rate=16000;
    disable_error=-19;
    const int compatibility_before=compat_calls;
    assert(_i2s_data_set_fmt(&adapter,ESP_CODEC_DEV_TYPE_OUT,&changed)==-19);
    assert(!adapter.in_fmt_valid && !adapter.out_fmt_valid && compat_calls==compatibility_before && locked==0);
    disable_error=0; compat_error=-20;
    assert(_i2s_data_set_fmt(&adapter,ESP_CODEC_DEV_TYPE_OUT,&changed)==-20 && !adapter.out_fmt_valid);
    compat_error=0;
    const int failed_disables=disables;
    assert(_i2s_data_set_fmt(&adapter,ESP_CODEC_DEV_TYPE_OUT,&changed)==0 && disables==failed_disables+1);
    // Identical cached fields do not excuse a pending reconfiguration.
    adapter.out_reconfig=true;
    assert(_i2s_data_set_fmt(&adapter,ESP_CODEC_DEV_TYPE_OUT,&changed)==0 && disables==failed_disables+2);
    adapter.out_reconfig=false;
    changed.sample_rate=32000; set_error=-21;
    assert(_i2s_data_set_fmt(&adapter,ESP_CODEC_DEV_TYPE_IN_OUT,&changed)==-21 && sets==1);
    assert(!adapter.in_fmt_valid && !adapter.out_fmt_valid && locked==0);
    set_error=0;
    assert(_i2s_data_set_fmt(&adapter,ESP_CODEC_DEV_TYPE_IN_OUT,&changed)==0 && sets==3);
    assert(adapter.in_fmt_valid && adapter.out_fmt_valid);
    const int combined_disables=disables;
    assert(_i2s_data_set_fmt(&adapter,ESP_CODEC_DEV_TYPE_IN_OUT,&changed)==0 && sets==3 && disables==combined_disables);
    changed.sample_rate=0;
    assert(_i2s_data_set_fmt(&adapter,ESP_CODEC_DEV_TYPE_OUT,&changed)==ESP_CODEC_DEV_NOT_SUPPORT && locked==0);
    adapter.in_handle=adapter.out_handle=&adapter;
    adapter.in_enable=true; adapter.out_enable=false;
    const int pending_disables=disables;
    assert(_i2s_data_enable(&adapter,ESP_CODEC_DEV_TYPE_OUT,false)==0 && adapter.out_disable_pending && disables==pending_disables);
    in_error=-25;
    assert(_i2s_data_enable(&adapter,ESP_CODEC_DEV_TYPE_IN,false)==-25 && adapter.in_enable && adapter.out_disable_pending);
    assert(disables==pending_disables+1); // RX failure must not be overwritten by TX success.
    in_error=0; out_error=-26;
    assert(_i2s_data_enable(&adapter,ESP_CODEC_DEV_TYPE_IN,false)==-26 && adapter.in_enable && adapter.out_disable_pending);
    out_error=0;
    assert(_i2s_data_enable(&adapter,ESP_CODEC_DEV_TYPE_IN,false)==0 && !adapter.in_enable && !adapter.out_disable_pending);
    out_error=-27;
    assert(_i2s_data_enable(&adapter,ESP_CODEC_DEV_TYPE_IN_OUT,true)==-27 && !adapter.out_enable && adapter.in_enable);
    out_error=0; in_error=-28;
    assert(_i2s_data_enable(&adapter,ESP_CODEC_DEV_TYPE_IN_OUT,false)==-28 && !adapter.out_enable && adapter.in_enable);
    out_error=-29; in_error=-30;
    assert(_i2s_data_enable(&adapter,ESP_CODEC_DEV_TYPE_IN_OUT,true)==-29 && !adapter.out_enable && adapter.in_enable);
    out_error=in_error=0;
    assert(_i2s_data_enable(&adapter,ESP_CODEC_DEV_TYPE_IN_OUT,true)==0 && adapter.out_enable && adapter.in_enable);
    assert(_i2s_data_enable(&adapter,ESP_CODEC_DEV_TYPE_OUT,false)==0 && adapter.out_disable_pending && !adapter.out_enable);
    out_error=-31;
    assert(_i2s_data_enable(&adapter,ESP_CODEC_DEV_TYPE_OUT,true)==-31 && adapter.out_disable_pending && !adapter.out_enable);
    out_error=0;
    assert(_i2s_data_enable(&adapter,ESP_CODEC_DEV_TYPE_OUT,true)==0 && !adapter.out_disable_pending && adapter.out_enable);
    assert(_i2s_data_enable(&adapter,ESP_CODEC_DEV_TYPE_IN,false)==0 && adapter.in_disable_pending && !adapter.in_enable);
    in_error=-32;
    assert(_i2s_data_enable(&adapter,ESP_CODEC_DEV_TYPE_IN,true)==-32 && adapter.in_disable_pending && !adapter.in_enable && locked==0);
}
"""


def main():
    compiler = sys.argv[1] if len(sys.argv) > 1 else "c++"
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull, GIT_ATTR_NOSYSTEM="1")
    with tempfile.TemporaryDirectory(prefix="stackchan-codec-i2s-") as temporary:
        root = Path(temporary).resolve()
        assert root.parent == Path(tempfile.gettempdir()).resolve()
        assert root.name.startswith("stackchan-codec-i2s-")
        target = root / "platform/audio_codec_data_i2s.c"
        target.parent.mkdir()
        target.write_bytes((HERE / "runtime_stubs/esp_codec_i2s_unpatched.c").read_bytes())
        def git(*args):
            subprocess.run(["git", *args], cwd=root, env=env, check=True, capture_output=True)
        git("init", "--quiet")
        git("apply", "--check", str(PATCH))
        git("apply", str(PATCH))
        git("apply", "--reverse", "--check", str(PATCH))
        patched = methods(target.read_text())
        patched_format = format_methods(target.read_text())
        # Optional downloaded dependency must agree byte-for-byte, rather than
        # quietly testing a fixture while a different production adapter builds.
        if VENDOR.is_file():
            assert methods(VENDOR.read_text()) == patched, "Managed codec adapter differs from tested patch"
            assert format_methods(VENDOR.read_text()) == patched_format, "Managed codec format differs from tested patch"
        for name, content in (("adapter", PRELUDE + patched + CASES), ("format", FORMAT_PRELUDE + patched_format + FORMAT_CASES)):
            program = root / f"{name}.cpp"
            program.write_text(content)
            executable = root / f"{name}-test"
            subprocess.run([compiler, "-std=c++17", "-Wall", "-Wextra", "-Werror", "-UNDEBUG", str(program), "-o", str(executable)], check=True)
            subprocess.run([str(executable)], check=True)
    print("Patched production I2S rejects partial transfers/format faults and preserves clocks on same-format reopen")


if __name__ == "__main__":
    main()
