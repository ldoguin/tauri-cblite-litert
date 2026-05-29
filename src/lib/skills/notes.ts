/**
 * notes skill — lightweight in-session note storage.
 *
 * Notes are kept in a module-level Map, so they survive React re-renders but
 * are cleared on page refresh / app restart.  Useful for LLMs that need to
 * remember structured information across multiple turns of a conversation.
 *
 * Actions: create · read · update · list · delete · search
 */
import type { Tool } from "../tools";

interface Note {
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

const store = new Map<string, Note>();

function now(): string {
  return new Date().toLocaleString();
}

export const notesTool: Tool = {
  id: "notes",
  name: "Notes",
  description:
    "Create, read, update, delete, list, and search short text notes. " +
    "Notes are kept in memory for the current session. " +
    "Useful for remembering intermediate results, user preferences, or structured information.",
  requiresNetwork: false,
  params: [
    { name: "action",  type: "string", description: '"create", "read", "update", "delete", "list", or "search"', required: true },
    { name: "title",   type: "string", description: "Note title (required for create/read/update/delete)",         required: false },
    { name: "content", type: "string", description: "Note content (required for create/update)",                   required: false },
    { name: "tags",    type: "string", description: "Comma-separated tags (optional, for create/update)",          required: false },
    { name: "query",   type: "string", description: "Search query (required for search action)",                   required: false },
  ],
  async run({ action, title, content, tags, query }) {
    const a = String(action ?? "").toLowerCase().trim();
    const t = title ? String(title).trim() : "";
    const c = content ? String(content) : "";
    const tagList = tags
      ? String(tags).split(",").map(s => s.trim()).filter(Boolean)
      : [];

    switch (a) {
      case "list": {
        if (store.size === 0) return "No notes saved. Use action=create to add one.";
        const lines = [`${store.size} note${store.size !== 1 ? "s" : ""}:`, ""];
        for (const [k, n] of store.entries()) {
          const tagStr = n.tags.length ? `  [${n.tags.join(", ")}]` : "";
          lines.push(`• ${k}${tagStr}  (updated ${n.updatedAt})`);
        }
        return lines.join("\n");
      }

      case "create": {
        if (!t) return "Error: title is required for create";
        if (!c) return "Error: content is required for create";
        if (store.has(t)) return `Note "${t}" already exists. Use action=update to overwrite it.`;
        store.set(t, { content: c, tags: tagList, createdAt: now(), updatedAt: now() });
        return `Note "${t}" created.`;
      }

      case "read": {
        if (!t) return "Error: title is required for read";
        const n = store.get(t);
        if (!n) return `Note "${t}" not found. Use action=list to see all notes.`;
        const tagStr = n.tags.length ? `Tags: ${n.tags.join(", ")}\n` : "";
        return `Title: ${t}\n${tagStr}Created: ${n.createdAt}\nUpdated: ${n.updatedAt}\n\n${n.content}`;
      }

      case "update": {
        if (!t) return "Error: title is required for update";
        if (!c) return "Error: content is required for update";
        const existing = store.get(t);
        if (!existing) return `Note "${t}" not found. Use action=create to make a new note.`;
        store.set(t, { ...existing, content: c, tags: tagList.length ? tagList : existing.tags, updatedAt: now() });
        return `Note "${t}" updated.`;
      }

      case "delete": {
        if (!t) return "Error: title is required for delete";
        if (!store.delete(t)) return `Note "${t}" not found.`;
        return `Note "${t}" deleted.`;
      }

      case "search": {
        const q = query ? String(query).toLowerCase() : (t ? t.toLowerCase() : "");
        if (!q) return "Error: provide a query parameter (or title as fallback) for search";
        const matches: string[] = [];
        for (const [k, n] of store.entries()) {
          if (
            k.toLowerCase().includes(q) ||
            n.content.toLowerCase().includes(q) ||
            n.tags.some(tag => tag.toLowerCase().includes(q))
          ) {
            matches.push(k);
          }
        }
        if (matches.length === 0) return `No notes match "${q}".`;
        const lines = [`${matches.length} note${matches.length !== 1 ? "s" : ""} matching "${q}":`, ""];
        for (const k of matches) {
          const n = store.get(k)!;
          const snippet = n.content.slice(0, 80) + (n.content.length > 80 ? "…" : "");
          lines.push(`• ${k}: ${snippet}`);
        }
        return lines.join("\n");
      }

      default:
        return `Error: unknown action "${a}". Valid actions: create, read, update, delete, list, search.`;
    }
  },
};
