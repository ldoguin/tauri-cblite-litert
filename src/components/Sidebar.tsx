import { useState } from "react";
import type { Conversation } from "../lib/types";

interface Props {
  conversations: Conversation[];
  activeConvId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onShowKnowledge: () => void;
  onShowSettings: () => void;
}

export function Sidebar({
  conversations, activeConvId, onSelect, onCreate, onDelete, onRename,
  onShowKnowledge, onShowSettings,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const startEdit = (id: string, current: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(id);
    setEditValue(current);
  };

  const commitEdit = (id: string) => {
    if (editValue.trim()) onRename(id, editValue.trim());
    setEditingId(null);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Conversations</span>
        <button className="icon-btn" onClick={onCreate} title="New conversation">＋</button>
      </div>

      <ul className="conv-list">
        {conversations.length === 0 && (
          <li className="conv-empty">No conversations yet</li>
        )}
        {conversations.map((c) => (
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
                <button className="conv-delete" title="Delete"
                  onClick={(e) => { e.stopPropagation(); onDelete(c.id); }}>✕</button>
              </>
            )}
          </li>
        ))}
      </ul>

      <div className="sidebar-footer">
        <button className="footer-btn" onClick={onShowKnowledge}>📚 Knowledge Base</button>
        <button className="footer-btn" onClick={onShowSettings}>⚙️ Settings</button>
      </div>
    </aside>
  );
}
