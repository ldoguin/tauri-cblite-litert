import { useCallback, useEffect, useRef, useState } from "react";

/** Strip markdown so the synthesizer reads clean prose. */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/_{2}(.*?)_{2}/g, "$1")
    .replace(/_(.*?)_/g, "$1")
    .replace(/#{1,6}\s+/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/^>\s*/gm, "")
    .replace(/🔀\s*/g, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Expand common abbreviations so the TTS engine pronounces them correctly.
 * Rules are tried in order; longer/more-specific patterns come first to prevent
 * "km/h" being partially matched by the "km" rule.
 *
 * Two categories:
 *  - NUMBER_UNITS  : matched only when immediately preceded by a number, so
 *                    single-letter units like "m" or "g" don't corrupt prose.
 *  - STANDALONE    : safe to replace anywhere (compound or unambiguous abbrs).
 */
const NUMBER_UNITS: [string, string][] = [
  ["km/h",  "kilometers per hour"],
  ["m/s",   "meters per second"],
  ["kWh",   "kilowatt-hours"],
  ["GHz",   "gigahertz"],
  ["MHz",   "megahertz"],
  ["kHz",   "kilohertz"],
  ["kW",    "kilowatts"],
  ["MW",    "megawatts"],
  ["mA",    "milliamperes"],
  ["mg",    "milligrams"],
  ["ml",    "milliliters"],
  ["mm",    "millimeters"],
  ["cm",    "centimeters"],
  ["km",    "kilometers"],
  ["kg",    "kilograms"],
  ["ms",    "milliseconds"],
  ["mph",   "miles per hour"],
  ["rpm",   "revolutions per minute"],
  ["°C",    "degrees Celsius"],
  ["°F",    "degrees Fahrenheit"],
  ["Hz",    "hertz"],
  ["ft",    "feet"],
  ["lb",    "pounds"],
  ["oz",    "ounces"],
  ["yd",    "yards"],
  ["mi",    "miles"],
  // Single-char: only safe with a leading number
  ["m",     "meters"],
  ["g",     "grams"],
  ["s",     "seconds"],
  ["l",     "liters"],
  ["h",     "hours"],
];

const STANDALONE_ABBRS: [string, string][] = [
  ["km/h",  "kilometers per hour"],
  ["m/s",   "meters per second"],
  ["mph",   "miles per hour"],
  ["kph",   "kilometers per hour"],
  ["rpm",   "revolutions per minute"],
  ["kWh",   "kilowatt-hours"],
];

// Pre-compile rules once at module load.
const ABBR_RULES: Array<[RegExp, string]> = (() => {
  function esc(s: string) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("°", "°");
  }
  const rules: Array<[RegExp, string]> = [];
  for (const [unit, expansion] of NUMBER_UNITS) {
    // Match digit(s), optional space, then unit — not followed by another letter.
    rules.push([
      new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${esc(unit)}(?![a-zA-Z])`, "g"),
      `$1 ${expansion}`,
    ]);
  }
  for (const [abbr, expansion] of STANDALONE_ABBRS) {
    rules.push([new RegExp(`\\b${esc(abbr)}\\b`, "g"), expansion]);
  }
  return rules;
})();

function expandAbbreviations(text: string): string {
  for (const [re, repl] of ABBR_RULES) text = text.replace(re, repl);
  return text;
}

// Xenova fallback only — the plugin handles long text natively.
const CHUNK_SIZE = 250;

function splitIntoChunks(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text];
  const sentences = text.match(/[^.!?]+[.!?]+[\s]*/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const s of sentences) {
    if (current.length + s.length > CHUNK_SIZE && current) {
      chunks.push(current.trim());
      current = s;
    } else {
      current += s;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export type TtsState = "idle" | "loading" | "ready" | "speaking" | "error";

export interface UseTtsReturn {
  enabled: boolean;
  state: TtsState;
  errorMsg: string | null;
  toggle: () => void;
  speak: (text: string) => void;
  cancel: () => void;
  modelId: string;
}

const DEFAULT_MODEL = "Xenova/mms-tts-eng";

/** Cached result of plugin availability check. */
let pluginAvailable: boolean | null = null;

async function checkPlugin(): Promise<boolean> {
  if (pluginAvailable !== null) return pluginAvailable;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("plugin:tts|is_initialized");
    pluginAvailable = true;
  } catch {
    pluginAvailable = false;
  }
  return pluginAvailable;
}

async function pluginSpeak(text: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("plugin:tts|speak", {
    payload: { text, rate: 1.0, pitch: 1.0, volume: 1.0 },
  });
}

async function pluginStop(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("plugin:tts|stop");
}

export function useTts(modelId = ""): UseTtsReturn {
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<TtsState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Whether we resolved to plugin (true) or Xenova fallback (false)
  const usePluginRef = useRef<boolean | null>(null);

  // Event unlisten callbacks
  const unlistenFinishRef = useRef<(() => void) | null>(null);
  const unlistenCancelRef = useRef<(() => void) | null>(null);

  // Xenova fallback resources
  const workerRef = useRef<Worker | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const chunkQueueRef = useRef<string[]>([]);

  useEffect(() => {
    return () => {
      unlistenFinishRef.current?.();
      unlistenCancelRef.current?.();
      sourceRef.current?.stop();
      workerRef.current?.terminate();
      audioCtxRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      chunkQueueRef.current = [];
      sourceRef.current?.stop();
      sourceRef.current = null;
      unlistenFinishRef.current?.();
      unlistenCancelRef.current?.();
      unlistenFinishRef.current = null;
      unlistenCancelRef.current = null;
      pluginStop().catch(() => {});
      setState("idle");
      return;
    }

    checkPlugin().then(async (available) => {
      usePluginRef.current = available;

      if (available) {
        // Subscribe to plugin finish/cancel events
        const { listen } = await import("@tauri-apps/api/event");
        unlistenFinishRef.current?.();
        unlistenCancelRef.current?.();
        const [unlistenFinish, unlistenCancel] = await Promise.all([
          listen("tts://speech:finish", () => setState("ready")),
          listen("tts://speech:cancel", () => setState("ready")),
        ]);
        unlistenFinishRef.current = unlistenFinish;
        unlistenCancelRef.current = unlistenCancel;
        setState("ready");
        return;
      }

      // Xenova fallback
      if (workerRef.current) { setState("ready"); return; }
      setState("loading");
      const worker = new Worker(
        new URL("../workers/tts.worker.ts", import.meta.url),
        { type: "module" },
      );
      workerRef.current = worker;

      worker.onmessage = (e: MessageEvent) => {
        const msg = e.data as
          | { type: "status"; status: string }
          | { type: "audio"; audio: Float32Array; sampleRate: number }
          | { type: "error"; message: string };

        if (msg.type === "status") {
          if (msg.status === "ready") setState("ready");
          else if (msg.status === "loading") setState("loading");
          else if (msg.status === "synthesizing") setState("speaking");
        } else if (msg.type === "audio") {
          playAudio(msg.audio, msg.sampleRate);
        } else if (msg.type === "error") {
          setErrorMsg(msg.message);
          setState("error");
        }
      };
      worker.onerror = (e) => { setErrorMsg(e.message); setState("error"); };
      worker.postMessage({ type: "load", modelId: modelId || DEFAULT_MODEL });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  function playAudio(samples: Float32Array<ArrayBufferLike>, sampleRate: number) {
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      audioCtxRef.current = new AudioContext({ sampleRate });
    }
    const ctx = audioCtxRef.current;
    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    sourceRef.current?.stop();
    sourceRef.current = source;
    source.onended = () => {
      const next = chunkQueueRef.current.shift();
      if (next && workerRef.current) {
        workerRef.current.postMessage({ type: "synthesize", text: next });
      } else {
        setState("ready");
      }
    };
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    source.start();
    setState("speaking");
  }

  const cancel = useCallback(() => {
    chunkQueueRef.current = [];
    if (usePluginRef.current) {
      pluginStop().catch(() => {});
    } else {
      sourceRef.current?.stop();
      sourceRef.current = null;
    }
    setState((s) => (s === "speaking" ? "ready" : s));
  }, []);

  const speak = useCallback((text: string) => {
    if (!enabled) return;
    const clean = expandAbbreviations(stripMarkdown(text));
    if (!clean) return;

    if (usePluginRef.current) {
      setState("speaking");
      pluginSpeak(clean).catch((err: unknown) => {
        setErrorMsg(String(err));
        setState("error");
      });
      return;
    }

    // Xenova fallback: chunk and synthesize
    const worker = workerRef.current;
    if (!worker) { console.warn("[useTts] worker not ready"); return; }
    const chunks = splitIntoChunks(clean);
    chunkQueueRef.current = chunks.slice(1);
    worker.postMessage({ type: "synthesize", text: chunks[0] });
  }, [enabled]);

  const toggle = useCallback(() => setEnabled((prev) => !prev), []);

  return { enabled, state, errorMsg, toggle, speak, cancel, modelId: modelId || DEFAULT_MODEL };
}
