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
set -euo pipefail
KANCLI_HOME="${KANCLI_INSTALL_DIR:-$HOME/.kancli}"
exec node "$KANCLI_HOME/cli/kancli.js" "$@"
EOF
chmod +x "$BIN_DIR/kancli"

echo "[kancli] installed from $REPO_URL"
echo "[kancli] binary: $BIN_DIR/kancli"
echo "[kancli] make sure PATH includes: $BIN_DIR"
echo "[kancli] quick start:"
echo "  cd <your-project>"
echo "  kancli init ."
echo "  kancli up"
echo "  kancli board"
