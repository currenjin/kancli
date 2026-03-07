#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${KANCLI_INSTALL_DIR:-$HOME/.kancli}"
BIN_DIR="${KANCLI_BIN_DIR:-$HOME/.local/bin}"
BIN_PATH="$BIN_DIR/kancli"
KC_PATH="$BIN_DIR/kc"

rm -f "$BIN_PATH"

if [[ -e "$KC_PATH" ]]; then
  if grep -q "kancli-shim" "$KC_PATH" 2>/dev/null; then
    rm -f "$KC_PATH"
  else
    echo "[kancli] skip removing kc (not managed by kancli): $KC_PATH"
  fi
fi

rm -rf "$INSTALL_DIR"

echo "[kancli] uninstalled"
echo "removed: $INSTALL_DIR"
echo "removed: $BIN_PATH"
echo "removed: $KC_PATH (if managed by kancli)"