/**
 * tools.ts — Tool registry and ReAct execution engine.
 *
 * Tools are invoked via a ReAct-style prompt loop:
 *   1. System prompt lists available tools with their schemas.
 *   2. LLM emits one or more <tool_call> blocks in its response.
 *   3. We parse, execute, and inject <tool_result> blocks.
 *   4. LLM generates a final answer with the results in context.
 *
 * Built-in tools (all offline-capable except web_search):
 *   - date_time    : current date, time, timezone — always available
 *   - calculator   : safe arithmetic expression evaluator — always available
 *   - wikipedia    : Wikipedia article summary — requires network
 *   - web_search   : DuckDuckGo Instant Answer API — requires network
 *                    (no API key needed; uses the public JSON endpoint)
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
  description: "Fetches a short summary of a Wikipedia article by title.",
  requiresNetwork: true,
  params: [
    { name: "query", type: "string", description: "The topic or article title to look up", required: true },
  ],
  async run({ query }, signal) {
    if (!query) return "Error: query is required";
    try {
      const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(String(query))}`;
      const res = await fetch(url, { headers: { "Accept": "application/json" }, signal });
      if (!res.ok) return `Wikipedia returned ${res.status} for "${query}"`;
      const data = await res.json() as { extract?: string; title?: string; type?: string };
      if (data.type === "disambiguation") {
        return `"${query}" is a disambiguation page. Try a more specific title.`;
      }
      return data.extract
        ? `**${data.title}**\n\n${data.extract}`
        : `No summary found for "${query}"`;
    } catch (e) {
      return `Error fetching Wikipedia: ${String(e)}`;
    }
  },
};

const webSearchTool: Tool = {
  id: "web_search",
  name: "Web Search",
  description: "Searches the web using DuckDuckGo and returns the top results. No API key required.",
  requiresNetwork: true,
  params: [
    { name: "query", type: "string", description: "The search query", required: true },
    { name: "max_results", type: "number", description: "Maximum number of results to return (default 5)", required: false },
  ],
  async run({ query, max_results }, signal) {
    if (!query) return "Error: query is required";
    const limit = typeof max_results === "number" ? Math.min(max_results, 10) : 5;
    try {
      // DuckDuckGo Instant Answer API — no key required.
      // Only registered in ALL_TOOLS on Tauri where CORS is not a constraint.
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(String(query))}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
      const res = await fetch(url, { signal });
      if (!res.ok) return `Search failed: HTTP ${res.status}`;
      const data = await res.json() as {
        AbstractText?: string;
        AbstractURL?: string;
        AbstractSource?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
        Answer?: string;
      };

      const lines: string[] = [];

      if (data.Answer) lines.push(`Answer: ${data.Answer}`);

      if (data.AbstractText) {
        lines.push(`Summary (${data.AbstractSource}): ${data.AbstractText}`);
        if (data.AbstractURL) lines.push(`Source: ${data.AbstractURL}`);
      }

      // Flatten related topics
      const topics = (data.RelatedTopics ?? []).flatMap((t) =>
        t.Topics ? t.Topics : [t],
      );

      for (const topic of topics.slice(0, limit)) {
        if (topic.Text) {
          lines.push(`• ${topic.Text}${topic.FirstURL ? ` — ${topic.FirstURL}` : ""}`);
        }
      }

      return lines.length > 0
        ? lines.join("\n")
        : `No results found for "${query}". Try rephrasing.`;
    } catch (e) {
      return `Search error: ${String(e)}`;
    }
  },
};

// ── knowledge_search tool (injected deps to avoid circular imports) ─────────

export interface KnowledgeSearchDeps {
  embed: (text: string) => Promise<number[]>;
  retrieveTopK: (
    vec: number[],
    text: string,
    topK: number,
    threshold: number,
  ) => Promise<Array<{ id: string; source: string; text: string; score: number; type: string }>>;
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
      "Searches the local knowledge base (uploaded documents and past conversation context) " +
      "using semantic similarity. Use when the user asks about something that may be in their documents.",
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
        const results = await deps.retrieveTopK(vec, String(query), k, 0.2);
        if (results.length === 0) return "No relevant content found in the knowledge base.";
        return results
          .map((r, i) =>
            `[${i + 1}] (${r.type}: ${r.source}, score: ${r.score.toFixed(3)})\n${r.text}`,
          )
          .join("\n\n");
      } catch (e) {
        return `Knowledge search error: ${String(e)}`;
      }
    },
  };
}

// ── Registry ───────────────────────────────────────────────────────────────

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// web_search is excluded on web builds — the DuckDuckGo API is blocked by
// browser CORS policy. Exposing it would cause every call to return an error
// string to the LLM, wasting context and confusing the model.
// knowledge_search is not in ALL_TOOLS because it requires injected deps;
// it is created and added dynamically in useChat after embedding is ready.
export const ALL_TOOLS: Tool[] = [
  dateTimeTool,
  calculatorTool,
  wikipediaTool,
  ...(isTauri() ? [webSearchTool] : []),
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
    executions.push({ id: `${call.tool}-${++_execCounter}`, call, result, durationMs: performance.now() - t0 });
  }

  const contextBlock = executions
    .map(({ call, result }) =>
      `<tool_result tool="${call.tool}">\n${result}\n</tool_result>`,
    )
    .join("\n");

  return { executions, contextBlock };
}
