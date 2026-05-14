FROM mcr.microsoft.com/devcontainers/base:2.0.4-noble

# ── System packages ────────────────────────────────────────────────────────
# Tauri Linux dependencies + build tools
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive && \
    apt-get install -y --no-install-recommends \
        # Tauri / WebKit
        libwebkit2gtk-4.1-dev \
        libgtk-3-dev \
        libayatana-appindicator3-dev \
        librsvg2-dev \
        libxdo-dev \
        # TLS / crypto
        libssl-dev \
        # Build essentials
        pkg-config \
        build-essential \
        cmake \
        file \
        # Utilities
        curl \
        wget \
        git \
        unzip \
        jq \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 22 ─────────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g pnpm && \
    rm -rf /var/lib/apt/lists/*

# ── Rust (stable) ──────────────────────────────────────────────────────────
USER vscode
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --default-toolchain stable --no-modify-path && \
    . "$HOME/.cargo/env" && \
    # Android cross-compilation targets
    rustup target add \
        aarch64-linux-android \
        armv7-linux-androideabi \
        x86_64-linux-android \
        i686-linux-android && \
    # Tauri CLI
    cargo install tauri-cli --version "^2" --locked

ENV PATH="/home/vscode/.cargo/bin:${PATH}"

# ── LiteRT runtime library path ────────────────────────────────────────────
# litert-sys and litert-lm-sys download prebuilt .so files into the user
# cache at build time. libLiteRtLmC.so has a hard NEEDED entry for
# libGemmaModelConstraintProvider.so whose RUNPATH points to Bazel build
# tree paths that don't exist outside Google's build environment. Setting
# LD_LIBRARY_PATH to the litert-sys cache dir lets the dynamic linker
# resolve it at runtime without patching the upstream libraries.
ENV LD_LIBRARY_PATH="/home/vscode/.cache/litert-sys/v0.10.2/x86_64-unknown-linux-gnu:${LD_LIBRARY_PATH:-}"

# ── Android SDK ────────────────────────────────────────────────────────────
# Required for `tauri android dev` / `tauri android build`.
# SDK version matches Tauri's minimum requirements (API 24+, build-tools 34).
USER root
ENV ANDROID_HOME="/opt/android-sdk"
ENV ANDROID_SDK_ROOT="${ANDROID_HOME}"
ENV NDK_HOME="${ANDROID_HOME}/ndk/27.0.12077973"
ENV PATH="${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${PATH}"

RUN mkdir -p "${ANDROID_HOME}/cmdline-tools" && \
    curl -fsSL "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip" \
      -o /tmp/cmdline-tools.zip && \
    unzip -q /tmp/cmdline-tools.zip -d /tmp/cmdline-tools-extract && \
    mv /tmp/cmdline-tools-extract/cmdline-tools "${ANDROID_HOME}/cmdline-tools/latest" && \
    rm -rf /tmp/cmdline-tools.zip /tmp/cmdline-tools-extract && \
    yes | sdkmanager --licenses > /dev/null && \
    sdkmanager \
      "platform-tools" \
      "platforms;android-34" \
      "build-tools;34.0.0" \
      "ndk;27.0.12077973" && \
    chown -R vscode:vscode "${ANDROID_HOME}"

USER root
