/**
 * useChat — central state and logic for the RAG chatbot.
 *
 * Key changes vs initial version (informed by plugin example):
 * - Both user AND assistant messages are embedded after generation completes
 *   so the vector index grows with every conversation turn.
 * - generateStream() now receives the full message history + ragContext
 *   separately, matching the example's API shape.
 * - Embedding backend is initialised via initEmbeddings() and its status
 *   is surfaced to the UI (litert / use / bow).
 * - LLM backend state (tauri / mediapipe / api / mock) is surfaced to the UI.
 * - Web API config is persisted to localStorage via persistApiConfig().
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import {
  initDatabase,
  loadConfig,
  saveConfig,
  listConversations,
  getConversation,
  saveConversation,
  deleteConversation,
  listMessages,
  saveMessage,
  saveKnowledgeChunk,
  listKnowledgeChunks,
  deleteKnowledgeChunk,
  deleteKnowledgeBySource,
  deleteMessage,
  listBookmarkedMessages,
  getKnowledgeChunksByIds,
  getMessagesByIds,
  saveImageAsBlob,
  listAgents,
  saveAgent,
  deleteAgent,
} from "../lib/db";
import { extractPdfContent, extractPdfPages, renderPdfPage } from "../lib/pdf";
import { MODEL_CATALOGUE, resolveDefaultModelPaths } from "../lib/modelCache";
import { DEFAULT_AGENTS } from "../lib/defaultAgents";
import { fetchUrlText } from "../lib/urlIngest";
import {
  embed,
  initEmbeddings,
  getEmbeddingBackend,
  retrieveTopK,
  rerank,
  splitIntoChunks,
  invalidateRagPoolCache,
  type EmbeddingStatus,
  type EmbeddingBackend,
  type RetrievedChunk,
} from "../lib/rag";
import {
  loadModels,
  unloadModels,
  generateStream,
  generateOnce,
  stripThinking,
  loadWebLlm,
  unloadWebLlm,
  getActiveBackend,
  persistApiConfig,
  loadPersistedApiConfig,
  loadLmFromPath,
  scanModels,
  isTauri,
  EMBED_MODEL_ID,
  type LlmBackend,
  type ApiConfig,
  type WebLlmOptions,
  type ModelPreset,
} from "../lib/llm";
import type { ScannedModelMeta } from "../lib/modelCache";
import type {
  Conversation,
  Message,
  KnowledgeChunk,
  ModelConfig,
  AppStatus,
  Agent,
} from "../lib/types";
import {
  ALL_TOOLS,
  getToolById,
  createKnowledgeSearchTool,
  createWebSearchTool,
  createPdfTools,
  createSourceTools,
  type Tool,
  type ToolExecution,
} from "../lib/tools";
import { extractPdfPageText } from "../lib/pdf";
import { savePdfRecord, getPdfPath } from "../lib/db";

/** Sentinel ID for the built-in system router agent. Never stored in CBL. */
export const ROUTER_AGENT_ID = "__router__";

/** Sentinel ID for the built-in agent manager UI. Never stored in CBL. */
export const AGENT_MANAGER_ID = "__agent_manager__";

async function resolveDbDir(): Promise<string> {
  if (!isTauri()) return "/tmp/rag-chatbot";
  const { appDataDir } = await import("@tauri-apps/api/path");
  return appDataDir();
}

export function useChat() {
  const [status, setStatus] = useState<AppStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const [config, setConfigState] = useState<ModelConfig | null>(null);
  const [availableModels, setAvailableModels] = useState<ScannedModelMeta[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [knowledgeChunks, setKnowledgeChunks] = useState<KnowledgeChunk[]>([]);
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [lastCompletedResponse, setLastCompletedResponse] = useState<string | null>(null);
  const [streamingTokensPerSec, setStreamingTokensPerSec] = useState<number>(0);
  const [streamingTokenCount, setStreamingTokenCount] = useState<number>(0);
  const streamStartRef = useRef<number>(0);
  const streamTokenCountRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);
  const [ragEnabled, setRagEnabled] = useState(true);

  // Embedding + LLM backend status surfaced to the UI
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus | null>(null);
  const [embeddingBackend, setEmbeddingBackend] = useState<EmbeddingBackend>("bow");
  const [llmBackend, setLlmBackend] = useState<LlmBackend>("mock");

  // Active model IDs — set when a model is loaded from the model manager
  const [activeLlmModelId, setActiveLlmModelId] = useState<string | null>(null);
  const [activeEmbedModelId, setActiveEmbedModelId] = useState<string | null>(null);

  // RAG debug: last retrieved chunks shown in the UI
  const [lastRagChunks, setLastRagChunks] = useState<RetrievedChunk[]>([]);

  // Tools
  const [enabledToolIds, setEnabledToolIds] = useState<Set<string>>(new Set());
  const [lastToolExecutions, setLastToolExecutions] = useState<ToolExecution[]>([]);
  const [streamingAgentName, setStreamingAgentName] = useState<string | null>(null);

  // Agents
  const [agents, setAgents] = useState<Agent[]>([]);

  // Ref that always holds the latest config so config saves are consistent.
  const configRef = useRef<ModelConfig | null>(null);
  // Ref that always holds the latest agents list for use in callbacks.
  const agentsRef = useRef<Agent[]>([]);
  // Ref that always holds the latest conversations list so sendMessage can
  // read it synchronously without a side-effect inside a state updater.
  const conversationsRef = useRef<Conversation[]>([]);

  // knowledge_search is created once and kept in a ref so it isn't recreated
  // on every render. It is always available when the embedding engine is ready.
  const knowledgeSearchToolRef = useRef<Tool | null>(null);
  if (!knowledgeSearchToolRef.current) {
    knowledgeSearchToolRef.current = createKnowledgeSearchTool({
      embed: (text) => embed(text),
      retrieveTopK: (vec, text, topK, threshold) =>
        retrieveTopK(vec, text, topK, threshold),
    });
  }

  // PDF tools are created once; they close over a live getter for knowledgeChunks
  // so the list stays current without recreating the tool objects.
  const knowledgeChunksRef = useRef<typeof knowledgeChunks>(knowledgeChunks);
  knowledgeChunksRef.current = knowledgeChunks;
  const pdfToolsRef = useRef<Tool[]>([]);
  if (pdfToolsRef.current.length === 0) {
    pdfToolsRef.current = createPdfTools({
      getChunks: () => knowledgeChunksRef.current,
      getPdfPath,
      readPdfBytes: async (path: string) => {
        const { invoke } = await import("@tauri-apps/api/core");
        const b64 = await invoke<string>("read_pdf_bytes", { path });
        const raw = atob(b64);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        return bytes.buffer;
      },
      renderPdfPage: async (buffer: ArrayBuffer, page: number) => renderPdfPage(buffer, page),
      extractPdfPageText,
    });
  }

  // Source tools: list_knowledge_sources + read_source_chunks
  const sourceToolsRef = useRef<Tool[]>([]);
  if (sourceToolsRef.current.length === 0) {
    sourceToolsRef.current = createSourceTools({
      getChunks: () => knowledgeChunksRef.current,
    });
  }

  // Memoize so sendMessage (and its useCallback deps) aren't recreated on
  // every render — enabledToolIds is a Set so we stringify it as the key.
  const enabledToolIdsKey = Array.from(enabledToolIds).sort().join(",");
  const searxngUrl = config?.searxngUrl ?? "";
  const PDF_TOOL_IDS    = new Set(["list_knowledge_pdfs", "get_pdf_page", "view_pdf_page"]);
  const SOURCE_TOOL_IDS = new Set(["list_knowledge_sources", "read_source_chunks", "search_knowledge_text"]);
  const enabledTools = useMemo(() => [
    ...Array.from(enabledToolIds).flatMap((id) => {
      if (id === "knowledge_search") {
        return knowledgeSearchToolRef.current ? [knowledgeSearchToolRef.current] : [];
      }
      if (id === "web_search") {
        return [createWebSearchTool(searxngUrl)];
      }
      if (PDF_TOOL_IDS.has(id)) {
        const t = pdfToolsRef.current.find((pt) => pt.id === id);
        return t ? [t] : [];
      }
      if (SOURCE_TOOL_IDS.has(id)) {
        const t = sourceToolsRef.current.find((st) => st.id === id);
        return t ? [t] : [];
      }
      const t = getToolById(id);
      return t ? [t] : [];
    }),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [enabledToolIdsKey, searxngUrl]);

  const modelsLoaded = useRef(false);
  // Ref-based guard for sendMessage — prevents concurrent sends even when
  // the status state hasn't re-rendered yet (stale closure race).
  const sendingRef = useRef(false);

  // Ref that always holds the current active conversation ID so async callbacks
  // (e.g. summarizeConversation's onDone) can check whether the user has
  // switched away mid-operation without capturing a stale closure value.
  const activeConvIdRef = useRef<string | null>(null);

  // Keep refs in sync so callbacks can read latest values without stale closures.
  useEffect(() => { configRef.current = config; }, [config]);
  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);
  useEffect(() => { activeConvIdRef.current = activeConvId; }, [activeConvId]);
  useEffect(() => { agentsRef.current = agents; }, [agents]);

  // ── Initialisation ───────────────────────────────────────────────────────

  useEffect(() => {
    // Reset mount flag — StrictMode unmounts and remounts, so we must restore
    // it here rather than relying on the initial useRef(true) value.
    isMountedRef.current = true;
    let cancelled = false;

    (async () => {
      try {
        setStatus("loading-models");
        const dbDir = await resolveDbDir();
        const ftsLanguage = localStorage.getItem("ftsLanguage") ?? "en";
        await initDatabase(dbDir, ftsLanguage);
        if (cancelled) return;

        let cfg = await loadConfig();
        if (cancelled) return;

        // On Tauri, auto-fill empty model paths from any downloaded models.
        if (isTauri() && (!cfg.lmModelPath || !cfg.embeddingModelPath)) {
          const defaults = await resolveDefaultModelPaths();
          let changed = false;
          if (!cfg.lmModelPath && defaults.lmModelPath) {
            cfg = { ...cfg, lmModelPath: defaults.lmModelPath };
            changed = true;
          }
          if (!cfg.embeddingModelPath && defaults.embeddingModelPath) {
            cfg = { ...cfg, embeddingModelPath: defaults.embeddingModelPath };
            changed = true;
          }
          if (changed) saveConfig(cfg).catch(() => {});
        }

        setConfigState(cfg);

        const convs = await listConversations();
        if (cancelled) return;
        setConversations(convs);

        const chunks = await listKnowledgeChunks();
        if (cancelled) return;
        setKnowledgeChunks(chunks);

        let agentList = await listAgents();
        if (cancelled) return;
        // Seed default agents on first run (empty DB).
        if (agentList.length === 0) {
          const now = new Date().toISOString();
          const seeded = DEFAULT_AGENTS.map((preset) => ({
            id: uuidv4(),
            name: preset.name,
            description: preset.description,
            systemPrompt: preset.systemPrompt,
            toolIds: preset.toolIds,
            createdAt: now,
            updatedAt: now,
          }));
          await Promise.all(seeded.map(saveAgent));
          agentList = seeded;
        } else {
          // Migrate: for each existing preset agent (matched by name), add any
          // tool IDs that appeared in DEFAULT_AGENTS since the agent was created.
          // User-added tools are preserved; nothing is removed.
          const migrations: Promise<void>[] = [];
          for (const existing of agentList) {
            const preset = DEFAULT_AGENTS.find((p) => p.name === existing.name);
            if (!preset) continue;
            const missing = preset.toolIds.filter((id) => !existing.toolIds.includes(id));
            const removedSystemPrompt = existing.systemPrompt !== preset.systemPrompt;
            if (missing.length === 0 && !removedSystemPrompt) continue;
            const updated = {
              ...existing,
              toolIds: [...existing.toolIds, ...missing],
              systemPrompt: preset.systemPrompt,
              updatedAt: new Date().toISOString(),
            };
            migrations.push(saveAgent(updated).then(() => {
              const idx = agentList.indexOf(existing);
              if (idx !== -1) agentList[idx] = updated;
            }));
          }
          if (migrations.length > 0) await Promise.all(migrations);
        }
        setAgents(agentList);
        // Router is always the active responder — agents are config only.

        // Restore persisted web API config
        loadPersistedApiConfig();

        // Initialise embedding engine
        const embStatus = await initEmbeddings(
          !isTauri() ? cfg.embeddingModelPath || undefined : undefined,
        );
        if (cancelled) return;
        setEmbeddingStatus(embStatus);
        setEmbeddingBackend(getEmbeddingBackend());

        // Load LiteRT models on Tauri.
        // Guard cancelled BEFORE calling loadModels — if StrictMode cleanup fired
        // while earlier awaits were in flight (setting cancelled=true), we must
        // not start Engine::new at all. Concurrent Engine::new calls corrupt the
        // LiteRT-LM global accelerator registry and make create_conversation return null.
        if ((cfg.lmModelPath || cfg.embeddingModelPath) && !cancelled) {
          await loadModels(cfg, availableModels);
          if (cancelled) return;
          modelsLoaded.current = true;
        }

        if (cancelled) return;
        setLlmBackend(getActiveBackend());
        setStatus("ready");
      } catch (err) {
        if (!cancelled) { setError(String(err)); setStatus("error"); }
      }
    })();

    return () => {
      cancelled = true;
      isMountedRef.current = false;
      sendingRef.current = false;
      unloadModels().catch(() => {});
    };
  }, []);

  /** Retry initialisation after a transient startup failure. */
  const retryInit = useCallback(() => {
    setError(null);
    setStatus("loading-models");
    (async () => {
      try {
        const dbDir = await resolveDbDir();
        const ftsLanguage = localStorage.getItem("ftsLanguage") ?? "en";
        await initDatabase(dbDir, ftsLanguage);
        if (!isMountedRef.current) return;
        const cfg = await loadConfig();
        if (!isMountedRef.current) return;
        setConfigState(cfg);
        const convs = await listConversations();
        if (!isMountedRef.current) return;
        setConversations(convs);
        const chunks = await listKnowledgeChunks();
        if (!isMountedRef.current) return;
        setKnowledgeChunks(chunks);
        const agentList = await listAgents();
        if (!isMountedRef.current) return;
        setAgents(agentList);
        loadPersistedApiConfig();
        const embStatus = await initEmbeddings(
          !isTauri() ? cfg.embeddingModelPath || undefined : undefined,
        );
        if (!isMountedRef.current) return;
        setEmbeddingStatus(embStatus);
        setEmbeddingBackend(getEmbeddingBackend());
        if (cfg.lmModelPath || cfg.embeddingModelPath) {
          await loadModels(cfg, availableModels);
          if (!isMountedRef.current) return;
          modelsLoaded.current = true;
        }
        if (!isMountedRef.current) return;
        setLlmBackend(getActiveBackend());
        setStatus("ready");
      } catch (err) {
        if (isMountedRef.current) { setError(String(err)); setStatus("error"); }
      }
    })();
  }, []);

  // ── Model folder scan ────────────────────────────────────────────────────

  useEffect(() => {
    if (!config?.modelFolder) { setAvailableModels([]); return; }
    scanModels(config.modelFolder)
      .then(setAvailableModels)
      .catch(() => setAvailableModels([]));
  }, [config?.modelFolder]);

  // ── Config ───────────────────────────────────────────────────────────────

  const updateConfig = useCallback(async (next: ModelConfig) => {
    await saveConfig(next);
    // Persist ftsLanguage to localStorage so initDatabase can read it before CBL opens.
    if (next.ftsLanguage) localStorage.setItem("ftsLanguage", next.ftsLanguage);
    if (!isMountedRef.current) return;
    setConfigState(next);
    // Invalidate the RAG pool cache whenever config changes — ragSourceTypes
    // or chunkSize/overlap changes would otherwise serve stale cached results.
    invalidateRagPoolCache();
    if (isTauri()) {
      // Tauri: loadModels handles both LM and embedding via IPC.
      if (modelsLoaded.current) {
        try { await unloadModels(); } catch { /* ignore unload errors */ }
        modelsLoaded.current = false;
      }
      if (next.lmModelPath || next.embeddingModelPath) {
        if (!isMountedRef.current) return;
        setStatus("loading-models");
        setError(null);
        try {
          await loadModels(next, availableModels);
          modelsLoaded.current = true;
          if (isMountedRef.current) setStatus("ready");
        } catch (err) {
          modelsLoaded.current = false;
          if (isMountedRef.current) { setError(String(err)); setStatus("error"); }
        }
      }
    } else {
      // Web: loadModels is a no-op. Re-initialise the embedding engine directly
      // when embeddingModelPath changes so the new model is actually loaded.
      if (next.embeddingModelPath) {
        setStatus("loading-models");
        setError(null);
        try {
          const embStatus = await initEmbeddings(next.embeddingModelPath || undefined);
          if (!isMountedRef.current) return;
          setEmbeddingStatus(embStatus);
          setEmbeddingBackend(getEmbeddingBackend());
          setStatus("ready");
        } catch (err) {
          if (isMountedRef.current) { setError(String(err)); setStatus("error"); }
        }
      }
    }
    if (isMountedRef.current) setLlmBackend(getActiveBackend());
  }, []);

  // ── Preset loader ────────────────────────────────────────────────────────

  const loadPreset = useCallback(async (preset: ModelPreset) => {
    setStatus("loading-models");
    setError(null);
    try {
      // Load embedding model first (smaller, faster)
      if (preset.embedUrl && !isTauri()) {
        const embStatus = await initEmbeddings(preset.embedUrl);
        if (!isMountedRef.current) return;
        setEmbeddingStatus(embStatus);
        setEmbeddingBackend(getEmbeddingBackend());
      }
      // Load web LLM
      if (preset.llmUrl && !isTauri()) {
        await loadWebLlm({ modelUrl: preset.llmUrl });
        if (!isMountedRef.current) return;
        setLlmBackend(getActiveBackend());
      }
      if (isMountedRef.current) setStatus("ready");
    } catch (err) {
      if (isMountedRef.current) { setError(String(err)); setStatus("error"); }
    }
  }, []);

  // ── Web LLM (MediaPipe) ──────────────────────────────────────────────────

  const loadWebLlmModel = useCallback(async (opts: WebLlmOptions) => {
    setStatus("loading-models");
    try {
      await loadWebLlm(opts);
      if (!isMountedRef.current) return;
      setLlmBackend(getActiveBackend());
      setStatus("ready");
    } catch (err) {
      if (isMountedRef.current) { setError(String(err)); setStatus("error"); }
    }
  }, []);

  const unloadWebLlmModel = useCallback(() => {
    unloadWebLlm();
    setLlmBackend(getActiveBackend());
  }, []);

  // ── API config ───────────────────────────────────────────────────────────

  const configureApi = useCallback((cfg: ApiConfig) => {
    persistApiConfig(cfg);
    setLlmBackend(getActiveBackend());
  }, []);

  // ── Embedding engine ─────────────────────────────────────────────────────

  const initEmbeddingEngine = useCallback(async (liteRtModelUrl?: string) => {
    const embStatus = await initEmbeddings(liteRtModelUrl);
    if (!isMountedRef.current) return;
    setEmbeddingStatus(embStatus);
    setEmbeddingBackend(getEmbeddingBackend());
  }, []);

  // ── Model manager loader ─────────────────────────────────────────────────
  //
  // Called by ModelManagerPanel when the user clicks "Load" on a cached model.
  // Handles both LLM (.task via MediaPipe) and embedding (.tflite via LiteRT).

  const loadLlmFromCache = useCallback(async (url: string, modelId: string) => {
    setStatus("loading-models");
    setError(null);
    try {
      const isLocalPath = url.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(url);
      if (isTauri() && isLocalPath) {
        await loadLmFromPath(url, {
          accelerator: configRef.current?.accelerator,
          scanned: availableModels,
        });
      } else {
        await loadWebLlm({ modelUrl: url });
      }
      if (!isMountedRef.current) return;
      setActiveLlmModelId(modelId);
      setLlmBackend(getActiveBackend());
      const catalogueEntry = MODEL_CATALOGUE.find((m) => m.id === modelId);
      if (catalogueEntry?.contextLength && configRef.current) {
        const next = { ...configRef.current, contextLength: catalogueEntry.contextLength };
        configRef.current = next;
        setConfigState(next);
        saveConfig(next).catch((e) => console.warn("[useChat] saveConfig failed:", e));
      }
      setStatus("ready");
    } catch (err) {
      if (isMountedRef.current) { setError(String(err)); setStatus("error"); }
    }
  }, []);

  const loadEmbedFromCache = useCallback(async (url: string, modelId: string) => {
    setStatus("loading-models");
    setError(null);
    try {
      const embStatus = await initEmbeddings(url);
      if (!isMountedRef.current) return;
      setActiveEmbedModelId(modelId);
      setEmbeddingStatus(embStatus);
      setEmbeddingBackend(getEmbeddingBackend());
      setStatus("ready");
    } catch (err) {
      if (isMountedRef.current) { setError(String(err)); setStatus("error"); }
    }
  }, []);

  // ── Conversations ────────────────────────────────────────────────────────

  const createConversation = useCallback(async (): Promise<string> => {
    const id = uuidv4();
    const now = new Date().toISOString();
    const conv: Conversation = { id, title: "New conversation", createdAt: now, updatedAt: now };
    await saveConversation(conv);
    if (isMountedRef.current) setConversations((prev) => [conv, ...prev]);
    return id;
  }, []);

  // Tracks the most recently requested conversation ID so that a slow
  // listMessages() response for an earlier selection doesn't overwrite the
  // messages of a later selection (rapid switching race condition).
  const pendingConvIdRef = useRef<string | null>(null);

  const selectConversation = useCallback((id: string): Promise<void> => {
    setActiveConvId(id);
    setLastRagChunks([]);
    pendingConvIdRef.current = id;
    // Swap LM model if the conversation has a model override different from current config
    const conv = conversations.find((c) => c.id === id);
    if (isTauri() && conv?.modelPath && conv.modelPath !== configRef.current?.lmModelPath) {
      const cfg = configRef.current;
      setStatus("loading-models");
      unloadModels()
        .then(() => loadLmFromPath(conv.modelPath!, { accelerator: cfg?.accelerator }))
        .then(() => { if (isMountedRef.current) setStatus("ready"); })
        .catch((e) => { if (isMountedRef.current) { setStatus("error"); setError(String(e)); } });
    }
    return listMessages(id).then((msgs) => {
      // Discard if the user switched away before this response arrived.
      if (pendingConvIdRef.current !== id) return;
      if (isMountedRef.current) setMessages(msgs);
    }).catch((e) => {
      if (pendingConvIdRef.current !== id) return;
      if (isMountedRef.current) { setError(String(e)); setStatus("error"); }
    });
  }, [conversations]);

  const renameConversation = useCallback(async (id: string, title: string) => {
    const conv = await getConversation(id);
    if (!conv || !isMountedRef.current) return;
    const updated = { ...conv, title, updatedAt: new Date().toISOString() };
    await saveConversation(updated);
    if (isMountedRef.current) setConversations((prev) => prev.map((c) => (c.id === id ? updated : c)));
  }, []);

  const updateConversationInstruction = useCallback(async (id: string, systemInstruction: string) => {
    const conv = await getConversation(id);
    if (!conv || !isMountedRef.current) return;
    const updated = { ...conv, systemInstruction: systemInstruction || undefined, updatedAt: new Date().toISOString() };
    await saveConversation(updated);
    if (isMountedRef.current) setConversations((prev) => prev.map((c) => (c.id === id ? updated : c)));
  }, []);

  const switchConversationModel = useCallback(async (id: string, modelPath: string | undefined) => {
    const conv = await getConversation(id);
    if (!conv || !isMountedRef.current) return;
    const updated = { ...conv, modelPath: modelPath || undefined, updatedAt: new Date().toISOString() };
    await saveConversation(updated);
    if (isMountedRef.current) setConversations((prev) => prev.map((c) => (c.id === id ? updated : c)));
    // Reload the LM only if this is the active conversation
    if (activeConvIdRef.current !== id || !isTauri()) return;
    if (!isMountedRef.current) return;
    setStatus("loading-models");
    try {
      await unloadModels();
      const resolvedPath = modelPath || config?.lmModelPath;
      if (resolvedPath) await loadLmFromPath(resolvedPath, { accelerator: config?.accelerator, scanned: availableModels });
      if (isMountedRef.current) setStatus("ready");
    } catch (err) {
      if (isMountedRef.current) { setStatus("error"); setError(String(err)); }
    }
  }, [config]);

  const removeConversation = useCallback(async (id: string) => {
    // Abort any in-flight generation for this conversation so onDone doesn't
    // write an orphaned assistant message to the deleted conversation's DB doc.
    if (activeConvIdRef.current === id) {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      sendingRef.current = false;
    }
    // deleteConversation cascades to all messages + their chunk siblings
    await deleteConversation(id);
    invalidateRagPoolCache();
    if (!isMountedRef.current) return;
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeConvIdRef.current === id) {
      setActiveConvId(null);
      setMessages([]);
      setStreamingContent(null);
      setStatus("ready");
    }
  }, []);

  // ── Embed a message and save its vector(s) back to CouchbaseLite ─────────
  //
  // Short messages (< CHUNK_SIZE chars) are embedded as a single document.
  // Long messages are split into overlapping chunks; each chunk is saved as
  // a separate message document so the vector index stays fine-grained.
  // The original message document gets the embedding of its first chunk so
  // it remains retrievable even without loading all chunks.

  const embedAndSave = useCallback(async (msg: Message): Promise<number[] | null> => {
    try {
      const modelId = modelsLoaded.current ? EMBED_MODEL_ID : undefined;
      const chunks = splitIntoChunks(
        msg.content,
        config?.chunkSize,
        config?.chunkOverlap,
      );

      if (chunks.length <= 1) {
        // Single chunk — embed in-place on the original message document
        const vec = await embed(msg.content, modelId);
        const updated: Message = { ...msg, embedding: vec };
        await saveMessage(updated);
        if (isMountedRef.current) {
          setMessages((prev) => prev.map((m) => (m.id === msg.id ? updated : m)));
        }
        return vec; // return for reuse by caller
      }

      // Multiple chunks — embed each and save as sibling message documents.
      // Track sibling IDs on the parent so they can be cascade-deleted later.
      const chunkIds: string[] = [];
      for (let i = 1; i < chunks.length; i++) {
        chunkIds.push(`${msg.id}-chunk-${i}`);
      }

      let firstVec: number[] | null = null;
      for (let i = 0; i < chunks.length; i++) {
        const vec = await embed(chunks[i], modelId);
        if (i === 0) {
          firstVec = vec;
          // Update the original message with the first chunk's embedding and
          // the list of sibling IDs so deletes can cascade.
          const updated: Message = { ...msg, embedding: vec, chunkIds };
          await saveMessage(updated);
          if (isMountedRef.current) {
            setMessages((prev) => prev.map((m) => (m.id === msg.id ? updated : m)));
          }
        } else {
          const chunkMsg: Message = {
            id: `${msg.id}-chunk-${i}`,
            conversationId: msg.conversationId,
            role: msg.role,
            content: chunks[i],
            createdAt: msg.createdAt,
            embedding: vec,
            isChunk: true,
          };
          await saveMessage(chunkMsg);
        }
      }
      return firstVec; // reusable by caller for RAG retrieval
    } catch (e) {
      console.warn("[useChat] embed failed:", e);
      return null;
    }
  }, [config]);

  // ── Send a message ───────────────────────────────────────────────────────

  const sendMessage = useCallback(async (text: string, imageDataUrl?: string, historyOverride?: Message[]) => {
    if (!config) return;
    // Use a ref guard in addition to status so rapid concurrent calls in the
    // same tick (before React re-renders) are also blocked.
    if (sendingRef.current) return;
    if (status === "generating" || status === "embedding" || status === "loading-models") return;
    sendingRef.current = true;
    // Hoist assistantId outside the try block so the catch can remove the
    // placeholder bubble if an exception fires after it was added to messages.
    let assistantId = "";
    try {

    // Use the ref so a conversation switch between the guard check and the
    // first await doesn't attribute the message to the wrong conversation.
    let convId = activeConvIdRef.current;
    if (!convId) {
      convId = await createConversation();
      setActiveConvId(convId);
    }

    // Convert image data URL to a CBL blob reference on Tauri before persisting.
    // On web the data URL is stored as-is (no blob API available).
    const storedImageRef = imageDataUrl
      ? await saveImageAsBlob(imageDataUrl)
      : undefined;

    // Persist user message
    const userMsg: Message = {
      id: uuidv4(),
      conversationId: convId,
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
      ...(storedImageRef ? { imageDataUrl: storedImageRef } : {}),
    };
    await saveMessage(userMsg);
    setMessages((prev) => [...prev, userMsg]);

    // Auto-title from first user message.
    // Read the latest conversations snapshot via a ref-captured value so we
    // don't need a side-effect inside the state updater (which runs twice in
    // StrictMode and would fire renameConversation twice).
    const convSnapshot = conversationsRef.current.find((c) => c.id === convId);
    if (convSnapshot?.title === "New conversation") {
      const autoTitle = text.slice(0, 60) + (text.length > 60 ? "…" : "");
      setConversations((prev) =>
        prev.map((c) => c.id === convId ? { ...c, title: autoTitle } : c),
      );
      renameConversation(convId, autoTitle).catch((e) => {
        if (isMountedRef.current) setError(String(e));
      });
    }

    // Embed user message — runs in background but we await it before RAG retrieval.
    // embedAndSave returns the first-chunk vector so we can reuse it for retrieval
    // without a second embed() call.
    const userEmbedPromise = embedAndSave(userMsg);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    setStatus("generating");
    setStreamingContent("");
    setLastCompletedResponse(null);
    setStreamingTokensPerSec(0);
    streamStartRef.current = Date.now();
    streamTokenCountRef.current = 0;
    setStreamingTokenCount(0);
    setLastRagChunks([]);

    // ── RAG retrieval ──────────────────────────────────────────────────────
    let ragSourceIds: string[] = [];
    let ragContext = "";

    if (ragEnabled) {
      try {
        setStatus("embedding");
        // Reuse the vector from embedAndSave — avoids a second embed() call.
        // Fall back to a fresh embed if embedAndSave failed (returned null).
        const savedVec = await userEmbedPromise;
        const userVec = savedVec ?? await embed(
          text,
          modelsLoaded.current ? EMBED_MODEL_ID : undefined,
        );
        const rawRetrieved = await retrieveTopK(
          userVec,
          text,
          config.ragTopK * 3, // over-fetch for re-ranking
          config.ragThreshold ?? 0.3,
          convId,
          config.ragSourceTypes ?? ["knowledge", "message"],
          config.hybridBm25Weight ?? 0.3,
        );
        // Jaccard re-ranking is only meaningful on cosine scores (0–1).
        // When BM25 is active, RRF fusion already incorporates lexical signal
        // and produces tiny scores (~0.008) that make alpha weighting useless.
        const bm25Weight = config.hybridBm25Weight ?? 0.3;
        const retrieved = (bm25Weight === 0 ? rerank(text, rawRetrieved) : rawRetrieved)
          .slice(0, config.ragTopK);
        ragSourceIds = retrieved.map((r) => r.id);
        setLastRagChunks(retrieved);
        if (retrieved.length > 0) {
          // Build only the context block — pass empty query and system so the
          // result is just the "--- Retrieved context ---" section.
          const lines = [
            "--- Retrieved context ---",
            ...retrieved.map(
              ({ source, text, score, type }, i) =>
                `[${i + 1}] (${type}: ${source}, score: ${score.toFixed(3)})\n${text}`,
            ),
            "--- End of context ---",
          ];
          ragContext = lines.join("\n");
        }
      } catch {
        // Embedding failed — proceed without RAG context
      }
    } else {
      setLastRagChunks([]);
    }

    // If the user aborted while RAG retrieval was running, bail before
    // starting generation — avoids a setLastRagChunks call on a stale conv.
    if (abortController.signal.aborted) {
      sendingRef.current = false;
      if (isMountedRef.current) setStatus("ready");
      return;
    }

    setStatus("generating");
    setLastToolExecutions([]);
    setStreamingAgentName(null);

    // ── Build history for the LLM ──────────────────────────────────────────
    // historyOverride is used by editMessage to pass the already-truncated
    // message list synchronously, before React re-renders with the new state.
    const history = (historyOverride ?? messages)
      .concat(userMsg)
      .map((m) => ({ role: m.role, content: m.content }));

    // ── Stream generation ──────────────────────────────────────────────────
    let accumulated = "";
    assistantId = uuidv4();

    // Build the final-message template (NOT added to messages yet —
    // StreamingBubble owns the display during streaming via streamingContent).
    const placeholderMsg: Message = {
      id: assistantId,
      conversationId: convId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
    };

    // The router is always the active responder. Agents are configuration only.
    const currentConv = conversationsRef.current.find((c) => c.id === convId);

    // ── Router intercept ────────────────────────────────────────────────────
    // Always runs: picks the most appropriate agent for this message, then uses
    // that agent's system prompt + tools for the actual visible response.
    let effectiveAgent: import("../lib/types").Agent | null = null;
    if (true) {
      const candidateAgents = agents.filter((a) => !a.isRouter);
      if (candidateAgents.length > 0) {
        const agentList = candidateAgents
          .map((a) => `- ${a.name}${a.description ? `: ${a.description}` : ""}`)
          .join("\n");
        const routerSystem =
          "You are a routing assistant. Read the user's message and select the most appropriate agent.\n" +
          'Reply ONLY with valid JSON on a single line. Example: {"agent": "coding-assistant"}\n\n' +
          "Available agents:\n" + agentList +
          '\n\nRespond ONLY with: {"agent": "<agent-name>"}';
        setStreamingContent("🔀 Routing…");
        try {
          const raw = await generateOnce(text, routerSystem, config, abortController.signal);
          // Accept both "agent" and "route" as the JSON key for robustness.
          // Normalise both sides: lowercase, collapse underscores/hyphens to spaces.
          const m = raw.match(/\{\s*"(?:agent|route)"\s*:\s*"([^"]+)"\s*\}/);
          if (m) {
            const norm = (s: string) => s.toLowerCase().replace(/[_-]/g, " ").replace(/\s+/g, " ").trim();
            const targetName = norm(m[1]);
            const target = candidateAgents.find((a) => norm(a.name) === targetName);
            if (target) effectiveAgent = target;
          }
        } catch {
          // Routing failed — fall through with no system instruction (default prompt)
        }
        // Show agent name as metadata badge (not injected into content)
        setStreamingAgentName(effectiveAgent?.name ?? "Router");
        setStreamingContent("");
      } else {
        // No custom agents — still badge as "Router" so the user can see it's active
        setStreamingAgentName("Router");
        setStreamingContent("");
      }
    }

    const systemInstruction =
      effectiveAgent?.systemPrompt ??
      currentConv?.systemInstruction ??
      "You are a helpful assistant. Answer using the provided context when relevant.";

    // The router always has access to all tools. When routing resolves to a specific
    // agent, restrict to that agent's toolIds; otherwise all tools are fair game.
    const allTools = [
      ...ALL_TOOLS,
      ...(knowledgeSearchToolRef.current ? [knowledgeSearchToolRef.current] : []),
      ...pdfToolsRef.current,
      ...sourceToolsRef.current,
      createWebSearchTool(config?.searxngUrl ?? ""),
    ];

    const effectiveTools = effectiveAgent
      ? allTools.filter((t) => effectiveAgent!.toolIds.includes(t.id ?? ""))
      : allTools;

    // Local accumulator for tool executions — used to persist with the message.
    const toolExecutionsAcc: Array<{ tool: string; args: Record<string, unknown>; result: string; durationMs: number }> = [];

    await generateStream(
      history,
      ragContext,
      {
        modelId: config.lmModelPath ? "rag-lm" : undefined,
        systemInstruction,
        config,
        enabledTools: effectiveTools,
        signal: abortController.signal,
        imageDataUrl,
      },
      {
        onChunk: (chunk) => {
          if (!isMountedRef.current) return;
          accumulated += chunk;
          streamTokenCountRef.current += 1;
          setStreamingTokenCount(streamTokenCountRef.current);
          const elapsed = (Date.now() - streamStartRef.current) / 1000;
          if (elapsed > 0.5) {
            setStreamingTokensPerSec(streamTokenCountRef.current / elapsed);
          }
          // Hide <think>…</think> reasoning blocks while streaming.
          // During an open block the visible content is empty; once closed it's stripped.
          setStreamingContent(stripThinking(accumulated));
        },
        onDone: async (latencyMs: number) => {
          const wasStopped = abortController.signal.aborted;
          const visible = stripThinking(accumulated);
          // Always clear these regardless of mount state
          sendingRef.current = false;
          if (visible.trim() && !wasStopped) {
            setLastCompletedResponse(visible);
          }
          setStreamingContent(null);

          if (isMountedRef.current) setStreamingAgentName(null);
          if (!isMountedRef.current) return;
          // Save whatever was accumulated — even a partial response is useful
          if (visible.trim()) {
            const assistantMsg: Message = {
              ...placeholderMsg,
              content: visible,
              latencyMs,
              ragSourceIds,
              stopped: wasStopped || undefined,
              agentName: effectiveAgent?.name ?? "Router",
              toolExecutions: toolExecutionsAcc.length > 0 ? toolExecutionsAcc : undefined,
            };
            await saveMessage(assistantMsg);
            if (isMountedRef.current) {
              setMessages((prev) => [...prev, assistantMsg]);
            }
            // Only embed and notify on a complete (non-stopped) response
            if (!wasStopped) {
              void embedAndSave(assistantMsg);
              notifyIfHidden("Response ready", visible.slice(0, 80) + (visible.length > 80 ? "…" : ""));
            }
          } else if (isMountedRef.current) {
            setMessages((prev) => prev.filter((m) => m.id !== assistantId));
          }

          if (!isMountedRef.current) return;
          // Read from ref to avoid side-effects inside the state updater
          // (updaters run twice in StrictMode — DB writes must stay outside).
          const latestConv = conversationsRef.current.find((c) => c.id === convId);
          if (latestConv) {
            const updatedConv = { ...latestConv, updatedAt: new Date().toISOString() };
            setConversations((prev) =>
              prev.map((c) => c.id === convId ? updatedConv : c),
            );
            saveConversation(updatedConv).catch((e) => console.warn("[useChat] saveConversation failed:", e));
          }
          setStatus("ready");
        },
        onToolCall: (_toolId, _args) => {
          if (isMountedRef.current) setStatus("generating");
        },
        onToolResult: (execution) => {
          toolExecutionsAcc.push({ tool: execution.call.tool, args: execution.call.args, result: execution.result, durationMs: execution.durationMs });
          if (isMountedRef.current) setLastToolExecutions((prev) => [...prev, execution]);
          // If view_pdf_page rendered a page, save it as an assistant message so
          // it appears inline in the chat (not just in the Tools panel).
          if (execution.imageDataUrl && activeConvIdRef.current) {
            const convId = activeConvIdRef.current;
            const imgMsg: Message = {
              id: uuidv4(),
              conversationId: convId,
              role: "assistant",
              content: execution.result,
              imageDataUrl: execution.imageDataUrl,
              createdAt: new Date().toISOString(),
            };
            saveMessage(imgMsg).catch((e) => console.warn("[onToolResult] Failed to save image message:", e));
            if (isMountedRef.current) setMessages((prev) => [...prev, imgMsg]);
          }
        },
        onError: (err) => {
          sendingRef.current = false;
          if (!isMountedRef.current) return;
          setStreamingContent(null);
          setMessages((prev) => prev.filter((m) => m.id !== assistantId));
          setError(err);
          setStatus("error");
        },
      },
    );
    } catch (err) {
      sendingRef.current = false;
      if (isMountedRef.current) {
        // Remove the placeholder bubble that was pushed before generateStream,
        // and clear the streaming indicator so the UI doesn't freeze.
        setStreamingContent(null);
        setMessages((prev) => prev.filter((m) => m.id !== assistantId));
        setError(String(err));
        setStatus("error");
      }
    }
  }, [
    // conversations is accessed via conversationsRef (kept in sync by useEffect)
    // so it doesn't need to be a dep — removing it prevents sendMessage from
    // being recreated on every saveConversation call.
    config, status, activeConvId, messages,
    agents,
    ragEnabled, enabledTools,
    createConversation, renameConversation, embedAndSave,
  ]);

  // ── Agents ───────────────────────────────────────────────────────────────

  const createAgent = useCallback(async (
    name: string,
    systemPrompt: string,
    description?: string,
    toolIds: string[] = [],
    isRouter?: boolean,
  ): Promise<Agent> => {
    const now = new Date().toISOString();
    const agent: Agent = {
      id: uuidv4(),
      name,
      systemPrompt,
      description,
      toolIds,
      ...(isRouter ? { isRouter: true } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await saveAgent(agent);
    setAgents((prev) => [...prev, agent].sort((a, b) => a.name.localeCompare(b.name)));
    return agent;
  }, []);

  const updateAgent = useCallback(async (
    id: string,
    patch: Partial<Pick<Agent, "name" | "systemPrompt" | "description" | "toolIds" | "isRouter">>,
  ) => {
    // Read from in-memory state before the updater runs to avoid a stale DB round-trip
    const current = agents.find((a) => a.id === id);
    if (!current) return;
    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
    setAgents((prev) =>
      prev
        .map((a) => (a.id !== id ? a : updated))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
    await saveAgent(updated);
  }, [agents]);

  const removeAgent = useCallback(async (id: string) => {
    await deleteAgent(id);
    setAgents((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // ── Full-text search across all conversations ─────────────────────────────

  const searchConversations = useCallback(async (query: string): Promise<
    Array<{ convId: string; convTitle: string; messageId: string; snippet: string; role: string }>
  > => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();

    // On Tauri: single N1QL LIKE query across all messages — O(1) DB round-trips.
    // On web: scan the in-memory store directly without per-conversation fetches.
    let matchingMsgs: import("../lib/types").Message[];
    if (isTauri()) {
      const { executeQuery } = await import("tauri-plugin-cblite");
      const rows = await executeQuery(
        "N1QL",
        `SELECT META().id AS id, conversationId, role, content, createdAt
         FROM \`_default\`.messages
         WHERE LOWER(content) LIKE $pattern
           AND (isChunk IS MISSING OR isChunk = false)
         ORDER BY createdAt DESC
         LIMIT 200`,
        { pattern: `%${q}%` },
      );
      matchingMsgs = rows as import("../lib/types").Message[];
    } else {
      // Web: fetch messages from all conversations sequentially.
      // The messages state only holds the active conversation, so we must
      // query each conversation individually.
      const allMsgs: import("../lib/types").Message[] = [];
      for (const conv of conversations) {
        const msgs = await listMessages(conv.id, 500);
        allMsgs.push(...msgs);
      }
      matchingMsgs = allMsgs.filter(
        (m) => !m.isChunk && m.content.toLowerCase().includes(q),
      );
    }

    const convMap = new Map(conversations.map((c) => [c.id, c.title]));
    const results: Array<{ convId: string; convTitle: string; messageId: string; snippet: string; role: string }> = [];

    for (const msg of matchingMsgs) {
      const idx = msg.content.toLowerCase().indexOf(q);
      if (idx === -1) continue;
      const start = Math.max(0, idx - 40);
      const end = Math.min(msg.content.length, idx + query.length + 60);
      const snippet =
        (start > 0 ? "…" : "") +
        msg.content.slice(start, end) +
        (end < msg.content.length ? "…" : "");
      results.push({
        convId: msg.conversationId,
        convTitle: convMap.get(msg.conversationId) ?? msg.conversationId,
        messageId: msg.id,
        snippet,
        role: msg.role,
      });
    }
    return results;
  // messages removed from deps — web path now fetches per-conversation via
  // listMessages() rather than filtering the active-conversation state.
  }, [conversations]);

  // ── Conversation summary ──────────────────────────────────────────────────
  //
  // Compresses the oldest messages in the active conversation into a single
  // summary message. Bookmarked messages are never removed.
  // Triggered manually or when context usage exceeds a threshold.

  const summarizeConversation = useCallback((keepLast = 6): void => {
    if (!config || !activeConvId) return;
    if (messages.length <= keepLast + 2) return; // nothing to compress
    // Guard against concurrent sendMessage calls during summarisation.
    if (sendingRef.current) return;
    sendingRef.current = true;
    void (async () => { try {

    // Capture before any await so conversation switches mid-generation don't
    // corrupt the wrong conversation's message list.
    const convId = activeConvId;
    const snapshotMessages = messages;

    // Split: messages to summarise vs messages to keep
    const toSummarise = snapshotMessages.slice(0, snapshotMessages.length - keepLast)
      .filter((m) => !m.bookmarked); // never remove bookmarked messages
    if (toSummarise.length < 2) { sendingRef.current = false; return; }

    const toSummariseIds = new Set(toSummarise.map((m) => m.id));
    const toKeep = snapshotMessages.filter((m) => !toSummariseIds.has(m.id));

    setStatus("generating");
    setStreamingContent(""); // show streaming bubble during summarisation
    setError(null);

    const transcript = toSummarise
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");

    const summaryPrompt = [
      { role: "system", content: "You are a concise summariser. Produce a factual summary of the conversation below, preserving key facts, decisions, and context. Write in third person. Be brief." },
      { role: "user", content: `Summarise this conversation:\n\n${transcript}` },
    ];

    let summaryText = "";
    // Wire to abortControllerRef so the global Stop button cancels summarisation
    const summaryAbort = new AbortController();
    abortControllerRef.current = summaryAbort;
    await generateStream(
      summaryPrompt,
      "",
      { config, signal: summaryAbort.signal },
      {
        onChunk: (c) => {
          summaryText += c;
          if (isMountedRef.current) setStreamingContent(stripThinking(summaryText));
        },
        onDone: async () => {
          if (isMountedRef.current) setStreamingContent(null);
          const visibleSummary = stripThinking(summaryText).trim();
          // Don't commit if the user aborted or summary was empty
          if (summaryAbort.signal.aborted || !visibleSummary) {
            sendingRef.current = false;
            if (isMountedRef.current) setStatus("ready");
            return;
          }

          const summaryMsg: Message = {
            id: uuidv4(),
            conversationId: convId,
            role: "assistant",
            content: `**[Conversation summary]**\n\n${visibleSummary}`,
            // Place at the timestamp of the first summarised message
            createdAt: toSummarise[0].createdAt,
          };

          // Save the summary FIRST, then delete the source messages.
          // This order ensures no data is lost if the process is interrupted
          // between the two steps — a duplicate summary is recoverable,
          // deleted messages without a summary are not.
          if (summaryAbort.signal.aborted || !isMountedRef.current) { sendingRef.current = false; return; }
          await saveMessage(summaryMsg);
          if (summaryAbort.signal.aborted || !isMountedRef.current) { sendingRef.current = false; return; }
          for (const m of toSummarise) await deleteMessage(m.id);

          if (isMountedRef.current) {
            // Only update messages if the user hasn't switched to a different
            // conversation while the summary was generating. activeConvIdRef
            // always holds the current value, avoiding a stale closure.
            if (activeConvIdRef.current === convId) {
              setMessages([summaryMsg, ...toKeep].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
            }
            setStatus("ready");
          }
          sendingRef.current = false;
        },
        onError: (err) => {
          sendingRef.current = false;
          if (isMountedRef.current) { setStreamingContent(null); setError(err); setStatus("error"); }
        },
      },
    );
    } catch (err) {
      sendingRef.current = false;
      if (isMountedRef.current) { setError(String(err)); setStatus("error"); }
    } })();
  }, [config, activeConvId, messages]);

  // ── Re-embed all ──────────────────────────────────────────────────────────
  //
  // Re-computes embeddings for every knowledge chunk and every conversation
  // message using the currently loaded embedding model. Use after switching
  // embedding models to avoid stale vectors degrading retrieval quality.

  const [reEmbedProgress, setReEmbedProgress] = useState<{ done: number; total: number } | null>(null);
  const [ingestProgress, setIngestProgress] = useState<{ done: number; total: number; source: string } | null>(null);
  const reEmbedAbortRef = useRef<AbortController | null>(null);

  const cancelReEmbed = useCallback(() => {
    reEmbedAbortRef.current?.abort();
  }, []);

  const reEmbedAll = useCallback(async () => {
    // Cancel any in-flight re-embed before starting a new one
    reEmbedAbortRef.current?.abort();
    const abort = new AbortController();
    reEmbedAbortRef.current = abort;

    setStatus("embedding");
    setError(null);
    const modelId = modelsLoaded.current ? EMBED_MODEL_ID : undefined;

    try {
      const allChunks = await listKnowledgeChunks();

      // Use conversationsRef so conversations created after reEmbedAll started
      // are included. The state closure would be stale for long-running re-embeds.
      const allConversations = conversationsRef.current;

      // Count total messages without loading them all — use conversation list
      // as a proxy. We'll update total as we go if counts differ.
      let total = allChunks.length + allConversations.length; // rough estimate
      let done = 0;
      if (isMountedRef.current) setReEmbedProgress({ done, total });

      // Re-embed knowledge chunks
      for (const chunk of allChunks) {
        if (abort.signal.aborted) break;
        const embedding = await embed(chunk.text, modelId);
        if (abort.signal.aborted) break;
        await saveKnowledgeChunk({ ...chunk, embedding });
        done++;
        if (isMountedRef.current) setReEmbedProgress({ done, total });
      }
      if (!abort.signal.aborted && isMountedRef.current) setKnowledgeChunks(await listKnowledgeChunks());

      // Re-embed messages one conversation at a time — never accumulate all
      // messages in memory simultaneously.
      for (const conv of allConversations) {
        if (abort.signal.aborted) break;
        const msgs = await listMessages(conv.id);
        // Adjust total now that we know the real message count for this conv
        total = total - 1 + msgs.length; // replace the 1-conv estimate with actual message count
        if (isMountedRef.current) setReEmbedProgress({ done, total });

        for (const msg of msgs) {
          if (abort.signal.aborted) break;
          if (msg.content.trim().length < 20) {
            done++;
            if (isMountedRef.current) setReEmbedProgress({ done, total });
            continue;
          }
          const chunks = splitIntoChunks(
            msg.content,
            config?.chunkSize,
            config?.chunkOverlap,
          );
          const embedding = await embed(chunks[0] ?? msg.content, modelId);
          if (abort.signal.aborted) break;
          await saveMessage({ ...msg, embedding });

          // Re-embed chunk siblings if this message was previously split
          if (msg.chunkIds?.length && chunks.length > 1) {
            for (let i = 1; i < chunks.length && i - 1 < msg.chunkIds.length; i++) {
              if (abort.signal.aborted) break;
              const siblingEmb = await embed(chunks[i], modelId);
              if (abort.signal.aborted) break;
              await saveMessage({
                id: msg.chunkIds[i - 1],
                conversationId: msg.conversationId,
                role: msg.role,
                content: chunks[i],
                createdAt: msg.createdAt,
                embedding: siblingEmb,
                isChunk: true,
              });
            }
          }

          done++;
          if (isMountedRef.current) setReEmbedProgress({ done, total });
        }
      }

      invalidateRagPoolCache();
      reEmbedAbortRef.current = null;
      if (isMountedRef.current) { setReEmbedProgress(null); setStatus("ready"); }
    } catch (err) {
      reEmbedAbortRef.current = null;
      if (!isMountedRef.current) return;
      setReEmbedProgress(null);
      if (!abort.signal.aborted) {
        setError(String(err));
        setStatus("error");
      } else {
        invalidateRagPoolCache();
        setStatus("ready");
      }
    }
  // conversationsRef used instead of conversations — see comment above.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  // ── RAG source viewer ─────────────────────────────────────────────────────
  //
  // Given a message's ragSourceIds, fetch the actual chunk text from the DB.
  // Returns objects with source label, text preview, and the retrieval score
  // stored in lastRagChunks (matched by id).

  const getRagChunksForMessage = useCallback(async (ragSourceIds: string[]) => {
    const [knowledgeChunks, messageChunks] = await Promise.all([
      getKnowledgeChunksByIds(ragSourceIds),
      getMessagesByIds(ragSourceIds),
    ]);
    // Scores are only available for the most recently generated message —
    // lastRagChunks is overwritten on every new query. Only use scores when
    // the requested IDs match the current lastRagChunks set; otherwise omit
    // them rather than showing scores from a different query.
    const lastIds = new Set(lastRagChunks.map((c) => c.id));
    const idsMatch = ragSourceIds.length > 0 && ragSourceIds.every((id) => lastIds.has(id));
    const scoreMap = idsMatch
      ? new Map(lastRagChunks.map((c) => [c.id, c.score]))
      : new Map<string, number>();
    const results = [
      ...knowledgeChunks.map((c) => ({
        id: c.id,
        source: c.source,
        text: c.text,
        type: "knowledge" as const,
        score: scoreMap.get(c.id),
      })),
      ...messageChunks.map((m) => ({
        id: m.id,
        source: `Message (${m.role})`,
        text: m.content,
        type: "message" as const,
        score: scoreMap.get(m.id),
      })),
    ];
    // Sort by score descending if available
    return results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }, [lastRagChunks]);

  // ── Bookmarks ─────────────────────────────────────────────────────────────

  const toggleBookmark = useCallback((messageId: string): void => {
    const msg = messages.find((m) => m.id === messageId);
    if (!msg) return;
    const updated: Message = { ...msg, bookmarked: !msg.bookmarked };
    // Optimistic update — revert on failure
    setMessages((prev) => prev.map((m) => m.id === messageId ? updated : m));
    saveMessage(updated).catch((e) => {
      if (isMountedRef.current) {
        setMessages((prev) => prev.map((m) => m.id === messageId ? msg : m));
        setError(String(e));
      }
    });
  }, [messages]);

  const getBookmarks = useCallback((): Promise<Message[]> => {
    return listBookmarkedMessages();
  }, []);

  // ── Export conversation ───────────────────────────────────────────────────

  const exportConversation = useCallback((format: "markdown" | "json") => {
    const conv = conversations.find((c) => c.id === activeConvId);
    if (!conv || messages.length === 0) return;

    let content: string;
    let filename: string;
    let mimeType: string;

    if (format === "json") {
      content = JSON.stringify({ conversation: conv, messages }, null, 2);
      filename = `${conv.title.slice(0, 40).replace(/[^a-z0-9]/gi, "_")}.json`;
      mimeType = "application/json";
    } else {
      const lines: string[] = [
        `# ${conv.title}`,
        `> Exported ${new Date().toLocaleString()}`,
        "",
      ];
      for (const msg of messages) {
        const role = msg.role === "user" ? "**You**" : "**Assistant**";
        const time = new Date(msg.createdAt).toLocaleTimeString();
        lines.push(`### ${role} — ${time}`);
        lines.push(msg.content);
        lines.push("");
      }
      content = lines.join("\n");
      filename = `${conv.title.slice(0, 40).replace(/[^a-z0-9]/gi, "_")}.md`;
      mimeType = "text/markdown";
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    // Revoke after 30 s — Firefox initiates downloads asynchronously and may
    // not start the transfer within 1 s for large exports, causing a silent
    // empty download if the URL is revoked too early.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }, [conversations, activeConvId, messages]);

  // ── Background notification ───────────────────────────────────────────────

  const notifyIfHidden = useCallback((title: string, body: string) => {
    if (document.visibilityState !== "hidden") return;
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") {
      new Notification(title, { body, icon: "/icons/icon.png" });
    } else if (Notification.permission === "default") {
      Notification.requestPermission().then((perm) => {
        if (perm === "granted") new Notification(title, { body, icon: "/icons/icon.png" });
      }).catch(() => { /* permission denied or API unavailable — safe to ignore */ });
    }
  }, []);

  // ── Stop generation ──────────────────────────────────────────────────────

  const stopGeneration = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }, []);

  // ── Branch conversation from a message point ─────────────────────────────
  //
  // Creates a new conversation containing all messages up to and including
  // the selected message, then switches to it.

  const branchConversation = useCallback(async (messageId: string) => {
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;

    const sourceConv = conversations.find((c) => c.id === activeConvId);
    const branchMessages = messages.slice(0, idx + 1);
    const branchTitle = `Branch: ${sourceConv?.title ?? "Conversation"}`;

    const newConvId = await createConversation();
    await renameConversation(newConvId, branchTitle);

    // Save all branched messages under the new conversation ID.
    // Strip embedding/chunkIds/isChunk so each message gets re-embedded fresh
    // under the new conversation — the old chunk sibling IDs are invalid here.
    for (const msg of branchMessages) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { embedding: _emb, chunkIds: _cids, isChunk: _ic, ...rest } = msg;
      const branched: Message = { ...rest, id: uuidv4(), conversationId: newConvId };
      await saveMessage(branched);
      void embedAndSave(branched);
    }

    // Load the new conversation
    await selectConversation(newConvId);
  }, [messages, conversations, activeConvId, createConversation, renameConversation, selectConversation]);

  // ── Edit a user message and regenerate from that point ───────────────────
  //
  // Truncates the message list to everything before the edited message,
  // then re-sends the new content as if the user typed it fresh.

  const editMessage = useCallback(async (messageId: string, newContent: string) => {
    // Block edits while generation is in progress — deleting messages mid-stream
    // would orphan the in-flight assistant response and corrupt the conversation.
    if (sendingRef.current) return;
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;

    // Delete the edited message and everything after it from the DB
    const toDelete = messages.slice(idx);
    await Promise.all(toDelete.map((m) => deleteMessage(m.id)));

    // Update state to only keep messages before the edited one
    const truncated = messages.slice(0, idx);
    setMessages(truncated);

    // Pass truncated array directly — React state update is async so the
    // messages closure in sendMessage would still see the old array otherwise.
    await sendMessage(newContent, undefined, truncated);
  }, [messages, sendMessage]);

  // ── Knowledge base ───────────────────────────────────────────────────────

  const ingestText = useCallback(async (source: string, rawText: string) => {
    // Don't corrupt the status machine if generation is in progress.
    if (sendingRef.current) {
      if (isMountedRef.current) setError("Cannot ingest while a response is being generated.");
      return;
    }
    setStatus("embedding");
    setError(null);
    const savedIds: string[] = [];
    try {
      const chunks = splitIntoChunks(rawText, config?.chunkSize, config?.chunkOverlap);
      const total = chunks.length;
      if (isMountedRef.current) setIngestProgress({ done: 0, total, source });
      for (let i = 0; i < chunks.length; i++) {
        const text = chunks[i];
        const embedding = await embed(
          text,
          modelsLoaded.current ? EMBED_MODEL_ID : undefined,
        );
        const chunk: KnowledgeChunk = {
          id: uuidv4(),
          source,
          text,
          embedding,
          createdAt: new Date().toISOString(),
        };
        await saveKnowledgeChunk(chunk);
        savedIds.push(chunk.id);
        if (isMountedRef.current) {
          setKnowledgeChunks((prev) => [chunk, ...prev]);
          setIngestProgress({ done: i + 1, total, source });
        }
      }
      if (isMountedRef.current) { setIngestProgress(null); setStatus("ready"); }
    } catch (err) {
      // Roll back any chunks saved before the failure
      for (const id of savedIds) {
        await deleteKnowledgeChunk(id).catch(() => {});
      }
      if (isMountedRef.current) {
        setKnowledgeChunks((prev) => prev.filter((c) => !savedIds.includes(c.id)));
        setIngestProgress(null);
        setError(String(err));
        setStatus("error");
      }
    }
  }, [config]);

  /**
   * Shared core: save a data URL as a blob, caption it with Gemma (or use
   * a fallback), embed the caption, and return the unsaved KnowledgeChunk.
   * Does NOT update UI state — callers own progress/status management.
   */
  const captionAndEmbedImage = useCallback(async (
    dataUrl: string,
    sourceName: string,
  ): Promise<KnowledgeChunk> => {
    const imageRef = await saveImageAsBlob(dataUrl);
    let caption = `Image: ${sourceName}`;
    if (llmBackend !== "mock") {
      try {
        let accumulated = "";
        await generateStream(
          [{ role: "user", content: "Describe this image in detail for search indexing. Include objects, colours, text, scene type, and notable features." }],
          "",
          {
            imageDataUrl: dataUrl,
            config: config!,
            modelId: activeLlmModelId ?? undefined,
            systemInstruction: "You are an image description assistant. Be specific and detailed.",
          },
          {
            onChunk: (t: string) => { accumulated += t; },
            onDone: () => {},
            onError: (e: string) => { throw new Error(e); },
          },
        );
        if (accumulated.trim()) caption = accumulated.trim();
      } catch { /* fallback caption already set */ }
    }
    const embedding = await embed(caption, modelsLoaded.current ? EMBED_MODEL_ID : undefined);
    return {
      id: uuidv4(),
      source: sourceName,
      text: caption,
      embedding,
      imageRef,
      createdAt: new Date().toISOString(),
    };
  }, [config, llmBackend, activeLlmModelId]);

  const ingestPdf = useCallback(async (file: File) => {
    setStatus("embedding");
    setError(null);
    try {
      // Each pdf.js call gets its own ArrayBuffer — pdf.js transfers (detaches)
      // the buffer it receives, so reusing one buffer across calls throws
      // "Cannot perform Construct on a detached ArrayBuffer".
      const { images } = await extractPdfContent(await file.arrayBuffer());
      const pages = await extractPdfPages(await file.arrayBuffer());
      if (pages.length === 0 && images.length === 0) throw new Error("No content found in PDF");

      // Persist raw PDF bytes to disk via Rust, then store the path in CBL
      // so PDF tools (get_pdf_page, view_pdf_page) can locate the file by name.
      // Re-read the file buffer here to guard against any internal consumption
      // by pdf.js; this also gives us a fresh ArrayBuffer for encoding.
      if (isTauri()) {
        try {
          const rawBuffer = await file.arrayBuffer();
          const bytes = new Uint8Array(rawBuffer);
          // Build base64 in chunks to avoid call-stack overflow on large files.
          let binary = "";
          const step = 8192;
          for (let i = 0; i < bytes.length; i += step) {
            binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + step, bytes.length)));
          }
          const b64 = btoa(binary);
          const { invoke } = await import("@tauri-apps/api/core");
          const savedPath = await invoke<string>("save_pdf", { filename: file.name, dataB64: b64 });
          await savePdfRecord(file.name, savedPath);
        } catch (e) {
          // Surface as a warning rather than failing the whole ingest — text
          // content is still usable even if the raw file couldn't be saved.
          console.warn("[ingestPdf] Failed to save PDF file for page tools:", e);
          if (isMountedRef.current) setError(`PDF saved to knowledge base, but file storage failed (page tools unavailable): ${String(e)}`);
        }
      }

      // Per-page text chunking — preserves page number in every chunk
      const savedIds: string[] = [];
      const allChunks = pages.flatMap(({ text: pageText, pageNumber }) =>
        splitIntoChunks(pageText, config?.chunkSize, config?.chunkOverlap).map((text) => ({ text, pageNumber })),
      );
      const total = allChunks.length + images.length;
      if (isMountedRef.current) setIngestProgress({ done: 0, total, source: file.name });
      for (let i = 0; i < allChunks.length; i++) {
        const { text, pageNumber } = allChunks[i];
        const embedding = await embed(text, modelsLoaded.current ? EMBED_MODEL_ID : undefined);
        const chunk: KnowledgeChunk = { id: uuidv4(), source: file.name, text, embedding, pageNumber, createdAt: new Date().toISOString() };
        await saveKnowledgeChunk(chunk);
        savedIds.push(chunk.id);
        if (isMountedRef.current) {
          setKnowledgeChunks((prev) => [chunk, ...prev]);
          setIngestProgress({ done: i + 1, total, source: file.name });
        }
      }

      // Embedded images — caption + embed each one
      for (let i = 0; i < images.length; i++) {
        const { dataUrl, pageNum } = images[i];
        const label = `${file.name} p.${pageNum} img${i + 1}`;
        if (isMountedRef.current) setIngestProgress({ done: allChunks.length + i, total, source: file.name });
        try {
          setStatus("embedding");
          const chunk = await captionAndEmbedImage(dataUrl, label);
          // Group under the PDF filename so delete-by-source removes everything
          const chunkUnderPdf = { ...chunk, source: file.name };
          await saveKnowledgeChunk(chunkUnderPdf);
          if (isMountedRef.current) setKnowledgeChunks((prev) => [chunkUnderPdf, ...prev]);
        } catch { /* skip failed image, continue */ }
        if (isMountedRef.current) setIngestProgress({ done: allChunks.length + i + 1, total, source: file.name });
      }

      if (isMountedRef.current) { setIngestProgress(null); setStatus("ready"); }
    } catch (err) {
      if (isMountedRef.current) { setIngestProgress(null); setError(String(err)); setStatus("error"); }
    }
  }, [captionAndEmbedImage, config?.chunkSize, config?.chunkOverlap]);

  const ingestUrl = useCallback(async (url: string) => {
    setStatus("embedding");
    setError(null);
    try {
      const { text, title } = await fetchUrlText(url);
      if (!text.trim()) throw new Error("No text extracted from URL");
      // ingestText owns status transitions from here
      await ingestText(title || url, text);
    } catch (err) {
      // Only reached for pre-ingest failures (fetchUrlText, empty text)
      if (isMountedRef.current) { setError(String(err)); setStatus("error"); }
    }
  }, [ingestText]);

  const ingestImage = useCallback(async (file: File) => {
    if (sendingRef.current) {
      if (isMountedRef.current) setError("Cannot ingest while a response is being generated.");
      return;
    }
    setStatus("embedding");
    setError(null);
    let savedId: string | null = null;
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      if (isMountedRef.current) setIngestProgress({ done: 0, total: 1, source: file.name });
      const chunk = await captionAndEmbedImage(dataUrl, file.name);
      await saveKnowledgeChunk(chunk);
      savedId = chunk.id;
      if (isMountedRef.current) {
        setKnowledgeChunks((prev) => [chunk, ...prev]);
        setIngestProgress({ done: 1, total: 1, source: file.name });
      }
      if (isMountedRef.current) { setIngestProgress(null); setStatus("ready"); }
    } catch (err) {
      if (savedId) await deleteKnowledgeChunk(savedId).catch(() => {});
      if (isMountedRef.current) {
        if (savedId) setKnowledgeChunks((prev) => prev.filter((c) => c.id !== savedId));
        setIngestProgress(null);
        setError(String(err));
        setStatus("error");
      }
    }
  }, [captionAndEmbedImage]);

  /** Render a PDF page and inject it as an assistant message in the active conversation. */
  const viewPdfPage = useCallback(async (filename: string, page: number) => {
    const path = await getPdfPath(filename);
    if (!path) { console.warn("[viewPdfPage] PDF not found:", filename); return; }
    const { invoke } = await import("@tauri-apps/api/core");
    const b64 = await invoke<string>("read_pdf_bytes", { path });
    const raw = atob(b64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const dataUrl = await renderPdfPage(bytes.buffer, page);
    if (!activeConvIdRef.current) return;
    const imgMsg: Message = {
      id: uuidv4(),
      conversationId: activeConvIdRef.current,
      role: "assistant",
      content: `Page ${page} of "${filename}"`,
      imageDataUrl: dataUrl,
      createdAt: new Date().toISOString(),
    };
    await saveMessage(imgMsg);
    if (isMountedRef.current) setMessages((prev) => [...prev, imgMsg]);
  }, []);

  const removeKnowledgeChunk = useCallback(async (id: string) => {
    await deleteKnowledgeChunk(id);
    if (isMountedRef.current) setKnowledgeChunks((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const removeKnowledgeBySource = useCallback(async (source: string) => {
    await deleteKnowledgeBySource(source);
    if (isMountedRef.current) setKnowledgeChunks((prev) => prev.filter((c) => c.source !== source));
  }, []);

  // The router is always the active agent — agents are configuration only.
  const activeAgent = { id: ROUTER_AGENT_ID, name: "Router", systemPrompt: "", description: "Routes messages to the most appropriate agent", toolIds: [], createdAt: "", updatedAt: "" } as import("../lib/types").Agent;

  return {
    status, error,
    config, conversations, activeConvId, messages, knowledgeChunks,
    streamingContent, lastCompletedResponse, streamingAgentName, streamingTokensPerSec, streamingTokenCount, lastRagChunks, lastToolExecutions,
    ragEnabled, setRagEnabled,
    allTools: [
      ...(knowledgeSearchToolRef.current ? [knowledgeSearchToolRef.current] : []),
      ...pdfToolsRef.current,
      ...sourceToolsRef.current,
      ...ALL_TOOLS,
    ],
    enabledToolIds, setEnabledToolIds,
    embeddingStatus, embeddingBackend, llmBackend,
    activeLlmModelId, activeEmbedModelId,
    agents, activeAgent,
    updateConfig,
    loadPreset,
    loadWebLlmModel, unloadWebLlmModel,
    configureApi, initEmbeddingEngine,
    loadLlmFromCache, loadEmbedFromCache,
    retryInit,
    availableModels, switchConversationModel,
    createConversation, selectConversation, renameConversation, updateConversationInstruction, removeConversation,
    sendMessage, stopGeneration, editMessage, branchConversation, exportConversation, searchConversations,
    toggleBookmark, getBookmarks,
    summarizeConversation,
    getRagChunksForMessage,
    reEmbedAll, cancelReEmbed, reEmbedProgress,
    ingestProgress,
    viewPdfPage,
    ingestText, ingestPdf, ingestUrl, ingestImage, removeKnowledgeChunk, removeKnowledgeBySource,
    createAgent, updateAgent, removeAgent,
    clearError: () => setError(null),
  };
}
