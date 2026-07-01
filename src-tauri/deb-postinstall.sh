#!/bin/sh
set -e
LIB_DIR="/usr/lib/tauri-cblite-litert"

# Create the libspeechd.so.2 fallback symlink only when the real
# speech-dispatcher library is not installed.  If the real library is
# present it will be found via ldconfig (system paths); the symlink is
# not needed and must not exist so it does not shadow the real one.
if ! ldconfig -p 2>/dev/null | grep -q 'libspeechd\.so\.2'; then
    ln -sf "$LIB_DIR/libspeechd-stub.so" "$LIB_DIR/libspeechd.so.2"
fi
