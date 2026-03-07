#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/currenjin/kancli"
ARCHIVE_URL="https://codeload.github.com/currenjin/kancli/tar.gz/refs/heads/main"
INSTALL_DIR="${KANCLI_INSTALL_DIR:-$HOME/.kancli}"
BIN_DIR="${KANCLI_BIN_DIR:-$HOME/.local/bin}"

mkdir -p "$INSTALL_DIR" "$BIN_DIR"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

curl -fsSL "$ARCHIVE_URL" | tar -xz -C "$TMP_DIR"
SRC_DIR="$(find "$TMP_DIR" -maxdepth 1 -type d -name 'kancli-*' | head -n 1)"

if [[ -z "$SRC_DIR" ]]; then
  echo "[kancli] install failed: archive extract not found" >&2
  exit 1
fi

rm -rf "$INSTALL_DIR"/*
cp -R "$SRC_DIR"/* "$INSTALL_DIR"/

cat > "$BIN_DIR/kancli" <<'EOF'
#!/usr/bin/env bash
# kancli-shim
set -euo pipefail
KANCLI_HOME="${KANCLI_INSTALL_DIR:-$HOME/.kancli}"
exec node "$KANCLI_HOME/cli/kancli.js" "$@"
EOF
chmod +x "$BIN_DIR/kancli"

KC_CONFLICT=0
if [[ -e "$BIN_DIR/kc" ]]; then
  if grep -q "kancli-shim" "$BIN_DIR/kc" 2>/dev/null; then
    :
  else
    KC_CONFLICT=1
  fi
fi

if [[ "$KC_CONFLICT" -eq 0 ]]; then
  cat > "$BIN_DIR/kc" <<'EOF'
#!/usr/bin/env bash
# kancli-shim
set -euo pipefail
KANCLI_HOME="${KANCLI_INSTALL_DIR:-$HOME/.kancli}"
exec node "$KANCLI_HOME/cli/kancli.js" "$@"
EOF
  chmod +x "$BIN_DIR/kc"
fi

echo "[kancli] installed from $REPO_URL"
echo "[kancli] binary: $BIN_DIR/kancli"
if [[ "$KC_CONFLICT" -eq 1 ]]; then
  echo "[kancli] note: '$BIN_DIR/kc' already exists and is not kancli-managed; skipped kc shim creation"
else
  echo "[kancli] alias: $BIN_DIR/kc"
fi
echo "[kancli] make sure PATH includes: $BIN_DIR"
echo "[kancli] quick start:"
echo "  cd <your-project>"
echo "  kc init .   # or kancli init ."
echo "  kc up"
echo "  kc board"