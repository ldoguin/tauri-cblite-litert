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

// ── Platform detection ─────────────────────────────────────────────────────
// Cached here independently of llm.ts to avoid a circular import
// (llm.ts already imports from this module).

let _platform: AppPlatform | null = null;

async function ensurePlatform(): Promise<AppPlatform> {
  if (_platform) return _platform;
  if (!isTauri()) { _platform = "web"; return _platform; }
  try {
    const { platform } = await import("@tauri-apps/plugin-os");
    _platform = (await platform()) === "android" ? "android" : "desktop";
  } catch {
    _platform = "desktop";
  }
  return _platform;
}

// ── Types ──────────────────────────────────────────────────────────────────

export type ModelKind = "llm" | "embed" | "whisper";

/** Runtime platform identifier used for per-platform overrides. */
export type AppPlatform = "web" | "android" | "windows" | "desktop";

/**
 * Capabilities and loading parameters for a specific model.
 * Used both in the catalogue and in sidecar JSON files.
 */
export type ModelCapabilities = {
  /** True for models with vision/audio encoders (e.g. Gemma 4). */
  supportsVision?: boolean;
  /**
   * Force a specific backend for this model.
   * "gpu" for models with backend_constraint: gpu in their .litertlm.
   */
  requiredAccelerator?: "cpu" | "gpu" | "npu";
  /**
   * Context window in tokens. Only set when the value is known exactly —
   * v0.13.1 enforces an exact KV-cache match; wrong values cause DYNAMIC_UPDATE_SLICE failures.
   */
  contextLength?: number;
  /**
   * Chat prompt template. Determines how system/user/assistant turns are formatted
   * before being sent to the model. "raw" = no wrapping (model handles it internally).
   */
  promptTemplate?: "gemma" | "qwen" | "llama3" | "chatml" | "raw";
};

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
  /** Restrict to a specific runtime — omit to show on all platforms.
   * "android" = Android only, "tauri" = desktop only, "web" = browser only. */
  platform?: "web" | "tauri" | "android";
  /** Default capabilities applied on all platforms */
  capabilities?: ModelCapabilities;
  /**
   * Per-platform capability overrides. Keys are AppPlatform values.
   * Merged on top of `capabilities` at load time.
   */
  platformOverrides?: Partial<Record<AppPlatform, ModelCapabilities>>;
  // ── Legacy flat fields (kept for back-compat, mapped to capabilities) ──
  contextLength?: number;
  requiredAccelerator?: "cpu" | "gpu" | "npu";
  supportsVision?: boolean;
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
  // ── LLMs (desktop / Tauri) ──
  // Qwen3-0.6B: smallest CPU-compatible model (~586 MB). Listed first so
  // resolveDefaultModelPaths auto-selects it on GPU-less Linux desktops.
  {
    id: "qwen3-0.6b-cpu",
    label: "Qwen3 0.6B CPU (desktop)",
    description: "Qwen3 0.6B — ~586 MB, CPU-compatible via LiteRT-LM, fast on-device inference",
    kind: "llm",
    platform: "tauri",
    url: "https://huggingface.co/litert-community/Qwen3-0.6B/resolve/main/Qwen3-0.6B.litertlm",
    fileName: "Qwen3-0.6B.litertlm",
    sizeBytes: 586 * 1024 * 1024,
    capabilities: { contextLength: 4096, promptTemplate: "qwen" },
  },
  // gemma3-1b-cpu / gemma3-1b-desktop replaced 2026-06-30: the entire
  // litert-community Gemma3 family became gated upstream (HF login +
  // license acceptance required), breaking unauthenticated downloads.
  // Qwen3-1.7B is the closest confirmed-ungated alternative (~2 GB, vs the
  // original ~700 MB) — works on CPU like qwen3-0.6b-cpu, just slower.
  {
    id: "qwen3-1.7b-desktop",
    label: "Qwen3 1.7B (desktop)",
    description: "Qwen3 1.7B — ~2.0 GB, CPU-compatible via LiteRT-LM (GPU recommended)",
    kind: "llm",
    platform: "tauri",
    url: "https://huggingface.co/litert-community/Qwen3-1.7B/resolve/main/Qwen3_1.7B.litertlm",
    fileName: "Qwen3_1.7B.litertlm",
    sizeBytes: 2057 * 1024 * 1024,
    // contextLength intentionally omitted — see qwen3-1.7b-android for why.
    // requiredAccelerator intentionally omitted — defaults to CPU (works,
    // just slower); GPU is opt-in via the user's own accelerator setting.
    capabilities: { promptTemplate: "qwen" },
  },
  // ── LLMs (Android) ──
  // Same .litertlm binaries as desktop — the format is cross-platform.
  // Sizing guide: practical per-app RAM budget is ~1.5 GB on 6 GB phones,
  // ~3–4 GB on 8–12 GB flagships (no swap + aggressive OOM-killer).
  // GPU is required for any model above ~1 GB — CPU inference is unusably
  // slow and more likely to OOM from repeated tensor buffer allocations.
  {
    id: "qwen3-0.6b-android",
    label: "Qwen3 0.6B (Android)",
    description: "Qwen3 0.6B INT4 — ~586 MB, fast on Adreno/Mali/Dimensity GPUs",
    kind: "llm",
    platform: "android",
    url: "https://huggingface.co/litert-community/Qwen3-0.6B/resolve/main/Qwen3-0.6B.litertlm",
    fileName: "Qwen3-0.6B.litertlm",
    sizeBytes: 586 * 1024 * 1024,
    capabilities: { contextLength: 4096, promptTemplate: "qwen", requiredAccelerator: "gpu" },
  },
  // Gemma3-1B-IT replaced 2026-06-30: the entire litert-community Gemma3
  // family (1B, 4B, even 270M) became gated upstream (HF login + license
  // acceptance required), breaking unauthenticated download_model fetches.
  // Qwen3-1.7B is the closest confirmed-ungated alternative — bigger than
  // the original ~700 MB target (~2 GB) but still a meaningfully lighter/
  // faster mid-tier option below Gemma4-2B.
  {
    id: "qwen3-1.7b-android",
    label: "Qwen3 1.7B (Android)",
    description: "Qwen3 1.7B — ~2.0 GB, GPU-accelerated on-device inference",
    kind: "llm",
    platform: "android",
    url: "https://huggingface.co/litert-community/Qwen3-1.7B/resolve/main/Qwen3_1.7B.litertlm",
    fileName: "Qwen3_1.7B.litertlm",
    sizeBytes: 2057 * 1024 * 1024,
    // contextLength intentionally omitted — unverified KV-cache size for this
    // export; v0.13.1 enforces an exact match and a wrong guess crashes at
    // generation time (see gemma4-2b-desktop below for the same precaution).
    capabilities: { promptTemplate: "qwen", requiredAccelerator: "gpu" },
  },
  {
    id: "gemma4-2b-android",
    label: "Gemma 4 2B (Android)",
    description: "Gemma 4 E2B INT4 — ~2.5 GB, vision-capable. Requires 8 GB+ RAM device and GPU.",
    kind: "llm",
    platform: "android",
    url: "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it.litertlm",
    fileName: "gemma-4-E2B-it.litertlm",
    sizeBytes: 2500 * 1024 * 1024,
    // contextLength intentionally omitted: v0.13.1 enforces an exact KV-cache
    // match — wrong values cause DYNAMIC_UPDATE_SLICE failures at generation time.
    capabilities: { supportsVision: true, promptTemplate: "gemma", requiredAccelerator: "gpu" },
  },
  {
    id: "gemma4-2b-desktop",
    label: "Gemma 4 2B (desktop)",
    description: "Gemma 4 E2B INT4 — ~2.5 GB, on-device via LiteRT-LM (GPU via WebGPU/RADV)",
    kind: "llm",
    platform: "tauri",
    url: "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it.litertlm",
    fileName: "gemma-4-E2B-it.litertlm",
    sizeBytes: 2500 * 1024 * 1024,
    // contextLength intentionally omitted: v0.13.1 enforces exact KV-cache match.
    capabilities: { supportsVision: true, promptTemplate: "gemma" },
  },
  {
    id: "gemma4-12b-desktop",
    label: "Gemma 4 12B (desktop)",
    description: "Gemma 4 12B INT4 — ~6.5 GB, on-device via LiteRT-LM, up to 32k context",
    kind: "llm",
    platform: "tauri",
    url: "https://huggingface.co/litert-community/gemma-4-12B-it-litert-lm/resolve/main/gemma-4-12B-it.litertlm",
    fileName: "gemma-4-12B-it.litertlm",
    sizeBytes: 6550 * 1024 * 1024,
    capabilities: { supportsVision: true, contextLength: 2048, promptTemplate: "gemma", requiredAccelerator: "gpu" },
  },
  // ── SmolVLM2-500M ──
  // 361 MB vision-language model from HuggingFace SmolLM2 family.
  // Context window 2048 (KV-cache size baked into the .litertlm bundle).
  // Vision encoder handles image + text — uses ChatML prompt format.
  // Small enough to run on CPU desktop; GPU recommended on Android.
  {
    id: "smolvlm2-500m-desktop",
    label: "SmolVLM2 500M (desktop)",
    description: "SmolVLM2 500M — ~361 MB, vision+text, CPU-compatible via LiteRT-LM",
    kind: "llm",
    platform: "tauri",
    url: "https://huggingface.co/litert-community/SmolVLM2-500M/resolve/main/SmolVLM2-500M.litertlm",
    fileName: "SmolVLM2-500M.litertlm",
    sizeBytes: 361 * 1024 * 1024,
    capabilities: { supportsVision: true, contextLength: 2048, promptTemplate: "chatml" },
  },
  {
    id: "smolvlm2-500m-android",
    label: "SmolVLM2 500M (Android)",
    description: "SmolVLM2 500M — ~361 MB, vision+text, GPU-accelerated on-device inference",
    kind: "llm",
    platform: "android",
    url: "https://huggingface.co/litert-community/SmolVLM2-500M/resolve/main/SmolVLM2-500M.litertlm",
    fileName: "SmolVLM2-500M.litertlm",
    sizeBytes: 361 * 1024 * 1024,
    capabilities: { supportsVision: true, contextLength: 2048, promptTemplate: "chatml", requiredAccelerator: "gpu" },
  },
  // ── LLMs (web) ──
  // ── LLMs (web — WASM engine via @litert-lm/core) ──
  // @litert-lm/core currently only supports the Gemma 4 -web.litertlm files.
  // These are stripped variants without vision/audio/embedder sub-models that
  // the browser WASM runtime cannot stream-load. No GPU required.
  {
    id: "gemma4-2b-wasm",
    label: "Gemma 4 2B (browser WASM)",
    description: "Gemma 4 E2B — ~2.5 GB, runs in-browser via WebAssembly, no GPU needed",
    kind: "llm",
    platform: "web",
    url: "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm",
    sizeBytes: 2500 * 1024 * 1024,
    capabilities: { contextLength: 8192, promptTemplate: "gemma" },
  },
  {
    id: "gemma4-4b-wasm",
    label: "Gemma 4 4B (browser WASM)",
    description: "Gemma 4 E4B — ~4.5 GB, higher quality, runs in-browser via WebAssembly, no GPU needed",
    kind: "llm",
    platform: "web",
    url: "https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it-web.litertlm",
    sizeBytes: 4500 * 1024 * 1024,
    capabilities: { contextLength: 8192, promptTemplate: "gemma" },
  },
  // gemma3-1b-web removed 2026-06-30: same upstream Gemma3 gating as the
  // desktop/Android entries (see qwen3-1.7b-desktop above). No ungated
  // Qwen3 .task (MediaPipe web) export exists yet, so there's currently no
  // small/fast tier for web — gemma4-2b-web is the only web LLM option.
  {
    id: "gemma4-2b-web",
    label: "Gemma 4 2B (web WebGPU)",
    description: "Gemma 4 E2B INT4 — ~1.5 GB, best quality on WebGPU (requires GPU)",
    kind: "llm",
    platform: "web",
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
    id: "avg-word-embedder",
    label: "Average Word embedder",
    description: "MediaPipe average-word-embedding — ~3 MB, fastest CPU option",
    kind: "embed",
    url: "https://storage.googleapis.com/mediapipe-models/text_embedder/average_word_embedder/float32/1/average_word_embedder.tflite",
    sizeBytes: 3 * 1024 * 1024,
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

/** Filter catalogue to models appropriate for the current runtime.
 * Uses the cached _platform value — call ensurePlatform() first in any
 * async context so Android is correctly distinguished from desktop. */
function platformModels(): ModelEntry[] {
  const p = _platform ?? (isTauri() ? "desktop" : "web");
  return MODEL_CATALOGUE.filter((e) => {
    if (!e.platform) return true;                // shown everywhere
    if (e.platform === "android") return p === "android";
    if (e.platform === "tauri")   return p === "desktop";
    if (e.platform === "web")     return p === "web";
    return false;
  });
}

// ── Model capability resolver ─────────────────────────────────────────────

/** Safe defaults when no other metadata is available. */
const CAPABILITY_DEFAULTS: Required<ModelCapabilities> = {
  supportsVision: false,
  requiredAccelerator: "cpu",
  contextLength: 0,
  promptTemplate: "raw",
};

/**
 * Resolve the effective capabilities for a model file given the current platform.
 *
 * Resolution order (later entries win):
 *   1. CAPABILITY_DEFAULTS
 *   2. Catalogue flat fields (legacy: supportsVision, requiredAccelerator, contextLength)
 *   3. Catalogue `capabilities` object
 *   4. Catalogue `platformOverrides[platform]`
 *   5. Sidecar metadata (from the scanned model list)
 *
 * @param modelPath  Absolute path to the .litertlm file
 * @param platform   Current runtime platform
 * @param scanned    Scanned model list (may contain sidecar metadata)
 */
export function resolveModelCapabilities(
  modelPath: string,
  platform: AppPlatform,
  scanned: ScannedModelMeta[] = [],
): Required<ModelCapabilities> {
  // 1. Start with safe defaults
  let caps: Required<ModelCapabilities> = { ...CAPABILITY_DEFAULTS };

  // 2. Catalogue entry (match by filename suffix)
  const entry = MODEL_CATALOGUE.find((m) => {
    const fn = m.fileName ?? m.url.split("/").pop() ?? "";
    return fn && modelPath.endsWith(fn);
  });

  if (entry) {
    // Legacy flat fields
    if (entry.supportsVision !== undefined)       caps.supportsVision = entry.supportsVision;
    if (entry.requiredAccelerator !== undefined)  caps.requiredAccelerator = entry.requiredAccelerator;
    if (entry.contextLength !== undefined)        caps.contextLength = entry.contextLength;
    // capabilities object
    if (entry.capabilities) Object.assign(caps, stripUndefined(entry.capabilities));
    // platform overrides
    const override = entry.platformOverrides?.[platform];
    if (override) Object.assign(caps, stripUndefined(override));
  }

  // 3. Sidecar metadata (takes precedence over catalogue for custom models)
  const sidecar = scanned.find((m) => m.path === modelPath);
  if (sidecar?.capabilities) Object.assign(caps, stripUndefined(sidecar.capabilities));

  return caps;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/** Shape of a scanned model entry (returned by the Rust scan_models command). */
export type ScannedModelMeta = {
  name: string;
  path: string;
  /** Parsed from <name>.json sidecar if present */
  capabilities?: ModelCapabilities;
};

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
  return platformModels().map((entry) => ({
    ...entry,
    ...(registry[entry.id] ?? { cached: false, cachedBytes: 0 }),
  }));
}

/** Check which models are actually present and sync the registry. */
export async function syncCacheRegistry(): Promise<CachedModel[]> {
  await ensurePlatform();
  const registry = loadRegistry();

  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    for (const entry of platformModels()) {
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

    for (const entry of platformModels()) {
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

// ── Default path resolution ────────────────────────────────────────────────

/**
 * On Tauri, probe the models directory for the first available LLM and
 * embedding model. Returns paths to pass into ModelConfig when the user
 * has not yet configured any paths.
 */
export async function resolveDefaultModelPaths(): Promise<{
  lmModelPath?: string;
  embeddingModelPath?: string;
}> {
  if (!isTauri()) return {};
  const platform = await ensurePlatform();
  const { invoke } = await import("@tauri-apps/api/core");

  const probe = (fileName: string) =>
    invoke<string | null>("get_model_path", { fileName }).catch(() => null);

  // Include both "tauri" (desktop) and "android" entries on their respective platforms.
  const llmEntries = MODEL_CATALOGUE.filter((e) =>
    e.kind === "llm" && (e.platform === platform || (platform === "desktop" && e.platform === "tauri"))
  );
  const embedEntries = MODEL_CATALOGUE.filter((e) => e.kind === "embed");

  let lmModelPath: string | undefined;
  for (const entry of llmEntries) {
    const path = await probe(modelFileName(entry));
    if (path) { lmModelPath = path; break; }
  }

  let embeddingModelPath: string | undefined;
  for (const entry of embedEntries) {
    const path = await probe(modelFileName(entry));
    if (path) { embeddingModelPath = path; break; }
  }

  return { lmModelPath, embeddingModelPath };
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
  hfToken?: string,
): Promise<string> {
  const entry = MODEL_CATALOGUE.find((m) => m.id === modelId);
  if (!entry) throw new Error(`Unknown model: ${modelId}`);

  // Cancel any existing download for this model.
  cancelDownload(modelId);

  if (isTauri()) {
    return downloadModelTauri(entry, onProgress, signal, hfToken);
  }

  // ── Web: Cache API path ───────────────────────────────────────────────────
  const controller = new AbortController();
  activeDownloads.set(modelId, controller);
  signal?.addEventListener("abort", () => controller.abort(), { once: true });

  const fetchHeaders: Record<string, string> = {};
  if (hfToken) fetchHeaders["Authorization"] = `Bearer ${hfToken}`;

  try {
    const response = await fetch(entry.url, { signal: controller.signal, headers: fetchHeaders });
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
  hfToken?: string,
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
      hfToken: hfToken || null,
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
