/**
 * tts.worker.ts
 *
 * Runs text-to-speech synthesis in a dedicated Web Worker so the main thread
 * is never blocked during model loading or inference.
 *
 * Uses @xenova/transformers (same package as the Whisper worker).
 * Default model: Xenova/mms-tts-eng (~50 MB, cached after first download).
 *
 * Message protocol (main → worker):
 *   { type: "load",       modelId?: string }         — download + cache model
 *   { type: "synthesize", text: string }              — run TTS, returns audio
 *
 * Message protocol (worker → main):
 *   { type: "status",  status: TtsWorkerStatus, message?: string }
 *   { type: "audio",   audio: Float32Array, sampleRate: number }
 *   { type: "error",   message: string }
 */

import { pipeline, env as xenovaEnv } from "@xenova/transformers";

xenovaEnv.allowLocalModels = false;
xenovaEnv.useBrowserCache  = true;

export type TtsWorkerStatus = "idle" | "loading" | "ready" | "synthesizing";

type InMsg =
  | { type: "load";       modelId?: string }
  | { type: "synthesize"; text: string };

type OutMsg =
  | { type: "status"; status: TtsWorkerStatus; message?: string }
  | { type: "audio";  audio: Float32Array; sampleRate: number }
  | { type: "error";  message: string };

function post(msg: OutMsg) {
  self.postMessage(msg);
}

const DEFAULT_MODEL = "Xenova/mms-tts-eng";

let synthesizer: Awaited<ReturnType<typeof pipeline>> | null = null;
let loadedModelId = "";
let isSynthesizing = false;

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data;

  if (msg.type === "load") {
    const modelId = msg.modelId || DEFAULT_MODEL;
    if (synthesizer && loadedModelId === modelId) {
      post({ type: "status", status: "ready" });
      return;
    }
    post({ type: "status", status: "loading", message: `Loading ${modelId}…` });
    try {
      synthesizer = await pipeline("text-to-speech", modelId);
      loadedModelId = modelId;
      post({ type: "status", status: "ready" });
    } catch (err) {
      post({ type: "error", message: String(err) });
    }
    return;
  }

  if (msg.type === "synthesize") {
    if (!synthesizer) {
      post({ type: "error", message: "TTS model not loaded" });
      return;
    }
    if (isSynthesizing) return; // drop if already busy
    isSynthesizing = true;
    post({ type: "status", status: "synthesizing" });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (synthesizer as any)(msg.text) as { audio: Float32Array; sampling_rate: number };
      // Transfer the buffer (zero-copy) so it arrives intact in the main thread.
      self.postMessage(
        { type: "audio", audio: result.audio, sampleRate: result.sampling_rate },
        { transfer: [result.audio.buffer] },
      );
    } catch (err) {
      post({ type: "error", message: String(err) });
    } finally {
      isSynthesizing = false;
      post({ type: "status", status: "ready" });
    }
  }
};
