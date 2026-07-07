/**
 * llm-wasm.ts
 *
 * Windows WASM backend for LLM inference using @litert-lm/core.
 * Hosts the engine in a Web Worker and exposes the same interface
 * as the Tauri IPC path so llm.ts can route to it transparently.
 *
 * The worker is created once and reused across calls. The model is
 * loaded once per session; subsequent generate() calls reuse the
 * loaded engine (KV-cache is reset per conversation by the worker).
 */

import type { GenerateOptions, StreamCallbacks } from "./llm";
import type { ChatMessage } from "../workers/litert-lm.worker";
// ── Worker singleton ──────────────────────────────────────────────────────────
//
// @litertjs/wasm-utils calls importScripts() to load the WASM glue script,
// which only works in classic workers. Vite's dev server always instantiates
// ?worker imports as ES module workers, so we bypass it entirely:
// - In dev:  Vite serves ?worker_file&type=classic as a pre-bundled classic script.
// - In prod: Vite emits the worker as an IIFE chunk (worker.format = "iife").
// We create the worker from a Blob that calls importScripts() on the file URL,
// which forces classic worker semantics in both environments.

// Resolved by Vite at build time to the correct asset URL.
const WORKER_URL = new URL(
  "../workers/litert-lm.worker.ts?worker_file&type=classic",
  import.meta.url,
).href;

let _worker: Worker | null = null;
let _workerReady = false;
let _loadedModelUrl: string | null = null;

function getWorker(): Worker {
  if (!_worker) {
    // The Blob worker has a blob: origin so relative importScripts() URLs
    // (e.g. /@vite/env injected by Vite) would fail. We override importScripts
    // to resolve relative URLs against the page origin before delegating.
    const origin = location.origin;
    const wasmBase = origin + "/litert-lm/";
    const bootstrap = `
self._wasmBase = ${JSON.stringify(wasmBase)};
// Pre-set Module.locateFile so the Emscripten WASM glue resolves .wasm
// relative to wasmBase instead of self.location.href (blob: URL).
self.Module = {
  locateFile: function(path, _scriptDir) {
    return ${JSON.stringify(wasmBase)} + path;
  }
};
self._origImportScripts = self.importScripts;
self.importScripts = function(...urls) {
  self._origImportScripts(...urls.map(u => /^(https?:|blob:|\\/\\/)/.test(u) ? u : ${JSON.stringify(origin)} + (u.startsWith('/') ? '' : '/') + u));
};
importScripts(${JSON.stringify(WORKER_URL)});
`;
    const blob = new Blob([bootstrap], { type: "application/javascript" });
    _worker = new Worker(URL.createObjectURL(blob));
  }
  return _worker;
}

// ── Model loading ─────────────────────────────────────────────────────────────

export type WasmLoadProgress = (progress: number) => void;

/**
 * Load a .litertlm model into the WASM engine.
 * modelUrl must be a URL accessible from the main thread (e.g. a Tauri asset
 * protocol URL or a local HTTP URL served by the dev server).
 *
 * The model is fetched in the main thread — blob: workers cannot reach
 * asset.localhost on Tauri — and the ArrayBuffer is transferred to the worker.
 */
export async function loadWasmModel(
  modelUrl: string,
  maxTokens = 2048,
  onProgress?: WasmLoadProgress,
): Promise<void> {
  if (_loadedModelUrl === modelUrl && _workerReady) return;

  // Fetch in the main thread where asset.localhost is accessible.
  onProgress?.(0);
  const response = await fetch(modelUrl);
  if (!response.ok) throw new Error(`Failed to fetch model: ${response.status} ${response.statusText}`);

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  let loaded = 0;
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    if (contentLength > 0) {
      // Reserve 0–90 % for the download; worker init gets 90–100 %.
      onProgress?.(Math.round((loaded / contentLength) * 90));
    }
  }

  // Concatenate into a single ArrayBuffer for zero-copy transfer.
  const totalBytes = chunks.reduce((n, c) => n + c.byteLength, 0);
  const buffer = new ArrayBuffer(totalBytes);
  const view = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) { view.set(chunk, offset); offset += chunk.byteLength; }

  return new Promise((resolve, reject) => {
    const worker = getWorker();

    const handler = (event: MessageEvent) => {
      const msg = event.data as Record<string, unknown>;
      switch (msg.type) {
        case "load-progress":
          onProgress?.(msg.progress as number);
          break;
        case "load-done":
          worker.removeEventListener("message", handler);
          _workerReady = true;
          _loadedModelUrl = modelUrl;
          resolve();
          break;
        case "load-error":
          worker.removeEventListener("message", handler);
          _workerReady = false;
          reject(new Error(msg.error as string));
          break;
      }
    };

    worker.addEventListener("message", handler);
    // Transfer the buffer — zero-copy, worker takes ownership.
    worker.postMessage({ type: "load", modelBuffer: buffer, maxTokens }, [buffer]);
  });
}

export function isWasmModelLoaded(): boolean {
  return _workerReady;
}

export function unloadWasmModel(): void {
  if (_worker) {
    _worker.postMessage({ type: "unload" });
    _workerReady = false;
    _loadedModelUrl = null;
  }
}

// ── Generation ────────────────────────────────────────────────────────────────

let _genCounter = 0;

export async function generateViaWasm(
  messages: Array<{ role: string; content: string }>,
  opts: GenerateOptions,
  callbacks: StreamCallbacks,
): Promise<void> {
  if (!_workerReady) {
    callbacks.onError("WASM engine not loaded");
    return;
  }

  if (opts.signal?.aborted) {
    callbacks.onDone(0);
    return;
  }

  const id = `gen-${++_genCounter}`;
  const worker = getWorker();
  const t0 = performance.now();

  // Forward AbortSignal to the worker
  const abortHandler = () => worker.postMessage({ type: "abort", id });
  opts.signal?.addEventListener("abort", abortHandler, { once: true });

  return new Promise<void>((resolve) => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as Record<string, unknown>;
      if ((msg.id as string | undefined) !== id) return;

      switch (msg.type) {
        case "chunk":
          callbacks.onChunk(msg.text as string);
          break;
        case "done":
          worker.removeEventListener("message", handler);
          opts.signal?.removeEventListener("abort", abortHandler);
          callbacks.onDone(performance.now() - t0);
          resolve();
          break;
        case "error":
          worker.removeEventListener("message", handler);
          opts.signal?.removeEventListener("abort", abortHandler);
          callbacks.onError(msg.error as string);
          resolve();
          break;
      }
    };

    worker.addEventListener("message", handler);

    const chatMessages: ChatMessage[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    worker.postMessage({
      type: "generate",
      id,
      messages: chatMessages,
      systemPrompt: opts.systemInstruction ?? "",
      maxTokens: opts.config.maxTokens ?? 2048,
      temperature: opts.config.temperature ?? 0.8,
      topK: opts.config.topK ?? 40,
      topP: opts.config.topP ?? 0.95,
    });
  });
}
