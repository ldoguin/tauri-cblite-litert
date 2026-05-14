/**
 * useVoiceInput — dual-backend voice input hook.
 *
 * Backend selection (in priority order):
 *   1. Web Speech API  — available in Chrome/Edge/Safari on web.
 *                        NOT available in Tauri webviews.
 *   2. Whisper (ONNX)  — MediaRecorder → Float32 PCM → @xenova/transformers
 *                        in a Web Worker. Works everywhere MediaRecorder works,
 *                        including Tauri desktop and Android WebView.
 *
 * The Whisper worker is lazy-loaded on first use and the model is cached by
 * the browser after the initial download (~40 MB for whisper-tiny.en).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkerStatus } from "../workers/whisper.worker";

// ── Web Speech API minimal types ───────────────────────────────────────────

interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: { readonly transcript: string; readonly confidence: number };
}
interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
}
interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  lang: string;
  onstart:  ((ev: Event) => void) | null;
  onresult: ((ev: SpeechRecognitionEvent) => void) | null;
  onerror:  ((ev: SpeechRecognitionErrorEvent) => void) | null;
  onend:    ((ev: Event) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  return (
    (window as unknown as { SpeechRecognition?: SpeechRecognitionCtor }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionCtor }).webkitSpeechRecognition ??
    null
  );
}

// ── Public API ─────────────────────────────────────────────────────────────

export type VoiceInputState = "idle" | "recording" | "processing";
export type VoiceBackend    = "speech-api" | "whisper" | "none";

export interface UseVoiceInputOptions {
  onResult: (text: string) => void;
  onError?: (message: string) => void;
  /** Whisper model ID on HuggingFace Hub. Defaults to Xenova/whisper-tiny.en. */
  whisperModelId?: string;
  lang?: string;
}

export interface UseVoiceInputReturn {
  backend: VoiceBackend;
  state: VoiceInputState;
  transcript: string;
  workerStatus: WorkerStatus;
  start: () => void;
  stop: () => void;
  toggle: () => void;
}

type WorkerOutMsg =
  | { type: "status";  status: WorkerStatus; message?: string }
  | { type: "result";  text: string }
  | { type: "error";   message: string };

const DEFAULT_WHISPER_MODEL = "Xenova/whisper-tiny.en";

export function useVoiceInput({
  onResult,
  onError,
  whisperModelId = DEFAULT_WHISPER_MODEL,
  lang,
}: UseVoiceInputOptions): UseVoiceInputReturn {
  const SpeechRecognitionCtor = getSpeechRecognition();
  const backend: VoiceBackend = SpeechRecognitionCtor ? "speech-api" : "whisper";

  const [state, setState]               = useState<VoiceInputState>("idle");
  const [transcript, setTranscript]     = useState("");
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus>("idle");

  const onResultRef = useRef(onResult);
  const onErrorRef  = useRef(onError);
  useEffect(() => { onResultRef.current = onResult; }, [onResult]);
  useEffect(() => { onErrorRef.current  = onError;  }, [onError]);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Ref mirror of state so startSpeechApi can read the current value without
  // listing `state` as a dep (which would recreate start/toggle on every
  // recording lifecycle event and cause unnecessary parent re-renders).
  const stateRef = useRef<VoiceInputState>("idle");
  useEffect(() => { stateRef.current = state; }, [state]);

  // Tracks the transcript-clear timer so it can be cancelled on unmount
  const transcriptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks the active MediaStream so mic tracks can be stopped on unmount
  // even if the recorder is already inactive (onstop may not fire on cleanup).
  const mediaStreamRef = useRef<MediaStream | null>(null);

  // ── Speech API backend ───────────────────────────────────────────────────

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);

  const startSpeechApi = useCallback(() => {
    if (!SpeechRecognitionCtor || stateRef.current === "recording") return;
    const rec = new SpeechRecognitionCtor();
    rec.continuous      = false;
    rec.interimResults  = true;
    rec.maxAlternatives = 1;
    if (lang) rec.lang  = lang;

    rec.onstart = () => { setState("recording"); setTranscript(""); };

    rec.onresult = (event) => {
      const ev = event as SpeechRecognitionEvent;
      let interim = "", final = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) final   += r[0].transcript;
        else           interim += r[0].transcript;
      }
      setTranscript(final || interim);
      if (final) {
        setState("processing");
        onResultRef.current(final.trim());
      }
    };

    rec.onerror = (event) => {
      const ev = event as SpeechRecognitionErrorEvent;
      if (ev.error !== "aborted") {
        onErrorRef.current?.(
          ev.error === "not-allowed"
            ? "Microphone access denied. Check browser permissions."
            : `Speech recognition error: ${ev.error}`,
        );
      }
      setState("idle");
      setTranscript("");
    };

    rec.onend = () => {
      // Reset both "recording" and "processing" → "idle".
      // "processing" is set by onresult when a final transcript fires; onend
      // always follows, so this is the correct place to clear it.
      if (isMountedRef.current) setState((prev) => (prev === "recording" || prev === "processing" ? "idle" : prev));
      if (transcriptTimerRef.current !== null) clearTimeout(transcriptTimerRef.current);
      transcriptTimerRef.current = setTimeout(() => {
        transcriptTimerRef.current = null;
        if (isMountedRef.current) setTranscript("");
      }, 1500);
      recognitionRef.current = null;
    };

    recognitionRef.current = rec;
    rec.start();
  // stateRef is used instead of state so this callback isn't recreated on
  // every recording lifecycle event.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [SpeechRecognitionCtor, lang]);

  const stopSpeechApi = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  // ── Whisper backend ──────────────────────────────────────────────────────

  const workerRef      = useRef<Worker | null>(null);
  const mediaRecRef    = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (backend !== "whisper") return;

    const worker = new Worker(
      new URL("../workers/whisper.worker.ts", import.meta.url),
      { type: "module" },
    );

    worker.onmessage = (e: MessageEvent<WorkerOutMsg>) => {
      if (!isMountedRef.current) return;
      const msg = e.data;
      if (msg.type === "status") {
        setWorkerStatus(msg.status);
        if (msg.message) setTranscript(msg.message);
      } else if (msg.type === "result") {
        setState("idle");
        setTranscript("");
        onResultRef.current(msg.text);
      } else if (msg.type === "error") {
        setState("idle");
        setTranscript("");
        onErrorRef.current?.(msg.message);
      }
    };

    // Surface unhandled worker crashes (WASM OOM, syntax errors, etc.)
    // so the UI doesn't silently hang in "loading" state forever.
    worker.onerror = (e: ErrorEvent) => {
      if (!isMountedRef.current) return;
      setWorkerStatus("idle");
      setState("idle");
      setTranscript("");
      onErrorRef.current?.(`Whisper worker crashed: ${e.message ?? "unknown error"}`);
    };

    // Pre-load model so it's ready on first use
    worker.postMessage({ type: "load", modelId: whisperModelId });
    workerRef.current = worker;

    return () => {
      worker.terminate();
      workerRef.current = null;
      // Reset voice state so the UI doesn't show "processing" while the new
      // model loads (effect re-runs when whisperModelId changes).
      if (isMountedRef.current) {
        setState("idle");
        setWorkerStatus("idle");
        setTranscript("");
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, whisperModelId]);

  const startWhisper = useCallback(async () => {
    if (stateRef.current === "recording") return;
    if (!workerRef.current) return;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      onErrorRef.current?.("Microphone access denied. Check browser permissions.");
      return;
    }

    audioChunksRef.current = [];
    mediaStreamRef.current = stream;
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream);
    } catch (err) {
      // MediaRecorder constructor throws on unsupported MIME types / codecs.
      // Stop the mic tracks so the browser mic indicator clears.
      stream.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
      onErrorRef.current?.(`Recording not supported: ${String(err)}`);
      return;
    }

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunksRef.current.push(e.data);
    };

    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
      if (isMountedRef.current) { setState("processing"); setTranscript("Transcribing…"); }

      const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType });
      const arrayBuffer = await blob.arrayBuffer();

      // Decode to 16 kHz mono Float32 PCM
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      let decoded: AudioBuffer;
      try {
        decoded = await audioCtx.decodeAudioData(arrayBuffer);
      } catch (err) {
        audioCtx.close();
        if (isMountedRef.current) {
          onErrorRef.current?.(`Audio decode failed: ${String(err)}`);
          setState("idle");
          setTranscript("");
        }
        return;
      }
      audioCtx.close();

      const pcm = decoded.getChannelData(0);
      // If the worker was replaced (whisperModelId changed) while recording,
      // workerRef.current is null — bail gracefully instead of hanging in
      // "processing" forever.
      if (!workerRef.current) {
        if (isMountedRef.current) { setState("idle"); setTranscript(""); }
        return;
      }
      workerRef.current.postMessage({ type: "transcribe", audio: pcm }, [pcm.buffer]);
    };

    mediaRecRef.current = recorder;
    recorder.start();
    setState("recording");
    setTranscript("");
  // stateRef used instead of state — see startSpeechApi comment.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopWhisper = useCallback(() => {
    const rec = mediaRecRef.current;
    if (rec && (rec.state === "recording" || rec.state === "paused")) {
      rec.stop();
    }
  }, []);

  // ── Unified API ──────────────────────────────────────────────────────────

  const start  = backend === "speech-api" ? startSpeechApi : startWhisper;
  const stop   = backend === "speech-api" ? stopSpeechApi  : stopWhisper;

  const toggle = useCallback(() => {
    if (state === "recording") stop();
    else start();
  }, [state, start, stop]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      if (mediaRecRef.current?.state === "recording") mediaRecRef.current.stop();
      // Stop mic tracks regardless of recorder state — onstop may not fire on unmount
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
      if (transcriptTimerRef.current !== null) clearTimeout(transcriptTimerRef.current);
    };
  }, []);

  return { backend, state, transcript, workerStatus, start, stop, toggle };
}
