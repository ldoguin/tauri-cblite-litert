/**
 * llm.ts — LiteRT LLM model management and generation.
 *
 * Wraps tauri-plugin-litert-api's LLM functions and provides a unified
 * interface for both streaming and blocking generation.
 *
 * On web, LiteRT-LM is not available; the app falls back to an
 * OpenAI-compatible HTTP endpoint (configurable in settings).
 */

import {
  loadLmModel,
  unloadLmModel,
  generateStream,
  loadModel,
  unloadModel,
} from "tauri-plugin-litert-api";
import { listen } from "@tauri-apps/api/event";
import type { ModelConfig } from "./types";

export const LM_MODEL_ID = "rag-lm";
export const EMBED_MODEL_ID = "rag-embed";

// ── Model lifecycle ────────────────────────────────────────────────────────

export async function loadModels(config: ModelConfig): Promise<void> {
  // Load embedding model (.tflite)
  if (config.embeddingModelPath) {
    await loadModel({
      modelId: EMBED_MODEL_ID,
      modelPath: config.embeddingModelPath,
      accelerator: config.accelerator,
    });
  }

  // Load LLM (.litertlm) — desktop and Android only
  if (config.lmModelPath && !isWeb()) {
    await loadLmModel({
      modelId: LM_MODEL_ID,
      modelPath: config.lmModelPath,
      accelerator: config.accelerator,
      maxTokens: config.maxTokens,
    });
  }
}

export async function unloadModels(): Promise<void> {
  try { await unloadModel(EMBED_MODEL_ID); } catch { /* not loaded */ }
  try { await unloadLmModel(LM_MODEL_ID); } catch { /* not loaded */ }
}

// ── Generation ─────────────────────────────────────────────────────────────

export interface GenerateOptions {
  prompt: string;
  systemInstruction?: string;
  config: ModelConfig;
  /** Called with each token chunk as it arrives */
  onChunk: (chunk: string) => void;
  /** Called when generation is complete */
  onDone: (latencyMs: number) => void;
  /** Called on error */
  onError: (err: string) => void;
}

/**
 * Streams a response from the LLM.
 * On web, delegates to the configured OpenAI-compatible endpoint.
 */
export async function streamGenerate(opts: GenerateOptions): Promise<void> {
  if (isWeb()) {
    await streamGenerateWeb(opts);
    return;
  }

  // Listen for token chunks before triggering generation
  type ChunkPayload = { modelId: string; chunk: string; done: boolean; latencyMs?: number };
  const unlisten = await listen<ChunkPayload>("litert-lm://chunk", (event) => {
    const { chunk, done, latencyMs } = event.payload;
    if (done) {
      unlisten();
      opts.onDone(latencyMs ?? 0);
    } else {
      opts.onChunk(chunk);
    }
  });

  try {
    await generateStream({
      modelId: LM_MODEL_ID,
      prompt: opts.prompt,
      systemInstruction: opts.systemInstruction,
      sampler: {
        temperature: opts.config.temperature,
        topP: opts.config.topP,
        topK: opts.config.topK,
      },
    });
  } catch (err) {
    unlisten();
    opts.onError(String(err));
  }
}

// ── Web fallback ───────────────────────────────────────────────────────────

const WEB_API_KEY_STORAGE = "rag-chatbot:web-api-key";
const WEB_API_URL_STORAGE = "rag-chatbot:web-api-url";

export function getWebApiConfig(): { url: string; apiKey: string } {
  return {
    url: localStorage.getItem(WEB_API_URL_STORAGE) ?? "https://api.groq.com/openai/v1",
    apiKey: localStorage.getItem(WEB_API_KEY_STORAGE) ?? "",
  };
}

export function setWebApiConfig(url: string, apiKey: string): void {
  localStorage.setItem(WEB_API_URL_STORAGE, url);
  localStorage.setItem(WEB_API_KEY_STORAGE, apiKey);
}

async function streamGenerateWeb(opts: GenerateOptions): Promise<void> {
  const { url, apiKey } = getWebApiConfig();
  if (!apiKey) {
    opts.onError("No API key configured. Open Settings to add one.");
    return;
  }

  const messages = [];
  if (opts.systemInstruction) {
    messages.push({ role: "system", content: opts.systemInstruction });
  }
  messages.push({ role: "user", content: opts.prompt });

  const start = performance.now();
  try {
    const res = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "llama3-8b-8192",
        messages,
        stream: true,
        temperature: opts.config.temperature,
        top_p: opts.config.topP,
        max_tokens: opts.config.maxTokens,
      }),
    });

    if (!res.ok || !res.body) {
      opts.onError(`API error: ${res.status} ${res.statusText}`);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = decoder.decode(value).split("\n");
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          opts.onDone(performance.now() - start);
          return;
        }
        try {
          const json = JSON.parse(data);
          const chunk = json.choices?.[0]?.delta?.content ?? "";
          if (chunk) opts.onChunk(chunk);
        } catch { /* skip malformed SSE lines */ }
      }
    }
    opts.onDone(performance.now() - start);
  } catch (err) {
    opts.onError(String(err));
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────

export function isWeb(): boolean {
  return !("__TAURI_INTERNALS__" in window);
}
