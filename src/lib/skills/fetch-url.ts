/**
 * fetch-url skill — retrieves the raw text content of any URL.
 *
 * Uses the Tauri `fetch_url` Rust command when available (bypasses CORS).
 * Falls back to plain fetch on web builds (subject to CORS restrictions).
 *
 * Useful for: reading API responses, plain-text files, RSS feeds, documentation.
 * For full HTML pages, the raw HTML is returned — the LLM can strip tags or summarise.
 */
import type { Tool } from "../tools";
import { skillFetch } from "./shared";

export const fetchUrlTool: Tool = {
  id: "fetch_url",
  name: "Fetch URL",
  description:
    "Fetches the text content of any URL. Useful for reading web pages, raw APIs, " +
    "JSON endpoints, RSS feeds, or plain-text files. Returns up to 8 000 characters by default.",
  requiresNetwork: true,
  params: [
    { name: "url",       type: "string", description: "The full URL to fetch (http or https)", required: true  },
    { name: "max_chars", type: "number", description: "Maximum characters to return (default 8000, max 32000)", required: false },
  ],
  async run({ url, max_chars }, signal) {
    if (!url) return "Error: url is required";
    const limit = typeof max_chars === "number"
      ? Math.min(Math.max(100, max_chars), 32_000)
      : 8_000;
    try {
      const text = await skillFetch(String(url), signal);
      if (text.length <= limit) return text;
      return (
        text.slice(0, limit) +
        `\n\n… [Truncated: ${text.length.toLocaleString()} chars total, showing first ${limit.toLocaleString()}]`
      );
    } catch (e) {
      return `Error fetching "${url}": ${String(e)}`;
    }
  },
};
