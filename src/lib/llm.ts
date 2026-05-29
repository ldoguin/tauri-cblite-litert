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
} from "tauri-plugin-litert-api";
import type { ModelConfig } from "./types";
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

// ── Backend types ──────────────────────────────────────────────────────────

export type LlmBackend = "tauri" | "mediapipe" | "api" | "mock";

export interface ApiConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

// ── State ──────────────────────────────────────────────────────────────────

let apiConfig: ApiConfig | null = null;
let activeLmModelId: string | null = null;
let webLlm: LlmInference | null = null;
let webLlmLoading = false;

export function setApiConfig(config: ApiConfig): void { apiConfig = config; }
export function getApiConfig(): ApiConfig | null { return apiConfig; }
export function setActiveLmModel(id: string | null): void { activeLmModelId = id; }
export function getActiveLmModel(): string | null { return activeLmModelId; }
export function getWebLlm(): LlmInference | null { return webLlm; }
export function isWebLlmLoading(): boolean { return webLlmLoading; }

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function getActiveBackend(): LlmBackend {
  if (isTauri() && activeLmModelId) return "tauri";
  if (webLlm) return "mediapipe";
  if (apiConfig) return "api";
  return "mock";
}

// ── Model lifecycle ────────────────────────────────────────────────────────

export async function loadModels(config: ModelConfig): Promise<void> {
  // Both loadModel and loadLmModel are Tauri IPC calls — skip on web.
  if (!isTauri()) return;
  if (config.embeddingModelPath) {
    await loadModel({
      modelId: EMBED_MODEL_ID,
      modelPath: config.embeddingModelPath,
      accelerator: config.accelerator,
    });
  }
  if (config.lmModelPath) {
    await loadLmModel({
      modelId: LM_MODEL_ID,
      modelPath: config.lmModelPath,
      accelerator: config.accelerator,
      maxTokens: config.maxTokens,
      vision: true, // enable vision backend for multimodal models (Gemma 4 E2B/E4B)
    });
    setActiveLmModel(LM_MODEL_ID);
  }
}

export async function unloadModels(): Promise<void> {
  try { await unloadModel(EMBED_MODEL_ID); } catch { /* not loaded */ }
  try { await unloadLmModel(LM_MODEL_ID); } catch { /* not loaded */ }
  setActiveLmModel(null);
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
      maxTokens: opts.maxTokens ?? 1024,
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
 * Run a single non-streaming LLM call and return the full text response.
 * Intended for internal tasks (e.g. routing decisions) that should not be
 * shown in the UI. Uses no tools, no RAG context, and no conversation history.
 */
export async function generateOnce(
  userText: string,
  systemInstruction: string,
  config: ModelConfig,
  signal?: AbortSignal,
): Promise<string> {
  let result = "";
  let rejected = false;
  await new Promise<void>((resolve, reject) => {
    generateStream(
      [{ role: "user", content: userText }],
      "",
      { systemInstruction, config, enabledTools: [], signal },
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
  return result;
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

    // Truncate history to fit within the model's token budget.
    // Reserve 25% of maxTokens for output; estimate 4 chars/token for input.
    const fittedMessages = truncateToFitTokens(messages, opts.config.maxTokens);

    const prompt = fittedMessages
      .filter((m) => m.role !== "system")
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n") + "\nAssistant:";

    const systemInstruction = fittedMessages.find((m) => m.role === "system")?.content;

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

/**
 * Drop oldest non-system messages until the flattened prompt fits within the
 * model's token budget (estimated at 4 chars/token, reserving 25% for output).
 * Always keeps at least the system message + the last user turn.
 */
function truncateToFitTokens(
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
): Array<{ role: string; content: string }> {
  const CHARS_PER_TOKEN = 4;
  const maxInputChars = Math.floor(maxTokens * 0.75) * CHARS_PER_TOKEN;

  const system = messages.filter((m) => m.role === "system");
  let history = messages.filter((m) => m.role !== "system");

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
