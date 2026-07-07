import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { useTheme } from "./hooks/useTheme";
import { useChat } from "./hooks/useChat";
import type { SidebarSection } from "./components/Sidebar";
import { useVoiceInput } from "./hooks/useVoiceInput";
import { useWakeWord } from "./hooks/useWakeWord";
import { useTts } from "./hooks/useTts";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { Sidebar } from "./components/Sidebar";
import { ChatPane } from "./components/ChatPane";
import { KnowledgePanel } from "./components/KnowledgePanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { AgentEditorPane } from "./components/AgentEditorPane";
import { ModelManagerPanel } from "./components/ModelManagerPanel";
import { TaskModelPanel } from "./components/TaskModelPanel";
import { SearchPanel } from "./components/SearchPanel";
import { WebGpuBanner } from "./components/WebGpuBanner";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { RetailScreen } from "./components/RetailScreen";
import { FashionOracle } from "./components/FashionOracle";
import { FitnessCoach } from "./components/FitnessCoach";
import { BackgroundStudio } from "./components/BackgroundStudio";
import { AccessibilityDescriber } from "./components/AccessibilityDescriber";
import { FieldInspection } from "./components/FieldInspection";
import { ClinicalNotes } from "./components/ClinicalNotes";
import { PhotoLibrary } from "./components/PhotoLibrary";
import { DatasetAnnotator } from "./components/DatasetAnnotator";
import { CropDisease } from "./components/CropDisease";
import { isTauri, MODEL_PRESETS, generateOnce, fetchLocalLlms } from "./lib/llm";
import type { LocalLlmServer } from "./lib/llm";
import { DB_PROGRESS_EVENT } from "./lib/db";
import { MODEL_CATALOGUE } from "./lib/modelCache";
import type { EmbeddingStatus, RetrievedChunk } from "./lib/rag";
import type { LlmBackend, ApiConfig, WebLlmOptions, ModelPreset } from "./lib/llm";
import "./App.css";

type Modal = "models" | "search" | null;
type ToolbarPanel = "none" | "presets" | "llm" | "wasm" | "api" | "embed";
type AppMode = "welcome" | "chat" | "retail" | "oracle" | "fitness" | "studio" | "accessibility" | "tasks" | "inspection" | "clinical" | "settings" | "photos" | "annotate" | "crop-disease";

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
    wasm:      "LLM: WASM",
    api:       "LLM: API",
    mock:      "LLM: mock",
  };
  const cls: Record<LlmBackend, string> = {
    tauri:     "badge-litert",
    mediapipe: "badge-litert",
    wasm:      "badge-litert",
    api:       "badge-use",
    mock:      "badge-bow",
  };
  return <span className={`badge ${cls[backend]}`}>{labels[backend]}</span>;
}

// ── Toolbar ────────────────────────────────────────────────────────────────

function Toolbar({
  embeddingStatus, llmBackend, isWebLlmLoaded,
  ragEnabled, onRagToggle,
  theme, onToggleTheme,
  wakeWordState, onToggleWakeWord,
  ttsEnabled, ttsState, ttsErrorMsg, onToggleTts,
  onLoadPreset, onLoadWebLlm, onUnloadWebLlm, onLoadWasmLlm, onConfigureApi, onInitEmbedModel,
  onShowModels, onNavBack, navBackLabel,
}: {
  embeddingStatus: EmbeddingStatus | null;
  llmBackend: LlmBackend;
  isWebLlmLoaded: boolean;
  ragEnabled: boolean;
  onRagToggle: (v: boolean) => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  wakeWordState: import("./hooks/useWakeWord").WakeWordState;
  onToggleWakeWord: () => void;
  ttsEnabled: boolean;
  ttsState: import("./hooks/useTts").TtsState;
  ttsErrorMsg: string | null;
  onToggleTts: () => void;
  onLoadPreset: (preset: ModelPreset) => void;
  onLoadWebLlm: (opts: WebLlmOptions) => void;
  onUnloadWebLlm: () => void;
  onLoadWasmLlm: (url: string) => void;
  onConfigureApi: (cfg: ApiConfig) => void;
  onInitEmbedModel: (url: string) => void;
  onShowModels: () => void;
  onNavBack: () => void;
  navBackLabel: string;
}) {
  const [panel, setPanel] = useState<ToolbarPanel>("none");
  const [llmUrl, setLlmUrl]         = useState("");
  const [llmLoading, setLlmLoading] = useState(false);
  const [wasmUrl, setWasmUrl]       = useState("");
  const [wasmLoading, setWasmLoading] = useState(false);
  const [apiUrl, setApiUrl]         = useState("https://api.groq.com/openai/v1");
  const [apiKey, setApiKey]         = useState("");
  const [apiModel, setApiModel]     = useState("llama-3.1-8b-instant");
  const [embedUrl, setEmbedUrl]     = useState("");
  const [loadingPresetId, setLoadingPresetId] = useState<string | null>(null);
  const [toolbarError, setToolbarError] = useState<string | null>(null);
  const [localServers, setLocalServers] = useState<LocalLlmServer[]>([]);
  const [detectingLocal, setDetectingLocal] = useState(false);

  const handleDetectLocal = async () => {
    setDetectingLocal(true);
    setToolbarError(null);
    try {
      const found = await fetchLocalLlms();
      setLocalServers(found);
      if (found.length === 0) setToolbarError("No local LLM servers found on standard ports (Ollama :11434, LM Studio :1234, llama.cpp :8080, Jan :1337).");
    } catch (e) {
      setToolbarError("Detection failed: " + String(e));
    } finally {
      setDetectingLocal(false);
    }
  };

  const handleLoadLlm = async () => {
    if (!llmUrl.trim()) return;
    setLlmLoading(true);
    setToolbarError(null);
    try { await onLoadWebLlm({ modelUrl: llmUrl.trim() }); setPanel("none"); }
    catch (e) { setToolbarError("Failed to load LLM: " + String(e)); }
    finally { setLlmLoading(false); }
  };

  const handleLoadWasm = async () => {
    if (!wasmUrl.trim()) return;
    setWasmLoading(true);
    setToolbarError(null);
    try { await onLoadWasmLlm(wasmUrl.trim()); setPanel("none"); }
    catch (e) { setToolbarError("Failed to load WASM model: " + String(e)); }
    finally { setWasmLoading(false); }
  };

  const handleLoadPreset = async (preset: ModelPreset) => {
    setLoadingPresetId(preset.id);
    setToolbarError(null);
    try { await onLoadPreset(preset); setPanel("none"); }
    catch (e) { setToolbarError("Failed to load preset: " + String(e)); }
    finally { setLoadingPresetId(null); }
  };

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <button
          className="nav-back-btn"
          onClick={onNavBack}
          title={navBackLabel}
          aria-label={navBackLabel}
        >
          {navBackLabel}
        </button>
        <EmbedBadge status={embeddingStatus} />
        <LlmBadge backend={llmBackend} />
        <label className="rag-toggle" title="When enabled, relevant context from the knowledge base and past conversations is injected into every prompt">
          <input
            type="checkbox"
            checked={ragEnabled}
            onChange={(e) => onRagToggle(e.target.checked)}
          />
          RAG
        </label>
        <button
          className={`wake-word-btn ${wakeWordState === "listening" ? "listening" : ""} ${wakeWordState === "detected" ? "detected" : ""} ${wakeWordState === "loading" ? "loading" : ""} ${wakeWordState === "error" ? "error" : ""}`}
          onClick={onToggleWakeWord}
          title={
            wakeWordState === "idle"     ? "Enable wake word detection" :
            wakeWordState === "loading"  ? "Loading Whisper + VAD…" :
            wakeWordState === "listening"? "Wake word active — click to stop" :
            wakeWordState === "detected" ? "Wake phrase detected!" :
            "Wake word error — click to retry"
          }
        >
          {wakeWordState === "loading"   ? "⏳" :
           wakeWordState === "listening" ? "👂" :
           wakeWordState === "detected"  ? "🔔" :
           wakeWordState === "error"     ? "⚠️" :
           "👂"}
          <span className="wake-word-label">
            {wakeWordState === "idle"     ? "Wake" :
             wakeWordState === "loading"  ? "Loading…" :
             wakeWordState === "listening"? "Listening" :
             wakeWordState === "detected" ? "Detected!" :
             "Error"}
          </span>
        </button>
        <button
          className={`wake-word-btn ${
            !ttsEnabled ? "" :
            ttsState === "speaking" ? "listening" :
            ttsState === "loading"  ? "loading" :
            ttsState === "error"    ? "error" :
            "detected"
          }`}
          onClick={onToggleTts}
        >
          {ttsState === "loading" ? "⏳" : ttsState === "speaking" ? "🔊" : ttsState === "error" ? "⚠️" : "🔈"}
          <span className="wake-word-label">
            {ttsState === "loading"  ? "Loading…"  :
             ttsState === "speaking" ? "Speaking"  :
             ttsState === "error"    ? `Err: ${(ttsErrorMsg ?? "unknown").slice(0, 50)}` :
             ttsEnabled ? "TTS on" : "TTS"}
          </span>
        </button>
      </div>

      <div className="toolbar-right">

        {/* ── Presets panel ── */}
        {panel === "presets" && (
          <div className="preset-panel">
            <div className="preset-panel-header">
              <span>Quick load</span>
              <button className="icon-btn" onClick={() => setPanel("none")}>✕</button>
            </div>
            {MODEL_PRESETS.map((preset) => {
              const loading = loadingPresetId === preset.id;
              return (
                <div key={preset.id} className="preset-row">
                  <div className="preset-info">
                    <span className="preset-label">{preset.label}</span>
                    <span className="preset-desc">{preset.description}</span>
                    <div className="preset-urls">
                      {preset.llmUrl && (
                        <span className="preset-url" title={preset.llmUrl}>
                          🤖 {preset.llmUrl.split("/").pop()}
                        </span>
                      )}
                      {preset.embedUrl && (
                        <span className="preset-url" title={preset.embedUrl}>
                          🔢 {preset.embedUrl.split("/").pop()}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    className="btn-sm"
                    onClick={() => handleLoadPreset(preset)}
                    disabled={loading || loadingPresetId !== null}
                  >
                    {loading ? "Loading…" : "Load"}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Custom LLM panel (MediaPipe .task) ── */}
        {panel === "llm" && (
          <div className="toolbar-panel-row">
            <input className="toolbar-input" style={{ width: 340 }}
              placeholder="https://…/model.task"
              value={llmUrl} onChange={(e) => setLlmUrl(e.target.value)} />
            <button className="btn-sm" onClick={handleLoadLlm} disabled={llmLoading}>
              {llmLoading ? "Loading…" : "Load"}
            </button>
            <button className="btn-sm secondary" onClick={() => setPanel("none")}>✕</button>
          </div>
        )}

        {/* ── WASM LLM panel (.litertlm via @litert-lm/core) ── */}
        {panel === "wasm" && (
          <div className="toolbar-panel-col">
            <div className="toolbar-panel-row">
              <input className="toolbar-input" style={{ width: 380 }}
                placeholder="https://…/model.litertlm"
                value={wasmUrl} onChange={(e) => setWasmUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleLoadWasm()} />
              <button className="btn-sm" onClick={handleLoadWasm} disabled={wasmLoading}>
                {wasmLoading ? "Loading…" : "Load"}
              </button>
              <button className="btn-sm secondary" onClick={() => setPanel("none")}>✕</button>
            </div>
            <div className="toolbar-hint" style={{ padding: "2px 4px" }}>
              Runs entirely in-browser via WebAssembly — no GPU required. Supports .litertlm models.
            </div>
          </div>
        )}

        {/* ── Cloud / local LLM API panel ── */}
        {panel === "api" && (
          <div className="toolbar-panel-col">
            <div className="toolbar-panel-row">
              <input className="toolbar-input" placeholder="API base URL" style={{ width: 190 }}
                value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} />
              <input className="toolbar-input" placeholder="API key (optional)" style={{ width: 120 }}
                type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
              <input className="toolbar-input" placeholder="model" style={{ width: 150 }}
                value={apiModel} onChange={(e) => setApiModel(e.target.value)} />
              <button className="btn-sm" onClick={() => {
                if (apiUrl.trim()) {
                  onConfigureApi({ baseUrl: apiUrl.trim(), apiKey: apiKey || undefined, model: apiModel.trim() });
                  setPanel("none");
                }
              }}>Save</button>
              <button className="btn-sm secondary" onClick={() => {
                setLocalServers([]);
                setToolbarError(null);
                setPanel("none");
              }}>✕</button>
            </div>
            <div className="toolbar-panel-row">
              <button className="btn-sm secondary" onClick={handleDetectLocal} disabled={detectingLocal}>
                {detectingLocal ? "Detecting…" : "🔍 Detect local"}
              </button>
              <span className="toolbar-hint">Ollama · LM Studio · llama.cpp · Jan</span>
            </div>
            {localServers.map((srv) => (
              <div key={srv.baseUrl} className="local-llm-server">
                <span className="local-llm-name">{srv.name}</span>
                <span className="local-llm-url">{srv.baseUrl}</span>
                <div className="local-llm-models">
                  {srv.models.map((m) => (
                    <button
                      key={m}
                      className="btn-sm local-llm-model-btn"
                      onClick={() => {
                        setApiUrl(srv.baseUrl);
                        setApiKey("");
                        setApiModel(m);
                      }}
                      title={`Use ${m} via ${srv.name}`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Custom embed panel ── */}
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

        {/* ── Default buttons ── */}
        {panel === "none" && (
          <>
            <button
              className="btn-sm icon-only"
              onClick={onToggleTheme}
              title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            >
              {theme === "dark" ? "☀️" : "🌙"}
            </button>
            <button className="btn-sm" onClick={onShowModels} title="Download and manage models">
              📦 Models
            </button>
            {!isTauri() && (
              <button className="btn-sm preset-btn" onClick={() => setPanel("presets")}>
                ⚡ Quick load
              </button>
            )}
            {!isTauri() && (
              isWebLlmLoaded
                ? <button className="btn-sm danger" onClick={onUnloadWebLlm}>Unload LLM</button>
                : <button className="btn-sm secondary" onClick={() => setPanel("llm")}>Load LLM</button>
            )}
            {!isTauri() && llmBackend !== "wasm" && (
              <button className="btn-sm secondary" onClick={() => setPanel("wasm")} title="Load a .litertlm model via WebAssembly">
                WASM LLM
              </button>
            )}
            {!isTauri() && llmBackend === "wasm" && (
              <span className="badge badge-litert">WASM loaded</span>
            )}
            {!isTauri() && (
              <button className="btn-sm secondary" onClick={() => setPanel("api")} title="Cloud LLM fallback for browsers without WebGPU">Cloud LLM fallback</button>
            )}
            {!isTauri() && (
              <button className="btn-sm secondary" onClick={() => setPanel("embed")}>Embed model</button>
            )}
          </>
        )}
        {toolbarError && (
          <div className="error-bar toolbar-error">
            {toolbarError}
            <button className="icon-btn" onClick={() => setToolbarError(null)}>✕</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── RAG debug panel ────────────────────────────────────────────────────────

function RagDebugPanel({ chunks }: { chunks: RetrievedChunk[] }) {
  if (chunks.length === 0) return null;
  return (
    <div className="rag-debug">
      <div className="rag-debug-title">RAG — retrieved context</div>
      {chunks.map((c) => (
        <div key={c.id} className="rag-debug-chunk">
          <span className="rag-score">{c.score.toFixed(3)}</span>
          <span className={`rag-type-badge rag-type-${c.type}`}>{c.type}</span>
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
  const { theme, toggleTheme } = useTheme();
  const tts = useTts(chat.config?.ttsModelId || undefined);
  const [appMode, setAppMode] = useState<AppMode>("welcome");
  const [modal, setModal] = useState<Modal>(null);
  const [section, setSection] = useState<SidebarSection>("conversations");
  const [ragDebugVisible, setRagDebugVisible] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [voiceInput, setVoiceInput] = useState("");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  // Track which agent is open in the Agent Manager pane (null=none, "new"=create form)
  const [activeEditAgentId, setActiveEditAgentId] = useState<string | null | "new">(null);
  // Knowledge panel state
  const [activeKnowledgeSource, setActiveKnowledgeSource] = useState<string | null>(null);
  const [showKnowledgeModal, setShowKnowledgeModal] = useState(false);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  // Holds the cancel function for any in-flight jumpToMessage retry loop so
  // pending timers are cleared when the component unmounts.
  const jumpCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { jumpCleanupRef.current?.(); }, []);
  const [bookmarks, setBookmarks] = useState<import("./lib/types").Message[]>([]);
  const [storageWarning, setStorageWarning] = useState(false);

  useEffect(() => {
    const handler = () => setStorageWarning(true);
    window.addEventListener("rag-chatbot:storage-full", handler);
    return () => window.removeEventListener("rag-chatbot:storage-full", handler);
  }, []);

  // Android hardware/gesture back button. Tauri's AppPlugin only auto-navigates
  // WebView history (this SPA never pushes any) or exits the app when NO
  // listener is registered — once we register one, Tauri defers entirely to
  // us, so we must explicitly replicate "close the topmost overlay, else exit"
  // ourselves. Mirrors the in-app Toolbar "← Back" button's section/appMode
  // priority (see onNavBack below) plus the modal/panel layers it doesn't cover.
  // Stored in a ref (reassigned every render) so the Tauri listener — registered
  // once on mount — always sees current state instead of a stale closure.
  const handleSystemBackRef = useRef<() => void>(() => {});
  handleSystemBackRef.current = () => {
    if (modal !== null) { setModal(null); return; }
    if (showKnowledgeModal) { setShowKnowledgeModal(false); return; }
    if (activeEditAgentId !== null) { setActiveEditAgentId(null); return; }
    if (ragDebugVisible) { setRagDebugVisible(false); return; }
    if (appMode === "chat" && section !== "conversations") { setSection("conversations"); return; }
    if (appMode !== "welcome") { setAppMode("welcome"); return; }
    if (sidebarOpen) { setSidebarOpen(false); return; }
    // True root — exit, matching the default behavior Tauri would use if no
    // listener were registered at all.
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("plugin:app|exit"))
      .catch(() => {});
  };

  useEffect(() => {
    if (!isTauri()) return;
    let listener: { unregister: () => void } | null = null;
    let cancelled = false;
    import("@tauri-apps/api/app")
      .then(({ onBackButtonPress }) => onBackButtonPress(() => handleSystemBackRef.current()))
      .then((l) => { if (cancelled) { l.unregister(); } else { listener = l; } })
      .catch(() => {});
    return () => { cancelled = true; listener?.unregister(); };
  }, []);

  // Auto-speak completed assistant response.
  // Uses lastCompletedResponse (set atomically in onDone with the full accumulated text)
  // rather than tracking streamingContent transitions, which is vulnerable to React 18
  // automatic batching swallowing the last-chunk update before the null clear.
  const lastSpokenResponseRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      chat.lastCompletedResponse &&
      chat.lastCompletedResponse !== lastSpokenResponseRef.current &&
      tts.enabled
    ) {
      lastSpokenResponseRef.current = chat.lastCompletedResponse;
      tts.speak(chat.lastCompletedResponse);
    }
  }, [chat.lastCompletedResponse, tts.enabled]);

  // Load bookmarks whenever the search/bookmarks panel opens
  const openSearch = useCallback(() => {
    chat.getBookmarks().then((bm) => {
      setBookmarks(bm);
      setModal("search");
    }).catch(() => {
      // Bookmarks unavailable — open panel with empty list
      setBookmarks([]);
      setModal("search");
    });
  }, [chat.getBookmarks]);

  // Keep the bookmarks list fresh while the search panel is open.
  // chat.messages changes whenever toggleBookmark is called, so this effect
  // re-fetches and reflects additions without requiring a panel close/reopen.
  useEffect(() => {
    if (modal !== "search") return;
    chat.getBookmarks().then(setBookmarks).catch(() => {});
  }, [modal, chat.messages, chat.getBookmarks]);

  // Jump to a message: select the conversation, then scroll to the message element.
  // Uses a retry loop because the message list may not be rendered immediately
  // after selectConversation resolves (React batches state updates).
  const jumpToMessage = useCallback(async (convId: string, messageId: string) => {
    await chat.selectConversation(convId);
    const targetId = `msg-${messageId}`;
    let attempts = 0;
    // Track pending timer so it can be cancelled if the component unmounts
    // while retries are still in flight (cleanup registered in jumpCleanupRef).
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    jumpCleanupRef.current = () => {
      cancelled = true;
      if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
    };

    const tryScroll = () => {
      if (cancelled) return;
      const el = document.getElementById(targetId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("msg-highlight");
        retryTimer = setTimeout(() => { retryTimer = null; el.classList.remove("msg-highlight"); }, 1500);
      } else if (attempts < 10) {
        attempts++;
        retryTimer = setTimeout(() => { retryTimer = null; tryScroll(); }, 100);
      }
    };
    // First attempt after two animation frames to let React flush
    requestAnimationFrame(() => requestAnimationFrame(tryScroll));
  }, [chat.selectConversation]);

  // Lifted voice input — shared between wake word trigger and ChatPane
  const voice = useVoiceInput({
    onResult: useCallback((text: string) => {
      setVoiceInput((prev) => (prev ? `${prev} ${text}` : text));
      setVoiceError(null);
    }, []),
    onError: useCallback((msg: string) => setVoiceError(msg), []),
    whisperModelId: chat.config?.whisperModelId || undefined,
  });

  const handleNewConversation = useCallback(async () => {
    const id = await chat.createConversation();
    await chat.selectConversation(id);
  }, [chat.createConversation, chat.selectConversation]);

  // Keyboard shortcuts
  useKeyboardShortcuts(useMemo(() => ({
    onNewConversation: handleNewConversation,
    onFocusInput: () => chatInputRef.current?.focus(),
    onOpenSearch: openSearch,
    onOpenKnowledge: () => setSection("knowledge"),
    onOpenAgents: () => setSection("agents"),
    onOpenSettings: () => setAppMode("settings"),
    onEscape: () => {
      if (modal) { setModal(null); return; }
      if (chat.status === "generating") chat.stopGeneration();
    },
    onStopGeneration: () => chat.stopGeneration(),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [modal, chat.status]));

  // Pause VAD while voice recording is active (avoids mic contention on Android).
  // voice must be declared before wakeWord so we can reference wakeWord below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const wakeWordRef = useRef<import("./hooks/useWakeWord").UseWakeWordReturn | null>(null);
  useEffect(() => {
    if (voice.state !== "idle") {
      wakeWordRef.current?.pause();
    } else {
      wakeWordRef.current?.resume();
    }
  }, [voice.state]);

  // Wake word — triggers voice.start() when phrase detected
  const wakeWord = useWakeWord({
    wakePhrase: chat.config?.wakePhrase ?? "jarvis",
    whisperModelId: chat.config?.whisperModelId || undefined,
    onDetected: useCallback(() => {
      if (voice.state === "idle" && voice.workerStatus !== "loading") voice.start();
    }, [voice.state, voice.workerStatus, voice.start]),
    onError: useCallback((msg: string) => setVoiceError(msg), []),
  });
  useEffect(() => { wakeWordRef.current = wakeWord; }, [wakeWord]);

  // Derive context window length in priority order:
  //   1. config.contextLength (user-set or auto-set when loading from catalogue)
  //   2. catalogue entry contextLength (for the active model ID)
  //   3. 0 — bar hidden
  // maxTokens is the generation output limit, not the context window size,
  // so it is no longer used as a fallback here.
  const contextLength = useMemo(() => {
    if (chat.config?.contextLength) return chat.config.contextLength;
    if (chat.activeLlmModelId) {
      const entry = MODEL_CATALOGUE.find((m) => m.id === chat.activeLlmModelId);
      if (entry?.contextLength) return entry.contextLength;
    }
    return 0;
  }, [chat.activeLlmModelId, chat.config?.contextLength]);

  // Derive unique knowledge sources from chunks for the sidebar list
  const knowledgeSources = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of chat.knowledgeChunks) map.set(c.source, (map.get(c.source) ?? 0) + 1);
    return Array.from(map.entries()).map(([name, count]) => ({ name, count }));
  }, [chat.knowledgeChunks]);

  // Active system prompt for context window calculation — mirrors the priority
  // order used in sendMessage: agent > conversation instruction > default.
  const activeSystemPrompt = useMemo(() => {
    const activeConv = chat.conversations.find((c) => c.id === chat.activeConvId);
    return (
      chat.activeAgent?.systemPrompt ??
      activeConv?.systemInstruction ??
      "You are a helpful assistant. Answer using the provided context when relevant."
    );
  }, [chat.activeAgent, chat.conversations, chat.activeConvId]);

  const [dbMessages, setDbMessages] = useState<string[]>([]);
  useEffect(() => {
    const handler = (e: Event) => {
      const msg = (e as CustomEvent<{ message: string }>).detail.message;
      setDbMessages((prev) => [...prev.slice(-6), msg]);
    };
    window.addEventListener(DB_PROGRESS_EVENT, handler);
    return () => window.removeEventListener(DB_PROGRESS_EVENT, handler);
  }, []);

  // Show splash during full initial load.
  const isInitialising = (chat.status === "idle" || chat.status === "loading-models") && chat.conversations.length === 0;
  if (isInitialising) {
    return (
      <div className="splash">
        <div className="spinner" />
        <p>Initialising…</p>
        {dbMessages.length > 0 && (
          <div className="splash-log">
            {dbMessages.map((m, i) => <p key={i}>{m}</p>)}
          </div>
        )}
      </div>
    );
  }

  if (appMode === "welcome") {
    return (
      <div className="app-shell" data-theme={theme}>
        <WelcomeScreen
          onSelectChat={() => setAppMode("chat")}
          onSelectRetail={() => setAppMode("retail")}
          onSelectOracle={() => setAppMode("oracle")}
          onSelectFitness={() => setAppMode("fitness")}
          onSelectStudio={() => setAppMode("studio")}
          onSelectAccessibility={() => setAppMode("accessibility")}
          onSelectTasks={() => setAppMode("tasks")}
          onSelectInspection={() => setAppMode("inspection")}
          onSelectClinical={() => setAppMode("clinical")}
          onSelectPhotos={() => setAppMode("photos")}
          onSelectAnnotate={() => setAppMode("annotate")}
          onSelectCropDisease={() => setAppMode("crop-disease")}
          onSelectSettings={() => setAppMode("settings")}
          logMessages={dbMessages}
        />
      </div>
    );
  }

  const describeImageFn = async (dataUrl: string) => {
    if (!chat.config) throw new Error("No model loaded — configure a model in Settings first");
    return generateOnce(
      "Describe this fashion item for a product search query. Be concise (under 20 words): mention type, main color, other colors, style/pattern, and gender if apparent.",
      "You are a fashion product image analyzer. Reply with only a product description, nothing else.",
      chat.config,
      undefined,
      dataUrl,
    );
  };

  if (appMode === "retail") {
    return (
      <div className="app-shell" data-theme={theme}>
        <RetailScreen
          onBack={() => setAppMode("welcome")}
          embedModelId={chat.activeEmbedModelId ?? undefined}
          whisperModelId={chat.config?.whisperModelId || undefined}
          onDescribeImage={describeImageFn}
          onAnalyze={async (userText, systemPrompt) => {
            if (!chat.config) throw new Error("No model loaded");
            return generateOnce(userText, systemPrompt, chat.config);
          }}
        />
      </div>
    );
  }

  if (appMode === "oracle") {
    return (
      <div className="app-shell" data-theme={theme}>
        <FashionOracle
          onBack={() => setAppMode("welcome")}
          embedModelId={chat.activeEmbedModelId ?? undefined}
          whisperModelId={chat.config?.whisperModelId || undefined}
          onDescribeImage={describeImageFn}
          onAnalyze={async (userText, systemPrompt) => {
            if (!chat.config) throw new Error("No model loaded");
            return generateOnce(userText, systemPrompt, chat.config);
          }}
        />
      </div>
    );
  }

  const analyzeOnce = chat.config
    ? async (userText: string, systemPrompt: string) =>
        generateOnce(userText, systemPrompt, chat.config!)
    : undefined;

  if (appMode === "fitness") {
    return (
      <div className="app-shell" data-theme={theme}>
        <FitnessCoach onBack={() => setAppMode("welcome")} onAnalyze={analyzeOnce} />
      </div>
    );
  }

  if (appMode === "studio") {
    return (
      <div className="app-shell" data-theme={theme}>
        <BackgroundStudio onBack={() => setAppMode("welcome")} />
      </div>
    );
  }

  if (appMode === "accessibility") {
    return (
      <div className="app-shell" data-theme={theme}>
        <AccessibilityDescriber onBack={() => setAppMode("welcome")} onAnalyze={analyzeOnce} />
      </div>
    );
  }

  if (appMode === "tasks") {
    return (
      <div className="app-shell" data-theme={theme}>
        <TaskModelPanel modelFolder={chat.config?.modelFolder} onBack={() => setAppMode("welcome")} />
      </div>
    );
  }

  if (appMode === "settings") {
    return (
      <div className="app-shell" data-theme={theme}>
        {chat.config && (
          <SettingsPanel
            embedded
            config={chat.config}
            onSave={chat.updateConfig}
            onClose={() => setAppMode("welcome")}
          />
        )}
      </div>
    );
  }

  if (appMode === "annotate") {
    return (
      <div className="app-shell" data-theme={theme}>
        <DatasetAnnotator
          onBack={() => setAppMode("welcome")}
          embedModelId={chat.activeEmbedModelId ?? undefined}
        />
      </div>
    );
  }

  if (appMode === "photos") {
    return (
      <div className="app-shell" data-theme={theme}>
        <PhotoLibrary
          onBack={() => setAppMode("welcome")}
          onCaption={analyzeOnce}
          embedModelId={chat.activeEmbedModelId ?? undefined}
        />
      </div>
    );
  }

  if (appMode === "inspection") {
    return (
      <div className="app-shell" data-theme={theme}>
        <FieldInspection
          onBack={() => setAppMode("welcome")}
          onReport={analyzeOnce}
        />
      </div>
    );
  }

  if (appMode === "clinical") {
    return (
      <div className="app-shell" data-theme={theme}>
        <ClinicalNotes
          onBack={() => setAppMode("welcome")}
          embedModelId={chat.activeEmbedModelId ?? undefined}
          onStructure={analyzeOnce}
        />
      </div>
    );
  }

  if (appMode === "crop-disease") {
    return (
      <div className="app-shell" data-theme={theme}>
        <CropDisease onBack={() => setAppMode("welcome")} />
      </div>
    );
  }

  return (
    <div className="app-shell">
      {/* Mobile overlay — closes sidebar when tapping outside */}
      {sidebarOpen && (
        <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
      )}
      <div className={`sidebar-wrap ${sidebarOpen ? "open" : ""} ${sidebarCollapsed ? "collapsed" : ""}`}>
        <Sidebar
          section={section}
          onSectionChange={(s) => { setSection(s); setSidebarOpen(false); if (s !== "knowledge") setActiveKnowledgeSource(null); }}
          conversations={chat.conversations}
          activeConvId={chat.activeConvId}
          onSelect={(id) => { chat.selectConversation(id); setSidebarOpen(false); }}
          onCreate={() => { handleNewConversation().catch((e) => console.error("[App] new conversation failed:", e)); setSidebarOpen(false); }}
          onDelete={chat.removeConversation}
          onRename={chat.renameConversation}
          onUpdateInstruction={chat.updateConversationInstruction}
          onExport={chat.exportConversation}
          onSearch={chat.searchConversations}
          onShowSearch={() => { openSearch(); setSidebarOpen(false); }}
          onSummarise={() => { chat.summarizeConversation(); setSidebarOpen(false); }}
          isGenerating={chat.status === "generating"}
          onShowKnowledge={() => { setSection("knowledge"); setSidebarOpen(false); }}
          agents={chat.agents}
          activeEditAgentId={activeEditAgentId}
          onSelectAgent={(id) => setActiveEditAgentId(id)}
          onCreateAgent={() => setActiveEditAgentId("new")}
          onDeleteAgent={(id) => {
            chat.removeAgent(id);
            if (activeEditAgentId === id) setActiveEditAgentId(null);
          }}
          knowledgeSources={knowledgeSources}
          activeKnowledgeSource={activeKnowledgeSource}
          onSelectKnowledgeSource={setActiveKnowledgeSource}
          onDeleteKnowledgeSource={(source) => { chat.removeKnowledgeBySource(source); if (activeKnowledgeSource === source) setActiveKnowledgeSource(null); }}
          onAddKnowledge={() => setShowKnowledgeModal(true)}
        />
      </div>

      <button
        className="sidebar-edge-btn"
        onClick={() => setSidebarCollapsed((v) => !v)}
        title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {sidebarCollapsed ? "›" : "‹"}
      </button>

      <main className="main-area">
        <button
          className="sidebar-hamburger"
          onClick={() => setSidebarOpen((v) => !v)}
          title="Toggle sidebar"
          aria-label="Toggle sidebar"
        >
          ☰
        </button>
        <WebGpuBanner />
        <Toolbar
          embeddingStatus={chat.embeddingStatus}
          navBackLabel="← Back"
          onNavBack={section !== "conversations" ? () => setSection("conversations") : () => setAppMode("welcome")}
          llmBackend={chat.llmBackend}
          isWebLlmLoaded={chat.llmBackend === "mediapipe"}
          ragEnabled={chat.ragEnabled}
          onRagToggle={chat.setRagEnabled}
          theme={theme}
          onToggleTheme={toggleTheme}
          wakeWordState={wakeWord.state}
          onToggleWakeWord={() => { wakeWord.toggle().catch((e) => setVoiceError(String(e))); }}
          ttsEnabled={tts.enabled}
          ttsState={tts.state}
          ttsErrorMsg={tts.errorMsg}
          onToggleTts={tts.toggle}
          onLoadPreset={chat.loadPreset}
          onLoadWebLlm={chat.loadWebLlmModel}
          onUnloadWebLlm={chat.unloadWebLlmModel}
          onLoadWasmLlm={chat.loadWasmLlmFromUrl}
          onConfigureApi={chat.configureApi}
          onInitEmbedModel={chat.initEmbeddingEngine}
          onShowModels={() => setModal("models")}
        />

        {(chat.status === "loading-models" || chat.status === "embedding") && (
          <div className="status-bar">
            <span className="spinner-sm" />
            {chat.status === "loading-models" ? "Loading models…" : "Embedding…"}
          </div>
        )}

        {storageWarning && (
          <div className="error-bar" role="alert">
            ⚠️ Browser storage is full — data is in memory only and will be lost on reload.
            Delete old conversations or knowledge chunks to free space.
            <button onClick={() => setStorageWarning(false)} aria-label="Dismiss storage warning">✕</button>
          </div>
        )}

        {chat.error && (
          <div className="error-bar" role="alert">
            ⚠️ {chat.error}
            {chat.status === "error" && (
              <button onClick={chat.retryInit} style={{ marginLeft: "0.5rem" }}>Retry</button>
            )}
            <button onClick={chat.clearError} aria-label="Dismiss error">✕</button>
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

        {section === "knowledge" ? (
          <KnowledgePanel
            embedded
            chunks={chat.knowledgeChunks}
            status={chat.status}
            onIngest={chat.ingestText}
            onIngestPdf={chat.ingestPdf}
            onIngestUrl={chat.ingestUrl}
            onIngestImage={chat.ingestImage}
            onDelete={chat.removeKnowledgeChunk}
            onDeleteBySource={(source) => { chat.removeKnowledgeBySource(source); if (activeKnowledgeSource === source) setActiveKnowledgeSource(null); }}
            onReEmbedAll={chat.reEmbedAll}
            onCancelReEmbed={chat.cancelReEmbed}
            reEmbedProgress={chat.reEmbedProgress}
            ingestProgress={chat.ingestProgress}
            onClose={() => setSection("conversations")}
            filterSource={activeKnowledgeSource}
            onClearFilter={() => setActiveKnowledgeSource(null)}
          />
        ) : section === "agents" ? (
          <AgentEditorPane
            editingAgentId={activeEditAgentId}
            agents={chat.agents}
            allTools={chat.allTools}
            onCreate={(name, prompt, desc, toolIds) => chat.createAgent(name, prompt, desc, toolIds)}
            onUpdate={(id, patch) => chat.updateAgent(id, patch)}
            onCreated={(agent) => setActiveEditAgentId(agent.id)}
            onDone={() => setSection("conversations")}
          />
        ) : (
          <>
            {chat.availableModels.length > 0 && chat.activeConvId && (() => {
              const activeConv = chat.conversations.find((c) => c.id === chat.activeConvId);
              const currentPath = activeConv?.modelPath || chat.config?.lmModelPath || "";
              return (
                <div className="conv-model-bar">
                  <span className="conv-model-label">Model:</span>
                  <select
                    className="conv-model-select"
                    value={currentPath}
                    onChange={(e) => chat.switchConversationModel(chat.activeConvId!, e.target.value || undefined)}
                  >
                    {chat.config?.lmModelPath && (
                      <option value={chat.config.lmModelPath}>
                        {chat.availableModels.find((m) => m.path === chat.config?.lmModelPath)?.name
                          ?? chat.config.lmModelPath.split("/").pop()?.replace(/\.litertlm$/, "")}
                        {" (default)"}
                      </option>
                    )}
                    {chat.availableModels
                      .filter((m) => m.path !== chat.config?.lmModelPath)
                      .map((m) => (
                        <option key={m.path} value={m.path}>{m.name}</option>
                      ))}
                  </select>
                  {activeConv?.modelPath && activeConv.modelPath !== chat.config?.lmModelPath && (
                    <span className="conv-model-override-badge">overridden</span>
                  )}
                </div>
              );
            })()}
          <ChatPane
            messages={chat.messages}
            streamingContent={chat.streamingContent}
            streamingTokensPerSec={chat.streamingTokensPerSec}
            status={chat.status}
            voice={voice}
            voiceInput={voiceInput}
            voiceError={voiceError}
            onVoiceInputChange={setVoiceInput}
            onVoiceErrorDismiss={() => setVoiceError(null)}
            onSend={(text, img) => { tts.cancel(); chat.sendMessage(text, img); }}
            onStop={chat.stopGeneration}
            onEdit={chat.editMessage}
            onBranch={chat.branchConversation}
            onBookmark={chat.toggleBookmark}
            onFetchRagChunks={chat.getRagChunksForMessage}
            inputRef={chatInputRef}
            ragChunks={chat.lastRagChunks}
            systemPrompt={activeSystemPrompt}
            contextLength={contextLength}
            maxTokens={chat.config?.maxTokens}
            tokensGenerated={chat.streamingTokenCount}
            toolExecutions={chat.lastToolExecutions}
            streamingAgentName={chat.streamingAgentName}
          />
          </>
        )}
      </main>

      {showKnowledgeModal && (
        <div role="dialog" aria-modal="true" aria-label="Add to Knowledge Base">
          <KnowledgePanel
            chunks={chat.knowledgeChunks}
            status={chat.status}
            onIngest={chat.ingestText}
            onIngestPdf={chat.ingestPdf}
            onIngestUrl={chat.ingestUrl}
            onIngestImage={chat.ingestImage}
            onDelete={chat.removeKnowledgeChunk}
            onDeleteBySource={chat.removeKnowledgeBySource}
            onReEmbedAll={chat.reEmbedAll}
            onCancelReEmbed={chat.cancelReEmbed}
            reEmbedProgress={chat.reEmbedProgress}
            ingestProgress={chat.ingestProgress}
            onClose={() => setShowKnowledgeModal(false)}
          />
        </div>
      )}

      {modal === "models" && (
        <div role="dialog" aria-modal="true" aria-label="Model Manager">
          <ModelManagerPanel
            activeLlmId={chat.activeLlmModelId ?? undefined}
            activeEmbedId={chat.activeEmbedModelId ?? undefined}
            onLoadLlm={chat.loadLlmFromCache}
            onLoadEmbed={chat.loadEmbedFromCache}
            onClose={() => setModal(null)}
            hfToken={chat.config?.hfToken || undefined}
          />
        </div>
      )}

      {modal === "search" && (
        <div role="dialog" aria-modal="true" aria-label="Search">
          <SearchPanel
            onSearch={chat.searchConversations}
            onJump={jumpToMessage}
            bookmarks={bookmarks}
            onJumpBookmark={jumpToMessage}
            onRemoveBookmark={(id) => {
              chat.toggleBookmark(id);
              setBookmarks((prev) => prev.filter((m) => m.id !== id));
            }}
            onClose={() => setModal(null)}
          />
        </div>
      )}
    </div>
  );
}
