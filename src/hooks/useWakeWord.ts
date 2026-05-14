/**
 * useWakeWord — Porcupine wake word detection hook.
 *
 * Uses @picovoice/porcupine-web + @picovoice/web-voice-processor.
 * Runs entirely in a Web Worker; the main thread only receives detection
 * callbacks. Works in Tauri webviews and all modern browsers.
 *
 * Lifecycle:
 *   - Call start() to initialise Porcupine and begin listening.
 *   - Call stop() to release the mic and destroy the engine.
 *   - The hook auto-stops on unmount.
 *
 * Requirements:
 *   - A Picovoice AccessKey (free tier available at console.picovoice.ai).
 *   - A built-in keyword name (e.g. "Jarvis") or a custom .ppn model file.
 */

import { useCallback, useEffect, useRef, useState } from "react";

// Picovoice types — imported lazily to avoid loading WASM at module parse time
type PorcupineWorkerType = import("@picovoice/porcupine-web").PorcupineWorker;

export type WakeWordState =
  | "idle"        // not started
  | "loading"     // initialising WASM + mic
  | "listening"   // active, waiting for keyword
  | "detected"    // keyword just fired (brief flash)
  | "error";      // failed to start

export interface UseWakeWordOptions {
  accessKey: string;
  /** Built-in keyword name, e.g. "Jarvis", "Bumblebee", "Computer". */
  keyword: string;
  sensitivity?: number;
  /** Called each time the wake word is detected. */
  onDetected: () => void;
  onError?: (msg: string) => void;
}

export interface UseWakeWordReturn {
  state: WakeWordState;
  /** Whether wake word detection is currently active. */
  active: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  toggle: () => Promise<void>;
}

// Built-in keyword names supported by Porcupine (subset — full list in the package)
export const BUILTIN_KEYWORDS = [
  "Alexa", "Americano", "Blueberry", "Bumblebee", "Computer",
  "Grapefruit", "Grasshopper", "Hey Google", "Hey Siri", "Jarvis",
  "Ok Google", "Picovoice", "Porcupine", "Terminator",
] as const;

export function useWakeWord({
  accessKey,
  keyword,
  sensitivity = 0.5,
  onDetected,
  onError,
}: UseWakeWordOptions): UseWakeWordReturn {
  const [state, setState] = useState<WakeWordState>("idle");

  const porcupineRef    = useRef<PorcupineWorkerType | null>(null);
  const onDetectedRef   = useRef(onDetected);
  const onErrorRef      = useRef(onError);
  const detectedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startingRef     = useRef(false); // guard against concurrent start() calls
  useEffect(() => { onDetectedRef.current = onDetected; }, [onDetected]);
  useEffect(() => { onErrorRef.current    = onError;    }, [onError]);

  const stop = useCallback(async (preserveError = false) => {
    // Clear any pending "detected → listening" reset timer
    if (detectedTimerRef.current !== null) {
      clearTimeout(detectedTimerRef.current);
      detectedTimerRef.current = null;
    }
    try {
      if (porcupineRef.current) {
        const { WebVoiceProcessor } = await import("@picovoice/web-voice-processor");
        await WebVoiceProcessor.unsubscribe(porcupineRef.current);
        await porcupineRef.current.release();
        porcupineRef.current = null;
      }
    } catch {
      // Ignore errors during teardown
    }
    startingRef.current = false;
    // Don't overwrite an "error" state set by the caller (e.g. start() catch block).
    if (!preserveError) setState("idle");
  }, []);

  const start = useCallback(async () => {
    // Prevent concurrent initialisation races
    if (startingRef.current || porcupineRef.current) return;
    startingRef.current = true;

    if (!accessKey.trim()) {
      onErrorRef.current?.("Picovoice AccessKey is required. Get one free at console.picovoice.ai");
      setState("error");
      startingRef.current = false;
      return;
    }

    setState("loading");

    try {
      // Lazy-load to avoid pulling WASM into the initial bundle
      const [{ PorcupineWorker, BuiltInKeyword }, { WebVoiceProcessor }] = await Promise.all([
        import("@picovoice/porcupine-web"),
        import("@picovoice/web-voice-processor"),
      ]);

      // Resolve keyword — match case-insensitively against built-in enum
      const builtinEntry = Object.entries(BuiltInKeyword).find(
        ([, v]) => v.toLowerCase() === keyword.toLowerCase(),
      );

      if (!builtinEntry) {
        throw new Error(
          `Unknown keyword "${keyword}". Available: ${Object.values(BuiltInKeyword).join(", ")}`,
        );
      }

      const builtinKeyword = builtinEntry[1] as typeof BuiltInKeyword[keyof typeof BuiltInKeyword];

      // Wrap PorcupineWorker.create() in a 30-second timeout. If the WASM
      // binary fetch stalls indefinitely, startingRef would stay true forever
      // and block all retry attempts.
      const createWithTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Porcupine init timed out after ${ms / 1000}s`)), ms),
        );
        return Promise.race([promise, timeout]);
      };

      const porcupine = await createWithTimeout(PorcupineWorker.create(
        accessKey,
        [{ builtin: builtinKeyword, sensitivity }],
        (_detection) => {
          setState("detected");
          onDetectedRef.current();
          // Reset to listening after brief flash — track timer so it can be
          // cleared if stop() is called before it fires.
          if (detectedTimerRef.current !== null) clearTimeout(detectedTimerRef.current);
          detectedTimerRef.current = setTimeout(() => {
            detectedTimerRef.current = null;
            setState("listening");
          }, 1000);
        },
        // porcupine_params.pv is served from public/ and cached in IndexedDB
        { publicPath: "/porcupine_params.pv", forceWrite: false },
        {
          processErrorCallback: (err) => {
            onErrorRef.current?.(`Porcupine error: ${err.message}`);
            setState("error");
          },
        },
      ), 30_000);

      porcupineRef.current = porcupine;

      await WebVoiceProcessor.subscribe(porcupine);
      startingRef.current = false;
      setState("listening");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onErrorRef.current?.(msg);
      setState("error");
      startingRef.current = false;
      // Clean up any partial init without overwriting the "error" state.
      await stop(true);
    }
  }, [accessKey, keyword, sensitivity, stop]);

  const toggle = useCallback(async () => {
    if (state === "listening" || state === "detected") await stop();
    else await start();
  }, [state, start, stop]);

  // Release resources on unmount. void is intentional — cleanup functions
  // cannot be async, but we still want the teardown to run asynchronously
  // rather than being silently dropped.
  useEffect(() => {
    return () => { void stop(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    state,
    active: state === "listening" || state === "detected",
    start,
    stop,
    toggle,
  };
}
