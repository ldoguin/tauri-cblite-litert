/**
 * hacker-news skill — top stories, item lookup, and Ask HN / Show HN feeds.
 *
 * Uses the official HN Firebase REST API (no key required, CORS-enabled):
 *   https://hacker-news.firebaseio.com/v0/
 */
import type { Tool } from "../tools";
import { skillFetch } from "./shared";

interface HnItem {
  id: number;
  type?: string;
  title?: string;
  url?: string;
  text?: string;
  by?: string;
  score?: number;
  time?: number;
  descendants?: number;
  kids?: number[];
  dead?: boolean;
  deleted?: boolean;
}

const BASE = "https://hacker-news.firebaseio.com/v0";

async function fetchItem(id: number, signal?: AbortSignal): Promise<HnItem> {
  const body = await skillFetch(`${BASE}/item/${id}.json`, signal);
  return JSON.parse(body) as HnItem;
}

function ago(unixSec: number): string {
  const diffSec = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  if (diffSec < 60)    return `${diffSec}s ago`;
  if (diffSec < 3600)  return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function fmtItem(item: HnItem, rank?: number): string {
  if (item.dead || item.deleted) return "";
  const prefix = rank != null ? `${rank}. ` : "";
  const title  = item.title ?? "(no title)";
  const pts    = item.score  != null ? `${item.score} pts` : "";
  const cmts   = item.descendants != null ? `${item.descendants} cmts` : "";
  const when   = item.time ? ago(item.time) : "";
  const by     = item.by  ? `by ${item.by}` : "";
  const meta   = [pts, cmts, when, by].filter(Boolean).join(" · ");
  const link   = item.url ? `\n   ${item.url}` : "";
  const hnLink = `https://news.ycombinator.com/item?id=${item.id}`;
  return `${prefix}${title}\n   ${meta}\n   HN: ${hnLink}${link}`;
}

type Feed = "top" | "new" | "best" | "ask" | "show" | "job";

const FEED_ENDPOINTS: Record<Feed, string> = {
  top:  "topstories",
  new:  "newstories",
  best: "beststories",
  ask:  "askstories",
  show: "showstories",
  job:  "jobstories",
};

export const hackerNewsTool: Tool = {
  id: "hacker_news",
  name: "Hacker News",
  description:
    "Fetches Hacker News stories or a specific item. " +
    'Feeds: "top" (default), "new", "best", "ask", "show", "job". ' +
    'Use action="item" with an id to fetch a specific story or comment.',
  requiresNetwork: true,
  params: [
    {
      name: "action",
      type: "string",
      description: '"feed" (default) or "item"',
      required: false,
    },
    {
      name: "feed",
      type: "string",
      description: '"top" | "new" | "best" | "ask" | "show" | "job" (default: top)',
      required: false,
    },
    {
      name: "limit",
      type: "number",
      description: "Number of stories to return (default 10, max 30)",
      required: false,
    },
    {
      name: "id",
      type: "number",
      description: "HN item ID — required when action=item",
      required: false,
    },
  ],
  async run({ action, feed, limit, id }, signal) {
    const act = action ? String(action).trim().toLowerCase() : "feed";

    // ── Single item lookup ─────────────────────────────────────────────────
    if (act === "item") {
      if (!id) return 'Error: id is required when action="item"';
      try {
        const item = await fetchItem(Number(id), signal);
        if (!item) return `Item ${id} not found.`;
        const lines = [fmtItem(item)];
        if (item.text) {
          const plain = item.text.replace(/<[^>]+>/g, " ").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
          lines.push("", plain.slice(0, 1000) + (plain.length > 1000 ? "…" : ""));
        }
        return lines.join("\n");
      } catch (e) {
        return `Error fetching item ${id}: ${String(e)}`;
      }
    }

    // ── Feed ───────────────────────────────────────────────────────────────
    const feedKey: Feed = (FEED_ENDPOINTS[feed as Feed] ? (feed as Feed) : "top");
    const n = typeof limit === "number" ? Math.min(Math.max(1, limit), 30) : 10;

    try {
      const idsBody = await skillFetch(`${BASE}/${FEED_ENDPOINTS[feedKey]}.json`, signal);
      const ids = (JSON.parse(idsBody) as number[]).slice(0, n);
      const items = await Promise.all(ids.map((itemId) => fetchItem(itemId, signal)));
      const lines = [`Hacker News — ${feedKey} stories (${items.length})`, ""];
      items.forEach((item, i) => {
        const row = fmtItem(item, i + 1);
        if (row) lines.push(row, "");
      });
      return lines.join("\n").trimEnd();
    } catch (e) {
      return `Hacker News error: ${String(e)}`;
    }
  },
};
