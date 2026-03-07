#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${KANCLI_INSTALL_DIR:-$HOME/.kancli}"
BIN_DIR="${KANCLI_BIN_DIR:-$HOME/.local/bin}"
BIN_PATH="$BIN_DIR/kancli"

rm -f "$BIN_PATH"
rm -rf "$INSTALL_DIR"

echo "[kancli] uninstalled"
echo "removed: $INSTALL_DIR"
echo "removed: $BIN_PATH"
