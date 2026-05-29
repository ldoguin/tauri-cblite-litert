/**
 * source-tools — browse the knowledge base by source.
 *
 * list_knowledge_sources  : lists every unique source (filename / URL) in the KB
 * read_source_chunks      : returns all stored text chunks for a named source
 * search_knowledge_text   : BM25 full-text search via CBL FTS / in-memory fallback
 *
 * These complement knowledge_search (semantic) by giving the LLM a way to do
 * deterministic, exact-source retrieval when the user references a specific doc.
 */
import type { Tool } from "../tools";
import type { KnowledgeChunk } from "../types";
import { searchKnowledgeText } from "../db";

export interface SourceToolDeps {
  getChunks: () => KnowledgeChunk[];
}

export function createSourceTools(deps: SourceToolDeps): Tool[] {
  const listSourcesTool: Tool = {
    id: "list_knowledge_sources",
    name: "List Knowledge Sources",
    description:
      "Lists every document, URL, or text source that has been ingested into the " +
      "knowledge base, along with its type (pdf, url, text) and chunk count. " +
      "Call this before read_source_chunks to discover exact source names.",
    requiresNetwork: false,
    params: [],
    async run() {
      const chunks = deps.getChunks();
      if (chunks.length === 0) return "The knowledge base is empty.";

      // Aggregate by source
      const map = new Map<string, { type: string; count: number }>();
      for (const c of chunks) {
        const entry = map.get(c.source);
        if (entry) {
          entry.count++;
        } else {
          const src = c.source;
          const type = src.toLowerCase().endsWith(".pdf") ? "pdf"
            : src.startsWith("http://") || src.startsWith("https://") ? "url"
            : "text";
          map.set(src, { type, count: 1 });
        }
      }

      const lines = [`${map.size} source${map.size !== 1 ? "s" : ""} in knowledge base:`, ""];
      for (const [src, { type, count }] of map.entries()) {
        lines.push(`  [${type}] ${src}  (${count} chunk${count !== 1 ? "s" : ""})`);
      }
      return lines.join("\n");
    },
  };

  const readSourceChunksTool: Tool = {
    id: "read_source_chunks",
    name: "Read Source Chunks",
    description:
      "Returns the stored text chunks for a specific knowledge source. " +
      "Use list_knowledge_sources first to find the exact source name. " +
      "Optionally filter by chunk index range to avoid returning huge documents at once.",
    requiresNetwork: false,
    params: [
      {
        name: "source",
        type: "string",
        description: "Exact source name as returned by list_knowledge_sources",
        required: true,
      },
      {
        name: "from_chunk",
        type: "number",
        description: "First chunk index to return, 0-based (default 0)",
        required: false,
      },
      {
        name: "to_chunk",
        type: "number",
        description: "Last chunk index to return, inclusive (default: first 20 chunks)",
        required: false,
      },
    ],
    async run({ source, from_chunk, to_chunk }) {
      if (!source) return "Error: source is required";
      const src = String(source);
      const chunks = deps.getChunks().filter((c) => c.source === src);
      if (chunks.length === 0) {
        return (
          `No chunks found for source "${src}". ` +
          "Use list_knowledge_sources to see available sources."
        );
      }
      const from = typeof from_chunk === "number" ? Math.max(0, from_chunk) : 0;
      const to   = typeof to_chunk   === "number" ? Math.min(chunks.length - 1, to_chunk) : Math.min(chunks.length - 1, from + 19);
      const slice = chunks.slice(from, to + 1);
      const lines = [
        `Source: ${src}  (showing chunks ${from}–${to} of ${chunks.length})`,
        "",
      ];
      for (let i = 0; i < slice.length; i++) {
        lines.push(`[chunk ${from + i}]\n${slice[i].text}`);
        if (i < slice.length - 1) lines.push("");
      }
      return lines.join("\n");
    },
  };

  const searchTextTool: Tool = {
    id: "search_knowledge_text",
    name: "Search Knowledge Text",
    description:
      "Full-text (BM25) search over the knowledge base. Finds chunks that contain " +
      "specific keywords or phrases. Complements knowledge_search (semantic/vector) — " +
      "use this when you need keyword precision rather than conceptual similarity. " +
      "On Tauri uses the CouchbaseLite FTS index; on web falls back to substring matching.",
    requiresNetwork: false,
    params: [
      {
        name: "query",
        type: "string",
        description: "Keywords or phrase to search for",
        required: true,
      },
      {
        name: "limit",
        type: "number",
        description: "Maximum number of chunks to return (default 20, max 50)",
        required: false,
      },
    ],
    async run({ query, limit }) {
      if (!query) return "Error: query is required";
      const q = String(query);
      const n = typeof limit === "number" ? Math.min(Math.max(1, limit), 50) : 20;
      try {
        const chunks = await searchKnowledgeText(q, n);
        if (chunks.length === 0) return `No knowledge chunks matched "${q}".`;
        const lines = [`${chunks.length} result${chunks.length !== 1 ? "s" : ""} for "${q}":`, ""];
        for (const c of chunks) {
          lines.push(`[${c.source}]\n${c.text}`);
          lines.push("");
        }
        return lines.join("\n").trimEnd();
      } catch (e) {
        return `Error searching knowledge base: ${String(e)}`;
      }
    },
  };

  return [listSourcesTool, readSourceChunksTool, searchTextTool];
}
