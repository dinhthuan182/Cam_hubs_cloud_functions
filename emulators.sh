#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PROJECT="ios-002-camera-hub"
DATA_DIR=".emulator-data"

npm --prefix functions run build

ARGS=(emulators:start --project "$PROJECT")

if [[ "${PERSIST:-0}" == "1" ]]; then
  mkdir -p "$DATA_DIR"
  ARGS+=(--import "$DATA_DIR" --export-on-exit "$DATA_DIR")
fi

exec firebase "${ARGS[@]}"
