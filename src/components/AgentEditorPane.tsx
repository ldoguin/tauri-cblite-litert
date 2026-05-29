/**
 * AgentEditorPane — full-pane agent create/edit UI.
 *
 * Replaces ChatPane when the Agent Manager built-in is active.
 * Layout mirrors the conversation UI:
 *   - Sidebar (in Sidebar.tsx) shows the agent list
 *   - This pane shows the editor for the selected agent
 */

import { useEffect, useRef, useState } from "react";
import type { Agent } from "../lib/types";
import type { Tool } from "../lib/tools";

interface Props {
  /** Currently selected agent (null = nothing selected, "new" = create form) */
  editingAgentId: string | null | "new";
  agents: Agent[];
  allTools: Tool[];
  onCreate: (name: string, systemPrompt: string, description?: string, toolIds?: string[]) => Promise<Agent>;
  onUpdate: (id: string, patch: Partial<Pick<Agent, "name" | "systemPrompt" | "description" | "toolIds">>) => Promise<void>;
  onCreated: (agent: Agent) => void;
  /** Called after a successful create — use to navigate away (e.g. back to chat). */
  onDone?: () => void;
}

const DEFAULT_PROMPTS: { label: string; prompt: string; toolIds?: string[] }[] = [
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
    label: "RAG assistant",
    prompt:
      "You are a retrieval-augmented assistant. Always ground your answers in the provided context. If the context does not contain enough information, say so explicitly rather than guessing.",
  },
  {
    label: "PDF research",
    prompt:
      "You are a PDF research assistant. You have access to tools to list, read, and render PDF documents stored in the knowledge base.\n\n" +
      "Workflow:\n" +
      "1. Use list_knowledge_pdfs to discover available documents.\n" +
      "2. Use knowledge_search to find relevant content — results include the document name and page number.\n" +
      "3. Use get_pdf_page to read the full text of a specific page.\n" +
      "4. Use view_pdf_page when the user wants to see a page — this renders it inline using pdf.js.\n\n" +
      "Always cite the document name and page number when quoting or referencing content.",
    toolIds: ["list_knowledge_pdfs", "get_pdf_page", "view_pdf_page", "knowledge_search"],
  },
];

export function AgentEditorPane({
  editingAgentId, agents, allTools, onCreate, onUpdate, onCreated, onDone,
}: Props) {
  const agent = editingAgentId && editingAgentId !== "new"
    ? agents.find((a) => a.id === editingAgentId) ?? null
    : null;

  const isCreate = editingAgentId === "new";
  const isEdit = !!agent;

  // ── Form state ─────────────────────────────────────────────────────────────
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [toolIds, setToolIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const isMountedRef = useRef(false);
  useEffect(() => { isMountedRef.current = true; return () => { isMountedRef.current = false; }; }, []);

  // Populate form when selected agent changes
  useEffect(() => {
    if (agent) {
      setName(agent.name);
      setDescription(agent.description ?? "");
      setSystemPrompt(agent.systemPrompt);
      setToolIds(agent.toolIds ?? []);
      setSaveError(null);
    } else if (isCreate) {
      setName("");
      setDescription("");
      setSystemPrompt("");
      setToolIds([]);
      setSaveError(null);
    }
  }, [editingAgentId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-save on blur for edit mode ────────────────────────────────────────
  const autoSave = async (patch: Partial<Pick<Agent, "name" | "systemPrompt" | "description" | "toolIds">>) => {
    if (!agent) return;
    if (Object.values(patch).every((v) => v === undefined)) return;
    try {
      await onUpdate(agent.id, patch);
    } catch (err) {
      if (isMountedRef.current) setSaveError(String(err));
    }
  };

  // ── Create ─────────────────────────────────────────────────────────────────
  const handleCreate = async () => {
    if (!name.trim() || !systemPrompt.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const created = await onCreate(name.trim(), systemPrompt.trim(), description.trim() || undefined, toolIds);
      if (isMountedRef.current) {
        onCreated(created);
        onDone?.();
      }
    } catch (err) {
      if (isMountedRef.current) setSaveError(String(err));
    } finally {
      if (isMountedRef.current) setSaving(false);
    }
  };

  // ── Empty state ─────────────────────────────────────────────────────────────
  if (!isCreate && !isEdit) {
    return (
      <div className="agent-editor-pane agent-editor-empty">
        <div className="agent-editor-empty-inner">
          <span className="agent-editor-empty-icon">🤖</span>
          <p>Select an agent from the sidebar to edit it,</p>
          <p>or press <strong>＋</strong> to create a new one.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="agent-editor-pane">
      <div className="agent-editor-header">
        <h2 className="agent-editor-title">
          {isCreate ? "New agent" : (
            <input
              className="agent-editor-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => { if (name.trim()) autoSave({ name: name.trim() }); }}
              placeholder="Agent name"
              aria-label="Agent name"
            />
          )}
        </h2>
      </div>

      <div className="agent-editor-body">
        {isCreate && (
          <div className="field-group">
            <label className="field-label">Name</label>
            <input
              className="field-input"
              placeholder="e.g. Code reviewer"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        )}

        <div className="field-group">
          <label className="field-label">
            Description <span className="field-optional">(optional)</span>
          </label>
          <input
            className="field-input"
            placeholder="Short description shown in the agent list"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => autoSave({ description: description.trim() || undefined })}
          />
        </div>

        <div className="field-group">
          <label className="field-label">System prompt</label>

          {isCreate && (
            <div className="agent-presets">
              <span className="agent-presets-label">Quick fill:</span>
              {DEFAULT_PROMPTS.map((p) => (
                <button
                  key={p.label}
                  className="btn-sm secondary"
                  onClick={() => {
                    setSystemPrompt(p.prompt);
                    if (!name) setName(p.label);
                    if (p.toolIds) setToolIds(p.toolIds);
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}

          <textarea
            className="field-textarea agent-editor-prompt"
            rows={12}
            placeholder="You are a helpful assistant…"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            onBlur={() => { if (systemPrompt.trim()) autoSave({ systemPrompt: systemPrompt.trim() }); }}
          />
        </div>

        {allTools.length > 0 && (
          <div className="field-group">
            <label className="field-label">
              Tools <span className="field-optional">(optional)</span>
            </label>
            <div className="agent-tools-list">
              {allTools.map((tool) => (
                <label key={tool.id} className="agent-tool-row">
                  <input
                    type="checkbox"
                    checked={toolIds.includes(tool.id)}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...toolIds, tool.id]
                        : toolIds.filter((id) => id !== tool.id);
                      setToolIds(next);
                      autoSave({ toolIds: next });
                    }}
                  />
                  <span className="agent-tool-name">{tool.name}</span>
                  <span className="agent-tool-desc">{tool.description}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {saveError && (
          <div className="error-bar" style={{ marginTop: 12 }}>
            {saveError}
            <button className="icon-btn" onClick={() => setSaveError(null)}>✕</button>
          </div>
        )}

        {isCreate && (
          <div className="agent-editor-actions">
            <button
              className="btn-sm"
              onClick={handleCreate}
              disabled={saving || !name.trim() || !systemPrompt.trim()}
            >
              {saving ? "Creating…" : "Create agent"}
            </button>
          </div>
        )}

        {isEdit && (
          <p className="hint" style={{ marginTop: 16 }}>
            Changes to description, system prompt, and tools are saved automatically on blur.
          </p>
        )}
      </div>
    </div>
  );
}
