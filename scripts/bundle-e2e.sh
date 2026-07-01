#!/usr/bin/env bash
# bundle-e2e.sh — Create a portable e2e test binary bundle.
#
# After `pnpm tauri:build`, copies the Tauri binary + all custom .so files
# into dist/e2e-bundle/ and patches the RPATH to $ORIGIN so the bundle runs
# from any directory on a machine with the same OS/ABI (ubuntu-24.04 amd64).
#
# Custom libs required at runtime:
#   libcblite.so.4           — CouchbaseLite native library
#   libLiteRtLmC.so          — LiteRT-LM inference engine
#   libLiteRt.so             — LiteRT core (loaded by libLiteRtLmC)
#   libGemmaModelConstraintProvider.so  — Gemma tokenizer constraint
#   libLiteRtWebGpuAccelerator.so       — GPU accelerator (optional, graceful fallback)
#   libLiteRtTopKWebGpuSampler.so       — GPU sampler  (optional, graceful fallback)
#   libspeechd.so.2          — TTS stub (satisfies Tauri accessibility link)
#
# All other libs (webkit2gtk, gtk, glib, …) are standard system packages.
#
# Usage:
#   bash scripts/bundle-e2e.sh
#
# Output:
#   dist/e2e-bundle/tauri-cblite-litert   (patched binary)
#   dist/e2e-bundle/*.so                  (all custom shared libraries)
#
# Run the tests with:
#   TAURI_BINARY=dist/e2e-bundle/tauri-cblite-litert pnpm test:e2e

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BINARY_NAME="tauri-cblite-litert"
BINARY="$ROOT/src-tauri/target/release/$BINARY_NAME"
BUNDLE="$ROOT/dist/e2e-bundle"
ARCH="$(uname -m)-unknown-linux-gnu"
CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"

if [[ ! -f "$BINARY" ]]; then
  echo "error: binary not found at $BINARY — run 'pnpm tauri:build' first" >&2
  exit 1
fi

if ! command -v patchelf &>/dev/null; then
  echo "error: patchelf not found — install with: sudo apt install patchelf" >&2
  exit 1
fi

echo "[bundle-e2e] target: $BUNDLE"
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE"

# ── Copy binary ──────────────────────────────────────────────────────────────
cp "$BINARY" "$BUNDLE/$BINARY_NAME"
echo "  copied: $BINARY_NAME"

# ── Locate OUT_DIR (build.rs copies .so files there) ────────────────────────
# Read it directly from the binary's RUNPATH — this is always the correct
# build artifact directory regardless of how many stale builds exist.
OUT_DIR=$(readelf -d "$BINARY" 2>/dev/null \
  | grep -oP '(?<=\[)[^]]+(?=\])' \
  | tr ':' '\n' \
  | grep -E "build/tauri-cblite-litert-.*/out$" \
  | head -1)

if [[ -z "$OUT_DIR" || ! -d "$OUT_DIR" ]]; then
  # Fallback: newest OUT_DIR containing libLiteRtLmC.so
  OUT_DIR=$(find "$ROOT/src-tauri/target/release/build" \
    -name "libLiteRtLmC.so" \
    -path "*/tauri-cblite-litert-*/out/*" \
    2>/dev/null \
    | xargs -I{} dirname {} \
    | xargs ls -dt 2>/dev/null \
    | head -1)
fi

if [[ -z "$OUT_DIR" || ! -d "$OUT_DIR" ]]; then
  echo "error: OUT_DIR not found — libLiteRtLmC.so missing from build artifacts" >&2
  echo "       Ensure 'pnpm tauri:build' completed successfully" >&2
  exit 1
fi

echo "  OUT_DIR: $OUT_DIR"

# Copy all .so files from OUT_DIR (libLiteRtLmC.so, libGemmaModelConstraintProvider.so,
# libLiteRt.so, libLiteRtWebGpuAccelerator.so, libLiteRtTopKWebGpuSampler.so)
for f in "$OUT_DIR"/*.so "$OUT_DIR"/*.so.*; do
  [[ -f "$f" ]] || continue
  cp "$f" "$BUNDLE/"
  echo "  copied: $(basename "$f")  (from OUT_DIR)"
done

# ── libcblite.so.4 ───────────────────────────────────────────────────────────
# Prefer reading the directory directly from the source binary's RUNPATH —
# this is the path build.rs emitted at build time and is always correct,
# even when CARGO_HOME differs (e.g. inside a root-running container).
CBLITE_SO=""

# Primary: check staged copy within the workspace (survives container bind-mounts).
# This file is created by the workflow's "Stage libcblite" step or by running
# scripts/stage-libcblite.sh locally before using act.
STAGED="$ROOT/src-tauri/target/release/libcblite.so.4"
if [[ -f "$STAGED" ]]; then
  STAGED_ARCH=$(file "$STAGED" 2>/dev/null || true)
  if ! echo "$STAGED_ARCH" | grep -qi "aarch64\|ARM" || [[ "$ARCH" != x86_64* ]]; then
    CBLITE_SO="$STAGED"
  fi
fi

# Fallback: read the cblite directory from the binary's RUNPATH (works on the
# host build machine where ~/.cargo is accessible).
if [[ -z "$CBLITE_SO" ]]; then
  CBLITE_DIR=$(readelf -d "$BINARY" 2>/dev/null \
    | grep -oP '(?<=\[)[^]]+(?=\])' \
    | tr ':' '\n' \
    | grep -E "couchbase-lite-rust|libcblite" \
    | head -1)
  if [[ -n "$CBLITE_DIR" && -d "$CBLITE_DIR" ]]; then
    CBLITE_SO="$CBLITE_DIR/libcblite.so.4"
  fi
fi

# Fallback 2: search CARGO_HOME — works in real CI where the build step
# populates the git checkout, and ARCH prevents picking an ARM cross-compile.
if [[ -z "$CBLITE_SO" || ! -f "$CBLITE_SO" ]]; then
  CBLITE_SO=$(find "${CARGO_HOME:-$HOME/.cargo}/git/checkouts" \
    -path "*/couchbase-lite-rust*/libcblite_community/lib/$ARCH/libcblite.so.4" \
    2>/dev/null | head -1 || true)
fi

if [[ -z "$CBLITE_SO" || ! -f "$CBLITE_SO" ]]; then
  echo "error: libcblite.so.4 not found (ARCH=$ARCH)" >&2
  echo "  Hint: run 'scripts/stage-libcblite.sh' once before using act." >&2
  exit 1
fi

# Sanity-check: the library must match the build machine's architecture.
SO_ARCH=$(file "$CBLITE_SO" 2>/dev/null || true)
if echo "$SO_ARCH" | grep -qi "aarch64\|ARM" && [[ "$ARCH" == x86_64* ]]; then
  echo "error: libcblite.so.4 at '$CBLITE_SO' is ARM but build arch is $ARCH" >&2
  exit 1
fi

cp "$CBLITE_SO" "$BUNDLE/"
echo "  copied: libcblite.so.4  (from $(dirname "$CBLITE_SO"))"

# ── libspeechd.so.2 ─────────────────────────────────────────────────────────
# The stub may have been compiled for a different arch (e.g. ARM64 when
# cross-compiling for Raspberry Pi). Detect and recompile from source if needed.
SPEECHD="$ROOT/src-tauri/libspeechd.so.2"
if [[ ! -f "$SPEECHD" ]]; then
  SPEECHD="$ROOT/src-tauri/libspeechd-stub.so"
fi

_SPEECHD_OK=false
if [[ -f "$SPEECHD" ]]; then
  SPEECHD_ELF=$(file "$SPEECHD" 2>/dev/null || true)
  if echo "$SPEECHD_ELF" | grep -qi "aarch64\|ARM" && [[ "$ARCH" == x86_64* ]]; then
    echo "  warning: $SPEECHD is ARM64; recompiling stub for x86_64"
    SPEECHD=""
  else
    _SPEECHD_OK=true
  fi
fi

if [[ "$_SPEECHD_OK" != true ]]; then
  STUB_SRC="$ROOT/src-tauri/libspeechd-stub.c"
  if [[ -f "$STUB_SRC" ]] && command -v gcc &>/dev/null; then
    COMPILED_STUB="$ROOT/src-tauri/libspeechd-$(uname -m).so.2"
    gcc -shared -fPIC -Wl,-soname,libspeechd.so.2 \
        -o "$COMPILED_STUB" "$STUB_SRC" 2>/dev/null
    SPEECHD="$COMPILED_STUB"
    _SPEECHD_OK=true
    echo "  compiled: libspeechd.so.2 stub ($(uname -m))"
  else
    echo "warning: libspeechd.so.2 not found and cannot compile — binary may fail to load" >&2
  fi
fi

if [[ "$_SPEECHD_OK" == true ]]; then
  cp "$SPEECHD" "$BUNDLE/libspeechd.so.2"
  echo "  copied: libspeechd.so.2  (stub)"
fi

# ── Patch RPATH to $ORIGIN ───────────────────────────────────────────────────
# Replace all absolute RUNPATH entries on the binary with $ORIGIN so the
# loader finds the bundled .so files regardless of where the bundle lives.
echo "  patching RPATH → \$ORIGIN"
patchelf --set-rpath '$ORIGIN' "$BUNDLE/$BINARY_NAME"

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "[bundle-e2e] Bundle ready:"
ls -lh "$BUNDLE/"
echo ""
echo "Run tests:"
echo "  TAURI_BINARY=$BUNDLE/$BINARY_NAME pnpm test:e2e"
echo "  # or headless:"
echo "  xvfb-run -a TAURI_BINARY=$BUNDLE/$BINARY_NAME pnpm test:e2e"
