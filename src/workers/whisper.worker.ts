/**
 * whisper.worker.ts
 *
 * Runs Whisper transcription in a dedicated Web Worker so the main thread
 * is never blocked during model loading or inference.
 *
 * Message protocol (main → worker):
 *   { type: "load",       modelId: string }          — download + cache model
 *   { type: "transcribe", audio: Float32Array }       — run ASR on PCM data
 *
 * Message protocol (worker → main):
 *   { type: "status",  status: WorkerStatus, message?: string }
 *   { type: "result",  text: string }
 *   { type: "error",   message: string }
 */

// Types for @xenova/transformers are declared in src/types/xenova-transformers.d.ts
import { pipeline, env as xenovaEnv } from "@xenova/transformers";

// Keep models in the browser cache; don't re-download on every page load.
xenovaEnv.allowLocalModels  = false;
xenovaEnv.useBrowserCache   = true;

export type WorkerStatus =
  | "idle"
  | "loading"
  | "ready"
  | "transcribing";

type InMsg =
  | { type: "load";       modelId: string; language?: string }
  | { type: "transcribe"; audio: Float32Array };

type OutMsg =
  | { type: "status";  status: WorkerStatus; message?: string }
  | { type: "result";  text: string }
  | { type: "error";   message: string };

function post(msg: OutMsg) {
  self.postMessage(msg);
}

// Singleton pipeline — reused across transcribe calls.
// TranscriberFn is declared in src/types/xenova-transformers.d.ts
let transcriber: Awaited<ReturnType<typeof pipeline>> | null = null;
let loadedModelId = "";
let loadedLanguage = "english";
// Serialise transcription calls — the pipeline is not re-entrant.
let isTranscribing = false;

async function loadModel(modelId: string, language = "english") {
  if (transcriber && loadedModelId === modelId && loadedLanguage === language) {
    post({ type: "status", status: "ready", message: `${modelId} already loaded` });
    return;
  }
  post({ type: "status", status: "loading", message: `Loading ${modelId}…` });
  try {
    transcriber = await pipeline("automatic-speech-recognition", modelId, {
      // Progress callback — forward download progress to main thread
      progress_callback: (p: { status: string; progress?: number; file?: string }) => {
        if (p.status === "downloading" || p.status === "progress") {
          const pct = p.progress != null ? ` (${Math.round(p.progress)}%)` : "";
          post({ type: "status", status: "loading", message: `Downloading${pct}` });
        }
      },
    });
    loadedModelId = modelId;
    loadedLanguage = language;
    post({ type: "status", status: "ready", message: `${modelId} ready` });
  } catch (err) {
    post({ type: "error", message: `Failed to load model: ${String(err)}` });
  }
}

async function transcribe(audio: Float32Array) {
  if (!transcriber) {
    post({ type: "error", message: "Model not loaded. Call load first." });
    return;
  }
  if (isTranscribing) {
    console.warn("[WhisperWorker] dropped audio — transcription already in progress");
    post({ type: "error", message: "Transcription already in progress. Please wait." });
    return;
  }
  isTranscribing = true;
  post({ type: "status", status: "transcribing" });
  try {
    // Whisper expects 16 kHz mono float32 PCM.
    // chunk_length_s=30 handles recordings up to 30 s; stride handles overlap.
    let maxAbs = 0, sumAbs = 0;
    for (let i = 0; i < audio.length; i++) {
      const a = Math.abs(audio[i]);
      sumAbs += a;
      if (a > maxAbs) maxAbs = a;
    }
    const meanAbs = sumAbs / audio.length;
    console.log("[WhisperWorker] transcribing", audio.length, "samples (~" + (audio.length / 16000).toFixed(1) + "s) maxAbs:", maxAbs.toFixed(6), "meanAbs:", meanAbs.toFixed(6));
    const result = await transcriber(audio, {
      sampling_rate: 16000,
      language: loadedLanguage,
      task: "transcribe",
      // Disable Whisper's internal no-speech gate so short/quiet clips still transcribe.
      // Without this, Whisper returns {"text":""} when it classifies audio as non-speech.
      no_speech_threshold: 1.0,
    });
    console.log("[WhisperWorker] raw result:", JSON.stringify(result));
    const text: string = Array.isArray(result)
      ? result.map((r: { text: string }) => r.text).join(" ").trim()
      : (result as { text: string }).text.trim();
    console.log("[WhisperWorker] final text:", JSON.stringify(text));
    post({ type: "result", text });
    post({ type: "status", status: "ready" });
  } catch (err) {
    post({ type: "error", message: `Transcription failed: ${String(err)}` });
    post({ type: "status", status: "ready" });
  } finally {
    isTranscribing = false;
  }
}

self.addEventListener("message", (event: MessageEvent<InMsg>) => {
  const msg = event.data;
  if (msg.type === "load") {
    loadModel(msg.modelId, msg.language).catch((err) => {
      post({ type: "error", message: `Unhandled load error: ${String(err)}` });
    });
  } else if (msg.type === "transcribe") {
    transcribe(msg.audio).catch((err) => {
      post({ type: "error", message: `Unhandled transcribe error: ${String(err)}` });
      post({ type: "status", status: "ready" });
    });
  }
});
