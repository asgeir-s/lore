#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This script is for macOS."
  exit 1
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew not found. Install it from https://brew.sh"
  exit 1
fi

BREW_PREFIX="$(brew --prefix)"
NODE_BIN="${BREW_PREFIX}/bin/node"
NPM_BIN="${BREW_PREFIX}/bin/npm"
QMD_BIN="${BREW_PREFIX}/bin/qmd"

echo "Installing runtime tools..."

# Runtime consistency for installed app tooling
brew install node

# Meeting recording: audio processing + transcription
brew install ffmpeg whisper-cpp

# AI features: auto-tagging, related notes, meeting summaries
if ! command -v ollama >/dev/null 2>&1; then
  brew install ollama
else
  echo "ollama already installed."
fi

# Related notes search (must be installed with the same npm runtime).
"${NPM_BIN}" install -g @tobilu/qmd
"${QMD_BIN}" collection list >/dev/null

# Download a whisper model if none exists
MODEL_DIR="$HOME/.local/share/whisper-cpp/models"
if [ ! -d "$MODEL_DIR" ] || [ -z "$(ls -A "$MODEL_DIR" 2>/dev/null)" ]; then
  echo "Downloading whisper model (ggml-large-v3, ~3.1 GB)..."
  mkdir -p "$MODEL_DIR"
  curl -L -o "$MODEL_DIR/ggml-large-v3.bin" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin"
else
  echo "Whisper model already exists in $MODEL_DIR"
fi

echo ""
echo "Done. Runtime tools installed:"
[ -x "$NODE_BIN" ] && echo "  node: $("$NODE_BIN" --version)"
command -v ffmpeg >/dev/null 2>&1 && echo "  ffmpeg: $(ffmpeg -version 2>&1 | head -1)"
command -v whisper-cli >/dev/null 2>&1 && echo "  whisper-cli: found"
[ -x "$QMD_BIN" ] && echo "  qmd: $("$QMD_BIN" --version 2>&1)"
command -v ollama >/dev/null 2>&1 && echo "  ollama: $(ollama --version 2>&1)"
echo ""
echo "To start ollama: ollama serve"
echo "To pull a model:  ollama pull qwen2.5:1.5b"
