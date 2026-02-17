#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This script is for macOS."
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "$ROOT_DIR"

tauri build --bundles app

APP_SRC="src-tauri/target/release/bundle/macos/Dump.app"
APP_DST="/Applications/Dump.app"

if [ ! -d "$APP_SRC" ]; then
  echo "Build completed but ${APP_SRC} was not found."
  exit 1
fi

if [ -w /Applications ]; then
  rm -rf "$APP_DST"
  cp -R "$APP_SRC" /Applications/
else
  sudo rm -rf "$APP_DST"
  sudo cp -R "$APP_SRC" /Applications/
fi

echo "Installed ${APP_DST}"
