#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PROJECT="ios-002-camera-hub"
DATA_DIR=".emulator-data"

npm --prefix functions run build

ARGS=(emulators:start --project "$PROJECT")

if [[ "${PERSIST:-1}" == "1" ]]; then
  mkdir -p "$DATA_DIR"
  ARGS+=(--export-on-exit "$DATA_DIR")
  if [[ -f "$DATA_DIR/firebase-export-metadata.json" ]]; then
    ARGS+=(--import "$DATA_DIR")
  fi
fi

exec firebase "${ARGS[@]}"
