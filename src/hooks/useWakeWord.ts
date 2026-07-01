/**
 * useWakeWord — Silero VAD + Whisper wake phrase detection hook.
 *
 * Uses @ricky0123/vad-web (Silero VAD) to detect speech onset, then forwards
 * the audio to a Whisper worker for transcription. The transcript is checked
 * against a configurable wake phrase — fully on-device, no API key required.
 *
 * Lifecycle:
 *   - Call start() to initialise VAD and begin listening.
 *   - Call stop() to release the mic and destroy the engine.
 *   - The hook auto-stops on unmount.
 *
 * Static files (served from origin root, copied by vite-plugin-static-copy):
 *   - /vad.worklet.bundle.min.js — Audio Worklet bundle
 *   - /silero_vad_v5.onnx — Silero VAD model
 *   - ONNX Runtime WASM files (.wasm / .mjs)
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type WakeWordState =
  | "idle"        // not started
  | "loading"     // initialising VAD + Whisper
  | "listening"   // active, waiting for speech
  | "detected"    // wake phrase just fired (brief flash)
  | "error";      // failed to start

export interface UseWakeWordOptions {
  /** Phrase matched (case-insensitive, punctuation-stripped) against Whisper transcript. */
  wakePhrase: string;
  /** Whisper model to use — default: "Xenova/whisper-tiny.en". */
  whisperModelId?: string;
  /** Called each time the wake phrase is detected. */
  onDetected: () => void;
  onError?: (msg: string) => void;
}

/** Human-readable diagnostic for common microphone / VAD failure modes. */
function diagnoseMicError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/not found|NotFoundError/i.test(msg))
    return "No microphone found. Plug in a mic and try again.";
  if (/denied|NotAllowedError/i.test(msg))
    return "Microphone access denied. Allow mic permission in your OS/browser settings.";
  if (/insecure|not allowed/i.test(msg))
    return "Microphone requires a secure context. Run the app via 'tauri dev' or a production build.";
  if (/AudioWorklet|worklet/i.test(msg))
    return `VAD audio worklet failed to load: ${msg}. Ensure the app assets include vad.worklet.bundle.min.js.`;
  if (/ort|onnx|wasm/i.test(msg))
    return `ONNX Runtime failed: ${msg}. Try restarting the app.`;
  return msg;
}

export interface UseWakeWordReturn {
  state: WakeWordState;
  /** Whether wake word detection is currently active. */
  active: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  toggle: () => Promise<void>;
  /** Pause VAD processing without destroying it (mic stays open). */
  pause: () => void;
  /** Resume VAD processing after pause(). */
  resume: () => void;
}

/** Normalise text for comparison: lowercase, strip punctuation, collapse whitespace. */
function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

export function useWakeWord({
  wakePhrase,
  whisperModelId = "Xenova/whisper-tiny.en",
  onDetected,
  onError,
}: UseWakeWordOptions): UseWakeWordReturn {
  const [state, setState] = useState<WakeWordState>("idle");

  // Keep stable refs so async callbacks always see current values.
  const onDetectedRef    = useRef(onDetected);
  const onErrorRef       = useRef(onError);
  const wakePhraseRef    = useRef(wakePhrase);
  useEffect(() => { onDetectedRef.current  = onDetected;  }, [onDetected]);
  useEffect(() => { onErrorRef.current     = onError;     }, [onError]);
  useEffect(() => { wakePhraseRef.current  = wakePhrase;  }, [wakePhrase]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vadRef           = useRef<any>(null);
  const workerRef        = useRef<Worker | null>(null);
  const detectedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startingRef      = useRef(false);

  const stop = useCallback(async (preserveError = false) => {
    if (detectedTimerRef.current !== null) {
      clearTimeout(detectedTimerRef.current);
      detectedTimerRef.current = null;
    }
    try {
      if (vadRef.current) {
        await vadRef.current.destroy();
        vadRef.current = null;
      }
    } catch {
      // ignore teardown errors
    }
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    startingRef.current = false;
    if (!preserveError) setState("idle");
  }, []);

  const start = useCallback(async () => {
    if (startingRef.current || vadRef.current) return;
    startingRef.current = true;
    setState("loading");

    try {
      // 0. Pre-flight: check microphone is available before spending time
      //    loading Whisper and the VAD model.
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          "getUserMedia not available. On Linux this requires GStreamer with PulseAudio/PipeWire support.",
        );
      }
      const testStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      testStream.getTracks().forEach((t) => t.stop());

      // 1. Spawn a dedicated Whisper worker for wake phrase detection.
      const worker = new Worker(
        new URL("../workers/whisper.worker.ts", import.meta.url),
        { type: "module" },
      );
      workerRef.current = worker;

      // Wait for the model to finish loading before starting VAD.
      console.log("[WakeWord] Loading Whisper model:", whisperModelId);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Whisper model load timed out (60 s)")),
          60_000,
        );
        worker.onmessage = (e) => {
          const msg = e.data as { type: string; status?: string; message?: string };
          if (msg.type === "status" && msg.status === "ready") {
            console.log("[WakeWord] Whisper model ready");
            clearTimeout(timeout);
            resolve();
          } else if (msg.type === "error") {
            clearTimeout(timeout);
            reject(new Error(msg.message ?? "Whisper worker error"));
          }
        };
        worker.postMessage({ type: "load", modelId: whisperModelId });
      });

      // 2. Wire ongoing result/error handler.
      worker.onmessage = (e) => {
        const msg = e.data as { type: string; text?: string; message?: string };
        if (msg.type === "result") {
          console.log("[WakeWord] Whisper result:", JSON.stringify(msg.text));
          if (msg.text) {
            const text   = normalise(msg.text);
            const phrase = normalise(wakePhraseRef.current);
            console.log("[WakeWord] normalised text:", JSON.stringify(text), "| phrase:", JSON.stringify(phrase), "| match:", text.includes(phrase));
            if (phrase && text.includes(phrase)) {
              setState("detected");
              onDetectedRef.current();
              if (detectedTimerRef.current !== null) clearTimeout(detectedTimerRef.current);
              detectedTimerRef.current = setTimeout(() => {
                detectedTimerRef.current = null;
                setState("listening");
              }, 1000);
            }
          }
        } else if (msg.type === "error") {
          console.error("[WakeWord] Whisper error:", msg.message);
          onErrorRef.current?.(`Whisper error: ${msg.message}`);
        }
      };

      // 3. Start MicVAD — lazily imported to keep the initial bundle small.
      const { MicVAD } = await import("@ricky0123/vad-web");

      const vad = await MicVAD.new({
        baseAssetPath: "/",
        onnxWASMBasePath: "/",
        // Force single-threaded WASM so SharedArrayBuffer is not required.
        // SharedArrayBuffer needs COOP+COEP HTTP headers which the Tauri
        // production asset server doesn't set. Single-threaded ORT is
        // sufficient for the lightweight Silero VAD model.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ortConfig: (ort: any) => {
          ort.env.wasm.numThreads = 1;
          ort.env.wasm.simd = true;
        },
        onSpeechEnd: (audio: Float32Array) => {
          console.log("[WakeWord] onSpeechEnd fired, audio samples:", audio.length, "duration:", (audio.length / 16000).toFixed(2) + "s");
          const copy = audio.slice();
          workerRef.current?.postMessage({ type: "transcribe", audio: copy }, [copy.buffer]);
        },
      });

      vadRef.current = vad;
      await vad.start();
      startingRef.current = false;
      console.log("[WakeWord] VAD started, listening for phrase:", JSON.stringify(wakePhrase));
      setState("listening");
    } catch (err) {
      console.error("[WakeWord] startup failed:", err);
      onErrorRef.current?.(diagnoseMicError(err));
      setState("error");
      startingRef.current = false;
      await stop(true);
    }
  }, [whisperModelId, stop]);

  const toggle = useCallback(async () => {
    if (state === "listening" || state === "detected") await stop();
    else await start();
  }, [state, start, stop]);

  // Release resources on unmount. void is intentional — cleanup functions
  // cannot be async.
  useEffect(() => {
    return () => { void stop(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pause = useCallback(() => {
    vadRef.current?.pause();
  }, []);

  const resume = useCallback(() => {
    // MicVAD.start() resumes from pause
    if (vadRef.current) vadRef.current.start();
  }, []);

  return {
    state,
    active: state === "listening" || state === "detected",
    start,
    stop,
    toggle,
    pause,
    resume,
  };
}
