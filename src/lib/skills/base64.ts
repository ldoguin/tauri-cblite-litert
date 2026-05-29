/**
 * base64 skill — encodes or decodes Base64 strings.
 *
 * Uses the browser's btoa / atob, wrapped with encodeURIComponent / decodeURIComponent
 * to handle non-Latin characters correctly.
 */
import type { Tool } from "../tools";

export const base64Tool: Tool = {
  id: "base64",
  name: "Base64 Encode / Decode",
  description: 'Encodes text to Base64 or decodes Base64 back to text. Works with UTF-8 content.',
  requiresNetwork: false,
  params: [
    { name: "action", type: "string", description: '"encode" or "decode"', required: true },
    { name: "text",   type: "string", description: "Text to encode, or Base64 string to decode", required: true },
  ],
  async run({ action, text }) {
    if (!action || !text) return "Error: action and text are required";
    const a = String(action).trim().toLowerCase();
    const t = String(text);
    try {
      if (a === "encode") {
        // Support full UTF-8 by percent-encoding first
        return btoa(encodeURIComponent(t).replace(/%([0-9A-F]{2})/g, (_, p1: string) =>
          String.fromCharCode(parseInt(p1, 16))
        ));
      }
      if (a === "decode") {
        return decodeURIComponent(
          Array.from(atob(t))
            .map(c => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
            .join("")
        );
      }
      return `Error: action must be "encode" or "decode", got "${a}"`;
    } catch (e) {
      return `Error: ${String(e)}`;
    }
  },
};
