/**
 * json-query skill — parses a JSON string and extracts values by dot-path.
 *
 * Path syntax:
 *   .                    → root object
 *   foo                  → top-level key
 *   foo.bar              → nested key
 *   items[0].name        → array index + nested key
 *   results[*].title     → map over array, return array of titles
 *   keys(obj)            → list keys of an object
 *   length(arr)          → length of array or string
 */
import type { Tool } from "../tools";

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

function getByPath(root: JsonValue, path: string): JsonValue {
  if (!path || path === ".") return root;

  // Special functions
  const keysMatch = path.match(/^keys\((.+)\)$/);
  if (keysMatch) {
    const inner = getByPath(root, keysMatch[1]) as JsonValue;
    if (inner === null || typeof inner !== "object" || Array.isArray(inner))
      throw new Error(`keys() requires an object, got ${Array.isArray(inner) ? "array" : typeof inner}`);
    return Object.keys(inner);
  }
  const lenMatch = path.match(/^length\((.+)\)$/);
  if (lenMatch) {
    const inner = getByPath(root, lenMatch[1]) as JsonValue;
    if (typeof inner === "string") return inner.length;
    if (Array.isArray(inner)) return inner.length;
    if (inner && typeof inner === "object") return Object.keys(inner).length;
    throw new Error("length() requires an array, string, or object");
  }

  // Tokenise: split on . separators and [n] / [*] subscripts
  const tokens: Array<string | number | "*"> = [];
  const re = /([^.[]+)|\[(\d+|\*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    if (m[2] !== undefined) {
      tokens.push(m[2] === "*" ? "*" : parseInt(m[2], 10));
    } else {
      tokens.push(m[1]);
    }
  }

  let cur: JsonValue = root;
  for (const token of tokens) {
    if (cur === null || cur === undefined) return null;
    if (token === "*") {
      if (!Array.isArray(cur)) throw new Error(`[*] applied to non-array`);
      // Remaining path after [*] — collect the rest
      const remainingIdx = tokens.indexOf(token);
      const rest = tokens.slice(remainingIdx + 1).join(".");
      return (cur as JsonValue[]).map(item =>
        rest ? getByPath(item, rest) : item
      );
    }
    if (typeof token === "number") {
      if (!Array.isArray(cur)) throw new Error(`Index [${token}] applied to non-array`);
      cur = (cur as JsonValue[])[token] ?? null;
    } else {
      if (typeof cur !== "object" || Array.isArray(cur))
        throw new Error(`Key "${token}" applied to ${Array.isArray(cur) ? "array" : typeof cur}`);
      cur = (cur as Record<string, JsonValue>)[token] ?? null;
    }
  }
  return cur;
}

export const jsonQueryTool: Tool = {
  id: "json_query",
  name: "JSON Query",
  description:
    'Parses a JSON string and extracts a value by dot-path. ' +
    'Examples: "user.address.city", "items[0].name", "results[*].title", ' +
    '"keys(data)", "length(items)". Use "." to return the whole object.',
  requiresNetwork: false,
  params: [
    { name: "json", type: "string", description: "The JSON string to query", required: true },
    { name: "path", type: "string", description: 'Path expression, e.g. "user.name", "items[0]", "results[*].id"', required: true },
  ],
  async run({ json, path }) {
    if (!json) return "Error: json is required";
    try {
      const obj = JSON.parse(String(json)) as JsonValue;
      const result = getByPath(obj, path ? String(path) : ".");
      if (result === undefined || result === null) return `null (no value at path "${path}")`;
      if (typeof result === "string") return result;
      return JSON.stringify(result, null, 2);
    } catch (e) {
      return `Error: ${String(e)}`;
    }
  },
};
