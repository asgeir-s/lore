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

echo "Installing optional tools..."

# Meeting recording: audio processing + transcription
brew install ffmpeg whisper-cpp

# AI features: auto-tagging, related notes, meeting summaries
if ! command -v ollama >/dev/null 2>&1; then
  brew install ollama
else
  echo "ollama already installed."
fi

# Download a whisper model if none exists
MODEL_DIR="$HOME/.local/share/whisper-cpp/models"
if [ ! -d "$MODEL_DIR" ] || [ -z "$(ls -A "$MODEL_DIR" 2>/dev/null)" ]; then
  echo "Downloading whisper model (ggml-large-v3-turbo, ~1.6 GB)..."
  mkdir -p "$MODEL_DIR"
  curl -L -o "$MODEL_DIR/ggml-large-v3-turbo.bin" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"
else
  echo "Whisper model already exists in $MODEL_DIR"
fi

echo ""
echo "Done. Optional tools installed:"
command -v ffmpeg >/dev/null 2>&1 && echo "  ffmpeg: $(ffmpeg -version 2>&1 | head -1)"
command -v whisper-cli >/dev/null 2>&1 && echo "  whisper-cli: found"
command -v ollama >/dev/null 2>&1 && echo "  ollama: $(ollama --version 2>&1)"
echo ""
echo "To start ollama: ollama serve"
echo "To pull a model:  ollama pull qwen2.5:1.5b"
