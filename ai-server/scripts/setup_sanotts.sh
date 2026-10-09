#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
server_root="$(cd -- "$script_dir/.." && pwd)"
project_root="$(cd -- "$server_root/.." && pwd)"
upstream_root="$project_root/sanoTTS-jp"
runtime_root="${SANOTTS_RUNTIME_DIR:-$server_root/.sanotts}"
asset_root="$runtime_root/assets"
binary_root="$runtime_root/bin"
release_base="https://github.com/ayutaz/sanoTTS-jp/releases/download/v0.3.0"

model_name="saanotts-jp-v3-int8.bin"
dict_name="k1-dict-438750.bin"
model_sha256="2d2b8543c06b6a749f19c9918de68244409e2bb6ad1d921a90b5c358f96d4d79"
dict_sha256="f162c922074d76817298b34d8a8fd35f7d195f38540303485a76c956b5d84877"

if [[ ! -f "$upstream_root/web/saan_web.c" ]]; then
    if [[ -f "$project_root/.gitmodules" ]] && command -v git >/dev/null 2>&1; then
        git -C "$project_root" submodule update --init --recursive sanoTTS-jp
    fi
fi
if [[ ! -f "$upstream_root/web/saan_web.c" ]]; then
    echo "sanoTTS-jp submodule is missing. Run: git submodule update --init --recursive" >&2
    exit 1
fi

for command_name in curl "${CC:-cc}"; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "Required command is missing: $command_name" >&2
        exit 1
    fi
done

mkdir -p "$asset_root" "$binary_root"

verify_sha256() {
    local expected="$1"
    local file="$2"
    local actual
    if command -v sha256sum >/dev/null 2>&1; then
        actual="$(sha256sum "$file" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then
        actual="$(shasum -a 256 "$file" | awk '{print $1}')"
    else
        echo "sha256sum or shasum is required" >&2
        exit 1
    fi
    if [[ "$actual" != "$expected" ]]; then
        echo "SHA-256 mismatch for $file" >&2
        echo "expected: $expected" >&2
        echo "actual:   $actual" >&2
        return 1
    fi
}

fetch_asset() {
    local name="$1"
    local expected="$2"
    local target="$asset_root/$name"
    if [[ -f "$target" ]]; then
        if verify_sha256 "$expected" "$target"; then
            return
        fi
    fi
    curl --fail --location --retry 3 --output "$target.part" "$release_base/$name"
    verify_sha256 "$expected" "$target.part"
    mv "$target.part" "$target"
}

fetch_asset "$model_name" "$model_sha256"
fetch_asset "$dict_name" "$dict_sha256"

cp "$upstream_root/LICENSE-MODEL.md" "$runtime_root/LICENSE-MODEL.md"
cp "$upstream_root/LICENSE" "$runtime_root/SANOTTS-LICENSE"
cp "$upstream_root/NOTICE.md" "$runtime_root/NOTICE.md"
cp "$upstream_root/csrc/openjtalk/COPYING" "$runtime_root/OPENJTALK-COPYING"

sources=(
    "$server_root/native/sanotts_cli.c"
    "$upstream_root/web/saan_web.c"
    "$upstream_root/csrc/saanotts.c"
    "$upstream_root/csrc/saanotts_stream.c"
    "$upstream_root/csrc/saanotts_int8.c"
    "$upstream_root/csrc/fft.c"
    "$upstream_root/csrc/g2p.c"
    "$upstream_root/csrc/jdict.c"
    "$upstream_root/csrc/accent.c"
    "$upstream_root/csrc/njd_rules.c"
    "$upstream_root/csrc/label_ids.c"
    "$upstream_root/esp32/main/saan_kanji.c"
    "$upstream_root/esp32/main/saan_pcm.c"
)
for source_file in "$upstream_root"/csrc/openjtalk/*.c; do
    sources+=("$source_file")
done

"${CC:-cc}" \
    -O2 -std=gnu17 -Wall -Wextra -DCHARSET_UTF_8 \
    -I "$server_root/native/host_include" \
    -I "$upstream_root/csrc" \
    -I "$upstream_root/csrc/openjtalk" \
    -I "$upstream_root/esp32/main" \
    "${sources[@]}" -lm -o "$binary_root/sanotts-cli"

echo "sanoTTS-jp runtime is ready in $runtime_root"
echo "Model terms: $runtime_root/LICENSE-MODEL.md"
