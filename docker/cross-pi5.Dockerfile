FROM docker.io/library/ubuntu:24.04

# Clean Ubuntu 24.04 — no Pop!_OS/derivative package conflicts for arm64.

ENV DEBIAN_FRONTEND=noninteractive

# ── Apt sources ──────────────────────────────────────────────────────────────
# Ubuntu 24.04's Docker image ships sources in deb822 format
# (/etc/apt/sources.list.d/ubuntu.sources) without arch constraints, so when
# arm64 is added dpkg tries to fetch arm64 indexes from archive.ubuntu.com
# which only has amd64.  Fix: remove all existing source files and replace
# with explicit per-arch entries using the correct mirrors.
RUN rm -f /etc/apt/sources.list \
          /etc/apt/sources.list.d/*.list \
          /etc/apt/sources.list.d/*.sources && \
    dpkg --add-architecture arm64 && \
    printf '%s\n' \
        'deb [arch=amd64] http://archive.ubuntu.com/ubuntu noble main restricted universe multiverse' \
        'deb [arch=amd64] http://archive.ubuntu.com/ubuntu noble-updates main restricted universe multiverse' \
        'deb [arch=amd64] http://archive.ubuntu.com/ubuntu noble-security main restricted universe multiverse' \
        'deb [arch=arm64] http://ports.ubuntu.com/ubuntu-ports noble main restricted universe multiverse' \
        'deb [arch=arm64] http://ports.ubuntu.com/ubuntu-ports noble-updates main restricted universe multiverse' \
        'deb [arch=arm64] http://ports.ubuntu.com/ubuntu-ports noble-security main restricted universe multiverse' \
        > /etc/apt/sources.list && \
    apt-get update

# ── amd64 build tools ────────────────────────────────────────────────────────
# libclang-dev: needed by bindgen (used in speech-dispatcher-sys and other
# crates with C FFI build scripts) to parse C headers at compile time.
RUN apt-get install -y --no-install-recommends \
        gcc-aarch64-linux-gnu \
        g++-aarch64-linux-gnu \
        build-essential \
        pkg-config \
        curl \
        ca-certificates \
        git \
        patchelf \
        file \
        libclang-dev \
        clang \
    && rm -rf /var/lib/apt/lists/*

# ── arm64 sysroot packages (Tauri Linux dependencies) ────────────────────────
# libspeechd-dev: pulled in by Tauri's Linux accessibility stack
# (speech-dispatcher-sys links against libspeechd on the target).
RUN apt-get update && apt-get install -y --no-install-recommends \
        libwebkit2gtk-4.1-dev:arm64 \
        libgtk-3-dev:arm64 \
        librsvg2-dev:arm64 \
        libssl-dev:arm64 \
        libpango1.0-dev:arm64 \
        libglib2.0-dev:arm64 \
        libsoup-3.0-dev:arm64 \
        libjavascriptcoregtk-4.1-dev:arm64 \
        libspeechd-dev:arm64 \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 22 + pnpm ────────────────────────────────────────────────────────
RUN apt-get update && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g pnpm@latest

# ── Rust stable + aarch64 target + cargo-tauri ───────────────────────────────
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --no-modify-path --default-toolchain stable && \
    . /root/.cargo/env && \
    rustup target add aarch64-unknown-linux-gnu && \
    cargo install tauri-cli --locked --version "^2"

ENV PATH="/root/.cargo/bin:$PATH"

# ── Cross-compilation environment ────────────────────────────────────────────
ENV CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc
ENV CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc
ENV CXX_aarch64_unknown_linux_gnu=aarch64-linux-gnu-g++
ENV AR_aarch64_unknown_linux_gnu=aarch64-linux-gnu-ar
ENV PKG_CONFIG_ALLOW_CROSS=1
ENV PKG_CONFIG_PATH=/usr/lib/aarch64-linux-gnu/pkgconfig:/usr/share/pkgconfig
ENV PKG_CONFIG_SYSROOT_DIR=/usr/aarch64-linux-gnu
