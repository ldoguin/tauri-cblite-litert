import { useState } from "react";
import { useChat } from "./hooks/useChat";
import { Sidebar } from "./components/Sidebar";
import { ChatPane } from "./components/ChatPane";
import { KnowledgePanel } from "./components/KnowledgePanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { isTauri } from "./lib/llm";
import type { EmbeddingStatus } from "./lib/rag";
import type { LlmBackend, ApiConfig, WebLlmOptions } from "./lib/llm";
import "./App.css";

type Modal = "knowledge" | "settings" | null;
type ToolbarPanel = "none" | "llm" | "api" | "embed";

// ── Backend status badges ──────────────────────────────────────────────────

function EmbedBadge({ status }: { status: EmbeddingStatus | null }) {
  if (!status) return <span className="badge badge-pending">embed: …</span>;
  if (status.backend === "litert") return <span className="badge badge-litert">embed: LiteRT</span>;
  if (status.backend === "use")    return <span className="badge badge-use">embed: USE</span>;
  return <span className="badge badge-bow" title={status.reason}>embed: BoW</span>;
}

function LlmBadge({ backend }: { backend: LlmBackend }) {
  const labels: Record<LlmBackend, string> = {
    tauri:     "LLM: LiteRT-LM",
    mediapipe: "LLM: on-device",
    api:       "LLM: API",
    mock:      "LLM: mock",
  };
  const cls: Record<LlmBackend, string> = {
    tauri:     "badge-litert",
    mediapipe: "badge-litert",
    api:       "badge-use",
    mock:      "badge-bow",
  };
  return <span className={`badge ${cls[backend]}`}>{labels[backend]}</span>;
}

// ── Toolbar ────────────────────────────────────────────────────────────────

function Toolbar({
  embeddingStatus, llmBackend, isWebLlmLoaded,
  onLoadWebLlm, onUnloadWebLlm, onConfigureApi, onInitEmbedModel,
}: {
  embeddingStatus: EmbeddingStatus | null;
  llmBackend: LlmBackend;
  isWebLlmLoaded: boolean;
  onLoadWebLlm: (opts: WebLlmOptions) => void;
  onUnloadWebLlm: () => void;
  onConfigureApi: (cfg: ApiConfig) => void;
  onInitEmbedModel: (url: string) => void;
}) {
  const [panel, setPanel] = useState<ToolbarPanel>("none");
  const [llmUrl, setLlmUrl]     = useState("");
  const [llmLoading, setLlmLoading] = useState(false);
  const [apiUrl, setApiUrl]     = useState("https://api.groq.com/openai/v1");
  const [apiKey, setApiKey]     = useState("");
  const [apiModel, setApiModel] = useState("llama-3.1-8b-instant");
  const [embedUrl, setEmbedUrl] = useState("");

  const handleLoadLlm = async () => {
    if (!llmUrl.trim()) return;
    setLlmLoading(true);
    try {
      await onLoadWebLlm({ modelUrl: llmUrl.trim() });
      setPanel("none");
    } catch (e) {
      alert("Failed to load LLM: " + String(e));
    } finally {
      setLlmLoading(false);
    }
  };

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <EmbedBadge status={embeddingStatus} />
        <LlmBadge backend={llmBackend} />
      </div>

      <div className="toolbar-right">
        {panel === "llm" && (
          <div className="toolbar-panel-row">
            <input className="toolbar-input" style={{ width: 340 }}
              placeholder="https://…/gemma3-1b-it-int4-web.task"
              value={llmUrl} onChange={(e) => setLlmUrl(e.target.value)} />
            <button className="btn-sm" onClick={handleLoadLlm} disabled={llmLoading}>
              {llmLoading ? "Loading…" : "Load"}
            </button>
            <button className="btn-sm secondary" onClick={() => setPanel("none")}>✕</button>
          </div>
        )}
        {panel === "api" && (
          <div className="toolbar-panel-row">
            <input className="toolbar-input" placeholder="API base URL" style={{ width: 190 }}
              value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} />
            <input className="toolbar-input" placeholder="API key" style={{ width: 120 }}
              type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            <input className="toolbar-input" placeholder="model" style={{ width: 150 }}
              value={apiModel} onChange={(e) => setApiModel(e.target.value)} />
            <button className="btn-sm" onClick={() => {
              if (apiUrl.trim()) {
                onConfigureApi({ baseUrl: apiUrl.trim(), apiKey: apiKey || undefined, model: apiModel.trim() });
                setPanel("none");
              }
            }}>Save</button>
            <button className="btn-sm secondary" onClick={() => setPanel("none")}>✕</button>
          </div>
        )}
        {panel === "embed" && (
          <div className="toolbar-panel-row">
            <input className="toolbar-input" placeholder="https://…/model.tflite"
              value={embedUrl} onChange={(e) => setEmbedUrl(e.target.value)} />
            <button className="btn-sm" onClick={() => {
              if (embedUrl.trim()) { onInitEmbedModel(embedUrl.trim()); setPanel("none"); }
            }}>Load</button>
            <button className="btn-sm secondary" onClick={() => setPanel("none")}>✕</button>
          </div>
        )}
        {panel === "none" && (
          <>
            {/* Web-only LLM controls */}
            {!isTauri() && (
              isWebLlmLoaded
                ? <button className="btn-sm danger" onClick={onUnloadWebLlm}>Unload LLM</button>
                : <button className="btn-sm secondary" onClick={() => setPanel("llm")}>Load LLM</button>
            )}
            <button className="btn-sm secondary" onClick={() => setPanel("api")}>API config</button>
            {!isTauri() && (
              <button className="btn-sm secondary" onClick={() => setPanel("embed")}>Embed model</button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── RAG debug panel ────────────────────────────────────────────────────────

function RagDebugPanel({
  chunks,
}: {
  chunks: Array<{ text: string; source: string; score: number }>;
}) {
  if (chunks.length === 0) return null;
  return (
    <div className="rag-debug">
      <div className="rag-debug-title">RAG — retrieved context</div>
      {chunks.map((c, i) => (
        <div key={i} className="rag-debug-chunk">
          <span className="rag-score">{c.score.toFixed(3)}</span>
          <span className="rag-source">{c.source}</span>
          <span className="rag-text">
            {c.text.slice(0, 120)}{c.text.length > 120 ? "…" : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── App root ───────────────────────────────────────────────────────────────

export default function App() {
  const chat = useChat();
  const [modal, setModal] = useState<Modal>(null);
  const [ragDebugVisible, setRagDebugVisible] = useState(false);

  const handleNewConversation = async () => {
    const id = await chat.createConversation();
    await chat.selectConversation(id);
  };

  if (chat.status === "loading-models" && !chat.config) {
    return (
      <div className="splash">
        <div className="spinner" />
        <p>Initialising…</p>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar
        conversations={chat.conversations}
        activeConvId={chat.activeConvId}
        onSelect={chat.selectConversation}
        onCreate={handleNewConversation}
        onDelete={chat.removeConversation}
        onRename={chat.renameConversation}
        onShowKnowledge={() => setModal("knowledge")}
        onShowSettings={() => setModal("settings")}
      />

      <main className="main-area">
        <Toolbar
          embeddingStatus={chat.embeddingStatus}
          llmBackend={chat.llmBackend}
          isWebLlmLoaded={chat.llmBackend === "mediapipe"}
          onLoadWebLlm={chat.loadWebLlmModel}
          onUnloadWebLlm={chat.unloadWebLlmModel}
          onConfigureApi={chat.configureApi}
          onInitEmbedModel={chat.initEmbeddingEngine}
        />

        {(chat.status === "loading-models" || chat.status === "embedding") && (
          <div className="status-bar">
            <span className="spinner-sm" />
            {chat.status === "loading-models" ? "Loading models…" : "Embedding…"}
          </div>
        )}

        {chat.error && (
          <div className="error-bar">
            ⚠️ {chat.error}
            <button onClick={chat.clearError}>✕</button>
          </div>
        )}

        {/* RAG debug toggle */}
        {chat.lastRagChunks.length > 0 && (
          <button
            className="rag-debug-toggle"
            onClick={() => setRagDebugVisible((v) => !v)}
          >
            {ragDebugVisible ? "Hide" : "Show"} RAG context ({chat.lastRagChunks.length})
          </button>
        )}
        {ragDebugVisible && <RagDebugPanel chunks={chat.lastRagChunks} />}

        <ChatPane
          messages={chat.messages}
          streamingContent={chat.streamingContent}
          status={chat.status}
          onSend={chat.sendMessage}
          onNewConversation={handleNewConversation}
        />
      </main>

      {modal === "knowledge" && chat.config && (
        <KnowledgePanel
          chunks={chat.knowledgeChunks}
          status={chat.status}
          onIngest={chat.ingestText}
          onDelete={chat.removeKnowledgeChunk}
          onClose={() => setModal(null)}
        />
      )}

      {modal === "settings" && chat.config && (
        <SettingsPanel
          config={chat.config}
          onSave={chat.updateConfig}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
