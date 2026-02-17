#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

case "$(uname -s)" in
  Darwin)
    exec bash "${SCRIPT_DIR}/install-macos.sh"
    ;;
  Linux)
    exec bash "${SCRIPT_DIR}/install-ubuntu.sh"
    ;;
  *)
    echo "Unsupported OS: $(uname -s)"
    echo "Run 'tauri build' and install the generated bundle manually."
    exit 1
    ;;
esac
