/**
 * modelCache.ts — download, cache, and manage LLM/embedding/Whisper model files.
 *
 * On web:   models are stored in the Cache API (origin-private, survives reload).
 * On Tauri: models are downloaded via a Rust command to <appLocalDataDir>/models/
 *           and progress is delivered via `model-download-progress` Tauri events.
 *
 * The registry (id → CachedModel) is persisted in localStorage so the UI can
 * show cached state without re-checking the filesystem on every render.
 */

import { isTauri } from "./db";

// ── Types ──────────────────────────────────────────────────────────────────

export type ModelKind = "llm" | "embed" | "whisper";

export type ModelEntry = {
  id: string;
  label: string;
  description: string;
  kind: ModelKind;
  /** Remote URL to download from */
  url: string;
  /** Filename used when saving to disk on Tauri (derived from url if omitted) */
  fileName?: string;
  /** Approximate size in bytes (shown before download) */
  sizeBytes: number;
  /** Context window token limit (LLM only) */
  contextLength?: number;
};

export type CachedModel = ModelEntry & {
  /** True when the file is fully cached locally */
  cached: boolean;
  /** Actual size on disk/cache in bytes (0 if not cached) */
  cachedBytes: number;
  /** ISO timestamp of when it was cached */
  cachedAt?: string;
};

export type DownloadProgress = {
  modelId: string;
  receivedBytes: number;
  totalBytes: number;
  /** 0–1 */
  fraction: number;
};

// ── Model catalogue ────────────────────────────────────────────────────────

export const MODEL_CATALOGUE: ModelEntry[] = [
  // ── LLMs ──
  {
    id: "gemma3-1b-web",
    label: "Gemma 3 1B (web)",
    description: "Gemma 3 1B INT4 — ~700 MB, ~133 tok/s on WebGPU",
    kind: "llm",
    url: "https://huggingface.co/litert-community/Gemma3-1B-IT/resolve/main/gemma3-1b-it-int4-web.task",
    sizeBytes: 700 * 1024 * 1024,
    contextLength: 8192,
  },
  {
    id: "gemma4-2b-web",
    label: "Gemma 4 2B (web)",
    description: "Gemma 4 E2B INT4 — ~1.5 GB, best quality on WebGPU",
    kind: "llm",
    url: "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.task",
    sizeBytes: 1500 * 1024 * 1024,
    contextLength: 8192,
  },
  // ── Embedding models ──
  {
    id: "bert-embedder",
    label: "BERT embedder",
    description: "MediaPipe BERT text embedder — ~25 MB, 512-dim",
    kind: "embed",
    url: "https://storage.googleapis.com/mediapipe-models/text_embedder/bert_embedder/float32/1/bert_embedder.tflite",
    sizeBytes: 25 * 1024 * 1024,
  },
  {
    id: "mobilebert-embedder",
    label: "MobileBERT embedder",
    description: "MediaPipe MobileBERT text embedder — ~25 MB, faster on CPU than BERT",
    kind: "embed",
    url: "https://storage.googleapis.com/mediapipe-models/text_embedder/mobilebert_embedder/float32/1/mobilebert_embedder.tflite",
    sizeBytes: 25 * 1024 * 1024,
  },
  // ── Whisper ASR ──
  {
    id: "whisper-tiny-en",
    label: "Whisper Tiny (English)",
    description: "Xenova/whisper-tiny.en — ~75 MB, fastest",
    kind: "whisper",
    url: "https://huggingface.co/Xenova/whisper-tiny.en",
    sizeBytes: 75 * 1024 * 1024,
  },
  {
    id: "whisper-base-en",
    label: "Whisper Base (English)",
    description: "Xenova/whisper-base.en — ~145 MB, better accuracy",
    kind: "whisper",
    url: "https://huggingface.co/Xenova/whisper-base.en",
    sizeBytes: 145 * 1024 * 1024,
  },
];

// ── Cache API storage (web) ────────────────────────────────────────────────

const CACHE_NAME = "rag-chatbot-models-v1";
const REGISTRY_KEY = "rag-chatbot:model-registry";

function loadRegistry(): Record<string, CachedModel> {
  try {
    return JSON.parse(localStorage.getItem(REGISTRY_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function saveRegistry(reg: Record<string, CachedModel>): void {
  localStorage.setItem(REGISTRY_KEY, JSON.stringify(reg));
}

/** Merge catalogue entries with cached state from the registry. */
export function getCachedModels(): CachedModel[] {
  const registry = loadRegistry();
  return MODEL_CATALOGUE.map((entry) => ({
    ...entry,
    ...(registry[entry.id] ?? { cached: false, cachedBytes: 0 }),
  }));
}

/** Check which models are actually present and sync the registry. */
export async function syncCacheRegistry(): Promise<CachedModel[]> {
  const registry = loadRegistry();

  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    for (const entry of MODEL_CATALOGUE) {
      const fileName = modelFileName(entry);
      const path = await invoke<string | null>("get_model_path", { fileName }).catch(() => null);
      if (path) {
        if (!registry[entry.id]?.cached) {
          registry[entry.id] = {
            ...entry,
            cached: true,
            cachedBytes: entry.sizeBytes,
            cachedAt: registry[entry.id]?.cachedAt ?? new Date().toISOString(),
          };
        }
      } else {
        if (registry[entry.id]?.cached) {
          registry[entry.id] = { ...entry, cached: false, cachedBytes: 0 };
        }
      }
    }
    saveRegistry(registry);
  } else if ("caches" in window) {
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    const cachedUrls = new Set(keys.map((r) => r.url));

    for (const entry of MODEL_CATALOGUE) {
      if (cachedUrls.has(entry.url)) {
        if (!registry[entry.id]?.cached) {
          let cachedBytes = entry.sizeBytes;
          try {
            const resp = await cache.match(entry.url);
            const cl = resp?.headers.get("content-length");
            if (cl) cachedBytes = Number(cl);
          } catch { /* fall back to catalogue estimate */ }
          registry[entry.id] = {
            ...entry,
            cached: true,
            cachedBytes,
            cachedAt: registry[entry.id]?.cachedAt ?? new Date().toISOString(),
          };
        }
      } else {
        if (registry[entry.id]?.cached) {
          registry[entry.id] = { ...entry, cached: false, cachedBytes: 0 };
        }
      }
    }
    saveRegistry(registry);
  }

  return getCachedModels();
}

// ── Download ───────────────────────────────────────────────────────────────

// Active downloads: AbortController for web, no-op sentinel for Tauri
// (Tauri cancellation is handled via the cancel_model_download command).
const activeDownloads = new Map<string, AbortController>();

/** Derive the on-disk filename for a model entry. */
function modelFileName(entry: ModelEntry): string {
  return entry.fileName ?? entry.url.split("/").pop() ?? `${entry.id}.bin`;
}

/**
 * Download a model file and persist it.
 *
 * On Tauri: invokes the Rust `download_model` command which streams the file
 *   to <appLocalDataDir>/models/ and emits `model-download-progress` events.
 *   `onProgress` is wired to those events.
 *
 * On web: streams via fetch into the Cache API with a TransformStream so
 *   only a small sliding window of chunks is held in memory at any time.
 *
 * Returns the path/URL to pass to loadWebLlm / initEmbeddings.
 */
export async function downloadModel(
  modelId: string,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  const entry = MODEL_CATALOGUE.find((m) => m.id === modelId);
  if (!entry) throw new Error(`Unknown model: ${modelId}`);

  // Cancel any existing download for this model.
  cancelDownload(modelId);

  if (isTauri()) {
    return downloadModelTauri(entry, onProgress, signal);
  }

  // ── Web: Cache API path ───────────────────────────────────────────────────
  const controller = new AbortController();
  activeDownloads.set(modelId, controller);
  signal?.addEventListener("abort", () => controller.abort(), { once: true });

  try {
    const response = await fetch(entry.url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${entry.url}`);

    const contentLength = Number(response.headers.get("content-length") ?? entry.sizeBytes);
    if (!response.body) throw new Error(`No response body for ${entry.url}`);

    let received = 0;
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        received += chunk.byteLength;
        onProgress({
          modelId,
          receivedBytes: received,
          totalBytes: contentLength,
          fraction: contentLength > 0 ? received / contentLength : 0,
        });
        ctrl.enqueue(chunk);
      },
    });

    const pipePromise = response.body.pipeTo(writable);

    if ("caches" in window) {
      const cache = await caches.open(CACHE_NAME);
      try {
        await Promise.all([
          cache.put(entry.url, new Response(readable, {
            headers: { "content-type": "application/octet-stream" },
          })),
          pipePromise,
        ]);
      } catch (err) {
        await cache.delete(entry.url).catch(() => {});
        throw err;
      }
    } else {
      const reader = readable.getReader();
      while (!(await reader.read()).done) { /* drain */ }
      await pipePromise;
      console.warn(`[modelCache] Cache API unavailable — "${modelId}" not persisted.`);
      return entry.url;
    }

    const registry = loadRegistry();
    registry[modelId] = {
      ...entry, cached: true, cachedBytes: received,
      cachedAt: new Date().toISOString(),
    };
    saveRegistry(registry);
    return entry.url;
  } finally {
    activeDownloads.delete(modelId);
  }
}

/** Tauri download path — delegates to the Rust command and bridges events → onProgress. */
async function downloadModelTauri(
  entry: ModelEntry,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");

  // Listen to progress events from the Rust command.
  const unlisten = await listen<{
    modelId: string; receivedBytes: number; totalBytes: number; fraction: number;
  }>("model-download-progress", (ev) => {
    if (ev.payload.modelId !== entry.id) return;
    onProgress({
      modelId: entry.id,
      receivedBytes: ev.payload.receivedBytes,
      totalBytes: ev.payload.totalBytes,
      fraction: ev.payload.fraction,
    });
  });

  // Wire external abort signal to the Rust cancel command.
  const abortHandler = async () => {
    await invoke("cancel_model_download", { modelId: entry.id }).catch(() => {});
  };
  signal?.addEventListener("abort", abortHandler, { once: true });

  try {
    const filePath: string = await invoke("download_model", {
      modelId: entry.id,
      url: entry.url,
      fileName: modelFileName(entry),
    });

    const registry = loadRegistry();
    registry[entry.id] = {
      ...entry, cached: true, cachedBytes: entry.sizeBytes,
      cachedAt: new Date().toISOString(),
    };
    saveRegistry(registry);

    return filePath;
  } catch (err) {
    if (String(err) === "cancelled") throw new DOMException("Download cancelled", "AbortError");
    throw err;
  } finally {
    unlisten();
    signal?.removeEventListener("abort", abortHandler);
  }
}

/** Cancel an in-progress download. */
export function cancelDownload(modelId: string): void {
  // Web path
  activeDownloads.get(modelId)?.abort();
  activeDownloads.delete(modelId);
  // Tauri path — fire-and-forget
  if (isTauri()) {
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("cancel_model_download", { modelId }))
      .catch(() => {});
  }
}

/** Remove a cached model from storage and the registry. */
export async function deleteModel(modelId: string): Promise<void> {
  const entry = MODEL_CATALOGUE.find((m) => m.id === modelId);
  if (!entry) return;

  // Cancel any in-progress download first.
  cancelDownload(modelId);

  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("delete_model_file", { fileName: modelFileName(entry) }).catch(() => {});
  } else if ("caches" in window) {
    const cache = await caches.open(CACHE_NAME);
    await cache.delete(entry.url);
  }

  const registry = loadRegistry();
  registry[modelId] = { ...entry, cached: false, cachedBytes: 0 };
  saveRegistry(registry);
}

/** Total bytes used by all cached models. */
export function totalCachedBytes(models: CachedModel[]): number {
  return models.filter((m) => m.cached).reduce((sum, m) => sum + m.cachedBytes, 0);
}

/** Format bytes as human-readable string. */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/** Returns true if a download is currently active for this model. */
export function isDownloading(modelId: string): boolean {
  return activeDownloads.has(modelId);
}
