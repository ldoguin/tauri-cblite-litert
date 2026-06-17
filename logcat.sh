#!/usr/bin/env bash
# Android logcat viewer for com.ldoguin.rag_chatbot
# Usage: ./logcat.sh [--clear] [--all] [--tags]
#
#   --clear   clear logcat buffer before streaming
#   --all     show all app logs (by PID) — default
#   --tags    filter by relevant tags only (Rust, WebView, CBL, LiteRT)

set -euo pipefail

PKG="com.ldoguin.rag_chatbot"

CLEAR=0
MODE="pid"

for arg in "$@"; do
  case "$arg" in
    --clear) CLEAR=1 ;;
    --tags)  MODE="tags" ;;
    --all)   MODE="pid" ;;
    -h|--help)
      echo "Usage: $0 [--clear] [--all|--tags]"
      exit 0
      ;;
  esac
done

# Check adb is available
if ! command -v adb &>/dev/null; then
  echo "ERROR: adb not found. Add Android SDK platform-tools to PATH." >&2
  exit 1
fi

# Check a device is connected
if ! adb get-state &>/dev/null; then
  echo "ERROR: No Android device/emulator connected." >&2
  exit 1
fi

if [[ "$CLEAR" -eq 1 ]]; then
  echo "Clearing logcat buffer..."
  adb logcat -c
fi

if [[ "$MODE" == "tags" ]]; then
  # Tag-based filter: Rust stdout/stderr, WRY WebView, CBL, LiteRT, Tauri
  echo "Streaming logs for $PKG (tag filter)..."
  echo "Tags: RustStdoutStderr, WRY, tao, CouchbaseLite, LiteRT, LiteRtLm, litert, tflite, Tauri"
  echo "---"
  adb logcat \
    RustStdoutStderr:V \
    WRY:V \
    tao:V \
    CouchbaseLite:V \
    LiteRT:V \
    LiteRtLm:V \
    litert:V \
    tflite:V \
    Tauri:V \
    LiteRtPlugin:V \
    CblitePlugin:V \
    *:S
else
  # PID-based filter: everything emitted by the app process
  PID=$(adb shell pidof "$PKG" 2>/dev/null | tr -d '[:space:]')
  if [[ -z "$PID" ]]; then
    echo "App not running yet — waiting for $PKG to start..."
    echo "(Launch the app or run: pnpm tauri android dev)"
    echo ""
    # Poll until the app starts, then attach
    while true; do
      PID=$(adb shell pidof "$PKG" 2>/dev/null | tr -d '[:space:]')
      if [[ -n "$PID" ]]; then
        echo "App started (PID=$PID). Streaming logs..."
        break
      fi
      sleep 1
    done
  else
    echo "Streaming logs for $PKG (PID=$PID)..."
  fi
  echo "---"
  adb logcat --pid="$PID"
fi
