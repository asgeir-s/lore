#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -s)" != "Linux" ]; then
  echo "This script is for Ubuntu Linux."
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "apt-get not found. Install dependencies manually for your distro."
  exit 1
fi

pick_pkg() {
  for pkg in "$@"; do
    if apt-cache show "$pkg" >/dev/null 2>&1; then
      echo "$pkg"
      return 0
    fi
  done
  return 1
}

sudo apt-get update

WEBKIT_PKG="$(pick_pkg libwebkit2gtk-4.1-dev libwebkit2gtk-4.0-dev || true)"
JSCORE_PKG="$(pick_pkg libjavascriptcoregtk-4.1-dev libjavascriptcoregtk-4.0-dev || true)"
APPINDICATOR_PKG="$(pick_pkg libayatana-appindicator3-dev libappindicator3-dev || true)"

if [ -z "$WEBKIT_PKG" ] || [ -z "$JSCORE_PKG" ] || [ -z "$APPINDICATOR_PKG" ]; then
  echo "Could not resolve required WebKit/AppIndicator packages for this Ubuntu release."
  exit 1
fi

sudo apt-get install -y \
  build-essential \
  curl \
  file \
  git \
  libgtk-3-dev \
  libssl-dev \
  librsvg2-dev \
  patchelf \
  "$WEBKIT_PKG" \
  "$JSCORE_PKG" \
  "$APPINDICATOR_PKG"

echo "Ubuntu build dependencies installed."
echo "If needed, install Rust and Node.js before running the app."
