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
USER root
