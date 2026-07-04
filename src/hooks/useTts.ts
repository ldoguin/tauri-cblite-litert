import { startTransition, useCallback, useEffect, useRef, useState } from "react";

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

const MAX_CHARS = 400;

function truncate(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  const cut = text.slice(0, MAX_CHARS);
  const last = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
  return last > 100 ? cut.slice(0, last + 1) : cut;
}

/** Cached platform detection — resolved once on first speak(). */
let cachedIsAndroid: boolean | null = null;

async function isAndroid(): Promise<boolean> {
  if (cachedIsAndroid !== null) return cachedIsAndroid;
  try {
    const { platform } = await import("@tauri-apps/plugin-os");
    cachedIsAndroid = (await platform()) === "android";
  } catch {
    cachedIsAndroid = false;
  }
  return cachedIsAndroid;
}

async function nativeTtsSpeak(text: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("plugin:litert|tts_speak", { text });
}

async function nativeTtsCancel(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("plugin:litert|tts_cancel");
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

export function useTts(_modelId = ""): UseTtsReturn {
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<TtsState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const uttRef = useRef<SpeechSynthesisUtterance | null>(null);

  const cancel = useCallback(() => {
    isAndroid().then((android) => {
      if (android) {
        nativeTtsCancel().catch(() => {});
      } else if (typeof speechSynthesis !== "undefined") {
        speechSynthesis.cancel();
      }
    });
    setState((s) => (s === "speaking" ? "ready" : s));
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!enabled) {
      cancel();
      startTransition(() => setState("idle"));
    } else {
      startTransition(() => setState("ready"));
    }
  }, [enabled, cancel]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => () => {
    cancel();
  }, [cancel]);

  const speak = useCallback((text: string) => {
    if (!enabled) return;
    const clean = truncate(stripMarkdown(text));
    if (!clean) return;

    setState("speaking");

    isAndroid().then((android) => {
      if (android) {
        // Android: use native Kotlin TextToSpeech via Tauri plugin command
        nativeTtsSpeak(clean)
          .then(() => setState("ready"))
          .catch((err: unknown) => {
            const msg = String(err);
            console.error("[useTts] native TTS error:", msg);
            setErrorMsg(msg);
            setState("error");
          });
      } else {
        // Desktop (Tauri or browser): Web Speech API
        if (typeof speechSynthesis === "undefined") {
          console.warn("[useTts] speechSynthesis not available");
          setState("error");
          return;
        }
        speechSynthesis.cancel();
        const utt = new SpeechSynthesisUtterance(clean);
        uttRef.current = utt;
        utt.onstart = () => setState("speaking");
        utt.onend   = () => setState("ready");
        utt.onerror = (e) => {
          if (e.error !== "interrupted" && e.error !== "canceled") {
            console.warn("[useTts] speechSynthesis error:", e.error);
            setState("error");
          } else {
            setState("ready");
          }
        };
        speechSynthesis.speak(utt);
      }
    });
  }, [enabled]);

  const toggle = useCallback(() => setEnabled((prev) => !prev), []);

  return { enabled, state, errorMsg, toggle, speak, cancel, modelId: "" };
}
