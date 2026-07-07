/**
 * litert-lm.worker.ts
 *
 * Web Worker that hosts the @litert-lm/core WASM engine.
 * Runs on Windows (and any platform where the Tauri native plugin is
 * unavailable) as a drop-in replacement for the Tauri IPC path.
 *
 * Message protocol (main → worker):
 *   { type: "load",     modelUrl: string, systemPrompt?: string, maxTokens?: number }
 *   { type: "generate", id: string, messages: ChatMessage[], systemPrompt: string,
 *                       maxTokens: number, temperature: number, topK: number, topP: number }
 *   { type: "abort",    id: string }
 *   { type: "unload" }
 *
 * Message protocol (worker → main):
 *   { type: "load-progress", progress: number }   // 0–100
 *   { type: "load-done" }
 *   { type: "load-error",    error: string }
 *   { type: "chunk",  id: string, text: string }
 *   { type: "done",   id: string, latencyMs: number }
 *   { type: "error",  id: string, error: string }
 */

// Types only — no runtime import at top level so this file can be bundled as
// a classic IIFE script (required for @litertjs/wasm-utils importScripts() call).
import type { Engine, ConversationConfig, Message } from "@litert-lm/core";

export interface ChatMessage {
  role: string;
  content: string;
}

// ── State ─────────────────────────────────────────────────────────────────────

// loadLiteRtLm() initialises a global WASM singleton — calling it twice throws.
// Track whether it has been called so subsequent load messages skip it.
let _wasmInitialised = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let engine: Engine | null = null;
// Reuse a single conversation to avoid re-initializing GPU on every turn.
// Recreated when the system prompt changes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let conversation: any | null = null;
let conversationSystemPrompt: string | undefined = undefined;
// Active abort controllers keyed by generation id
const abortControllers = new Map<string, AbortController>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function post(msg: object) {
  self.postMessage(msg);
}

// ── Message handler ───────────────────────────────────────────────────────────

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data as Record<string, unknown>;

  switch (msg.type) {
    case "load": {
      try {
        // Dynamic import keeps top-level imports out of this file so Vite can
        // bundle it as a classic IIFE (required for importScripts() support).
        const { loadLiteRtLm, Engine: EngineClass } = await import("@litert-lm/core");

        // Point the WASM loader at the /litert-lm/ directory served by Vite /
        // the Tauri asset protocol. Must be an absolute URL — this worker may
        // run inside a Blob worker (blob: origin) where relative paths fail.
        const wasmBase = (self as unknown as { _wasmBase?: string })._wasmBase
          ?? (location.origin + "/litert-lm/");
        // loadLiteRtLm() sets a global WASM singleton and throws if called
        // twice — guard so reloading a model in the same worker session works.
        if (!_wasmInitialised) {
          await loadLiteRtLm(wasmBase);
          _wasmInitialised = true;
        }

        const maxTokens = (msg.maxTokens as number | undefined) ?? 2048;

        // The model bytes are fetched in the main thread (where asset.localhost
        // is accessible) and transferred here as an ArrayBuffer.
        const modelBlob = new Blob(
          [msg.modelBuffer as ArrayBuffer],
          { type: "application/octet-stream" },
        );
        post({ type: "load-progress", progress: 92 });

        if (conversation) { await conversation.delete().catch(() => {}); conversation = null; }
        if (engine) { await engine.delete(); engine = null; }

        engine = await EngineClass.create({
          model: modelBlob,
          mainExecutorSettings: {
            maxNumTokens: maxTokens,
            advancedSettings: {
              // Parallelise weight upload to GPU — speeds up load and first inference
              num_threads_to_upload: 4,
              num_threads_to_compile: 4,
              // Already-optimal defaults kept explicit for clarity
              convert_weights_on_gpu: true,
              optimize_shader_compilation: true,
              share_constant_tensors: true,
              gpu_madvise_original_shared_tensors: true,
              // Required fields with their defaults
              prefill_batch_sizes: [],
              num_output_candidates: 1,
              configure_magic_numbers: true,
              verify_magic_numbers: false,
              clear_kv_cache_before_prefill: true,
              num_logits_to_print_after_decode: 0,
              is_benchmark: false,
              preferred_device_substr: "",
            },
          },
        });

        // Warm up: create a conversation now so GPU shader compilation happens
        // during load (progress 92–100) rather than on the first user message.
        post({ type: "load-progress", progress: 95 });
        conversation = await engine.createConversation({
          preface: { messages: [] },
          // Prefill the (empty) preface KV cache immediately to warm up shaders.
          prefillPrefaceOnInit: true,
          sessionConfig: {
            // Greedy sampling — fastest, no top-k/top-p overhead.
            samplerParams: { type: 3 /* SamplerType.GREEDY */ },
            // Cap output to avoid runaway generation.
            maxOutputTokens: 1024,
          },
        });
        conversationSystemPrompt = undefined;

        post({ type: "load-progress", progress: 100 });
        post({ type: "load-done" });
      } catch (err) {
        const msg = String(err);
        // The WASM runtime cannot load .litertlm files that contain embedder
        // sub-models (e.g. Gemma 4). Use a text-only model like Qwen3 instead.
        const friendly = msg.includes("kTfLiteEmbedder")
          ? "This model contains a vision/embedder sub-model not supported by the browser WASM runtime. Try Qwen3 0.6B or 1.7B instead."
          : msg;
        post({ type: "load-error", error: friendly });
      }
      break;
    }

    case "generate": {
      const id = msg.id as string;
      if (!engine) {
        post({ type: "error", id, error: "Engine not loaded" });
        return;
      }

      const messages = msg.messages as ChatMessage[];
      const systemPrompt = msg.systemPrompt as string | undefined;
      const ac = new AbortController();
      abortControllers.set(id, ac);

      try {
        // Build the preface with system prompt and conversation history.
        // The last message is the user turn we're responding to.
        const prefaceMessages: Message[] = [];
        if (systemPrompt) {
          prefaceMessages.push({ role: "system", content: systemPrompt });
        }
        // All messages except the last go into the preface as history.
        const historyMessages = messages.slice(0, -1);
        const lastMessage = messages[messages.length - 1];

        // Recreate conversation only when system prompt changes, to avoid
        // re-initializing GPU accelerators on every message turn.
        if (!conversation || conversationSystemPrompt !== systemPrompt) {
          if (conversation) await conversation.delete().catch(() => {});
          const config: ConversationConfig = {
            preface: { messages: prefaceMessages },
            prefillPrefaceOnInit: true,
            sessionConfig: {
              samplerParams: { type: 3 /* SamplerType.GREEDY */ },
              maxOutputTokens: 1024,
            },
          };
          conversation = await engine.createConversation(config);
          conversationSystemPrompt = systemPrompt;
        }

        // Inject history by resetting preface to include all prior turns.
        if (historyMessages.length > 0) {
          await conversation.setPreface?.({
            messages: [
              ...prefaceMessages,
              ...historyMessages.map((m: ChatMessage) => ({ role: m.role, content: m.content })),
            ],
          }).catch(() => {
            // setPreface not available — fall back to recreating conversation
          });
        }

        const t0 = performance.now();

        try {
          const stream = conversation.sendMessageStreaming(lastMessage.content);
          const reader = stream.getReader();

          while (true) {
            if (ac.signal.aborted) {
              conversation.cancel();
              reader.cancel();
              break;
            }
            const { done, value } = await reader.read();
            if (done) break;
            // value is a Message; content may be string or ContentPart[]
            const text = typeof value.content === "string"
              ? value.content
              : (value.content ?? [])
                  .filter((p: { type: string; text?: string }): p is { type: "text"; text: string } => p.type === "text")
                  .map((p: { type: "text"; text: string }) => p.text)
                  .join("");
            if (text) post({ type: "chunk", id, text });
          }
        } catch (genErr) {
          // If generation fails, reset conversation so next call gets a fresh one
          await conversation.delete().catch(() => {});
          conversation = null;
          throw genErr;
        }

        post({ type: "done", id, latencyMs: performance.now() - t0 });
      } catch (err) {
        if (!ac.signal.aborted) {
          post({ type: "error", id, error: String(err) });
        } else {
          // Aborted — signal done cleanly
          post({ type: "done", id, latencyMs: 0 });
        }
      } finally {
        abortControllers.delete(id);
      }
      break;
    }

    case "abort": {
      const id = msg.id as string;
      abortControllers.get(id)?.abort();
      break;
    }

    case "unload": {
      if (conversation) { await conversation.delete().catch(() => {}); conversation = null; }
      if (engine) {
        await engine.delete();
        engine = null;
      }
      break;
    }
  }
};
