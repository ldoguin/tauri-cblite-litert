#!/usr/bin/env bash
# fetch-litert-extras.sh
#
# Downloads prebuilt LiteRT shared libraries that are missing from the
# litert-sys crate's Linux prebuilt list but are required at runtime.
#
# libGemmaModelConstraintProvider.so is a hard NEEDED dependency of
# libLiteRtLmC.so. litert-sys 0.2.1 only ships it for macOS; the Linux
# version must be fetched separately from the LiteRT-LM LFS release.
#
# The file is placed in the litert-sys cache dir, which is already on
# LD_LIBRARY_PATH (set in the Dockerfile).

set -euo pipefail

LITERT_TAG="v0.10.2"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64)  UPSTREAM_DIR="linux_x86_64" ;;
  aarch64) UPSTREAM_DIR="linux_arm64"  ;;
  *)
    echo "fetch-litert-extras: unsupported arch $ARCH, skipping" >&2
    exit 0
    ;;
esac

CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/litert-sys/${LITERT_TAG}/${ARCH}-unknown-linux-gnu"
mkdir -p "$CACHE_DIR"

LIB="libGemmaModelConstraintProvider.so"
DEST="$CACHE_DIR/$LIB"

if [[ -f "$DEST" ]]; then
  echo "fetch-litert-extras: $LIB already present, skipping"
  exit 0
fi

URL="https://media.githubusercontent.com/media/google-ai-edge/LiteRT-LM/${LITERT_TAG}/prebuilt/${UPSTREAM_DIR}/${LIB}"

echo "fetch-litert-extras: downloading $LIB for $UPSTREAM_DIR ..."
curl -fsSL "$URL" -o "$DEST"
echo "fetch-litert-extras: saved to $DEST"
