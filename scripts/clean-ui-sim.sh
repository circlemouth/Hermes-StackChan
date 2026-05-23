#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SIM_DIR="${REPO_ROOT}/firmware/tools/ui_sim"

rm -rf "${SIM_DIR}/build" "${SIM_DIR}/build-headless" "${SIM_DIR}/.deps" "${SIM_DIR}/out"
