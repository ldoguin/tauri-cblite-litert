#!/usr/bin/env bash
# stage-libcblite.sh — Copy the host's x86_64 libcblite.so.4 into the
# workspace so it is accessible inside the act container (bind-mount only
# covers the project directory, not ~/.cargo).
#
# Run once before using act:
#   bash scripts/stage-libcblite.sh
#
# In real CI the workflow's "Stage libcblite.so.4" step does this automatically
# after the cargo build populates the git checkout.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ARCH="$(uname -m)-unknown-linux-gnu"
DEST="$ROOT/src-tauri/target/release/libcblite.so.4"

if [[ -f "$DEST" ]]; then
  CURRENT_ARCH=$(file "$DEST" 2>/dev/null || true)
  if ! echo "$CURRENT_ARCH" | grep -qi "aarch64\|ARM"; then
    echo "libcblite.so.4 already staged ($(file "$DEST" | grep -oP 'x86-64|aarch64'))"
    exit 0
  fi
  echo "Replacing staged ARM64 libcblite.so.4 with x86_64 version..."
fi

LIB=$(find "${CARGO_HOME:-$HOME/.cargo}/git/checkouts" \
  -path "*/couchbase-lite-rust*/libcblite_community/lib/$ARCH/libcblite.so.4" \
  2>/dev/null | head -1 || true)

if [[ -z "$LIB" ]]; then
  echo "error: libcblite.so.4 not found in CARGO_HOME for ARCH=$ARCH" >&2
  echo "  Make sure you've run 'pnpm tauri:build' at least once to populate the cargo git checkout." >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST")"
cp "$LIB" "$DEST"
echo "Staged: $DEST  (from $LIB)"
echo "  $(file "$DEST")"
