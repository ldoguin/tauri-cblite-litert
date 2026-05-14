/**
 * modelCache.ts — download, cache, and manage LLM/embedding/Whisper model files.
 *
 * On web: models are stored in the Cache API (origin-private, survives page reload).
 * On Tauri: models are stored on the filesystem; the path is returned directly.
 *
 * The registry (name → CachedModel) is persisted in localStorage so the UI
 * can show cached models without re-fetching headers.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type ModelKind = "llm" | "embed" | "whisper";

export type ModelEntry = {
  id: string;
  label: string;
  description: string;
  kind: ModelKind;
  /** Remote URL to download from */
  url: string;
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

/** Check which models are actually present in the Cache API and sync registry. */
export async function syncCacheRegistry(): Promise<CachedModel[]> {
  const registry = loadRegistry();

  if ("caches" in window) {
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    const cachedUrls = new Set(keys.map((r) => r.url));

    for (const entry of MODEL_CATALOGUE) {
      if (cachedUrls.has(entry.url)) {
        if (!registry[entry.id]?.cached) {
          // Try to read the actual stored size from the content-length header
          // rather than using the catalogue's approximate sizeBytes.
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

const activeDownloads = new Map<string, AbortController>();

/**
 * Download a model file and store it in the Cache API.
 * Calls `onProgress` with live byte counts.
 * Returns the URL that can be passed to loadWebLlm / initEmbeddings.
 */
export async function downloadModel(
  modelId: string,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  const entry = MODEL_CATALOGUE.find((m) => m.id === modelId);
  if (!entry) throw new Error(`Unknown model: ${modelId}`);

  // Abort any existing download for this model
  activeDownloads.get(modelId)?.abort();
  const controller = new AbortController();
  activeDownloads.set(modelId, controller);

  // Combine external signal with our own controller
  signal?.addEventListener("abort", () => controller.abort(), { once: true });

  try {
    const response = await fetch(entry.url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${entry.url}`);

    const contentLength = Number(response.headers.get("content-length") ?? entry.sizeBytes);
    if (!response.body) throw new Error(`No response body for ${entry.url}`);

    // Stream through a TransformStream to track progress without buffering the
    // entire file in memory. The readable side is passed directly to cache.put()
    // so only a small sliding window of chunks is held at any time.
    let received = 0;
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        onProgress({
          modelId,
          receivedBytes: received,
          totalBytes: contentLength,
          fraction: contentLength > 0 ? received / contentLength : 0,
        });
        controller.enqueue(chunk);
      },
    });

    // Pipe the fetch body through the progress transform.
    // Capture the promise so we can detect network drops — a silently swallowed
    // pipeTo error would otherwise store a truncated file as cached:true.
    const pipePromise = response.body.pipeTo(writable);

    if ("caches" in window) {
      const cache = await caches.open(CACHE_NAME);
      // Await both cache.put (which consumes the readable) and the pipe
      // (which surfaces network errors). If either rejects, the registry
      // is never updated and the truncated cache entry is deleted.
      try {
        await Promise.all([
          cache.put(entry.url, new Response(readable, {
            headers: { "content-type": "application/octet-stream" },
          })),
          pipePromise,
        ]);
      } catch (err) {
        // Clean up any partial cache entry so the model doesn't appear cached.
        await cache.delete(entry.url).catch(() => {});
        throw err;
      }
    } else {
      // No Cache API — drain the stream so the progress callbacks fire,
      // but do NOT mark the model as cached since nothing was persisted.
      const reader = readable.getReader();
      while (!(await reader.read()).done) { /* drain */ }
      await pipePromise.catch(() => {}); // surface network errors as thrown
      console.warn(`[modelCache] Cache API unavailable — model "${modelId}" was not persisted.`);
      return entry.url;
    }

    // Update registry — only reached when Cache API is available.
    const registry = loadRegistry();
    registry[modelId] = {
      ...entry,
      cached: true,
      cachedBytes: received,
      cachedAt: new Date().toISOString(),
    };
    saveRegistry(registry);

    return entry.url;
  } finally {
    activeDownloads.delete(modelId);
  }
}

/** Cancel an in-progress download. */
export function cancelDownload(modelId: string): void {
  activeDownloads.get(modelId)?.abort();
  activeDownloads.delete(modelId);
}

/** Remove a cached model from the Cache API and registry. */
export async function deleteModel(modelId: string): Promise<void> {
  const entry = MODEL_CATALOGUE.find((m) => m.id === modelId);
  if (!entry) return;

  // Cancel any in-progress download first so it can't re-add the model to
  // the Cache API after we delete it.
  cancelDownload(modelId);

  if ("caches" in window) {
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
