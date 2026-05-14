#!/usr/bin/env bash
# fetch-litert-extras.sh
#
# Fixes two gaps in the litert-sys / litert-lm-sys Linux prebuilt setup:
#
# 1. libGemmaModelConstraintProvider.so is a hard NEEDED dependency of
#    libLiteRtLmC.so but is absent from litert-sys 0.2.1's Linux prebuilt
#    list. Download it from the LiteRT-LM LFS release.
#
# 2. libLiteRtLmC.so ships with a RUNPATH pointing to Bazel build-tree
#    paths that don't exist outside Google's build environment. Patch it
#    to $ORIGIN so it finds libGemmaModelConstraintProvider.so in the
#    same directory (via a symlink from the litert-lm-sys cache dir).
#
# Run once on container creation (postCreateCommand in devcontainer.json).
# Safe to re-run — all steps are idempotent.

set -euo pipefail

LITERT_TAG="v0.10.2"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64)  UPSTREAM_DIR="linux_x86_64" ; RUST_TARGET="x86_64-unknown-linux-gnu"  ;;
  aarch64) UPSTREAM_DIR="linux_arm64"  ; RUST_TARGET="aarch64-unknown-linux-gnu" ;;
  *)
    echo "fetch-litert-extras: unsupported arch $ARCH, skipping" >&2
    exit 0
    ;;
esac

CACHE="${XDG_CACHE_HOME:-$HOME/.cache}"
LITERT_DIR="$CACHE/litert-sys/$LITERT_TAG/$RUST_TARGET"
LITERTLM_DIR="$CACHE/litert-lm-sys/$LITERT_TAG/$RUST_TARGET"

mkdir -p "$LITERT_DIR" "$LITERTLM_DIR"

LIB="libGemmaModelConstraintProvider.so"
DEST="$LITERT_DIR/$LIB"

# ── Step 1: download the missing library ────────────────────────────────────
if [[ -f "$DEST" ]]; then
  echo "fetch-litert-extras: $LIB already present, skipping download"
else
  URL="https://media.githubusercontent.com/media/google-ai-edge/LiteRT-LM/${LITERT_TAG}/prebuilt/${UPSTREAM_DIR}/${LIB}"
  echo "fetch-litert-extras: downloading $LIB for $UPSTREAM_DIR ..."
  curl -fsSL "$URL" -o "$DEST"
  echo "fetch-litert-extras: saved to $DEST"
fi

# ── Step 2: symlink into the litert-lm-sys cache dir ────────────────────────
# libLiteRtLmC.so's RUNPATH will be patched to $ORIGIN (its own dir), so
# libGemmaModelConstraintProvider.so must be reachable from there.
SYMLINK="$LITERTLM_DIR/$LIB"
if [[ ! -L "$SYMLINK" ]]; then
  ln -sf "$DEST" "$SYMLINK"
  echo "fetch-litert-extras: symlinked $SYMLINK -> $DEST"
fi

# ── Step 3: patch libLiteRtLmC.so RUNPATH ───────────────────────────────────
# The shipped RUNPATH points to Bazel build-tree paths. Replace it with
# $ORIGIN so the dynamic linker looks in the same directory as the library.
LITERTLM_SO="$LITERTLM_DIR/libLiteRtLmC.so"
if [[ -f "$LITERTLM_SO" ]]; then
  CURRENT_RPATH="$(patchelf --print-rpath "$LITERTLM_SO" 2>/dev/null || true)"
  if [[ "$CURRENT_RPATH" != '$ORIGIN' ]]; then
    patchelf --set-rpath '$ORIGIN' "$LITERTLM_SO"
    echo "fetch-litert-extras: patched RUNPATH of libLiteRtLmC.so to \$ORIGIN"
  else
    echo "fetch-litert-extras: libLiteRtLmC.so RUNPATH already patched, skipping"
  fi
else
  echo "fetch-litert-extras: libLiteRtLmC.so not yet downloaded (will be fetched on first cargo build)"
  echo "fetch-litert-extras: re-run this script after the first 'cargo build' to patch the RUNPATH"
fi
