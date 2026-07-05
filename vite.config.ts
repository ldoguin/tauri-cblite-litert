import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";
import * as path from "path";
import * as fs from "fs";
import { createRequire } from "module";

const host = process.env.TAURI_DEV_HOST;

// viteStaticCopy loses to Vite's SPA fallback in dev mode for binary/ONNX files.
// This plugin serves all VAD + ORT static assets directly from node_modules
// via a Connect middleware that runs before ANY Vite transform pipeline.
// viteStaticCopy is kept only for production builds (copies files to dist/).

// Resolve package roots portably across npm / yarn / pnpm without hardcoding
// version numbers or pnpm's content-addressable layout.
//
// We cannot use `require.resolve("pkg/package.json")` because some packages
// (e.g. onnxruntime-web@1.26) do not list "./package.json" in their exports
// map and Node will throw ERR_PACKAGE_PATH_NOT_EXPORTED.
// Instead we resolve a known exported entry point and walk up the directory
// tree until we find the package.json boundary.
const _require = createRequire(import.meta.url);

function findPkgDir(resolvedFile: string): string {
  let dir = path.dirname(resolvedFile);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`Could not find package.json above ${resolvedFile}`);
}

// vad-web ships a CJS main entry that is always resolvable.
const VAD_PKG_DIR = findPkgDir(_require.resolve("@ricky0123/vad-web"));
const VAD_DIST = path.join(VAD_PKG_DIR, "dist");

// onnxruntime-web is a direct dep of vad-web; resolve it relative to vad-web
// so we always get the version vad-web actually depends on, not a hoisted one.
const ORT_PKG_DIR = findPkgDir(
  _require.resolve("onnxruntime-web", { paths: [VAD_PKG_DIR] })
);
const ORT_DIST = path.join(ORT_PKG_DIR, "dist");

// @litert-lm/core ships WASM files in its wasm/ subdirectory.
const LITERT_LM_PKG_DIR = findPkgDir(_require.resolve("@litert-lm/core"));
const LITERT_LM_WASM_DIR = path.join(LITERT_LM_PKG_DIR, "wasm");

const STATIC_MAP: Record<string, { file: string; mime: string }> = {};
// ORT WASM binaries and MJS workers
for (const f of fs.readdirSync(ORT_DIST)) {
  if (f.endsWith(".wasm") || f.endsWith(".mjs")) {
    STATIC_MAP[`/${f}`] = { file: path.resolve(ORT_DIST, f), mime: f.endsWith(".wasm") ? "application/wasm" : "application/javascript; charset=utf-8" };
  }
}
// Silero VAD model + Audio Worklet bundle
for (const f of ["vad.worklet.bundle.min.js", "silero_vad_v5.onnx", "silero_vad_legacy.onnx"]) {
  const mime = f.endsWith(".js") ? "application/javascript; charset=utf-8" : "application/octet-stream";
  STATIC_MAP[`/${f}`] = { file: path.resolve(VAD_DIST, f), mime };
}
// LiteRT-LM WASM runtime files — served under /litert-lm/
for (const f of fs.readdirSync(LITERT_LM_WASM_DIR)) {
  if (f.endsWith(".wasm") || f.endsWith(".js")) {
    const mime = f.endsWith(".wasm") ? "application/wasm" : "application/javascript; charset=utf-8";
    STATIC_MAP[`/litert-lm/${f}`] = { file: path.resolve(LITERT_LM_WASM_DIR, f), mime };
  }
}

function staticAssetsPlugin() {
  return {
    name: "static-assets-serve",
    configureServer(server: import("vite").ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? "").split("?")[0];
        const entry = STATIC_MAP[pathname];
        if (entry) {
          res.setHeader("Content-Type", entry.mime);
          res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
          fs.createReadStream(entry.file).pipe(res);
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig(async () => ({
  plugins: [
    react(),
    // Dev: serves all VAD+ORT assets via middleware (before Vite's SPA fallback)
    // Build: viteStaticCopy copies them to dist/
    staticAssetsPlugin(),
    viteStaticCopy({
      targets: [
        { src: path.resolve(VAD_DIST, "vad.worklet.bundle.min.js"), dest: "./", rename: { stripBase: true } },
        { src: path.resolve(VAD_DIST, "silero_vad_v5.onnx"), dest: "./", rename: { stripBase: true } },
        { src: path.resolve(VAD_DIST, "silero_vad_legacy.onnx"), dest: "./", rename: { stripBase: true } },
        { src: path.resolve(ORT_DIST, "*.wasm"), dest: "./", rename: { stripBase: true } },
        { src: path.resolve(ORT_DIST, "*.mjs"), dest: "./", rename: { stripBase: true } },
        { src: path.resolve(LITERT_LM_WASM_DIR, "*.wasm"), dest: "./litert-lm/", rename: { stripBase: true } },
        { src: path.resolve(LITERT_LM_WASM_DIR, "*.js"), dest: "./litert-lm/", rename: { stripBase: true } },
      ],
    }),
  ],
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || "0.0.0.0",
    allowedHosts: true,
    // SharedArrayBuffer (required by ORT threaded WASM) needs these headers.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  // Bundle Web Workers as classic IIFE so @litertjs/wasm-utils can call
  // importScripts() to load the WASM glue script at runtime.
  worker: {
    format: "iife",
  },
  // Env variables starting with the item of `envPrefix` will be exposed in tauri's source code through `import.meta.env`.
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // Tauri uses Chromium on Windows and WebKit on macOS and Linux
    target:
      process.env.TAURI_ENV_PLATFORM == "windows"
        ? "chrome105"
        : "safari13",
    // don't minify for debug builds
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    // produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
}));
