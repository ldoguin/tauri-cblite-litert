/**
 * tools.ts — Tool registry and ReAct execution engine.
 *
 * Tools are invoked via a ReAct-style prompt loop:
 *   1. System prompt lists available tools with their schemas.
 *   2. LLM emits one or more <tool_call> blocks in its response.
 *   3. We parse, execute, and inject <tool_result> blocks.
 *   4. LLM generates a final answer with the results in context.
 *
 * Static tools (registered in ALL_TOOLS):
 *   - date_time         : current date, time, timezone
 *   - calculator        : safe arithmetic expression evaluator
 *   - wikipedia         : Wikipedia article summary (network)
 *   - fetch_url         : fetch any URL (network, Tauri only)
 *   - weather           : Open-Meteo forecast (network)
 *   - exchange_rates    : ECB/Frankfurter FX rates (network)
 *   - hacker_news       : HN stories and items (network)
 *   - unit_converter    : unit of measurement conversion
 *   - date_diff         : difference between two dates
 *   - text_stats        : word/char/reading-time stats
 *   - base64            : encode/decode Base64
 *   - json_query        : query a JSON value by dot-path
 *   - notes             : in-session note storage
 *
 * Dynamic tools (factory functions, registered in useChat):
 *   - knowledge_search  : semantic RAG search (needs embed engine)
 *   - web_search        : SearXNG / DuckDuckGo (needs searxngUrl config)
 *   - list_knowledge_pdfs / get_pdf_page / view_pdf_page  : PDF tools
 *   - list_knowledge_sources / read_source_chunks / search_knowledge_text : source tools
 */

// ── Tool definition ────────────────────────────────────────────────────────

export interface ToolParam {
  name: string;
  type: "string" | "number" | "boolean";
  description: string;
  required?: boolean;
}

export interface Tool {
  id: string;
  name: string;
  description: string;
  /** Whether the tool requires a network connection */
  requiresNetwork: boolean;
  params: ToolParam[];
  /**
   * Execute the tool and return a plain-text result.
   * `signal` is an AbortSignal that fires when the 15 s ReAct timeout expires;
   * network tools should pass it to fetch() so the request is actually cancelled.
   */
  run(args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

// ── Built-in tools ─────────────────────────────────────────────────────────

const dateTimeTool: Tool = {
  id: "date_time",
  name: "Date & Time",
  description: "Returns the current date, time, and timezone. No parameters needed.",
  requiresNetwork: false,
  params: [],
  async run(_args: Record<string, unknown>, _signal?: AbortSignal) {
    const now = new Date();
    return [
      `Date: ${now.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`,
      `Time: ${now.toLocaleTimeString()}`,
      `Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
      `ISO: ${now.toISOString()}`,
    ].join("\n");
  },
};

/**
 * Evaluates a math expression without using eval() or Function().
 * Supports: numbers, +, -, *, /, **, %, (, ), unary minus, and a
 * whitelist of Math.* identifiers. Uses a recursive descent parser.
 */
function safeEval(expr: string): number {
  // Allowed Math identifiers → their values
  const MATH_CONSTS: Record<string, number> = {
    PI: Math.PI, E: Math.E, LN2: Math.LN2, LN10: Math.LN10,
    LOG2E: Math.LOG2E, LOG10E: Math.LOG10E, SQRT2: Math.SQRT2,
  };
  // Allowed Math functions → their implementations
  const MATH_FUNS: Record<string, (...a: number[]) => number> = {
    abs: Math.abs, ceil: Math.ceil, floor: Math.floor, round: Math.round,
    sqrt: Math.sqrt, cbrt: Math.cbrt, exp: Math.exp, log: Math.log,
    log2: Math.log2, log10: Math.log10, sin: Math.sin, cos: Math.cos,
    tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
    atan2: Math.atan2, pow: Math.pow, min: Math.min, max: Math.max,
    hypot: Math.hypot, sign: Math.sign, trunc: Math.trunc,
  };

  let pos = 0;
  const src = expr.replace(/\s+/g, "");

  function peek() { return src[pos]; }
  function consume(ch?: string) {
    if (ch && src[pos] !== ch) throw new Error(`Expected '${ch}' at pos ${pos}`);
    return src[pos++];
  }

  function parseExpr(): number { return parseAddSub(); }

  function parseAddSub(): number {
    let left = parseMulDiv();
    while (peek() === "+" || peek() === "-") {
      const op = consume();
      const right = parseMulDiv();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  function parseMulDiv(): number {
    let left = parsePow();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = consume();
      const right = parsePow();
      if (op === "*") left *= right;
      else if (op === "/") left /= right;
      else left %= right;
    }
    return left;
  }

  function parsePow(): number {
    const base = parseUnary();
    if (src.slice(pos, pos + 2) === "**") { pos += 2; return base ** parsePow(); }
    return base;
  }

  function parseUnary(): number {
    if (peek() === "-") { consume(); return -parseUnary(); }
    if (peek() === "+") { consume(); return parseUnary(); }
    return parseAtom();
  }

  function parseAtom(): number {
    // Parenthesised sub-expression
    if (peek() === "(") {
      consume("(");
      const v = parseExpr();
      consume(")");
      return v;
    }
    // Number literal
    if (/[\d.]/.test(peek() ?? "")) {
      let s = "";
      while (/[\d.e+\-]/.test(peek() ?? "") && (s.length === 0 || !/[+\-]/.test(peek()) || /e/i.test(s.slice(-1)))) {
        s += consume();
      }
      const n = Number(s);
      if (isNaN(n)) throw new Error(`Invalid number: ${s}`);
      return n;
    }
    // Identifier: Math.xxx or bare constant/function name
    if (/[a-zA-Z_]/.test(peek() ?? "")) {
      let name = "";
      while (/[a-zA-Z0-9_.]/.test(peek() ?? "")) name += consume();
      // Strip leading "Math." prefix
      const key = name.startsWith("Math.") ? name.slice(5) : name;
      if (key in MATH_CONSTS) return MATH_CONSTS[key];
      if (key in MATH_FUNS) {
        consume("(");
        const args: number[] = [];
        if (peek() !== ")") {
          args.push(parseExpr());
          while (peek() === ",") { consume(","); args.push(parseExpr()); }
        }
        consume(")");
        return MATH_FUNS[key](...args);
      }
      throw new Error(`Unknown identifier: ${name}`);
    }
    throw new Error(`Unexpected character '${peek()}' at pos ${pos}`);
  }

  const result = parseExpr();
  if (pos !== src.length) throw new Error(`Unexpected token at pos ${pos}: '${src[pos]}'`);
  return result;
}

const calculatorTool: Tool = {
  id: "calculator",
  name: "Calculator",
  description: "Evaluates a mathematical expression. Supports +, -, *, /, **, %, parentheses, Math.* functions.",
  requiresNetwork: false,
  params: [
    { name: "expression", type: "string", description: "The math expression to evaluate, e.g. '2 ** 10' or 'Math.sqrt(144)'", required: true },
  ],
  async run({ expression }, _signal?: AbortSignal) {
    if (typeof expression !== "string") return "Error: expression must be a string";
    try {
      const result = safeEval(String(expression));
      return `${expression} = ${result}`;
    } catch (e) {
      return `Error: ${String(e)}`;
    }
  },
};

const wikipediaTool: Tool = {
  id: "wikipedia",
  name: "Wikipedia",
  description:
    "Fetches a short summary of a Wikipedia article by title. " +
    "Supports any Wikipedia language edition. Use the 'language' parameter when the topic " +
    "is more likely to have an article in a language other than English (e.g. 'fr' for French topics).",
  requiresNetwork: true,
  params: [
    { name: "query", type: "string", description: "The topic or article title to look up", required: true },
    { name: "language", type: "string", description: "Wikipedia language code, e.g. 'en' (default), 'fr', 'de', 'es', 'it'", required: false },
  ],
  async run({ query, language }, signal) {
    if (!query) return "Error: query is required";
    const lang = (typeof language === "string" && language.trim()) ? language.trim() : "en";
    const q = String(query);
    try {
      // Try direct title lookup first.
      let body: string;
      try {
        const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q)}`;
        body = await tauriFetch(url, signal);
      } catch {
        // Direct lookup failed (e.g. 404) — fall back to Wikipedia search API to
        // find the closest matching article title, then retry the summary endpoint.
        const searchUrl =
          `https://${lang}.wikipedia.org/w/api.php?action=query&list=search` +
          `&srsearch=${encodeURIComponent(q)}&format=json&origin=*&srlimit=1`;
        const searchBody = await tauriFetch(searchUrl, signal);
        const searchData = JSON.parse(searchBody) as {
          query?: { search?: Array<{ title: string }> };
        };
        const firstResult = searchData.query?.search?.[0];
        if (!firstResult) return `No Wikipedia article found for "${q}" (language: ${lang}).`;
        const retryUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(firstResult.title)}`;
        body = await tauriFetch(retryUrl, signal);
      }
      const data = JSON.parse(body) as { extract?: string; title?: string; type?: string };
      if (data.type === "disambiguation") {
        return `"${q}" is a disambiguation page. Try a more specific title.`;
      }
      return data.extract
        ? `**${data.title}**\n\n${data.extract}`
        : `No summary found for "${q}"`;
    } catch (e) {
      return `Error fetching Wikipedia: ${String(e)}`;
    }
  },
};

/**
 * Fetch the searx.space instance list, rank candidates by reported latency,
 * then probe the top ones with a real JSON search request to verify that
 * `format=json` is enabled and the instance isn't rate-limiting us.
 * Returns the URL of the first instance that responds successfully.
 */
export async function pickBestSearxInstance(): Promise<string> {
  const body = await tauriFetch("https://searx.space/data/instances.json");
  const data = JSON.parse(body) as {
    instances: Record<string, {
      network_type?: string;
      http?: { status_code?: number };
      engines?: Record<string, { error_rate?: number | null }>;
      timing?: {
        search?: {
          success_percentage?: number;
          all?: { median?: number };
        };
      };
    }>;
  };

  const candidates: Array<{ url: string; median: number }> = [];
  for (const [url, info] of Object.entries(data.instances)) {
    if (info.network_type !== "normal") continue;
    if (info.http?.status_code !== 200) continue;
    // Must have Google engine enabled with 0% error rate
    const googleEngine = info.engines?.google;
    if (!googleEngine || (googleEngine.error_rate ?? 100) !== 0) continue;
    const search = info.timing?.search;
    const sp = search?.success_percentage ?? 0;
    if (sp < 80) continue;
    const median = search?.all?.median;
    if (typeof median !== "number" || median >= 2.0) continue;
    candidates.push({ url: url.replace(/\/$/, ""), median });
  }

  if (candidates.length === 0) throw new Error("No healthy SearXNG instances found.");
  candidates.sort((a, b) => a.median - b.median);

  // Probe the top candidates in parallel; return the first that serves JSON.
  // A 5-second hard timeout prevents indefinite hangs when all instances are slow.
  const top = candidates.slice(0, 15);
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("probe timeout")), 5_000),
  );

  const probeOne = async (url: string): Promise<string> => {
    const testUrl = `${url}/search?q=wikipedia&format=json&categories=general&engines=google&language=en-US`;
    const resp = await tauriFetch(testUrl);
    const json = JSON.parse(resp) as { results?: unknown[] };
    if (!Array.isArray(json.results)) throw new Error("no results array");
    return url;
  };

  try {
    return await Promise.race([
      Promise.any(top.map(({ url }) => probeOne(url))),
      timeout,
    ]);
  } catch {
    throw new Error(
      "None of the tested SearXNG instances responded correctly. " +
      "Try again later, or enter an instance URL manually from https://searx.space/",
    );
  }
}

/** SearXNG JSON result shape (subset we care about). */
interface SearxResult {
  title?: string;
  url?: string;
  content?: string;
}

async function searchViaSearxng(
  instanceUrl: string,
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<string> {
  const base = instanceUrl.replace(/\/$/, "");
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&categories=general&engines=google&language=en-US`;
  const body = await tauriFetch(url, signal);
  let data: { results?: SearxResult[] };
  try {
    data = JSON.parse(body) as { results?: SearxResult[] };
  } catch {
    // Log full response to console for adb logcat diagnosis
    console.error("[searxng] non-JSON response from", base, ":", body.slice(0, 500));
    const isHtml = body.trimStart().startsWith("<");
    const is429 = body.includes("429") || body.toLowerCase().includes("too many");
    if (is429) throw new Error(`Rate limited by ${base}. Try Auto-pick again in Settings.`);
    if (isHtml) throw new Error(`${base} returned HTML instead of JSON. format=json may be disabled on this instance. Try Auto-pick again.`);
    throw new Error(`${base} returned unexpected response. Check adb logcat for details.`);
  }
  const results = (data.results ?? []).slice(0, limit);
  if (results.length === 0) return `No results found for "${query}". Try rephrasing.`;
  return results
    .map((r, i) => `[${i + 1}] ${r.title ?? ""}\n${r.content ?? ""}\n${r.url ?? ""}`)
    .join("\n\n");
}

async function searchViaDDG(
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<string> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const html = await tauriFetch(url, signal);

  if (html.includes("anomaly-modal") || html.includes("bots use DuckDuckGo")) {
    return "Search unavailable: DuckDuckGo returned a bot challenge. Configure a SearXNG instance in Settings for reliable search.";
  }

  // DDG Lite puts href before OR after class — match both orderings.
  // Also handle uddg= redirect links which wrap the real URL.
  const linkRe =
    /<a\s[^>]*?(?:class="result-link"[^>]*?href="([^"]*?)"|href="([^"]*?)"[^>]*?class="result-link")[^>]*?>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;

  const titles: Array<{ title: string; url: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const href = m[1] ?? m[2];
    const rawTitle = m[3].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/&lt;/g, "<").trim();
    if (!href || !rawTitle) continue;
    let resolvedUrl = href;
    try {
      const uddg = new URL("https://lite.duckduckgo.com" + href).searchParams.get("uddg");
      if (uddg) resolvedUrl = decodeURIComponent(uddg);
    } catch { /* keep href as-is */ }
    titles.push({ title: rawTitle, url: resolvedUrl });
  }

  // Fallback: grab any anchor whose href contains "uddg=" (handles relative,
  // protocol-relative, and full DDG redirect URLs, plus &amp; encoding).
  if (titles.length === 0) {
    console.debug("[DDG] class regex found 0 links; raw HTML head:", html.slice(0, 2000));
    const uddgRe = /href="([^"]*uddg=[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = uddgRe.exec(html)) !== null) {
      const raw = m[1].replace(/&amp;/g, "&");
      const rawTitle = m[2].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
      if (!rawTitle) continue;
      let resolvedUrl = raw;
      try {
        const base = raw.startsWith("http") ? raw : "https://lite.duckduckgo.com" + raw;
        const uddg = new URL(base).searchParams.get("uddg");
        if (uddg) resolvedUrl = decodeURIComponent(uddg);
      } catch { /* keep raw */ }
      titles.push({ title: rawTitle, url: resolvedUrl });
    }
  }

  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  }

  const results = titles.slice(0, limit).map((t, i) => ({ ...t, snippet: snippets[i] ?? "" }));
  if (results.length === 0) {
    console.debug("[DDG] 0 results; full HTML length:", html.length, "head:", html.slice(0, 2000));
    return `No results found for "${query}". Try rephrasing.`;
  }
  return results.map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\n${r.url}`).join("\n\n");
}

/**
 * Creates a web_search tool wired to a SearXNG instance when configured,
 * falling back to DuckDuckGo otherwise.
 */
export function createWebSearchTool(searxngUrl?: string): Tool {
  const backend = searxngUrl?.trim() ? `SearXNG (${searxngUrl.trim()})` : "DuckDuckGo";
  return {
    id: "web_search",
    name: "Web Search",
    description:
      "Searches the web. Use this for questions about people, current events, recent news, or facts you are unsure about. " +
      "Do NOT use for weather — use the weather tool instead. No API key required.",
    requiresNetwork: true,
    params: [
      { name: "query", type: "string", description: "The search query", required: true },
      { name: "max_results", type: "number", description: "Maximum number of results to return (default 5)", required: false },
    ],
    async run({ query, max_results }, signal) {
      if (!query) return "Error: query is required";
      const limit = typeof max_results === "number" ? Math.min(max_results, 10) : 5;
      try {
        const instance = searxngUrl?.trim();
        if (instance) return await searchViaSearxng(instance, String(query), limit, signal);
        return await searchViaDDG(String(query), limit, signal);
      } catch (e) {
        return `Search error (${backend}): ${String(e)}`;
      }
    },
  };
}

// ── knowledge_search tool (injected deps to avoid circular imports) ─────────

export interface KnowledgeSearchDeps {
  embed: (text: string) => Promise<number[]>;
  retrieveTopK: (
    vec: number[],
    text: string,
    topK: number,
    threshold: number,
  ) => Promise<Array<{ id: string; source: string; text: string; score: number; type: string; pageNumber?: number }>>;
}

/**
 * Returns a `knowledge_search` tool wired to the active RAG pipeline.
 * Call once after the embedding engine is initialised and pass the result
 * into `enabledTools` alongside the static tools.
 */
export function createKnowledgeSearchTool(deps: KnowledgeSearchDeps): Tool {
  return {
    id: "knowledge_search",
    name: "Knowledge Search",
    description:
      "Searches ONLY the user's locally uploaded documents and ingested knowledge. " +
      "Use ONLY when the user explicitly asks about their own documents, notes, or uploaded files. " +
      "Do NOT use for general questions, current events, or anything that requires internet access — use web_search for those.",
    requiresNetwork: false,
    params: [
      {
        name: "query",
        type: "string",
        description: "The search query — describe what you are looking for",
        required: true,
      },
      {
        name: "top_k",
        type: "number",
        description: "Maximum number of results to return (default 3, max 10)",
        required: false,
      },
    ],
    async run({ query, top_k }, _signal?: AbortSignal) {
      if (!query || typeof query !== "string") return "Error: query is required";
      const k = typeof top_k === "number" ? Math.min(Math.max(1, top_k), 10) : 3;
      try {
        const vec = await deps.embed(String(query));
        // Retrieve more chunks than requested so page-level aggregation has
        // enough candidates — a single PDF page can span several chunks.
        const chunkK = Math.max(k * 6, 18);
        const results = await deps.retrieveTopK(vec, String(query), chunkK, 0.2);
        if (results.length === 0) return "No relevant content found in the knowledge base.";

        // Aggregate PDF chunks by (source, pageNumber): sum scores and
        // concatenate text so each page appears as a single ranked result.
        // Non-PDF results (no pageNumber) are kept as-is.
        type PageEntry = { source: string; pageNumber: number; type: string; texts: string[]; score: number };
        const pageMap = new Map<string, PageEntry>();
        const nonPageResults: typeof results = [];

        for (const r of results) {
          if (r.pageNumber != null) {
            const key = `${r.source}\0${r.pageNumber}`;
            const entry = pageMap.get(key);
            if (entry) {
              entry.texts.push(r.text);
              entry.score += r.score;
            } else {
              pageMap.set(key, { source: r.source, pageNumber: r.pageNumber, type: r.type, texts: [r.text], score: r.score });
            }
          } else {
            nonPageResults.push(r);
          }
        }

        // Sort aggregated pages by total score descending, take top-k
        const pageResults = Array.from(pageMap.values())
          .sort((a, b) => b.score - a.score)
          .slice(0, k);

        const formatted: string[] = [];
        let idx = 1;
        for (const p of pageResults) {
          formatted.push(
            `[${idx++}] (${p.type}: ${p.source} page ${p.pageNumber}, agg-score: ${p.score.toFixed(3)})\n${p.texts.join(" [...] ")}`,
          );
        }
        // Fill remaining slots with non-page results
        for (const r of nonPageResults.slice(0, k - pageResults.length)) {
          formatted.push(`[${idx++}] (${r.type}: ${r.source}, score: ${r.score.toFixed(3)})\n${r.text}`);
        }
        return formatted.join("\n\n");
      } catch (e) {
        return `Knowledge search error: ${String(e)}`;
      }
    },
  };
}

// ── Skill imports ──────────────────────────────────────────────────────────

import { unitConverterTool } from "./skills/unit-converter";
import { dateDiffTool }       from "./skills/date-diff";
import { textStatsTool }      from "./skills/text-stats";
import { base64Tool }         from "./skills/base64";
import { jsonQueryTool }      from "./skills/json-query";
import { notesTool }          from "./skills/notes";
import { fetchUrlTool }       from "./skills/fetch-url";
import { weatherTool }        from "./skills/weather";
import { exchangeRatesTool }  from "./skills/exchange-rates";
import { hackerNewsTool }     from "./skills/hacker-news";
import { createTaskModelTools } from "./skills/task-models";

export { createSourceTools } from "./skills/source-tools";
export type { SourceToolDeps } from "./skills/source-tools";

// ── Registry ───────────────────────────────────────────────────────────────

import { isTauri } from "./db";

/**
 * On Tauri: fetch via the Rust `fetch_url` command (bypasses WebView CORS).
 * The Rust command has no native cancellation; we race it against the signal
 * so the JS side stops waiting on abort even if the Rust task continues.
 * On web: plain fetch with the provided signal.
 */
async function tauriFetch(url: string, signal?: AbortSignal): Promise<string> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const fetchPromise = invoke<string>("fetch_url", { url });
    if (!signal) return fetchPromise;
    // Race the invoke against the abort signal.
    return Promise.race([
      fetchPromise,
      new Promise<never>((_, reject) => {
        if (signal.aborted) { reject(signal.reason ?? new DOMException("Aborted", "AbortError")); return; }
        signal.addEventListener("abort", () =>
          reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
        { once: true });
      }),
    ]);
  }
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ── PDF tools (injected deps to avoid circular imports) ────────────────────

export interface PdfToolDeps {
  /** Return all knowledge chunks currently in memory. */
  getChunks: () => import("../lib/types").KnowledgeChunk[];
  /** Look up the on-disk path for a PDF by filename (null if not stored). */
  getPdfPath: (filename: string) => Promise<string | null>;
  /** Read a PDF file from disk and return its bytes as an ArrayBuffer. */
  readPdfBytes: (path: string) => Promise<ArrayBuffer>;
  /** Render a single PDF page to a JPEG data URL using pdf.js. */
  renderPdfPage: (buffer: ArrayBuffer, page: number) => Promise<string>;
  /** Extract text from a single PDF page. */
  extractPdfPageText: (buffer: ArrayBuffer, pageNum: number) => Promise<{ text: string; totalPages: number }>;
}

/**
 * Creates three PDF tools wired to the active PDF store + knowledge base.
 * Returned tools:
 *   - list_knowledge_pdfs  : lists PDF sources in the knowledge base
 *   - get_pdf_page         : extracts text from a specific page
 *   - view_pdf_page        : renders a page inline using pdf.js (returns JPEG data URL)
 */
export function createPdfTools(deps: PdfToolDeps): Tool[] {
  const listPdfsTool: Tool = {
    id: "list_knowledge_pdfs",
    name: "List Knowledge PDFs",
    description:
      "Lists all PDF files that have been ingested into the knowledge base. " +
      "Call this first to discover available filenames before using other PDF tools.",
    requiresNetwork: false,
    params: [],
    async run() {
      const chunks = deps.getChunks();
      const pdfs = [...new Set(
        chunks
          .map((c) => c.source)
          .filter((s) => s.toLowerCase().endsWith(".pdf")),
      )].sort();
      if (pdfs.length === 0) return "No PDF files found in the knowledge base.";
      return pdfs.join("\n");
    },
  };

  const getPdfPageTool: Tool = {
    id: "get_pdf_page",
    name: "Get PDF Page Text",
    description:
      "Extracts the text from a specific page of a PDF that was ingested into the " +
      "knowledge base. Use list_knowledge_pdfs first to find the correct filename.",
    requiresNetwork: false,
    params: [
      {
        name: "filename",
        type: "string",
        description: "PDF filename exactly as returned by list_knowledge_pdfs",
        required: true,
      },
      {
        name: "page",
        type: "number",
        description: "Page number (1-based)",
        required: true,
      },
    ],
    async run({ filename, page }) {
      if (!filename) return "Error: filename is required";
      const path = await deps.getPdfPath(String(filename));
      if (!path) {
        return `PDF "${filename}" is not in the local store. ` +
          "Re-ingest the file via the Knowledge panel so its pages become accessible.";
      }
      try {
        const buffer = await deps.readPdfBytes(path);
        const { text, totalPages } = await deps.extractPdfPageText(buffer, Number(page));
        if (!text) return `Page ${page} of "${filename}" appears to be empty (no extractable text).`;
        return `[${filename} — page ${page} of ${totalPages}]\n\n${text}`;
      } catch (e) {
        return `Error reading page: ${String(e)}`;
      }
    },
  };

  const viewPdfPageTool: Tool = {
    id: "view_pdf_page",
    name: "View PDF Page",
    description:
      "Renders a specific page of a PDF inline using pdf.js and displays it in the chat. " +
      "Use this when the user wants to see a page visually, or when knowledge_search " +
      "returns a result with a page number and you want to show that page. " +
      "Use list_knowledge_pdfs to find the filename first.",
    requiresNetwork: false,
    params: [
      {
        name: "filename",
        type: "string",
        description: "PDF filename exactly as returned by list_knowledge_pdfs",
        required: true,
      },
      {
        name: "page",
        type: "number",
        description: "1-based page number to render",
        required: true,
      },
    ],
    async run({ filename, page }) {
      if (!filename) return "Error: filename is required";
      const path = await deps.getPdfPath(String(filename));
      if (!path) {
        return `PDF "${filename}" is not in the local store. ` +
          "Re-ingest the file via the Knowledge panel so its pages become accessible.";
      }
      try {
        const buffer = await deps.readPdfBytes(path);
        // Returns a JPEG data URL — executeToolCalls intercepts it to store the
        // image separately and send a short summary to the LLM context instead.
        return await deps.renderPdfPage(buffer, Number(page));
      } catch (e) {
        return `Error rendering page: ${String(e)}`;
      }
    },
  };

  return [listPdfsTool, getPdfPageTool, viewPdfPageTool];
}

// ── Registry ───────────────────────────────────────────────────────────────

// knowledge_search, web_search, PDF tools, and source tools are created dynamically
// in useChat (they need injected deps or runtime config).
// fetch_url is Tauri-only (arbitrary URLs — no CORS on web).
export const ALL_TOOLS: Tool[] = [
  // Always-available offline tools
  dateTimeTool,
  calculatorTool,
  unitConverterTool,
  dateDiffTool,
  textStatsTool,
  base64Tool,
  jsonQueryTool,
  notesTool,
  // Network tools — CORS-friendly public APIs (work in both Tauri and web)
  wikipediaTool,
  weatherTool,
  exchangeRatesTool,
  hackerNewsTool,
  // Network tools — Tauri only (need Rust fetch_url to bypass CORS)
  ...(isTauri() ? [fetchUrlTool, createWebSearchTool()] : []),
  // On-device vision tools — Tauri only (need get_model_path + litert inference)
  ...(isTauri() ? createTaskModelTools() : []),
];

export function getToolById(id: string): Tool | undefined {
  return ALL_TOOLS.find((t) => t.id === id);
}

// ── System prompt injection ────────────────────────────────────────────────

/**
 * Builds the tool-use section of the system prompt.
 * Uses a simple XML-like syntax that most instruction-tuned LLMs follow
 * without fine-tuning.
 */
export function buildToolSystemPrompt(enabledTools: Tool[]): string {
  if (enabledTools.length === 0) return "";

  const toolDefs = enabledTools.map((t) => {
    const params = t.params.length > 0
      ? t.params.map((p) =>
          `    - ${p.name} (${p.type}${p.required ? ", required" : ", optional"}): ${p.description}`,
        ).join("\n")
      : "    (no parameters)";
    return `  <tool id="${t.id}">\n    ${t.description}\n    Parameters:\n${params}\n  </tool>`;
  }).join("\n");

  return `You have access to the following tools. Use them when they would help answer the user's question.

To call a tool, emit EXACTLY this format (nothing else on those lines):
<tool_call>
{"tool": "<tool_id>", "args": {<json args>}}
</tool_call>

You will receive the result as:
<tool_result>
<result text>
</tool_result>

Then continue your response using the result. You may call multiple tools sequentially.
Only call tools when necessary. Do not call tools for questions you can answer directly.

Available tools:
${toolDefs}`;
}

// ── ReAct parser ───────────────────────────────────────────────────────────

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

// Global regex used only in parseToolCalls — lastIndex is always reset before use.
const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
// Non-global regex for hasToolCall — avoids shared lastIndex state entirely.
const TOOL_CALL_RE_TEST = /<tool_call>/;

/** Extracts all <tool_call> blocks from a model response. */
export function parseToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  let match: RegExpExecArray | null;
  TOOL_CALL_RE.lastIndex = 0;
  while ((match = TOOL_CALL_RE.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]) as { tool: string; args?: Record<string, unknown> };
      if (parsed.tool) calls.push({ tool: parsed.tool, args: parsed.args ?? {} });
    } catch { /* skip malformed blocks */ }
  }
  return calls;
}

/** Returns true if the text contains at least one <tool_call> block. */
export function hasToolCall(text: string): boolean {
  return TOOL_CALL_RE_TEST.test(text);
}

// ── Execution ──────────────────────────────────────────────────────────────

export interface ToolExecution {
  /** Stable render key — tool name + monotonic counter */
  id: string;
  call: ToolCall;
  result: string;
  durationMs: number;
  /** Rendered PDF page data URL — set by view_pdf_page; displayed inline below result text */
  imageDataUrl?: string;
}

let _execCounter = 0;

/**
 * Executes all tool calls found in `modelResponse` and returns
 * the results plus a formatted context block to inject back into the LLM.
 */
export async function executeToolCalls(
  modelResponse: string,
  enabledTools: Tool[],
  /** Outer generation abort signal — cancels all tool fetches immediately when fired. */
  outerSignal?: AbortSignal,
): Promise<{ executions: ToolExecution[]; contextBlock: string }> {
  const calls = parseToolCalls(modelResponse);
  if (calls.length === 0) return { executions: [], contextBlock: "" };

  const executions: ToolExecution[] = [];

  for (const call of calls) {
    // Stop executing further tools if the outer generation was aborted.
    if (outerSignal?.aborted) break;

    const tool = enabledTools.find((t) => t.id === call.tool);
    const t0 = performance.now();
    let result: string;
    if (!tool) {
      result = `Error: unknown tool "${call.tool}"`;
    } else {
      // Combine the 15 s per-tool timeout with the outer generation signal so
      // that stopping generation immediately cancels any in-flight fetch.
      const toolAbort = new AbortController();
      const timeoutId = setTimeout(() => toolAbort.abort(new Error("Tool timed out after 15 s")), 15_000);
      // Forward outer abort to the tool's controller
      outerSignal?.addEventListener("abort", () => toolAbort.abort(outerSignal.reason), { once: true });
      try {
        result = await tool.run(call.args, toolAbort.signal);
      } catch (e) {
        result = `Error: ${String(e)}`;
      } finally {
        clearTimeout(timeoutId);
      }
    }
    // view_pdf_page returns a JPEG data URL. Store it in imageDataUrl and
    // send a concise text summary to the LLM context instead of the raw data URL.
    let imageDataUrl: string | undefined;
    if (call.tool === "view_pdf_page" && result.startsWith("data:image/")) {
      imageDataUrl = result;
      result = `Page ${call.args.page ?? "?"} of "${call.args.filename ?? "?"}" rendered and displayed inline.`;
    }
    executions.push({
      id: `${call.tool}-${++_execCounter}`,
      call,
      result,
      durationMs: performance.now() - t0,
      imageDataUrl,
    });
  }

  const contextBlock = executions
    .map(({ call, result }) =>
      `<tool_result tool="${call.tool}">\n${result}\n</tool_result>`,
    )
    .join("\n");

  return { executions, contextBlock };
}
