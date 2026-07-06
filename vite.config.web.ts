/**
 * Vite config for the standalone web build (no Tauri).
 *
 * Identical to vite.config.ts except:
 *   - @cblite alias → src/lib/cblite/web.ts  (Couchbase Lite JS adapter)
 *   - No Tauri-specific build targets or env vars
 *
 * Usage:
 *   pnpm vite build --config vite.config.web.ts
 *   pnpm vite dev   --config vite.config.web.ts
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";
import * as path from "path";
import * as fs from "fs";
import { createRequire } from "module";

const _require = createRequire(import.meta.url);

function findPkgDir(resolvedFile: string): string {
  let dir = path.dirname(resolvedFile);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`Could not find package.json above ${resolvedFile}`);
}

const VAD_PKG_DIR      = findPkgDir(_require.resolve("@ricky0123/vad-web"));
const VAD_DIST         = path.join(VAD_PKG_DIR, "dist");
const ORT_PKG_DIR      = findPkgDir(_require.resolve("onnxruntime-web", { paths: [VAD_PKG_DIR] }));
const ORT_DIST         = path.join(ORT_PKG_DIR, "dist");
const LITERT_LM_PKG_DIR = findPkgDir(_require.resolve("@litert-lm/core"));
const LITERT_LM_WASM_DIR = path.join(LITERT_LM_PKG_DIR, "wasm");

const STATIC_MAP: Record<string, { file: string; mime: string }> = {};
for (const f of fs.readdirSync(ORT_DIST)) {
  if (f.endsWith(".wasm") || f.endsWith(".mjs")) {
    STATIC_MAP[`/${f}`] = { file: path.resolve(ORT_DIST, f), mime: f.endsWith(".wasm") ? "application/wasm" : "application/javascript; charset=utf-8" };
  }
}
for (const f of ["vad.worklet.bundle.min.js", "silero_vad_v5.onnx", "silero_vad_legacy.onnx"]) {
  const mime = f.endsWith(".js") ? "application/javascript; charset=utf-8" : "application/octet-stream";
  STATIC_MAP[`/${f}`] = { file: path.resolve(VAD_DIST, f), mime };
}
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
  resolve: {
    alias: {
      // Web build: @cblite → Couchbase Lite JS adapter (no Tauri dependency).
      "@cblite": path.resolve(__dirname, "src/lib/cblite/web.ts"),
    },
  },
  plugins: [
    react(),
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
  clearScreen: false,
  server: {
    port: 1421,
    strictPort: true,
    host: "0.0.0.0",
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  worker: { format: "iife" },
  envPrefix: ["VITE_"],
  build: {
    target: "es2022",
    minify: "esbuild",
    outDir: "dist-web",
  },
}));
