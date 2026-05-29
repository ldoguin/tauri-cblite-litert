import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";
import * as path from "path";
import * as fs from "fs";

const host = process.env.TAURI_DEV_HOST;

// viteStaticCopy loses to Vite's SPA fallback in dev mode for binary/ONNX files.
// This plugin serves all VAD + ORT static assets directly from node_modules
// via a Connect middleware that runs before ANY Vite transform pipeline.
// viteStaticCopy is kept only for production builds (copies files to dist/).
const ORT_DIST = "node_modules/.pnpm/onnxruntime-web@1.26.0/node_modules/onnxruntime-web/dist";
const VAD_DIST = "node_modules/@ricky0123/vad-web/dist";

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
        { src: "node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js", dest: "./" },
        { src: "node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx", dest: "./" },
        { src: "node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx", dest: "./" },
        { src: `${ORT_DIST}/*.wasm`, dest: "./" },
        { src: `${ORT_DIST}/*.mjs`, dest: "./" },
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
