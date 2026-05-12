import type { Conversation } from "../lib/types";

interface Props {
  conversations: Conversation[];
  activeConvId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onShowKnowledge: () => void;
  onShowSettings: () => void;
}

export function Sidebar({
  conversations,
  activeConvId,
  onSelect,
  onCreate,
  onDelete,
  onShowKnowledge,
  onShowSettings,
}: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Conversations</span>
        <button className="icon-btn" onClick={onCreate} title="New conversation">
          ＋
        </button>
      </div>

      <ul className="conv-list">
        {conversations.length === 0 && (
          <li className="conv-empty">No conversations yet</li>
        )}
        {conversations.map((c) => (
          <li
            key={c.id}
            className={`conv-item ${c.id === activeConvId ? "active" : ""}`}
          >
            <button
              className="conv-btn"
              onClick={() => onSelect(c.id)}
              title={c.title}
            >
              <span className="conv-icon">💬</span>
              <span className="conv-label">{c.title}</span>
            </button>
            <button
              className="conv-delete"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(c.id);
              }}
              title="Delete"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>

      <div className="sidebar-footer">
        <button className="footer-btn" onClick={onShowKnowledge}>
          📚 Knowledge Base
        </button>
        <button className="footer-btn" onClick={onShowSettings}>
          ⚙️ Settings
        </button>
      </div>
    </aside>
  );
}
