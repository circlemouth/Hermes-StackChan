#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SIM_DIR="${REPO_ROOT}/firmware/tools/ui_sim"

HEADLESS=0
for arg in "$@"; do
  if [[ "${arg}" == "--headless" ]]; then
    HEADLESS=1
    break
  fi
done

if ! command -v cmake >/dev/null 2>&1; then
  echo "cmake is required but was not found. Install it without modifying this script to run package managers." >&2
  exit 1
fi

if [[ "${HEADLESS}" -eq 0 ]]; then
  if ! command -v pkg-config >/dev/null 2>&1 || ! pkg-config --exists sdl2; then
    echo "SDL2 development files were not found via pkg-config." >&2
    echo "Visible mode requires SDL2. Re-run with --headless for the framebuffer smoke test." >&2
    exit 1
  fi
fi

BUILD_DIR="${SIM_DIR}/build"
HEADLESS_FLAG="OFF"
if [[ "${HEADLESS}" -eq 1 ]]; then
  BUILD_DIR="${SIM_DIR}/build-headless"
  HEADLESS_FLAG="ON"
fi

GENERATOR_ARGS=()
if command -v ninja >/dev/null 2>&1; then
  GENERATOR_ARGS=(-G Ninja)
else
  GENERATOR_ARGS=(-G "Unix Makefiles")
fi

cmake -S "${SIM_DIR}" -B "${BUILD_DIR}" "${GENERATOR_ARGS[@]}" -DUI_SIM_HEADLESS="${HEADLESS_FLAG}"
cmake --build "${BUILD_DIR}" --target stackchan_ui_sim

"${BUILD_DIR}/stackchan_ui_sim" "$@"
