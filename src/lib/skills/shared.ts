/**
 * Shared network helper for skill files.
 *
 * On Tauri: delegates to the Rust `fetch_url` command (bypasses WebView CORS).
 * On web:   plain fetch with an optional AbortSignal.
 *
 * Each skill that needs network access imports `skillFetch` from here instead
 * of duplicating the Tauri-detection logic.
 */
export async function skillFetch(url: string, signal?: AbortSignal): Promise<string> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("fetch_url", { url });
  }
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
