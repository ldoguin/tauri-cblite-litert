import { useState, useEffect, useRef, useCallback } from "react";
import type { Message } from "../lib/types";

export type SearchResult = {
  convId: string;
  convTitle: string;
  messageId: string;
  snippet: string;
  role: string;
};

interface Props {
  onSearch: (query: string) => Promise<SearchResult[]>;
  onJump: (convId: string, messageId: string) => void;
  /** Bookmarked messages to show in the Bookmarks tab */
  bookmarks: Message[];
  onJumpBookmark: (convId: string, messageId: string) => void;
  onRemoveBookmark: (messageId: string) => void;
  onClose: () => void;
}

type Tab = "search" | "bookmarks";

function highlight(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="search-highlight">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export function SearchPanel({
  onSearch,
  onJump,
  bookmarks,
  onJumpBookmark,
  onRemoveBookmark,
  onClose,
}: Props) {
  const [tab, setTab] = useState<Tab>("search");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  // Auto-focus input on open
  useEffect(() => { inputRef.current?.focus(); }, []);

  // Clear pending debounce on unmount
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); return; }
    setSearching(true);
    try {
      const res = await onSearch(q);
      if (isMountedRef.current) setResults(res);
    } catch {
      if (isMountedRef.current) setResults([]);
    } finally {
      if (isMountedRef.current) setSearching(false);
    }
  }, [onSearch]);

  const handleQueryChange = (q: string) => {
    setQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(q), 300);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    if (e.key === "Enter") runSearch(query);
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-panel search-panel">
        <div className="search-panel-header">
          <div className="search-tabs">
            <button
              className={`search-tab ${tab === "search" ? "active" : ""}`}
              onClick={() => setTab("search")}
            >
              🔍 Search
            </button>
            <button
              className={`search-tab ${tab === "bookmarks" ? "active" : ""}`}
              onClick={() => setTab("bookmarks")}
            >
              ★ Bookmarks
              {bookmarks.length > 0 && (
                <span className="search-tab-count">{bookmarks.length}</span>
              )}
            </button>
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {tab === "search" && (
          <>
            <div className="search-input-row">
              <input
                ref={inputRef}
                className="search-input"
                type="text"
                placeholder="Search all conversations…"
                value={query}
                onChange={(e) => handleQueryChange(e.target.value)}
                onKeyDown={handleKeyDown}
              />
              {searching && <span className="spinner-sm" />}
            </div>

            <div className="search-results">
              {results.length === 0 && query.trim() && !searching && (
                <div className="search-empty">No results for "{query}"</div>
              )}
              {results.length === 0 && !query.trim() && (
                <div className="search-empty search-hint">
                  Type to search across all conversations
                </div>
              )}
              {results.map((r) => (
                <button
                  key={`${r.convId}-${r.messageId}`}
                  className="search-result-row"
                  onClick={() => { onJump(r.convId, r.messageId); onClose(); }}
                >
                  <div className="search-result-meta">
                    <span className={`search-result-role role-${r.role}`}>
                      {r.role === "user" ? "You" : "Assistant"}
                    </span>
                    <span className="search-result-conv">{r.convTitle}</span>
                  </div>
                  <div className="search-result-snippet">
                    {highlight(r.snippet, query)}
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        {tab === "bookmarks" && (
          <div className="search-results">
            {bookmarks.length === 0 && (
              <div className="search-empty search-hint">
                Bookmark messages with ☆ to save them here
              </div>
            )}
            {bookmarks.map((msg) => (
              <div key={msg.id} className="search-result-row bookmark-row">
                <button
                  className="bookmark-row-content"
                  onClick={() => { onJumpBookmark(msg.conversationId, msg.id); onClose(); }}
                >
                  <div className="search-result-meta">
                    <span className={`search-result-role role-${msg.role}`}>
                      {msg.role === "user" ? "You" : "Assistant"}
                    </span>
                    <span className="search-result-conv">
                      {new Date(msg.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="search-result-snippet">
                    {msg.content.slice(0, 160)}{msg.content.length > 160 ? "…" : ""}
                  </div>
                </button>
                <button
                  className="bookmark-remove-btn"
                  title="Remove bookmark"
                  onClick={() => onRemoveBookmark(msg.id)}
                >
                  ★
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
