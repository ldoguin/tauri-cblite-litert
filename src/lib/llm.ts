/**
 * llm.ts — LLM generation with four backends, in priority order:
 *
 *   1. Tauri IPC (desktop/Android) — LiteRT-LM via tauri-plugin-litert
 *   2. MediaPipe LLM Inference     — on-device WebGPU/Wasm in the browser
 *   3. OpenAI-compatible API       — Groq, OpenRouter, Ollama, etc.
 *   4. Mock                        — word-by-word echo, always available
 *
 * generateViaTauri() uses a regular dynamic import for @tauri-apps/api/core;
 * Vite bundles it correctly since @tauri-apps/api is an npm dependency.
 */

import type { LlmInference } from "@mediapipe/tasks-genai";
import {
  loadLmModel,
  unloadLmModel,
  loadModel,
  unloadModel,
  queryAcceleratorSupport,
  type Accelerator,
} from "tauri-plugin-litert-api";
import type { ModelConfig } from "./types";
import {
  resolveModelCapabilities,
  type AppPlatform,
  type ScannedModelMeta,
} from "./modelCache";
import {
  buildToolSystemPrompt,
  executeToolCalls,
  hasToolCall,
  parseToolCalls,
  type Tool,
  type ToolExecution,
} from "./tools";

export const LM_MODEL_ID = "rag-lm";
export const EMBED_MODEL_ID = "rag-embed";

// ── Platform detection ─────────────────────────────────────────────────────

let _platform: AppPlatform | null = null;

/** Returns the current runtime platform, cached after first call. */
export async function getAppPlatform(): Promise<AppPlatform> {
  if (_platform) return _platform;
  if (!isTauri()) { _platform = "web"; return _platform; }
  try {
    const { platform } = await import("@tauri-apps/plugin-os");
    const p = await platform();
    if (p === "android") _platform = "android";
    else if (p === "windows") _platform = "windows";
    else _platform = "desktop";
  } catch {
    _platform = "desktop";
  }
  return _platform;
}

// ── Backend types ──────────────────────────────────────────────────────────

export type LlmBackend = "tauri" | "mediapipe" | "wasm" | "api" | "mock";

export interface ApiConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

// ── State ──────────────────────────────────────────────────────────────────

let apiConfig: ApiConfig | null = null;
let activeLmModelId: string | null = null;
let activeContextLength = 4096; // true context window of the loaded model
let webLlm: LlmInference | null = null;
let webLlmLoading = false;

export function setApiConfig(config: ApiConfig): void { apiConfig = config; }
export function getApiConfig(): ApiConfig | null { return apiConfig; }
export function setActiveLmModel(id: string | null): void { activeLmModelId = id; }
export function getActiveLmModel(): string | null { return activeLmModelId; }
export function setActiveContextLength(n: number): void { if (n > 0) activeContextLength = n; }
export function getActiveContextLength(): number { return activeContextLength; }
export function getWebLlm(): LlmInference | null { return webLlm; }
export function isWebLlmLoading(): boolean { return webLlmLoading; }

export { isTauri } from "./db";
import { isTauri } from "./db";
import { generateViaWasm, isWasmModelLoaded, loadWasmModel, unloadWasmModel } from "./llm-wasm";

/** -web.litertlm files use GPU_ARTISAN streaming; standard files use CPU+VFS. */
function isWebLitertlm(path: string): boolean {
  return path.includes("-web.litertlm") || path.endsWith("-web.task");
}

export function getActiveBackend(): LlmBackend {
  if (isTauri() && activeLmModelId) return "tauri";
  if (webLlm) return "mediapipe";
  if (isWasmModelLoaded()) return "wasm";
  if (apiConfig) return "api";
  return "mock";
}

// ── Model lifecycle ────────────────────────────────────────────────────────

// Serialise loadModels calls — concurrent Engine::new invocations corrupt the
// LiteRT-LM global accelerator registry causing create_conversation to return null.
let _loadModelsPromise: Promise<void> | null = null;

export async function loadModels(
  config: ModelConfig,
  scanned: ScannedModelMeta[] = [],
): Promise<void> {
  // Both loadModel and loadLmModel are Tauri IPC calls — skip on web.
  if (!isTauri()) return;
  if (_loadModelsPromise) { await _loadModelsPromise; return; }
  const run = async () => {
    const platform = await getAppPlatform();

    // On Windows, LiteRtLmC.dll is not available — use the WASM engine instead.
    if (platform === "windows" && config.lmModelPath) {
      try {
        const { convertFileSrc } = await import("@tauri-apps/api/core");
        const modelUrl = convertFileSrc(config.lmModelPath);
        const caps = resolveModelCapabilities(config.lmModelPath, platform, scanned);
        await loadWasmModel(modelUrl, caps.contextLength || 2048, undefined, isWebLitertlm(config.lmModelPath));
        setActiveLmModel(LM_MODEL_ID);
        setActiveContextLength(caps.contextLength || 4096);
      } catch (err) {
        console.error("[llm] WASM model load failed:", err);
      }
      // Embedding model still loads natively on Windows (litert-sys ships libLiteRt.dll)
      if (config.embeddingModelPath) {
        try {
          await loadModel({
            modelId: EMBED_MODEL_ID,
            modelPath: config.embeddingModelPath,
            accelerator: "cpu",
          });
        } catch (err) {
          console.warn("[llm] Embedding model load failed on Windows:", err);
        }
      }
      return;
    }

    if (config.lmModelPath) {
      const caps = resolveModelCapabilities(config.lmModelPath, platform, scanned);
      // Skip embedding model when LLM requires GPU — shared thread-pool may crash.
      const skipEmbedding = caps.requiredAccelerator === "gpu";
      if (config.embeddingModelPath && !skipEmbedding) {
        await loadModel({
          modelId: EMBED_MODEL_ID,
          modelPath: config.embeddingModelPath,
          accelerator: "cpu",
        });
      }

      let cacheDir: string | undefined;
      try {
        const { appLocalDataDir, join } = await import("@tauri-apps/api/path");
        cacheDir = await join(await appLocalDataDir(), "litert-shader-cache");
      } catch { /* non-Tauri build or path API unavailable */ }

      // Resolve the effective accelerator:
      // 1. Start from the model's required accelerator or the user's configured choice.
      // 2. On Android, auto-upgrade GPU → NPU when the device SoC is supported
      //    (Qualcomm Hexagon, MediaTek APU, or Google Tensor NPU).
      let accelerator: Accelerator =
        caps.requiredAccelerator !== "cpu" ? caps.requiredAccelerator : config.accelerator;
      if (platform === "android" && accelerator === "gpu") {
        try {
          const support = await queryAcceleratorSupport();
          if (support.accelerator === "npu") {
            accelerator = "npu";
            console.log(`[llm] NPU available (${support.vendor}) — upgrading from GPU`);
          }
        } catch { /* leave accelerator as-is on any error */ }
      }

      await loadLmModel({
        modelId: LM_MODEL_ID,
        modelPath: config.lmModelPath,
        accelerator,
        // contextLength 0 means "unknown" — omit so the library uses its compiled-in default.
        maxTokens: caps.contextLength || undefined,
        vision: caps.supportsVision,
        cacheDir,
      });
      setActiveLmModel(LM_MODEL_ID);
      setActiveContextLength(caps.contextLength || 4096);
    } else if (config.embeddingModelPath) {
      await loadModel({
        modelId: EMBED_MODEL_ID,
        modelPath: config.embeddingModelPath,
        accelerator: "cpu",
      });
    }
  };
  _loadModelsPromise = run();
  try { await _loadModelsPromise; }
  finally { _loadModelsPromise = null; }
}

export async function unloadModels(): Promise<void> {
  try { await unloadModel(EMBED_MODEL_ID); } catch { /* not loaded */ }
  // On Windows the LM runs via WASM — skip the native unloadLmModel IPC call
  // which would fail with "model not found" since it was never loaded natively.
  const platform = await getAppPlatform();
  if (platform !== "windows") {
    try { await unloadLmModel(LM_MODEL_ID); } catch { /* not loaded */ }
  }
  unloadWasmModel();
  setActiveLmModel(null);
}

/** Load a .litertlm model from a local absolute path (Tauri desktop only). */
export async function loadLmFromPath(
  modelPath: string,
  opts?: { accelerator?: Accelerator; scanned?: ScannedModelMeta[] },
): Promise<void> {
  if (!isTauri()) throw new Error("loadLmFromPath requires Tauri");
  const platform = await getAppPlatform();
  const caps = resolveModelCapabilities(modelPath, platform, opts?.scanned ?? []);

  // On Windows, LiteRtLmC.dll is not available — use the WASM engine instead.
  if (platform === "windows") {
    if (!isWebLitertlm(modelPath)) {
      console.warn(
        "[llm] Windows WASM engine requires a -web.litertlm file. " +
        "Standard .litertlm files (kTfLitePrefillDecode) use CPU+VFS which " +
        "may OOM on large models. Use a -web.litertlm variant for best results.",
      );
    }
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    const modelUrl = convertFileSrc(modelPath);
    await loadWasmModel(modelUrl, caps.contextLength || 2048, undefined, isWebLitertlm(modelPath));
    setActiveLmModel(LM_MODEL_ID);
    setActiveContextLength(caps.contextLength || 4096);
    return;
  }

  let cacheDir: string | undefined;
  try {
    const { appLocalDataDir, join } = await import("@tauri-apps/api/path");
    cacheDir = await join(await appLocalDataDir(), "litert-shader-cache");
  } catch { /* non-Tauri build */ }

  let accelerator: Accelerator =
    caps.requiredAccelerator !== "cpu" ? caps.requiredAccelerator : (opts?.accelerator ?? "cpu");
  if (platform === "android" && accelerator === "gpu") {
    try {
      const support = await queryAcceleratorSupport();
      if (support.accelerator === "npu") accelerator = "npu";
    } catch { /* leave as-is */ }
  }

  await loadLmModel({
    modelId: LM_MODEL_ID,
    modelPath,
    accelerator,
    maxTokens: caps.contextLength || undefined,
    vision: caps.supportsVision,
    cacheDir,
  });
  setActiveLmModel(LM_MODEL_ID);
  setActiveContextLength(caps.contextLength || 4096);
}

/**
 * Load a .litertlm model from a URL into the WASM engine.
 * Works on web and Tauri (no native plugin required).
 * Pass onProgress to show a loading bar (0–100).
 */
export async function loadWasmFromUrl(
  modelUrl: string,
  maxTokens = 4096,
  onProgress?: (pct: number) => void,
): Promise<void> {
  await loadWasmModel(modelUrl, maxTokens, onProgress, isWebLitertlm(modelUrl));
  setActiveLmModel(LM_MODEL_ID);
  setActiveContextLength(maxTokens);
}

/** Scan a folder for .litertlm files. Returns [{name, path}] sorted by name. */
export async function scanModels(folder: string): Promise<Array<{ name: string; path: string }>> {
  if (!isTauri() || !folder) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<Array<{ name: string; path: string }>>("scan_models", { folder });
}

// ── MediaPipe web LLM ──────────────────────────────────────────────────────

export interface WebLlmOptions {
  /** URL to a .litertlm or .task model file */
  modelUrl: string;
  maxTokens?: number;
  topK?: number;
  temperature?: number;
  wasmPath?: string;
}

/**
 * Load a .litertlm / .task model for in-browser inference via
 * @mediapipe/tasks-genai (WebGPU with CPU/Wasm fallback).
 *
 * Recommended: Gemma3-1B-IT web variant (~700 MB, ~133 tok/s on WebGPU)
 * https://huggingface.co/litert-community/Gemma3-1B-IT/resolve/main/gemma3-1b-it-int4-web.task
 */
export async function loadWebLlm(opts: WebLlmOptions): Promise<void> {
  if (webLlmLoading) throw new Error("Already loading a web LLM model");
  webLlmLoading = true;
  try {
    const { FilesetResolver, LlmInference } = await import("@mediapipe/tasks-genai");
    const wasmPath = opts.wasmPath ?? "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai/wasm";
    const genai = await FilesetResolver.forGenAiTasks(wasmPath);

    // requestAdapter() returns null when no adapter found, undefined when
    // navigator.gpu is absent (optional chain short-circuits). Both mean no GPU.
    const gpuAvailable =
      typeof navigator !== "undefined" &&
      "gpu" in navigator &&
      !!(await (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu?.requestAdapter());

    webLlm = await LlmInference.createFromOptions(genai, {
      baseOptions: {
        modelAssetPath: opts.modelUrl,
        delegate: gpuAvailable ? "GPU" : "CPU",
      },
      maxTokens: opts.maxTokens ?? 4096,
      topK: opts.topK ?? 40,
      temperature: opts.temperature ?? 0.8,
    });
  } finally {
    webLlmLoading = false;
  }
}

export function unloadWebLlm(): void {
  webLlm?.close();
  webLlm = null;
}

// ── Streaming generation ───────────────────────────────────────────────────

export interface StreamCallbacks {
  onChunk: (text: string) => void;
  /** May be async — callers must await the return value to ensure DB writes complete. */
  onDone: (latencyMs: number) => Promise<void> | void;
  onError: (err: string) => void;
  /** Called when a tool call is detected and being executed */
  onToolCall?: (toolId: string, args: Record<string, unknown>) => void;
  /** Called when a tool execution completes */
  onToolResult?: (execution: ToolExecution) => void;
}

export interface GenerateOptions {
  modelId?: string;
  systemInstruction?: string;
  config: ModelConfig;
  /** Tools to make available for this generation */
  enabledTools?: Tool[];
  /** Abort signal — resolve the stream early when aborted */
  signal?: AbortSignal;
  /**
   * Base64 data URL of an image attached to the latest user message.
   * Passed to vision-capable backends (Tauri LiteRT, MediaPipe Gemma 4).
   * For text-only backends the image is described in the prompt instead.
   */
  imageDataUrl?: string;
}

const MAX_REACT_ITERATIONS = 5;

/**
 * Remove <think>…</think> reasoning blocks emitted by models like DeepSeek-R1
 * and Qwen3. Both complete blocks and unclosed trailing blocks are stripped.
 */
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*/gi, "")
    .trimStart();
}

/**
 * Run a single non-streaming LLM call and return the full text response.
 * Intended for internal tasks (e.g. routing decisions) that should not be
 * shown in the UI. Uses no tools, no RAG context, and no conversation history.
 */
export async function generateOnce(
  userText: string,
  systemInstruction: string,
  config: ModelConfig,
  signal?: AbortSignal,
  imageDataUrl?: string,
): Promise<string> {
  let result = "";
  let rejected = false;
  await new Promise<void>((resolve, reject) => {
    generateStream(
      [{ role: "user", content: userText }],
      "",
      { systemInstruction, config, enabledTools: [], signal, imageDataUrl },
      {
        onChunk: (c) => { result += c; },
        onDone: () => resolve(),
        onToolCall: () => {},
        onToolResult: () => {},
        onError: (e) => {
          if (!rejected) { rejected = true; reject(new Error(e)); }
        },
      },
    ).catch((e) => { if (!rejected) { rejected = true; reject(e); } });
  });
  return stripThinking(result);
}

/**
 * Stream a response from the active LLM backend.
 * `history` is the full conversation so far (user + assistant turns).
 * `ragContext` is injected as a system message when non-empty.
 *
 * When `enabledTools` is non-empty, runs a ReAct loop:
 *   generate → parse tool calls → execute → inject results → generate again
 * up to MAX_REACT_ITERATIONS times.
 */
export async function generateStream(
  history: Array<{ role: string; content: string }>,
  ragContext: string,
  opts: GenerateOptions,
  callbacks: StreamCallbacks,
): Promise<void> {
  const backend = getActiveBackend();
  const enabledTools = opts.enabledTools ?? [];
  const toolSystemPrompt = buildToolSystemPrompt(enabledTools);

  // Merge RAG context + tool instructions into the system block
  const combinedSystem = [opts.systemInstruction, toolSystemPrompt, ragContext]
    .filter(Boolean).join("\n\n");

  const messages = buildMessages(history, combinedSystem);

  const signal = opts.signal;

  if (enabledTools.length === 0) {
    // No tools — plain streaming
    return dispatchGenerate(backend, messages, opts, callbacks);
  }

  // ReAct loop
  const t0 = performance.now();
  let llmMs = 0; // cumulative LLM inference time only (excludes tool execution)
  let loopMessages = [...messages];
  let loopError: string | null = null;
  let accumulated = ""; // raw LLM output including tool-call XML
  let visibleAccumulated = ""; // text actually forwarded to the UI (tool XML stripped)
  // Track the last tool call signature to detect and break infinite identical-call loops.
  let lastToolCallSignature = "";

  for (let i = 0; i < MAX_REACT_ITERATIONS; i++) {
    if (signal?.aborted) break;
    accumulated = "";
    visibleAccumulated = "";

    // Suppress <tool_call>…</tool_call> blocks from the UI stream.
    // We scan a sliding window of (pending + chunk) so tags split across
    // chunk boundaries are handled correctly.
    let inToolCall = false;
    let toolCallPending = ""; // partial tag accumulator
    const iterStart = performance.now();
    const iterError = await new Promise<string | null>((resolve) => {
      // Only attach the image on the first iteration. On subsequent iterations
      // the last user message is a <tool_result> block, not the original
      // question, so injecting the image there would be incorrect.
      const iterOpts = i === 0
        ? { ...opts, systemInstruction: undefined }
        : { ...opts, systemInstruction: undefined, imageDataUrl: undefined };
      dispatchGenerate(
        backend,
        loopMessages,
        iterOpts,
        {
          onChunk: (chunk) => {
            accumulated += chunk;
            // Process the chunk character-by-character via a small buffer so
            // tags split across network chunks are handled correctly.
            toolCallPending += chunk;
            let visible = "";
            while (toolCallPending.length > 0) {
              if (!inToolCall) {
                const start = toolCallPending.indexOf("<tool_call>");
                if (start === -1) {
                  // No tag — everything is visible, but keep a suffix in case
                  // a tag starts at the very end of this chunk.
                  const safe = toolCallPending.length > 11
                    ? toolCallPending.length - 11
                    : 0;
                  visible += toolCallPending.slice(0, safe);
                  toolCallPending = toolCallPending.slice(safe);
                  break;
                }
                // Emit text before the tag, then enter suppression mode
                visible += toolCallPending.slice(0, start);
                toolCallPending = toolCallPending.slice(start + "<tool_call>".length);
                inToolCall = true;
              } else {
                const end = toolCallPending.indexOf("</tool_call>");
                if (end === -1) {
                  toolCallPending = ""; // still inside tag — discard
                  break;
                }
                toolCallPending = toolCallPending.slice(end + "</tool_call>".length);
                inToolCall = false;
              }
            }
            if (visible) {
              visibleAccumulated += visible;
              callbacks.onChunk(visible);
            }
          },
          onDone: async () => {
            // Flush any remaining buffered text that wasn't emitted because it
            // was held back waiting for a potential <tool_call> tag start.
            // If we're still inside a tag when the stream ends, discard it.
            if (!inToolCall && toolCallPending) {
              visibleAccumulated += toolCallPending;
              callbacks.onChunk(toolCallPending);
              toolCallPending = "";
            }
            resolve(null);
          },
          onError: (e) => resolve(e),
          onToolCall: callbacks.onToolCall,
          onToolResult: callbacks.onToolResult,
        },
      ).catch((e: unknown) => resolve(String(e)));
    });

    llmMs += performance.now() - iterStart;

    if (iterError) { loopError = iterError; break; }
    if (signal?.aborted) break;

    if (!hasToolCall(accumulated)) break; // final answer — chunks already forwarded

    // Deduplicate: if the model emits the exact same tool calls as the previous
    // iteration, it is stuck in a loop — break rather than executing again.
    const callSignature = JSON.stringify(parseToolCalls(accumulated));
    if (callSignature === lastToolCallSignature) {
      callbacks.onChunk("\n\n*(Stopped: repeated identical tool call detected.)*");
      break;
    }
    lastToolCallSignature = callSignature;

    const { executions, contextBlock } = await executeToolCalls(accumulated, enabledTools, signal);
    for (const ex of executions) {
      callbacks.onToolCall?.(ex.call.tool, ex.call.args);
      callbacks.onToolResult?.(ex);
    }

    loopMessages = [
      ...loopMessages,
      { role: "assistant", content: accumulated },
      { role: "user", content: contextBlock },
    ];
  }

  if (loopError) { callbacks.onError(loopError); return; }

  // If the loop exhausted MAX_REACT_ITERATIONS without forwarding any visible
  // text (all output was tool-call XML), emit a fallback so the user isn't
  // left with an empty bubble. Check visibleAccumulated, not accumulated,
  // because accumulated always contains the raw tool-call XML.
  if (!signal?.aborted && visibleAccumulated.trim() === "") {
    callbacks.onChunk("(No response generated after maximum tool iterations.)");
  }

  // Always call onDone so sendMessage can clear sendingRef and reset status.
  // Pass LLM-only time (excludes tool execution) so the latency badge reflects
  // inference speed rather than network round-trips to external tools.
  // Fall back to wall-clock time if llmMs was never accumulated (e.g. aborted
  // before the first iteration completed).
  await callbacks.onDone(llmMs > 0 ? llmMs : performance.now() - t0);
}

function dispatchGenerate(
  backend: LlmBackend,
  messages: Array<{ role: string; content: string }>,
  opts: GenerateOptions,
  callbacks: StreamCallbacks,
): Promise<void> {
  if (backend === "tauri") return generateViaTauri(messages, opts, callbacks);
  if (backend === "mediapipe") return generateViaMediaPipe(messages, opts, callbacks);
  if (backend === "wasm") return generateViaWasm(messages, opts, callbacks);
  if (backend === "api") return generateViaApi(messages, opts, callbacks);
  return generateMock(messages, opts, callbacks);
}

// ── Tauri IPC backend ──────────────────────────────────────────────────────

async function generateViaTauri(
  messages: Array<{ role: string; content: string }>,
  opts: GenerateOptions,
  callbacks: StreamCallbacks,
): Promise<void> {
  // Bail immediately if the signal was already aborted before we started.
  if (opts.signal?.aborted) { await callbacks.onDone(0); return; }

  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");

  type ChunkPayload = { chunk: string; done: boolean; latencyMs?: number; error?: string };
  const unlistenHolder: { fn: (() => void) | null } = { fn: null };

  // settled prevents onDone/onError firing twice if abort races with the event
  let settled = false;
  const settle = async (latencyMs: number, error?: string) => {
    if (settled) return;
    settled = true;
    opts.signal?.removeEventListener("abort", onAbort);
    unlistenHolder.fn?.();
    unlistenHolder.fn = null;
    if (error) callbacks.onError(error);
    else await callbacks.onDone(latencyMs);
  };

  const onAbort = async () => { await settle(0); };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const unlisten = await (listen as (
      event: string,
      handler: (e: { payload: ChunkPayload }) => void,
    ) => Promise<() => void>)(
      "litert-lm://chunk",
      async (event) => {
        if (opts.signal?.aborted) return;
        const { chunk, done, latencyMs, error } = event.payload;
        if (done || error) { await settle(latencyMs ?? 0, error); return; }
        callbacks.onChunk(chunk);
      },
    );
    unlistenHolder.fn = unlisten;

    // If abort fired while listen() was awaiting, settled is already true and
    // unlistenHolder.fn was null when onAbort ran — call unlisten directly now.
    if (settled) {
      unlisten();
      unlistenHolder.fn = null;
      return;
    }

    // Truncate history to fit within the model's context window.
    // Use the known context length of the loaded model; fall back to 4096.
    const fittedMessages = truncateToFitTokens(messages, activeContextLength);

    const systemContent = fittedMessages.find((m) => m.role === "system")?.content;

    const conversationText = fittedMessages
      .filter((m) => m.role !== "system")
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n") + "\nAssistant:";

    // Embed the system instruction (which includes RAG context) directly in the
    // prompt so the model definitely sees it. The LiteRT-LM conversation API's
    // system_message_json parameter requires an undocumented JSON format that
    // doesn't reliably reach the model, so we prepend it as plain text instead.
    const prompt = systemContent
      ? `${systemContent}\n\n${conversationText}`
      : conversationText;

    const systemInstruction = undefined;

    // Extract raw base64 bytes from the data URL for the plugin's image input
    const imageBase64 = opts.imageDataUrl
      ? opts.imageDataUrl.replace(/^data:[^;]+;base64,/, "")
      : undefined;

    await (invoke as (cmd: string, args: unknown) => Promise<void>)(
      "plugin:litert|generate_stream",
      {
        input: {
          modelId: opts.modelId ?? activeLmModelId,
          prompt,
          systemInstruction,
          // image is passed as base64 string; the Rust plugin handles decoding.
          // Falls back gracefully if the loaded model is text-only.
          ...(imageBase64 ? { image: imageBase64 } : {}),
          sampler: {
            temperature: opts.config.temperature,
            topP: opts.config.topP,
            topK: opts.config.topK,
            maxOutputTokens: opts.config.maxTokens,
          },
        },
      },
    );
  } catch (e) {
    // Route through settle() so the settled guard prevents double-fire if
    // the abort listener already fired before listen()/invoke() threw.
    await settle(0, String(e));
  }
}

// ── MediaPipe backend ──────────────────────────────────────────────────────

async function generateViaMediaPipe(
  messages: Array<{ role: string; content: string }>,
  opts: GenerateOptions,
  callbacks: StreamCallbacks,
): Promise<void> {
  if (!webLlm) { callbacks.onError("No web LLM loaded"); return; }

  const prompt = messages
    .map((m) => {
      if (m.role === "system") return `<start_of_turn>system\n${m.content}<end_of_turn>`;
      if (m.role === "user") return `<start_of_turn>user\n${m.content}<end_of_turn>`;
      return `<start_of_turn>model\n${m.content}<end_of_turn>`;
    })
    .join("\n") + "\n<start_of_turn>model\n";

  const t0 = performance.now();
  // settled prevents onDone firing twice if abort races with the done callback
  let settled = false;
  const settle = async (latencyMs: number) => {
    if (settled) return;
    settled = true;
    await callbacks.onDone(latencyMs);
  };

  // cancelProcessing() stops token decoding. We must still call onDone so the
  // app transitions out of "generating" — that's the bug this fixes.
  const onAbort = async () => {
    webLlm?.cancelProcessing();
    await settle(performance.now() - t0);
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  // If already aborted before we registered the listener, clean up and settle.
  if (opts.signal?.aborted) {
    opts.signal.removeEventListener("abort", onAbort);
    await settle(0);
    return;
  }

  try {
    let promptInput: string | { text: string; images?: ImageData[] } = prompt;

    if (opts.imageDataUrl) {
      try {
        const imageData = await dataUrlToImageData(opts.imageDataUrl);
        promptInput = { text: prompt, images: [imageData] };
      } catch {
        promptInput = prompt + "\n[Note: an image was attached but could not be decoded]";
      }
    }

    await webLlm.generateResponse(
      promptInput as string,
      async (partialResult: string, done: boolean) => {
        if (opts.signal?.aborted) return;
        // Emit the final partial token before settling — MediaPipe passes the
        // last token with done=true and it must not be silently discarded.
        if (partialResult) callbacks.onChunk(partialResult);
        if (done) await settle(performance.now() - t0);
      },
    );
    // Ensure onDone fires even if generateResponse resolves without done=true
    await settle(performance.now() - t0);
  } catch (e) {
    // generateResponse threw — route through onError but ensure we don't
    // leave the app stuck in 'generating' if settle already fired.
    if (!settled) callbacks.onError(String(e));
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** Decode a base64 data URL into an ImageData object via OffscreenCanvas. */
async function dataUrlToImageData(dataUrl: string): Promise<ImageData> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    // Release GPU texture memory — ImageBitmap holds a decoded GPU resource
    // and must be explicitly closed when no longer needed.
    bitmap.close();
  }
}

// ── OpenAI-compatible API backend ──────────────────────────────────────────

async function generateViaApi(
  messages: Array<{ role: string; content: string }>,
  opts: GenerateOptions,
  callbacks: StreamCallbacks,
): Promise<void> {
  if (!apiConfig) { callbacks.onError("No API config set"); return; }

  const t0 = performance.now();
  let settled = false;
  const settle = async (latencyMs: number) => {
    if (settled) return;
    settled = true;
    await callbacks.onDone(latencyMs);
  };

  try {
    const response = await fetch(`${apiConfig.baseUrl}/chat/completions`, {
      method: "POST",
      signal: opts.signal,
      headers: {
        "Content-Type": "application/json",
        ...(apiConfig.apiKey ? { Authorization: `Bearer ${apiConfig.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: apiConfig.model,
        // Inject image as OpenAI vision content block on the last user message.
        // Scan backwards to find it — don't assume it's the final element,
        // since a system message or tool-result block may follow.
        messages: opts.imageDataUrl
          ? (() => {
              const lastUserIdx = [...messages].map((m) => m.role).lastIndexOf("user");
              return messages.map((m, i) =>
                i === lastUserIdx
                  ? {
                      ...m,
                      content: [
                        { type: "text", text: m.content },
                        { type: "image_url", image_url: { url: opts.imageDataUrl } },
                      ],
                    }
                  : m,
              );
            })()
          : messages,
        stream: true,
        temperature: opts.config.temperature,
        top_p: opts.config.topP,
      }),
    });

    if (!response.ok) {
      callbacks.onError(`API error ${response.status}: ${await response.text()}`);
      return;
    }

    if (!response.body) {
      callbacks.onError("API returned no response body");
      return;
    }

    const reader = response.body.getReader();
    // stream:true preserves multi-byte UTF-8 sequences split across network chunks
    const decoder = new TextDecoder("utf-8", { fatal: false });
    // Buffer incomplete lines across chunk boundaries
    let lineBuffer = "";

    while (true) {
      if (opts.signal?.aborted) { reader.cancel(); break; }
      const { done, value } = await reader.read();
      if (done) break;
      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split("\n");
      // Keep the last (potentially incomplete) line in the buffer
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") { await settle(performance.now() - t0); return; }
        try {
          const chunk = JSON.parse(data).choices?.[0]?.delta?.content;
          if (chunk) callbacks.onChunk(chunk);
        } catch { /* ignore malformed SSE */ }
      }
    }
    // Flush any remaining bytes in the decoder
    const tail = decoder.decode();
    if (tail) {
      for (const line of (lineBuffer + tail).split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") break;
        try {
          const chunk = JSON.parse(data).choices?.[0]?.delta?.content;
          if (chunk) callbacks.onChunk(chunk);
        } catch { /* ignore */ }
      }
    }
    await settle(performance.now() - t0);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      // User stopped — settle normally so accumulated content is saved
      await settle(performance.now() - t0);
    } else {
      // Network/parse error mid-stream — surface the error first so the UI
      // removes the placeholder bubble, then skip onDone to avoid saving
      // partial content to the DB.
      if (!settled) {
        settled = true;
        callbacks.onError(String(e));
      }
    }
  }
}

// ── Mock backend ───────────────────────────────────────────────────────────

async function generateMock(
  messages: Array<{ role: string; content: string }>,
  opts: GenerateOptions,
  callbacks: StreamCallbacks,
): Promise<void> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const hasRag = messages.some((m) => m.role === "system" && m.content.includes("context"));

  const reply =
    (hasRag ? "*(RAG context injected)*\n\n" : "") +
    `You said: "${lastUser?.content ?? ""}"\n\n` +
    `Configure an LLM to get real responses:\n` +
    `• **On-device (desktop/Android)**: set a .litertlm path in Settings\n` +
    `• **On-device (web)**: click "Load LLM" and enter a .task model URL\n` +
    `  e.g. https://huggingface.co/litert-community/Gemma3-1B-IT/resolve/main/gemma3-1b-it-int4-web.task\n` +
    `• **API**: click "API config" and enter a Groq / OpenRouter / Ollama endpoint`;

  const t0 = performance.now();
  for (const word of reply.split(" ")) {
    if (opts.signal?.aborted) break;
    await new Promise((r) => setTimeout(r, 25 + Math.random() * 35));
    callbacks.onChunk(word + " ");
  }
  await callbacks.onDone(performance.now() - t0);
}

// ── Helpers ────────────────────────────────────────────────────────────────

// Maximum chars for a single tool result injected into the prompt.
// Prevents one large fetch_url or knowledge_search result from filling the context.
const MAX_TOOL_RESULT_CHARS = 4000;

/**
 * Drop oldest non-system messages until the flattened prompt fits within the
 * model's context window (estimated at 3 chars/token — conservative for BPE
 * tokenisers on English text — reserving 30% for output tokens).
 * Always keeps at least the system message + the last user turn.
 */
function truncateToFitTokens(
  messages: Array<{ role: string; content: string }>,
  contextWindow: number,
): Array<{ role: string; content: string }> {
  const CHARS_PER_TOKEN = 3; // conservative: BPE English averages ~3 chars/token
  const maxInputTokens = Math.floor(contextWindow * 0.70);
  const maxInputChars = maxInputTokens * CHARS_PER_TOKEN;

  const system = messages.filter((m) => m.role === "system");
  let history = messages.filter((m) => m.role !== "system");

  // Cap any individual tool-result block to prevent one response from filling the window.
  history = history.map((m) => {
    if (m.role === "user" && m.content.startsWith("<tool_results>") && m.content.length > MAX_TOOL_RESULT_CHARS) {
      return { ...m, content: m.content.slice(0, MAX_TOOL_RESULT_CHARS) + "\n…[truncated]</tool_results>" };
    }
    return m;
  });

  const promptLen = (msgs: Array<{ role: string; content: string }>) =>
    msgs.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n").length +
    "\nAssistant:".length;

  // Drop from the front (oldest turns) until it fits, keeping at least the last message.
  while (history.length > 1 && promptLen(history) + (system[0]?.content.length ?? 0) > maxInputChars) {
    history = history.slice(1);
  }

  return [...system, ...history];
}

function buildMessages(
  history: Array<{ role: string; content: string }>,
  systemContent?: string,
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  if (systemContent) messages.push({ role: "system", content: systemContent });
  messages.push(...history);
  return messages;
}

// ── Predefined model presets ───────────────────────────────────────────────

export interface ModelPreset {
  id: string;
  label: string;
  description: string;
  llmUrl?: string;       // .task for MediaPipe web LLM
  embedUrl?: string;     // .tflite for LiteRT embedding
  lmModelPath?: string;  // local path for Tauri desktop/Android
  embeddingModelPath?: string;
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "gemma4-bert",
    label: "Gemma 4 2B + BERT",
    description: "Gemma 4 E2B (web, ~1.5 GB) + MediaPipe BERT embedder (~25 MB)",
    llmUrl: "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.task",
    embedUrl: "https://storage.googleapis.com/mediapipe-models/text_embedder/bert_embedder/float32/1/bert_embedder.tflite",
  },
  {
    id: "bert-only",
    label: "BERT embedder only",
    description: "MediaPipe BERT embedder (~25 MB) — use with API config for LLM",
    embedUrl: "https://storage.googleapis.com/mediapipe-models/text_embedder/bert_embedder/float32/1/bert_embedder.tflite",
  },
];

// ── Web API config persistence ─────────────────────────────────────────────
//
// API keys are stored in localStorage on web (no OS keychain available in a
// browser context). On Tauri desktop builds, consider migrating to
// tauri-plugin-stronghold for OS-level key storage.
//
// Keys are never logged — use getApiConfig() only for constructing headers.

const WEB_API_KEY_STORAGE = "rag-chatbot:web-api-key";
const WEB_API_URL_STORAGE = "rag-chatbot:web-api-url";
const WEB_API_MODEL_STORAGE = "rag-chatbot:web-api-model";

export function loadPersistedApiConfig(): void {
  const baseUrl = localStorage.getItem(WEB_API_URL_STORAGE);
  const apiKey = localStorage.getItem(WEB_API_KEY_STORAGE) ?? undefined;
  const model = localStorage.getItem(WEB_API_MODEL_STORAGE) ?? "llama-3.1-8b-instant";
  if (baseUrl) setApiConfig({ baseUrl, apiKey, model });
}

export function persistApiConfig(config: ApiConfig): void {
  try {
    localStorage.setItem(WEB_API_URL_STORAGE, config.baseUrl);
    // Explicitly remove keys when cleared so stale values aren't reloaded on next start
    if (config.apiKey) localStorage.setItem(WEB_API_KEY_STORAGE, config.apiKey);
    else localStorage.removeItem(WEB_API_KEY_STORAGE);
    if (config.model) localStorage.setItem(WEB_API_MODEL_STORAGE, config.model);
    else localStorage.removeItem(WEB_API_MODEL_STORAGE);
  } catch (e) {
    // QuotaExceededError — storage full; config is still applied in-memory
    if (e instanceof DOMException && (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED")) {
      console.warn("[llm] localStorage quota exceeded — API config saved in memory only");
    } else {
      throw e;
    }
  }
  setApiConfig(config);
}

/** Returns a redacted version of the API key for display (e.g. "sk-...abc1"). */
export function redactApiKey(key: string | undefined): string {
  if (!key || key.length < 8) return key ? "••••••••" : "";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

// ── Local LLM discovery ────────────────────────────────────────────────────

export interface LocalLlmServer {
  name: string;
  baseUrl: string;
  models: string[];
}

// Well-known local LLM servers, each with its own model-list endpoint.
// All expose (or will expose) an OpenAI-compatible /v1/chat/completions.
const LOCAL_PROVIDERS: Array<{
  name: string;
  baseUrl: string;
  modelsUrl: string;
  parseModels: (data: unknown) => string[];
}> = [
  {
    name: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    // Ollama's own /api/tags returns { models: [{ name, ... }] }
    modelsUrl: "http://localhost:11434/api/tags",
    parseModels: (d) => ((d as { models?: { name: string }[] }).models ?? []).map((m) => m.name),
  },
  {
    name: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    modelsUrl: "http://localhost:1234/v1/models",
    parseModels: (d) => ((d as { data?: { id: string }[] }).data ?? []).map((m) => m.id),
  },
  {
    name: "llama.cpp",
    baseUrl: "http://127.0.0.1:8080/v1",
    modelsUrl: "http://127.0.0.1:8080/v1/models",
    parseModels: (d) => ((d as { data?: { id: string }[] }).data ?? []).map((m) => m.id),
  },
  {
    name: "Jan",
    baseUrl: "http://localhost:1337/v1",
    modelsUrl: "http://localhost:1337/v1/models",
    parseModels: (d) => ((d as { data?: { id: string }[] }).data ?? []).map((m) => m.id),
  },
];

/**
 * Probe well-known local ports for running LLM servers and return those that
 * respond with at least one available model. Times out each probe after 2 s.
 */
export async function fetchLocalLlms(): Promise<LocalLlmServer[]> {
  const results: LocalLlmServer[] = [];
  await Promise.all(
    LOCAL_PROVIDERS.map(async (p) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        const res = await fetch(p.modelsUrl, { signal: controller.signal });
        if (!res.ok) return;
        const data: unknown = await res.json();
        const models = p.parseModels(data);
        if (models.length > 0) {
          results.push({ name: p.name, baseUrl: p.baseUrl, models });
        }
      } catch {
        // server not running or CORS block — skip
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return results;
}
