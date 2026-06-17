import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Text-to-speech hook.
 *
 * NOTE: This file was missing from the repository (App.tsx imported
 * `./hooks/useTts` but it was never committed, which broke the frontend build
 * on every platform). It has been reconstructed from App.tsx's usage to satisfy
 * the same interface. The implementation uses the browser Web Speech API
 * (`window.speechSynthesis`), which is available in the iOS WKWebView and in
 * desktop WebViews. The optional `modelId` argument is accepted for forward
 * compatibility with an on-device neural TTS model but is not used yet.
 */

export type TtsState = "idle" | "loading" | "speaking" | "error";

export interface UseTts {
  /** Whether TTS is turned on by the user. */
  enabled: boolean;
  /** Current playback state. */
  state: TtsState;
  /** Last error message, if state === "error". */
  errorMsg: string | null;
  /** Toggle TTS on/off. Turning it off also cancels any current speech. */
  toggle: () => void;
  /** Speak the given text (no-op unless enabled). */
  speak: (text: string) => void;
  /** Stop any in-progress speech. */
  cancel: () => void;
}

function getSynth(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null;
  return window.speechSynthesis ?? null;
}

export function useTts(modelId?: string): UseTts {
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<TtsState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Keep `enabled` reachable from callbacks without making them change identity.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const cancel = useCallback(() => {
    const synth = getSynth();
    if (synth) {
      try {
        synth.cancel();
      } catch {
        /* ignore */
      }
    }
    setState("idle");
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (!enabledRef.current) return;
      const trimmed = (text ?? "").trim();
      if (!trimmed) return;

      const synth = getSynth();
      if (!synth) {
        setErrorMsg("Speech synthesis is not available in this WebView");
        setState("error");
        return;
      }

      try {
        // Cancel anything already queued so we don't stack utterances.
        synth.cancel();
        const utt = new SpeechSynthesisUtterance(trimmed);
        utt.onstart = () => setState("speaking");
        utt.onend = () => setState("idle");
        utt.onerror = (ev) => {
          // "interrupted"/"canceled" are expected when we cancel intentionally.
          const err = (ev as SpeechSynthesisErrorEvent).error;
          if (err === "interrupted" || err === "canceled") {
            setState("idle");
            return;
          }
          setErrorMsg(err ?? "tts error");
          setState("error");
        };
        setErrorMsg(null);
        setState("speaking");
        synth.speak(utt);
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : String(e));
        setState("error");
      }
    },
    [],
  );

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      if (!next) cancel();
      return next;
    });
  }, [cancel]);

  // If a model id was provided, this is where a neural TTS engine would be
  // loaded. Web Speech API needs no loading, so we just clear any prior error.
  useEffect(() => {
    setErrorMsg(null);
    setState("idle");
  }, [modelId]);

  // Stop speaking when the component using the hook unmounts.
  useEffect(() => cancel, [cancel]);

  return useMemo(
    () => ({ enabled, state, errorMsg, toggle, speak, cancel }),
    [enabled, state, errorMsg, toggle, speak, cancel],
  );
}
