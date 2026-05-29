import { useState, useRef, useEffect } from "react";
import type { Conversation, Agent } from "../lib/types";

export type SidebarSection = "conversations" | "knowledge" | "agents" | "settings";

interface Props {
  section: SidebarSection;
  onSectionChange: (s: SidebarSection) => void;

  // Conversations
  conversations: Conversation[];
  activeConvId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onUpdateInstruction: (id: string, instruction: string) => void;
  onExport: (format: "markdown" | "json") => void;
  onSearch: (query: string) => Promise<Array<{ convId: string; convTitle: string; messageId: string; snippet: string; role: string }>>;
  onShowSearch: () => void;
  onSummarise: () => void;
  isGenerating: boolean;
  onShowKnowledge: () => void;

  // Agents
  agents: Agent[];
  activeEditAgentId: string | null | "new";
  onSelectAgent: (id: string | null) => void;
  onCreateAgent: () => void;
  onDeleteAgent: (id: string) => void;

  // Knowledge
  knowledgeSources: { name: string; count: number }[];
  activeKnowledgeSource: string | null;
  onSelectKnowledgeSource: (source: string | null) => void;
  onDeleteKnowledgeSource: (source: string) => void;
  onAddKnowledge: () => void;

}

export function Sidebar({
  section, onSectionChange,
  conversations, activeConvId, onSelect, onCreate, onDelete, onRename, onUpdateInstruction,
  onExport, onSearch, onShowSearch, onSummarise, isGenerating, onShowKnowledge,
  agents, activeEditAgentId, onSelectAgent, onCreateAgent, onDeleteAgent,
  knowledgeSources, activeKnowledgeSource, onSelectKnowledgeSource, onDeleteKnowledgeSource, onAddKnowledge,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editingInstructionId, setEditingInstructionId] = useState<string | null>(null);
  const [instructionValue, setInstructionValue] = useState("");
  const [search, setSearch] = useState("");
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [searchResults, setSearchResults] = useState<Array<{ convId: string; convTitle: string; messageId: string; snippet: string; role: string }> | null>(null);
  const [searching, setSearching] = useState(false);
  const [agentDeleteConfirmId, setAgentDeleteConfirmId] = useState<string | null>(null);
  const [knowledgeDeleteConfirm, setKnowledgeDeleteConfirm] = useState<string | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(false);
  useEffect(() => { isMountedRef.current = true; return () => { isMountedRef.current = false; }; }, []);

  useEffect(() => {
    setEditingId(null);
    setShowExportMenu(false);
    setEditingInstructionId(null);
  }, [activeConvId]);

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
        if (isMountedRef.current) setSearchResults(null);
      } finally {
        if (isMountedRef.current) setSearching(false);
      }
    }, 350);
  };

  const filtered = search.trim() && searchResults === null
    ? conversations.filter((c) => c.title.toLowerCase().includes(search.toLowerCase()))
    : conversations;

  const editCommittedRef = useRef(false);
  const commitEdit = (id: string) => {
    if (editCommittedRef.current) return;
    editCommittedRef.current = true;
    if (editValue.trim()) onRename(id, editValue.trim());
    setEditingId(null);
  };
  useEffect(() => { editCommittedRef.current = false; }, [editingId]);

  const commitInstruction = (id: string) => {
    onUpdateInstruction(id, instructionValue);
    setEditingInstructionId(null);
  };

  return (
    <aside className="sidebar">
      {/* ── Section tab bar ──────────────────────────────────────────────── */}
      <nav className="sidebar-tabs">
        {(["conversations", "knowledge", "agents", "settings"] as SidebarSection[]).map((s) => {
          const icons: Record<SidebarSection, string> = {
            conversations: "💬", knowledge: "📚", agents: "🤖", settings: "⚙️",
          };
          const labels: Record<SidebarSection, string> = {
            conversations: "Chats", knowledge: "Docs", agents: "Agents", settings: "Settings",
          };
          return (
            <button
              key={s}
              className={`sidebar-tab ${section === s ? "active" : ""}`}
              onClick={() => onSectionChange(s)}
              title={labels[s]}
            >
              <span className="sidebar-tab-icon">{icons[s]}</span>
              <span className="sidebar-tab-label">{labels[s]}</span>
            </button>
          );
        })}
      </nav>

      {/* ── Conversations ─────────────────────────────────────────────────── */}
      {section === "conversations" && (
        <>
          <div className="sidebar-header">
            <span className="sidebar-title">Conversations</span>
            <button className="icon-btn" onClick={onShowSearch} title="Search & bookmarks">🔍</button>
            <button className="icon-btn" onClick={onSummarise} disabled={isGenerating} title="Summarise">📝</button>
            <button className="icon-btn" onClick={onShowKnowledge} title="Knowledge Base">📚</button>
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
                      onClick={(e) => { e.stopPropagation(); setEditingId(c.id); setEditValue(c.title); }}>✎</button>
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
                        onClick={(e) => { e.stopPropagation(); setEditingInstructionId(c.id); setInstructionValue(c.systemInstruction ?? ""); }}
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
        </>
      )}

      {/* ── Knowledge ─────────────────────────────────────────────────────── */}
      {section === "knowledge" && (
        <>
          <div className="sidebar-header">
            <span className="sidebar-title">Docs</span>
            <button className="icon-btn" onClick={onAddKnowledge} title="Add document">＋</button>
          </div>

          <ul className="conv-list">
            {knowledgeSources.length === 0 && (
              <li className="conv-empty">No documents yet — press ＋ to add one</li>
            )}
            {knowledgeSources.map(({ name, count }) => (
              <li key={name} className={`conv-item ${activeKnowledgeSource === name ? "active" : ""}`}>
                <button
                  className="conv-btn"
                  title={name}
                  onClick={() => onSelectKnowledgeSource(activeKnowledgeSource === name ? null : name)}
                >
                  <span className="conv-icon">📄</span>
                  <span className="conv-label">{name}</span>
                  <span className="source-count-badge">{count}</span>
                </button>
                {knowledgeDeleteConfirm === name ? (
                  <>
                    <button
                      className="btn-sm danger"
                      style={{ fontSize: "0.7em", padding: "2px 6px" }}
                      onClick={(e) => { e.stopPropagation(); onDeleteKnowledgeSource(name); setKnowledgeDeleteConfirm(null); }}
                    >
                      Delete
                    </button>
                    <button className="conv-delete" onClick={(e) => { e.stopPropagation(); setKnowledgeDeleteConfirm(null); }}>✕</button>
                  </>
                ) : (
                  <button
                    className="conv-delete"
                    title="Delete all chunks from this source"
                    onClick={(e) => { e.stopPropagation(); setKnowledgeDeleteConfirm(name); }}
                  >
                    🗑
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {/* ── Agents ────────────────────────────────────────────────────────── */}
      {section === "agents" && (
        <>
          <div className="sidebar-header">
            <span className="sidebar-title">Agents</span>
            <button className="icon-btn" onClick={onCreateAgent} title="New agent">＋</button>
          </div>

          <ul className="conv-list">
            {agents.length === 0 && (
              <li className="conv-empty">No agents yet — press ＋ to create one</li>
            )}
            {agents.map((agent) => (
              <li
                key={agent.id}
                className={`conv-item ${activeEditAgentId === agent.id ? "active" : ""}`}
              >
                <button
                  className="conv-btn"
                  onClick={() => onSelectAgent(agent.id)}
                  title={agent.description ?? agent.name}
                >
                  <span className="conv-icon">🤖</span>
                  <span className="conv-label">{agent.name}</span>
                </button>
                {agentDeleteConfirmId === agent.id ? (
                  <>
                    <button
                      className="btn-sm danger"
                      style={{ fontSize: "0.7em", padding: "2px 6px" }}
                      onClick={(e) => { e.stopPropagation(); onDeleteAgent(agent.id); setAgentDeleteConfirmId(null); }}
                    >
                      Delete
                    </button>
                    <button className="conv-delete" onClick={(e) => { e.stopPropagation(); setAgentDeleteConfirmId(null); }}>✕</button>
                  </>
                ) : (
                  <button
                    className="conv-delete"
                    title="Delete agent"
                    onClick={(e) => { e.stopPropagation(); setAgentDeleteConfirmId(agent.id); }}
                  >
                    🗑
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {/* ── Settings ──────────────────────────────────────────────────────── */}
      {section === "settings" && (
        <>
          <div className="sidebar-header">
            <span className="sidebar-title">Settings</span>
          </div>

          <ul className="conv-list">
            {([
              { id: "settings-models",     label: "Models",     icon: "🤖" },
              { id: "settings-generation", label: "Generation", icon: "⚡" },
              { id: "settings-web-search", label: "Web search", icon: "🌐" },
              { id: "settings-wake-word",  label: "Wake word",  icon: "👂" },
            ] as const).map(({ id, label, icon }) => (
              <li key={id} className="conv-item">
                <button
                  className="conv-btn"
                  onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                >
                  <span className="conv-icon">{icon}</span>
                  <span className="conv-label">{label}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}
