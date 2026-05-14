/**
 * useKeyboardShortcuts — global keyboard shortcut handler.
 *
 * Shortcuts:
 *   Cmd/Ctrl + K          → new conversation
 *   Cmd/Ctrl + /          → focus chat input
 *   Cmd/Ctrl + F          → open search
 *   Cmd/Ctrl + Shift + K  → open knowledge base
 *   Cmd/Ctrl + Shift + A  → open agents panel
 *   Cmd/Ctrl + ,          → open settings
 *   Escape                → close open modal / stop generation
 *   Cmd/Ctrl + Shift + S  → stop generation
 */

import { useEffect, useRef } from "react";

export interface KeyboardShortcutHandlers {
  onNewConversation: () => void;
  onFocusInput: () => void;
  onOpenSearch: () => void;
  onOpenKnowledge: () => void;
  onOpenAgents: () => void;
  onOpenSettings: () => void;
  onEscape: () => void;
  onStopGeneration: () => void;
}

export function useKeyboardShortcuts(handlers: KeyboardShortcutHandlers) {
  // Store handlers in a ref so the event listener never goes stale and the
  // effect only runs once — avoids re-registering on every render.
  const handlersRef = useRef(handlers);
  useEffect(() => { handlersRef.current = handlers; });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const h = handlersRef.current;
      const mod = e.metaKey || e.ctrlKey;
      // Don't fire shortcuts when typing in an input/textarea
      const target = e.target as HTMLElement;
      const isTyping =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      if (e.key === "Escape") { h.onEscape(); return; }
      if (!mod) return;

      if (e.key === "k" && !e.shiftKey && !isTyping) { e.preventDefault(); h.onNewConversation(); return; }
      if (e.key === "/" && !e.shiftKey)               { e.preventDefault(); h.onFocusInput();      return; }
      if (e.key === "f" && !e.shiftKey && !isTyping)  { e.preventDefault(); h.onOpenSearch();      return; }
      // Guard panel-opening shortcuts with isTyping — Cmd+Shift+K/A and Cmd+,
      // must not fire while the user is typing (e.g. typing a comma with Cmd held).
      if (e.key === "k" && e.shiftKey && !isTyping)   { e.preventDefault(); h.onOpenKnowledge();   return; }
      if (e.key === "a" && e.shiftKey && !isTyping)   { e.preventDefault(); h.onOpenAgents();      return; }
      if (e.key === "," && !isTyping)                 { e.preventDefault(); h.onOpenSettings();    return; }
      if (e.key === "s" && e.shiftKey)                { e.preventDefault(); h.onStopGeneration();  return; }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []); // empty deps — listener registered once, handlers read via ref
}
