/**
 * tauri-plugin-litert – JavaScript/TypeScript API
 *
 * On Tauri targets (desktop / Android) every call is forwarded to the Rust
 * plugin via `invoke`.  On plain web targets the same API is backed by
 * `@litertjs/core` (https://ai.google.dev/edge/litert/web).
 */

import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Types (mirror src/models.rs)
// ---------------------------------------------------------------------------

export type Accelerator = "cpu" | "gpu" | "npu";

export interface LoadModelOptions {
  /** Filesystem path (desktop/Android) or URL (web) to the `.tflite` file. */
  modelPath: string;
  /** Stable identifier used in subsequent calls. */
  modelId: string;
  accelerator?: Accelerator;
}

export interface ModelInfo {
  modelId: string;
  modelPath: string;
  accelerator: Accelerator;
  inputCount: number;
  outputCount: number;
  inputShapes: number[][];
  outputShapes: number[][];
}

export interface InferenceInput {
  modelId: string;
  /** One flat Float32 array per input tensor, in order. */
  inputs: number[][];
}

export interface InferenceOutput {
  modelId: string;
  /** One flat Float32 array per output tensor, in order. */
  outputs: number[][];
  latencyMs: number;
}

export interface EmbeddingInput {
  modelId: string;
  input: number[];
}

export interface EmbeddingOutput {
  modelId: string;
  embedding: number[];
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// LiteRT-LM types (mirror src/lm_models.rs)
// ---------------------------------------------------------------------------

export interface LoadLmModelOptions {
  /** Filesystem path to the `.litertlm` model file. */
  modelPath: string;
  modelId: string;
  accelerator?: Accelerator;
  maxTokens?: number;
  cacheDir?: string;
}

export interface LmModelInfo {
  modelId: string;
  modelPath: string;
  accelerator: Accelerator;
}

export interface SamplerOptions {
  temperature?: number;
  topP?: number;
  topK?: number;
}

export interface GenerateInput {
  modelId: string;
  prompt: string;
  sampler?: SamplerOptions;
  systemInstruction?: string;
  /** Base64-encoded image to pass to multimodal models (optional). */
  image?: string;
}

export interface GenerateOutput {
  modelId: string;
  text: string;
  latencyMs: number;
}

/** Emitted as `litert-lm://chunk` Tauri events during `generateStream()`. */
export interface StreamChunk {
  modelId: string;
  chunk: string;
  done: boolean;
  latencyMs?: number;
  /** Set on the final chunk when generation failed. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Web backend configuration
// ---------------------------------------------------------------------------

/**
 * Path (URL) to the `@litertjs/core` Wasm files.
 * Defaults to the jsDelivr CDN. Use `setWasmPath()` to override before the
 * first `loadModel` call.
 */
export let wasmPath =
  "https://cdn.jsdelivr.net/npm/@litertjs/core/wasm/";

/**
 * Override the Wasm path used by the web backend.
 * Must be called before the first `loadModel` on web.
 * Resets the initialisation state so the new path is picked up immediately.
 *
 * @example
 * ```ts
 * import { setWasmPath } from "tauri-plugin-litert-api";
 * setWasmPath("/wasm/");
 * ```
 */
export function setWasmPath(path: string): void {
  wasmPath = path;
  liteRtInitialised = false;
}

// ---------------------------------------------------------------------------
// Web backend internals
// ---------------------------------------------------------------------------

type LiteRtJsModel = {
  run(input: unknown): Promise<unknown[]>;
  getInputDetails(): readonly unknown[];
  getOutputDetails(): readonly unknown[];
  delete(): void;
};

interface WebModelRecord {
  model: LiteRtJsModel;
  info: ModelInfo;
}

const webModels = new Map<string, WebModelRecord>();

let liteRtInitialised = false;

// Cache the dynamic import so the module is only fetched once.
let litertCorePromise: Promise<typeof import("@litertjs/core")> | null = null;

function getLiteRtCore(): Promise<typeof import("@litertjs/core")> {
  if (!litertCorePromise) {
    litertCorePromise = import("@litertjs/core");
  }
  return litertCorePromise;
}

async function webLoadModel(opts: LoadModelOptions): Promise<ModelInfo> {
  if (webModels.has(opts.modelId)) {
    throw new Error(`model already loaded: ${opts.modelId}`);
  }

  const { loadLiteRt, loadAndCompile } = await getLiteRtCore();

  // loadLiteRt must be called once before any model is compiled.
  // setWasmPath() resets liteRtInitialised so a new path is honoured.
  if (!liteRtInitialised) {
    await loadLiteRt(wasmPath);
    liteRtInitialised = true;
  }

  // Map Accelerator → @litertjs/core accelerator strings.
  // NPU has no web equivalent; warn and fall back to wasm.
  let accel: "webgpu" | "wasm";
  if (opts.accelerator === "gpu") {
    accel = "webgpu";
  } else {
    if (opts.accelerator === "npu") {
      console.warn(
        "[tauri-plugin-litert] NPU is not available on web; falling back to wasm (XNNPack CPU)."
      );
    }
    accel = "wasm";
  }

  const model = (await loadAndCompile(opts.modelPath, {
    accelerator: accel,
  })) as LiteRtJsModel;

  const inputDetails = model.getInputDetails() as Array<{ shape: number[] }>;
  const outputDetails = model.getOutputDetails() as Array<{ shape: number[] }>;

  const info: ModelInfo = {
    modelId: opts.modelId,
    modelPath: opts.modelPath,
    accelerator: opts.accelerator ?? "cpu",
    inputCount: inputDetails.length,
    outputCount: outputDetails.length,
    inputShapes: inputDetails.map((d) => d.shape),
    outputShapes: outputDetails.map((d) => d.shape),
  };

  webModels.set(opts.modelId, { model, info });
  return info;
}

async function webUnloadModel(modelId: string): Promise<void> {
  const record = webModels.get(modelId);
  if (!record) throw new Error(`model not found: ${modelId}`);
  record.model.delete();
  webModels.delete(modelId);
}

async function webListModels(): Promise<ModelInfo[]> {
  return Array.from(webModels.values()).map((r) => r.info);
}

async function webGetModelInfo(modelId: string): Promise<ModelInfo> {
  const record = webModels.get(modelId);
  if (!record) throw new Error(`model not found: ${modelId}`);
  return record.info;
}

async function webRunInference(input: InferenceInput): Promise<InferenceOutput> {
  const record = webModels.get(input.modelId);
  if (!record) throw new Error(`model not found: ${input.modelId}`);

  // Reuse the cached module — no repeated dynamic import per inference call.
  const { Tensor } = await getLiteRtCore();

  const info = record.info;
  // Input dtype is inferred from the model's input details when available.
  // BERT-family models use int32 token IDs; most other models use float32.
  const inputDetails = record.model.getInputDetails() as Array<{ shape: number[]; dtype?: string }>;
  const tensors = input.inputs.map((data, i) => {
    const shape = info.inputShapes[i] ?? [data.length];
    const dtype = inputDetails[i]?.dtype ?? "float32";
    const typedData = dtype === "int32"
      ? new Int32Array(data)
      : new Float32Array(data);
    return new Tensor(typedData, shape);
  });

  const t0 = performance.now();
  let rawOutputs: Array<{ data(): Promise<Float32Array>; delete(): void }>;
  try {
    rawOutputs = (await record.model.run(tensors)) as typeof rawOutputs;
  } finally {
    // Always release input tensors, even if run() throws.
    tensors.forEach((t: { delete(): void }) => t.delete());
  }
  const latencyMs = performance.now() - t0;

  const outputs: number[][] = await Promise.all(
    rawOutputs.map(async (t) => {
      try {
        const arr = await t.data();
        return Array.from(arr);
      } finally {
        // Always release output tensors, even if data() throws.
        t.delete();
      }
    })
  );

  return { modelId: input.modelId, outputs, latencyMs };
}

async function webCreateEmbedding(input: EmbeddingInput): Promise<EmbeddingOutput> {
  const result = await webRunInference({
    modelId: input.modelId,
    inputs: [input.input],
  });
  return {
    modelId: input.modelId,
    embedding: result.outputs[0] ?? [],
    latencyMs: result.latencyMs,
  };
}

// ---------------------------------------------------------------------------
// Runtime detection
// ---------------------------------------------------------------------------

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a `.tflite` model.
 *
 * - **Desktop / Android**: delegates to the Rust/Kotlin plugin via IPC.
 * - **Web**: uses `@litertjs/core` (WebAssembly + WebGPU).
 */
export async function loadModel(opts: LoadModelOptions): Promise<ModelInfo> {
  if (isTauri()) {
    return invoke<ModelInfo>("plugin:litert|load_model", { opts });
  }
  return webLoadModel(opts);
}

/** Release a loaded model and free its resources. */
export async function unloadModel(modelId: string): Promise<void> {
  if (isTauri()) {
    return invoke<void>("plugin:litert|unload_model", { modelId });
  }
  return webUnloadModel(modelId);
}

/** Return metadata for all currently loaded models. */
export async function listModels(): Promise<ModelInfo[]> {
  if (isTauri()) {
    return invoke<ModelInfo[]>("plugin:litert|list_models");
  }
  return webListModels();
}

/** Return metadata for a single loaded model. */
export async function getModelInfo(modelId: string): Promise<ModelInfo> {
  if (isTauri()) {
    return invoke<ModelInfo>("plugin:litert|get_model_info", { modelId });
  }
  return webGetModelInfo(modelId);
}

/**
 * Run a forward pass through the model.
 *
 * `inputs` must contain one flat `number[]` per input tensor, in the order
 * reported by `ModelInfo.inputShapes`.
 */
export async function runInference(input: InferenceInput): Promise<InferenceOutput> {
  if (isTauri()) {
    return invoke<InferenceOutput>("plugin:litert|run_inference", { input });
  }
  return webRunInference(input);
}

/**
 * Run the model and return the first output tensor as an embedding vector.
 *
 * Convenience wrapper for single-input / single-output embedding models.
 */
export async function createEmbedding(input: EmbeddingInput): Promise<EmbeddingOutput> {
  if (isTauri()) {
    return invoke<EmbeddingOutput>("plugin:litert|create_embedding", { input });
  }
  return webCreateEmbedding(input);
}

// ---------------------------------------------------------------------------
// LiteRT-LM public API (Tauri only — no web runtime for LLM generation)
// ---------------------------------------------------------------------------

/** Load a `.litertlm` LLM model (desktop / Android only). */
export async function loadLmModel(opts: LoadLmModelOptions): Promise<LmModelInfo> {
  return invoke<LmModelInfo>("plugin:litert|load_lm_model", { opts });
}

/** Release a loaded LLM model. */
export async function unloadLmModel(modelId: string): Promise<void> {
  return invoke<void>("plugin:litert|unload_lm_model", { modelId });
}

/** Return metadata for all loaded LLM models. */
export async function listLmModels(): Promise<LmModelInfo[]> {
  return invoke<LmModelInfo[]>("plugin:litert|list_lm_models");
}

/**
 * Run a blocking generation and return the full response text.
 * For streaming, use `generateStream()` and listen for `litert-lm://chunk` events.
 */
export async function generate(input: GenerateInput): Promise<GenerateOutput> {
  return invoke<GenerateOutput>("plugin:litert|generate", { input });
}

/**
 * Start a streaming generation.
 * Tokens are emitted as `litert-lm://chunk` Tauri events on the app handle.
 * The final event has `done: true` and `latencyMs` set.
 *
 * @example
 * ```ts
 * import { listen } from "@tauri-apps/api/core";
 * const unlisten = await listen<StreamChunk>("litert-lm://chunk", (e) => {
 *   if (e.payload.done) unlisten();
 *   else process.stdout.write(e.payload.chunk);
 * });
 * await generateStream({ modelId: "gemma", prompt: "Hello!" });
 * ```
 */
export async function generateStream(input: GenerateInput): Promise<void> {
  return invoke<void>("plugin:litert|generate_stream", { input });
}
