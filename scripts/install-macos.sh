#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This script is for macOS."
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "$ROOT_DIR"

# Tauri signing needs Apple's xattr; a Python package can shadow it on PATH.
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

npm install
LOCAL_BUILD_CONFIG="$(node scripts/prepare-local-build.mjs)"
npx tauri build --bundles app --config "$LOCAL_BUILD_CONFIG"

APP_SRC="src-tauri/target/release/bundle/macos/Lore.app"
APP_DST="/Applications/Lore.app"

if [ ! -d "$APP_SRC" ]; then
  echo "Build completed but ${APP_SRC} was not found."
  exit 1
fi

# Refuse to install a partial linker signature or a damaged bundle.
codesign --verify --deep --strict --verbose=2 "$APP_SRC"

if [ -w /Applications ]; then
  rm -rf "$APP_DST"
  cp -R "$APP_SRC" /Applications/
else
  sudo rm -rf "$APP_DST"
  sudo cp -R "$APP_SRC" /Applications/
fi

APP_VERSION="$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP_DST/Contents/Info.plist")"
APP_BUILD="$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$APP_DST/Contents/Info.plist")"
echo "Installed Lore ${APP_VERSION} (build ${APP_BUILD}) at ${APP_DST}"
echo "Quit and reopen Lore to use the new build."
echo "Local ad-hoc builds may need microphone/system audio permission again after an update."
