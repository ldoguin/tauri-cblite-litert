/**
 * urlIngest.ts — Fetch a URL and extract readable text.
 *
 * On Tauri (desktop/Android): direct fetch — no CORS restriction.
 * On web: direct fetch is attempted first (works for CORS-permissive servers).
 *         If it fails with a network/CORS error, a clear message is shown
 *         rather than routing traffic through a third-party proxy.
 *
 * Text extraction strips HTML tags, collapses whitespace, and removes
 * script/style content.
 */

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Strips HTML and returns readable text. */
function htmlToText(html: string): string {
  // Remove script and style blocks entirely
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");

  // Replace block-level tags with newlines
  text = text.replace(/<\/(p|div|li|h[1-6]|tr|br|blockquote)>/gi, "\n");

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, " ");

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // Collapse whitespace
  return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export async function fetchUrlText(url: string): Promise<{ text: string; title: string }> {
  let html: string;

  // AbortSignal.timeout() is not available on Safari < 15.4 (Vite target
  // includes safari13). Use a manual AbortController + setTimeout instead.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error("Request timed out after 30 s")), 30_000);
  const timeout = controller.signal;

  try {
  if (isTauri()) {
    // Tauri: direct fetch, no CORS restriction
    const res = await fetch(url, { signal: timeout });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    html = await res.text();
  } else {
    // Web: attempt a direct fetch. Works for servers that send permissive
    // CORS headers (e.g. Wikipedia, many APIs). For servers that don't, the
    // browser will block the request — we surface a clear error rather than
    // routing user URLs through a third-party proxy.
    try {
      const res = await fetch(url, { signal: timeout });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      html = await res.text();
    } catch (e) {
      const msg = String(e);
      if (
        msg.includes("Failed to fetch") ||
        msg.includes("NetworkError") ||
        msg.includes("TypeError")
      ) {
        throw new Error(
          `Cannot fetch "${url}" from the browser — the server does not allow cross-origin requests. ` +
          "Use the Tauri desktop build to ingest arbitrary URLs.",
        );
      }
      throw e;
    }
  }

  } finally {
    clearTimeout(timeoutId);
  }

  // Extract <title>
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : url;

  return { text: htmlToText(html), title };
}
