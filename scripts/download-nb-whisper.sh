#!/usr/bin/env bash
# NB-Whisper Large by the National Library of Norway (Apache-2.0).
set -euo pipefail

variant="${1:-full}"
model_dir="${LORE_WHISPER_MODELS_DIR:-$HOME/.local/share/whisper-cpp/models}"
revision="8c6249fdeeb4dcd05e5735a4c39640607eb6e4ac"
case "$variant" in
  full)
    source_name="ggml-model.bin"
    file_name="ggml-nb-whisper-large.bin"
    checksum="0f2f66f22e11a7c7da3c582d8e5c89cb2c0011753ba9c7c9731e320a4ba33e76"
    ;;
  q5_0)
    source_name="ggml-model-q5_0.bin"
    file_name="ggml-nb-whisper-large-q5_0.bin"
    checksum="feb5951ae694a62cfeb81fb501f6cfa8cc50d96bcddb1e4e8215f7006bac23a2"
    ;;
  *) echo "Usage: bash scripts/download-nb-whisper.sh [full|q5_0]" >&2; exit 2 ;;
esac

verify() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s  %s\n' "$checksum" "$1" | sha256sum -c -
  else
    printf '%s  %s\n' "$checksum" "$1" | shasum -a 256 -c -
  fi
}

mkdir -p "$model_dir"
destination="$model_dir/$file_name"
if [[ -f "$destination" ]] && verify "$destination"; then
  echo "NB-Whisper is installed. Refresh models in Lore Settings."
  exit 0
fi
temporary="$(mktemp "$destination.download.XXXXXX")"
trap 'rm -f "$temporary"' EXIT
curl --fail --location --retry 3 \
  "https://huggingface.co/NbAiLab/nb-whisper-large/resolve/$revision/$source_name" \
  -o "$temporary"
verify "$temporary"
mv "$temporary" "$destination"
echo "Installed NB-Whisper. Choose Norwegian and Automatic, or select NB-Whisper explicitly in Lore Settings."
