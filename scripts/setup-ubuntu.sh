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

node_major() {
  node --version | sed -E 's/^v([0-9]+).*/\1/'
}

ensure_node_runtime() {
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    local major
    major="$(node_major)"
    if [ "${major}" -ge 22 ]; then
      echo "Node.js $(node --version) already installed."
      return 0
    fi
    echo "Node.js $(node --version) found, but qmd requires >=22."
  else
    echo "Node.js/npm not found. Installing Node.js 22..."
  fi

  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
  echo "Installed Node.js $(node --version)"
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
  libasound2-dev \
  libssl-dev \
  librsvg2-dev \
  ffmpeg \
  patchelf \
  "$WEBKIT_PKG" \
  "$JSCORE_PKG" \
  "$APPINDICATOR_PKG"

# Install Rust if not present
if ! command -v cargo >/dev/null 2>&1; then
  echo "Installing Rust..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck source=/dev/null
  . "$HOME/.cargo/env"
else
  echo "Rust already installed."
fi

ensure_node_runtime

# whisper-cpp package availability varies across Ubuntu versions.
if apt-cache show whisper-cpp >/dev/null 2>&1; then
  sudo apt-get install -y whisper-cpp
else
  echo "whisper-cpp package not found in apt repositories; skipping."
fi

# ollama is optional; install when available.
if ! command -v ollama >/dev/null 2>&1; then
  if curl -fsSL https://ollama.com/install.sh | sh; then
    echo "Installed ollama."
  else
    echo "Could not install ollama automatically; install manually from https://ollama.com/"
  fi
else
  echo "ollama already installed."
fi

sudo npm install -g @tobilu/qmd
QMD_BIN="/usr/local/bin/qmd"
if [ ! -x "$QMD_BIN" ] && [ -x /usr/bin/qmd ]; then
  QMD_BIN="/usr/bin/qmd"
fi
if [ ! -x "$QMD_BIN" ]; then
  QMD_BIN="$(command -v qmd || true)"
fi
if [ -z "$QMD_BIN" ] || [ ! -x "$QMD_BIN" ]; then
  echo "qmd binary not found after installation."
  exit 1
fi
"$QMD_BIN" collection list >/dev/null

echo ""
echo "Done. Runtime tools installed:"
echo "  node: $(node --version)"
echo "  npm: $(npm --version)"
command -v ffmpeg >/dev/null 2>&1 && echo "  ffmpeg: $(ffmpeg -version 2>&1 | head -1)"
command -v whisper-cli >/dev/null 2>&1 && echo "  whisper-cli: found"
[ -x "$QMD_BIN" ] && echo "  qmd: $("$QMD_BIN" --version 2>&1)"
command -v ollama >/dev/null 2>&1 && echo "  ollama: $(ollama --version 2>&1)"
echo ""
echo "You can now run: npm run install-app"
