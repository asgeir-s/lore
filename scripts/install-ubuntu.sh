#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -s)" != "Linux" ]; then
  echo "This script is for Ubuntu Linux."
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "apt-get not found. Install the generated bundle manually for your distro."
  exit 1
fi

if [ -r /etc/os-release ] && ! grep -qi "ubuntu" /etc/os-release; then
  echo "Warning: this script is tuned for Ubuntu and may need tweaks on other distros."
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "$ROOT_DIR"

tauri build --bundles deb

BUNDLE_DIR="src-tauri/target/release/bundle/deb"
DEB_PATH="$(find "$BUNDLE_DIR" -maxdepth 1 -type f -name '*.deb' | sort | tail -n 1 || true)"

if [ -z "$DEB_PATH" ]; then
  echo "No .deb bundle found in ${BUNDLE_DIR}."
  exit 1
fi

DEB_ABS="$(cd -- "$(dirname -- "$DEB_PATH")" && pwd)/$(basename -- "$DEB_PATH")"

sudo apt-get install -y "$DEB_ABS"

echo "Installed $(basename -- "$DEB_ABS")"
