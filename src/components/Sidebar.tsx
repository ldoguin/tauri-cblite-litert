import { useState, useRef, useEffect } from "react";
import type { Conversation, Agent } from "../lib/types";

interface Props {
  conversations: Conversation[];
  activeConvId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onUpdateInstruction: (id: string, instruction: string) => void;
  onExport: (format: "markdown" | "json") => void;
  onSearch: (query: string) => Promise<Array<{ convId: string; convTitle: string; messageId: string; snippet: string; role: string }>>;
  onShowKnowledge: () => void;
  onShowAgents: () => void;
  onShowTools: () => void;
  onShowSettings: () => void;
  onShowSearch: () => void;
  onSummarise: () => void;
  isGenerating: boolean;
  activeAgent: Agent | null;
}

export function Sidebar({
  conversations, activeConvId, onSelect, onCreate, onDelete, onRename, onUpdateInstruction,
  onExport, onSearch, onShowKnowledge, onShowAgents, onShowTools, onShowSettings, onShowSearch, onSummarise, isGenerating, activeAgent,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editingInstructionId, setEditingInstructionId] = useState<string | null>(null);
  const [instructionValue, setInstructionValue] = useState("");
  const [search, setSearch] = useState("");
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [searchResults, setSearchResults] = useState<Array<{ convId: string; convTitle: string; messageId: string; snippet: string; role: string }> | null>(null);
  const [searching, setSearching] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  // Reset per-conversation UI state when the active conversation changes so
  // stale dropdowns/edit fields don't bleed onto the newly selected item.
  useEffect(() => {
    setEditingId(null);
    setShowExportMenu(false);
    setEditingInstructionId(null);
  }, [activeConvId]);

  // Clear pending debounce on unmount to prevent setState on unmounted component
  useEffect(() => () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); }, []);

  const handleSearchChange = (value: string) => {
    setSearch(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!value.trim()) { setSearchResults(null); return; }
    searchTimerRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const results = await onSearch(value);
        if (isMountedRef.current) setSearchResults(results);
      } catch {
        // Search failure is non-fatal — clear results and let user retry
        if (isMountedRef.current) setSearchResults(null);
      } finally {
        if (isMountedRef.current) setSearching(false);
      }
    }, 350);
  };

  const filtered = search.trim() && searchResults === null
    ? conversations.filter((c) => c.title.toLowerCase().includes(search.toLowerCase()))
    : conversations;

  const startEdit = (id: string, current: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(id);
    setEditValue(current);
  };

  // Guard against double-fire: pressing Enter calls commitEdit, which clears
  // editingId and blurs the input, which would call commitEdit again via onBlur.
  const editCommittedRef = useRef(false);
  const commitEdit = (id: string) => {
    if (editCommittedRef.current) return;
    editCommittedRef.current = true;
    if (editValue.trim()) onRename(id, editValue.trim());
    setEditingId(null);
  };
  // Reset the guard whenever a new edit session starts (editingId changes).
  useEffect(() => { editCommittedRef.current = false; }, [editingId]);

  const startEditInstruction = (conv: Conversation, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingInstructionId(conv.id);
    setInstructionValue(conv.systemInstruction ?? "");
  };

  const commitInstruction = (id: string) => {
    onUpdateInstruction(id, instructionValue);
    setEditingInstructionId(null);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Conversations</span>
        <button className="icon-btn" onClick={onShowSearch} title="Search & bookmarks (Cmd+F)">🔍</button>
        <button className="icon-btn" onClick={onCreate} title="New conversation">＋</button>
      </div>

      <div className="sidebar-search-wrap">
        <input
          className="sidebar-search"
          placeholder="Search messages…"
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
        />
        {search && (
          <button className="sidebar-search-clear" onClick={() => { setSearch(""); setSearchResults(null); }}>✕</button>
        )}
      </div>

      {/* Full-text search results */}
      {search.trim() && (
        <div className="search-results">
          {searching && <div className="search-status">Searching…</div>}
          {!searching && searchResults !== null && searchResults.length === 0 && (
            <div className="search-status">No results</div>
          )}
          {!searching && searchResults !== null && searchResults.map((r) => (
            <button
              key={r.messageId}
              className="search-result-item"
              onClick={() => { onSelect(r.convId); setSearch(""); setSearchResults(null); }}
            >
              <span className="search-result-conv">{r.convTitle}</span>
              <span className="search-result-role">{r.role === "user" ? "You" : "AI"}</span>
              <span className="search-result-snippet">{r.snippet}</span>
            </button>
          ))}
        </div>
      )}

      <ul className="conv-list">
        {filtered.length === 0 && (
          <li className="conv-empty">{search ? "No matches" : "No conversations yet"}</li>
        )}
        {filtered.map((c) => (
          <li key={c.id} className={`conv-item ${c.id === activeConvId ? "active" : ""}`}>
            {editingId === c.id ? (
              <input
                className="conv-rename-input"
                value={editValue}
                autoFocus
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={() => commitEdit(c.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitEdit(c.id);
                  if (e.key === "Escape") setEditingId(null);
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <>
                <button className="conv-btn" onClick={() => onSelect(c.id)} title={c.title}>
                  <span className="conv-icon">💬</span>
                  <span className="conv-label">{c.title}</span>
                </button>
                <button className="conv-action" title="Rename"
                  onClick={(e) => startEdit(c.id, c.title, e)}>✎</button>
                {c.id === activeConvId && (
                  <div className="conv-export-wrap">
                    <button className="conv-action" title="Export"
                      onClick={(e) => { e.stopPropagation(); setShowExportMenu((v) => !v); }}>⬇</button>
                    {showExportMenu && (
                      <div className="conv-export-menu" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => { onExport("markdown"); setShowExportMenu(false); }}>Markdown</button>
                        <button onClick={() => { onExport("json"); setShowExportMenu(false); }}>JSON</button>
                      </div>
                    )}
                  </div>
                )}
                {c.id === activeConvId && (
                  <button
                    className="conv-action"
                    title={c.systemInstruction ? "Edit system instruction" : "Add system instruction"}
                    onClick={(e) => startEditInstruction(c, e)}
                    aria-label="Edit system instruction"
                  >
                    {c.systemInstruction ? "📌" : "📎"}
                  </button>
                )}
                <button className="conv-delete" title="Delete"
                  onClick={(e) => { e.stopPropagation(); onDelete(c.id); }}>✕</button>
              </>
            )}
          </li>
        ))}
      </ul>

      {editingInstructionId && (
        <div className="conv-instruction-editor" onClick={(e) => e.stopPropagation()}>
          <label className="conv-instruction-label">System instruction for this conversation</label>
          <textarea
            className="conv-instruction-input"
            value={instructionValue}
            autoFocus
            rows={4}
            placeholder="Override the default system prompt for this conversation…"
            onChange={(e) => setInstructionValue(e.target.value)}
            aria-label="System instruction"
          />
          <div className="conv-instruction-actions">
            <button className="btn-sm primary" onClick={() => commitInstruction(editingInstructionId)}>Save</button>
            <button className="btn-sm secondary" onClick={() => setEditingInstructionId(null)}>Cancel</button>
            {instructionValue && (
              <button className="btn-sm danger" onClick={() => { setInstructionValue(""); commitInstruction(editingInstructionId); }}>Clear</button>
            )}
          </div>
        </div>
      )}

      <div className="sidebar-footer">
        <button className="footer-btn agent-footer-btn" onClick={onShowAgents}>
          🤖 {activeAgent ? activeAgent.name : "Agents"}
          {activeAgent && <span className="agent-footer-active-dot" />}
        </button>
        <button className="footer-btn" onClick={onShowKnowledge}>📚 Knowledge Base</button>
        <button className="footer-btn" onClick={onShowTools}>🛠️ Tools</button>
        <button
          className="footer-btn"
          onClick={onSummarise}
          disabled={isGenerating}
          title={isGenerating ? "Cannot summarise while generating" : "Compress old messages into a summary"}
          aria-disabled={isGenerating}
        >📝 Summarise</button>
        <button className="footer-btn" onClick={onShowSettings}>⚙️ Settings</button>
      </div>
    </aside>
  );
}
