#!/usr/bin/env bash
# cross-compile-pi5.sh — Build a Raspberry Pi 5 (aarch64-unknown-linux-gnu) .deb.
#
# Runs the Tauri cross-compilation inside a clean Ubuntu 24.04 Docker container
# so that Pop!_OS / Ubuntu-derivative package conflicts (systemd:arm64, udev:arm64,
# wayland:arm64, gcc-13-aarch64-linux-gnu) don't block the build.
#
# Prerequisites on the host:
#   docker  (or podman aliased to docker)
#
# Usage:
#   ./scripts/cross-compile-pi5.sh                  # build image if needed, then compile
#   ./scripts/cross-compile-pi5.sh --rebuild-image  # force Docker image rebuild
#   ./scripts/cross-compile-pi5.sh --profile dist   # stripped distribution build

set -euo pipefail

PROFILE="release"
REBUILD_IMAGE=false

usage() {
    echo "Usage: $0 [--rebuild-image] [--profile release|dist]"
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --rebuild-image) REBUILD_IMAGE=true ;;
        --profile) PROFILE="$2"; shift ;;
        -h|--help) usage ;;
        *) echo "Unknown option: $1"; usage ;;
    esac
    shift
done

# ── Paths ────────────────────────────────────────────────────────────────────
# Script lives in <project>/scripts/; derive the project root from that.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_NAME="$(basename "$PROJECT_DIR")"

# Mount the PARENT of the project so that Cargo path dependencies that live
# as siblings (tauri-plugin-cblite, tauri-plugin-litert) are reachable at the
# same relative paths they have on the host.
WORKSPACE_DIR="$(dirname "$PROJECT_DIR")"

DOCKERFILE="$PROJECT_DIR/docker/cross-pi5.Dockerfile"
IMAGE_TAG="tauri-cross-pi5:$(sha256sum "$DOCKERFILE" | cut -c1-12)"

TARGET="aarch64-unknown-linux-gnu"

# ── Docker check ─────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
    echo "Error: docker not found. Install Docker (or Podman aliased to docker)."
    echo "  https://docs.docker.com/engine/install/"
    exit 1
fi

# ── QEMU binfmt registration ─────────────────────────────────────────────────
# arm64 package post-install scripts (e.g. python3.12:arm64) execute arm64 ELF
# binaries during "apt-get install" inside the container.  The host kernel's
# binfmt_misc must be able to run arm64 binaries transparently via QEMU.
#
# qemu-user-static registers handlers with the -F (fix-binary) flag so the
# interpreter is held by the kernel — no QEMU binary needed inside the image.
if ! dpkg -l qemu-user-static 2>/dev/null | grep -q '^ii'; then
    echo "==> Installing qemu-user-static (registers arm64 binfmt handlers)..."
    sudo apt-get install -y qemu-user-static
else
    echo "==> qemu-user-static already installed"
fi

# ── Build Docker image if needed ─────────────────────────────────────────────
if [[ "$REBUILD_IMAGE" == true ]] || ! docker image inspect "$IMAGE_TAG" &>/dev/null; then
    echo "==> Building cross-compilation Docker image ($IMAGE_TAG)..."
    echo "    This takes ~5 minutes the first time; the result is cached."
    docker build \
        --tag "$IMAGE_TAG" \
        --file "$DOCKERFILE" \
        "$PROJECT_DIR"
else
    echo "==> Using cached Docker image $IMAGE_TAG"
fi

# ── Run the build inside the container ───────────────────────────────────────
echo "==> Building Tauri app for $TARGET (profile: $PROFILE) inside Docker..."

# Cache mounts:
#   ~/.cargo/registry + ~/.cargo/git  — Cargo crate downloads
#   ~/.cache                          — LiteRT prebuilt binary cache (litert-sys, litert-lm-sys)
# The project workspace is mounted read-write so the build artifacts land on
# the host at src-tauri/target/ as usual.

CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"

docker run --rm \
    --volume "$WORKSPACE_DIR:/workspace" \
    --volume "$CARGO_HOME/registry:/root/.cargo/registry" \
    --volume "$CARGO_HOME/git:/root/.cargo/git" \
    --volume "${XDG_CACHE_HOME:-$HOME/.cache}:/root/.cache" \
    --workdir "/workspace/$PROJECT_NAME" \
    --env CI=true \
    "$IMAGE_TAG" \
    bash -c "
        set -euo pipefail
        echo '--- Installing JS dependencies ---'
        pnpm install --frozen-lockfile
        echo '--- Building frontend ---'
        pnpm build

        echo '--- Fetching Cargo dependencies ---'
        cargo fetch --target $TARGET --manifest-path src-tauri/Cargo.toml

        # The couchbase-lite-rust fork at rev 6a8c7c5 ships libcblite.so.3 for
        # aarch64-unknown-linux-gnu, but CBL_Edition.h declares version 4.0.3 so
        # build.rs copies libcblite.so.4 — which doesn't exist.  Download the
        # correct binary from Couchbase before the build runs.
        echo '--- Ensuring libcblite 4.0.3 arm64 binary is present ---'
        CBL_ARM64=\$(find /root/.cargo/git/checkouts -type d \
            -path '*/couchbase-lite-rust-*/*/libcblite_community/lib/aarch64-unknown-linux-gnu' \
            2>/dev/null | head -1)
        if [[ -n \"\$CBL_ARM64\" && ! -f \"\$CBL_ARM64/libcblite.so.4\" ]]; then
            TMPDIR_CBL=\$(mktemp -d)
            curl -fL 'https://packages.couchbase.com/releases/couchbase-lite-c/4.0.3/couchbase-lite-c-community-4.0.3-linux-arm64.tar.gz' \
                | tar -xz -C \"\$TMPDIR_CBL\"
            find \"\$TMPDIR_CBL\" -name 'libcblite.so.4' -exec cp {} \"\$CBL_ARM64/\" \;
            rm -rf \"\$TMPDIR_CBL\"
            echo \"    Installed \$CBL_ARM64/libcblite.so.4\"
        else
            echo '    libcblite.so.4 already present'
        fi

        echo '--- Compiling libspeechd stub (optional TTS fallback) ---'
        # The stub satisfies the dynamic linker so the binary starts when
        # speech-dispatcher is not installed.  spd_open() returns NULL and
        # the TTS plugin falls back to Xenova.  Installed to
        # /usr/lib/tauri-cblite-litert/ by the .deb (see tauri.conf.json
        # bundle.linux.deb.files), which is on the binary's RPATH.
        aarch64-linux-gnu-gcc -shared -fPIC \
            -Wl,-soname,libspeechd.so.2 \
            src-tauri/libspeechd-stub.c \
            -o src-tauri/libspeechd-stub.so

        # Phase 1: Rust-only build to trigger build scripts and download all
        # native .so files (libLiteRtLmC.so, libGemmaModelConstraintProvider.so,
        # libLiteRt.so, libLiteRtWebGpuAccelerator.so, libLiteRtTopKWebGpuSampler.so).
        # build.rs copies them all into OUT_DIR with RUNPATH patched to \$ORIGIN.
        echo '--- Phase 1: Rust build (downloads and prepares native libraries) ---'
        cargo build --release --target $TARGET --manifest-path src-tauri/Cargo.toml

        # Collect all .so files from OUT_DIR into bundle-libs/ so that
        # cargo tauri build can include them in the .deb (see tauri.conf.json
        # bundle.linux.deb.files).  All libs are installed to
        # /usr/lib/tauri-cblite-litert/ which is on the binary's RPATH.
        echo '--- Collecting native libraries for .deb bundle ---'
        mkdir -p src-tauri/bundle-libs

        LITERT_OUT=\$(find src-tauri/target/$TARGET/release/build/tauri-cblite-litert-*/out \
            -maxdepth 0 -type d 2>/dev/null | head -1)
        if [[ -z \"\$LITERT_OUT\" ]]; then
            echo 'ERROR: Could not find tauri-cblite-litert build OUT_DIR'; exit 1
        fi
        echo \"  Copying from: \$LITERT_OUT\"
        cp \"\$LITERT_OUT\"/lib*.so src-tauri/bundle-libs/ 2>/dev/null || true

        CBL_LIB=\$(find /root/.cargo/git/checkouts \
            -path '*/couchbase-lite-rust-*/*/libcblite_community/lib/aarch64-unknown-linux-gnu/libcblite.so.4' \
            2>/dev/null | head -1)
        [[ -n \"\$CBL_LIB\" ]] && cp \"\$CBL_LIB\" src-tauri/bundle-libs/
        echo '  Bundle contents:'; ls src-tauri/bundle-libs/

        # Phase 2: cargo tauri build reuses phase-1 Rust artifacts (no recompile)
        # and packages the .deb including all files from tauri.conf.json deb.files.
        echo '--- Phase 2: Bundle .deb ---'
        if [[ "$PROFILE" == "dist" ]]; then
            cargo tauri build --target $TARGET --bundles deb -- --profile dist
        else
            cargo tauri build --target $TARGET --bundles deb
        fi
    "

echo ""
echo "==> Done! Package:"
find "$PROJECT_DIR/src-tauri/target/$TARGET" \
    -name "*.deb" -path "*/bundle/deb/*" 2>/dev/null \
    || echo "  (no .deb found — check src-tauri/target/$TARGET/$PROFILE/bundle/)"
