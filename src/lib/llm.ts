/**
 * llm.ts — LLM generation with four backends, in priority order:
 *
 *   1. Tauri IPC (desktop/Android) — LiteRT-LM via tauri-plugin-litert
 *   2. MediaPipe LLM Inference     — on-device WebGPU/Wasm in the browser
 *   3. OpenAI-compatible API       — Groq, OpenRouter, Ollama, etc.
 *   4. Mock                        — word-by-word echo, always available
 *
 * The Function() trick in generateViaTauri() escapes Vite's static import
 * analysis so @tauri-apps/api is never bundled into the web build.
 */

import type { LlmInference } from "@mediapipe/tasks-genai";
import {
  loadLmModel,
  unloadLmModel,
  loadModel,
  unloadModel,
} from "tauri-plugin-litert-api";
import type { ModelConfig } from "./types";

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
  if (config.embeddingModelPath) {
    await loadModel({
      modelId: EMBED_MODEL_ID,
      modelPath: config.embeddingModelPath,
      accelerator: config.accelerator,
    });
  }
  if (config.lmModelPath && isTauri()) {
    await loadLmModel({
      modelId: LM_MODEL_ID,
      modelPath: config.lmModelPath,
      accelerator: config.accelerator,
      maxTokens: config.maxTokens,
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

    const gpuAvailable =
      typeof navigator !== "undefined" &&
      "gpu" in navigator &&
      (await (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu?.requestAdapter()) !== null;

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
  onDone: (latencyMs: number) => void;
  onError: (err: string) => void;
}

export interface GenerateOptions {
  modelId?: string;
  systemInstruction?: string;
  config: ModelConfig;
}

/**
 * Stream a response from the active LLM backend.
 * `history` is the full conversation so far (user + assistant turns).
 * `ragContext` is injected as a system message when non-empty.
 */
export async function generateStream(
  history: Array<{ role: string; content: string }>,
  ragContext: string,
  opts: GenerateOptions,
  callbacks: StreamCallbacks,
): Promise<void> {
  const backend = getActiveBackend();
  const messages = buildMessages(history, ragContext, opts.systemInstruction);

  if (backend === "tauri") return generateViaTauri(messages, opts, callbacks);
  if (backend === "mediapipe") return generateViaMediaPipe(messages, callbacks);
  if (backend === "api") return generateViaApi(messages, opts, callbacks);
  return generateMock(messages, callbacks);
}

// ── Tauri IPC backend ──────────────────────────────────────────────────────

async function generateViaTauri(
  messages: Array<{ role: string; content: string }>,
  opts: GenerateOptions,
  callbacks: StreamCallbacks,
): Promise<void> {
  // Function() escapes Vite's static import analysis — @tauri-apps/api must
  // never be bundled into the web build; it is injected by the Tauri webview.
  const tauriImport = new Function("specifier", "return import(specifier)");
  const { invoke, listen } = await tauriImport("@tauri-apps/api/core");

  type ChunkPayload = { chunk: string; done: boolean; latencyMs?: number; error?: string };
  const unlistenHolder: { fn: (() => void) | null } = { fn: null };

  unlistenHolder.fn = await (listen as (
    event: string,
    handler: (e: { payload: ChunkPayload }) => void,
  ) => Promise<() => void>)(
    "litert-lm://chunk",
    (event) => {
      const { chunk, done, latencyMs, error } = event.payload;
      if (done) {
        unlistenHolder.fn?.();
        if (error) callbacks.onError(error);
        else callbacks.onDone(latencyMs ?? 0);
        return;
      }
      if (error) { unlistenHolder.fn?.(); callbacks.onError(error); return; }
      callbacks.onChunk(chunk);
    },
  );

  try {
    const prompt = messages
      .filter((m) => m.role !== "system")
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n") + "\nAssistant:";

    const systemInstruction = messages.find((m) => m.role === "system")?.content;

    await (invoke as (cmd: string, args: unknown) => Promise<void>)(
      "plugin:litert|generate_stream",
      {
        input: {
          modelId: opts.modelId ?? activeLmModelId,
          prompt,
          systemInstruction,
          sampler: {
            temperature: opts.config.temperature,
            topP: opts.config.topP,
            topK: opts.config.topK,
          },
        },
      },
    );
  } catch (e) {
    unlistenHolder.fn?.();
    callbacks.onError(String(e));
  }
}

// ── MediaPipe backend ──────────────────────────────────────────────────────

async function generateViaMediaPipe(
  messages: Array<{ role: string; content: string }>,
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
  await webLlm.generateResponse(
    prompt,
    (partialResult: string, done: boolean) => {
      if (done) callbacks.onDone(performance.now() - t0);
      else callbacks.onChunk(partialResult);
    },
  );
}

// ── OpenAI-compatible API backend ──────────────────────────────────────────

async function generateViaApi(
  messages: Array<{ role: string; content: string }>,
  opts: GenerateOptions,
  callbacks: StreamCallbacks,
): Promise<void> {
  if (!apiConfig) { callbacks.onError("No API config set"); return; }

  const t0 = performance.now();
  const response = await fetch(`${apiConfig.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiConfig.apiKey ? { Authorization: `Bearer ${apiConfig.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: apiConfig.model,
      messages,
      stream: true,
      temperature: opts.config.temperature,
      top_p: opts.config.topP,
    }),
  });

  if (!response.ok) {
    callbacks.onError(`API error ${response.status}: ${await response.text()}`);
    return;
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value).split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") { callbacks.onDone(performance.now() - t0); return; }
      try {
        const chunk = JSON.parse(data).choices?.[0]?.delta?.content;
        if (chunk) callbacks.onChunk(chunk);
      } catch { /* ignore malformed SSE */ }
    }
  }
  callbacks.onDone(performance.now() - t0);
}

// ── Mock backend ───────────────────────────────────────────────────────────

async function generateMock(
  messages: Array<{ role: string; content: string }>,
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
    await new Promise((r) => setTimeout(r, 25 + Math.random() * 35));
    callbacks.onChunk(word + " ");
  }
  callbacks.onDone(performance.now() - t0);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildMessages(
  history: Array<{ role: string; content: string }>,
  ragContext: string,
  systemInstruction?: string,
): Array<{ role: string; content: string }> {
  const systemParts: string[] = [];
  if (systemInstruction) systemParts.push(systemInstruction);
  if (ragContext) systemParts.push(ragContext);

  const messages: Array<{ role: string; content: string }> = [];
  if (systemParts.length > 0) {
    messages.push({ role: "system", content: systemParts.join("\n\n") });
  }
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
  localStorage.setItem(WEB_API_URL_STORAGE, config.baseUrl);
  if (config.apiKey) localStorage.setItem(WEB_API_KEY_STORAGE, config.apiKey);
  if (config.model) localStorage.setItem(WEB_API_MODEL_STORAGE, config.model);
  setApiConfig(config);
}
