import { useEffect, useRef, useState } from "react";
import type { Agent } from "../lib/types";

interface Props {
  agents: Agent[];
  activeAgentId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (name: string, systemPrompt: string, description?: string) => Promise<Agent>;
  onUpdate: (id: string, patch: Partial<Pick<Agent, "name" | "systemPrompt" | "description">>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}

type View = "list" | "create" | "edit";

const DEFAULT_PROMPTS: { label: string; prompt: string }[] = [
  {
    label: "Helpful assistant",
    prompt: "You are a helpful assistant. Answer clearly and concisely.",
  },
  {
    label: "Code reviewer",
    prompt:
      "You are an expert code reviewer. Analyse code for bugs, performance issues, and style problems. Be specific and actionable.",
  },
  {
    label: "Socratic tutor",
    prompt:
      "You are a Socratic tutor. Guide the user to answers through questions rather than giving direct answers. Encourage critical thinking.",
  },
  {
    label: "Concise summariser",
    prompt:
      "You are a summarisation assistant. Produce concise, bullet-pointed summaries. Omit filler and focus on key facts.",
  },
  {
    label: "RAG-focused assistant",
    prompt:
      "You are a retrieval-augmented assistant. Always ground your answers in the provided context. If the context does not contain enough information, say so explicitly rather than guessing.",
  },
];

export function AgentsPanel({
  agents,
  activeAgentId,
  onSelect,
  onCreate,
  onUpdate,
  onDelete,
  onClose,
}: Props) {
  const [view, setView] = useState<View>("list");
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);

  // Form state (shared between create and edit)
  const [name, setName] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  const openCreate = () => {
    setName("");
    setSystemPrompt("");
    setDescription("");
    setEditingAgent(null);
    setView("create");
  };

  const openEdit = (agent: Agent) => {
    setName(agent.name);
    setSystemPrompt(agent.systemPrompt);
    setDescription(agent.description ?? "");
    setEditingAgent(agent);
    setView("edit");
  };

  const handleSave = async () => {
    if (!name.trim() || !systemPrompt.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (view === "create") {
        await onCreate(name.trim(), systemPrompt.trim(), description.trim() || undefined);
      } else if (view === "edit" && editingAgent) {
        await onUpdate(editingAgent.id, {
          name: name.trim(),
          systemPrompt: systemPrompt.trim(),
          description: description.trim() || undefined,
        });
      }
      if (isMountedRef.current) setView("list");
    } catch (err) {
      if (isMountedRef.current) setSaveError(String(err));
    } finally {
      if (isMountedRef.current) setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeleteError(null);
    try {
      await onDelete(id);
      if (isMountedRef.current) setDeleteConfirmId(null);
    } catch (err) {
      if (isMountedRef.current) {
        setDeleteError(String(err));
        setDeleteConfirmId(null);
      }
    }
  };

  // ── List view ─────────────────────────────────────────────────────────────

  if (view === "list") {
    return (
      <div className="panel-overlay" onClick={onClose}>
        <div className="panel" onClick={(e) => e.stopPropagation()}>
          <div className="panel-header">
            <h2>🤖 Agents</h2>
            <button className="icon-btn" onClick={onClose}>✕</button>
          </div>

          <div className="panel-body">
            <section className="panel-section">
              {deleteError && (
                <div className="error-bar">
                  {deleteError}
                  <button className="icon-btn" onClick={() => setDeleteError(null)}>✕</button>
                </div>
              )}

              <p className="hint">
                Agents are named system prompts stored in CouchbaseLite. The active
                agent's prompt is injected at the start of every generation. Select
                <strong> None</strong> to use the default assistant prompt.
              </p>

              {/* None / default option */}
              <ul className="agent-list">
                <li
                  className={`agent-item ${activeAgentId === null ? "active" : ""}`}
                  onClick={() => onSelect(null)}
                >
                  <div className="agent-item-left">
                    <span className="agent-name">Default assistant</span>
                    <span className="agent-desc">Built-in helpful assistant prompt</span>
                  </div>
                  {activeAgentId === null && <span className="agent-active-badge">active</span>}
                </li>

                {agents.map((agent) => (
                  <li
                    key={agent.id}
                    className={`agent-item ${activeAgentId === agent.id ? "active" : ""}`}
                    onClick={() => onSelect(agent.id)}
                  >
                    <div className="agent-item-left">
                      <span className="agent-name">{agent.name}</span>
                      {agent.description && (
                        <span className="agent-desc">{agent.description}</span>
                      )}
                      <span className="agent-prompt-preview">
                        {agent.systemPrompt.slice(0, 100)}
                        {agent.systemPrompt.length > 100 ? "…" : ""}
                      </span>
                    </div>
                    <div className="agent-item-actions" onClick={(e) => e.stopPropagation()}>
                      {activeAgentId === agent.id && (
                        <span className="agent-active-badge">active</span>
                      )}
                      <button
                        className="icon-btn"
                        title="Edit"
                        onClick={() => openEdit(agent)}
                      >
                        ✎
                      </button>
                      {deleteConfirmId === agent.id ? (
                        <>
                          <button
                            className="btn-sm danger"
                            onClick={() => handleDelete(agent.id)}
                          >
                            Confirm
                          </button>
                          <button
                            className="btn-sm secondary"
                            onClick={() => setDeleteConfirmId(null)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          className="icon-btn danger"
                          title="Delete"
                          onClick={() => setDeleteConfirmId(agent.id)}
                        >
                          🗑
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <div className="panel-footer">
            <button className="btn-sm" onClick={openCreate}>+ New agent</button>
          </div>
        </div>
      </div>
    );
  }

  // ── Create / Edit form ────────────────────────────────────────────────────

  return (
    <div className="panel-overlay" onClick={() => setView("list")}>
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-header">
          <h2>{view === "create" ? "New agent" : `Edit — ${editingAgent?.name}`}</h2>
          <button className="icon-btn" onClick={() => setView("list")}>✕</button>
        </div>

        <div className="panel-body">
          <section className="panel-section">
            <label className="field-label">Name</label>
            <input
              className="field-input"
              placeholder="e.g. Code reviewer"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />

            <label className="field-label" style={{ marginTop: 12 }}>
              Description <span className="field-optional">(optional)</span>
            </label>
            <input
              className="field-input"
              placeholder="Short description shown in the list"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />

            <label className="field-label" style={{ marginTop: 12 }}>System prompt</label>

            {/* Quick-fill presets */}
            {view === "create" && (
              <div className="agent-presets">
                <span className="agent-presets-label">Quick fill:</span>
                {DEFAULT_PROMPTS.map((p) => (
                  <button
                    key={p.label}
                    className="btn-sm secondary"
                    onClick={() => {
                      setSystemPrompt(p.prompt);
                      if (!name) setName(p.label);
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}

            <textarea
              className="field-textarea"
              rows={8}
              placeholder="You are a helpful assistant…"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
          </section>
        </div>

        <div className="panel-footer">
          {saveError && (
            <div className="error-bar">
              {saveError}
              <button className="icon-btn" onClick={() => setSaveError(null)}>✕</button>
            </div>
          )}
          <button className="btn-sm secondary" onClick={() => setView("list")}>
            Cancel
          </button>
          <button
            className="btn-sm"
            onClick={handleSave}
            disabled={saving || !name.trim() || !systemPrompt.trim()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
