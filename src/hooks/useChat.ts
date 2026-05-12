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

import { useCallback, useEffect, useRef, useState } from "react";
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
} from "../lib/db";
import {
  embed,
  initEmbeddings,
  getEmbeddingBackend,
  retrieveTopK,
  buildRagPrompt,
  splitIntoChunks,
  type EmbeddingStatus,
  type EmbeddingBackend,
  type RetrievedChunk,
} from "../lib/rag";
import {
  loadModels,
  unloadModels,
  generateStream,
  loadWebLlm,
  unloadWebLlm,
  getActiveBackend,
  persistApiConfig,
  loadPersistedApiConfig,
  isTauri,
  EMBED_MODEL_ID,
  type LlmBackend,
  type ApiConfig,
  type WebLlmOptions,
  type ModelPreset,
} from "../lib/llm";
import type {
  Conversation,
  Message,
  KnowledgeChunk,
  ModelConfig,
  AppStatus,
} from "../lib/types";

async function resolveDbDir(): Promise<string> {
  if (!isTauri()) return "/tmp/rag-chatbot";
  const { appDataDir } = await import("@tauri-apps/api/path");
  return appDataDir();
}

export function useChat() {
  const [status, setStatus] = useState<AppStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const [config, setConfigState] = useState<ModelConfig | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [knowledgeChunks, setKnowledgeChunks] = useState<KnowledgeChunk[]>([]);
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [ragEnabled, setRagEnabled] = useState(true);

  // Embedding + LLM backend status surfaced to the UI
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus | null>(null);
  const [embeddingBackend, setEmbeddingBackend] = useState<EmbeddingBackend>("bow");
  const [llmBackend, setLlmBackend] = useState<LlmBackend>("mock");

  // RAG debug: last retrieved chunks shown in the UI
  const [lastRagChunks, setLastRagChunks] = useState<RetrievedChunk[]>([]);

  const modelsLoaded = useRef(false);

  // ── Initialisation ───────────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      try {
        setStatus("loading-models");
        const dbDir = await resolveDbDir();
        await initDatabase(dbDir);

        const cfg = await loadConfig();
        setConfigState(cfg);

        const convs = await listConversations();
        setConversations(convs);

        const chunks = await listKnowledgeChunks();
        setKnowledgeChunks(chunks);

        // Restore persisted web API config
        loadPersistedApiConfig();

        // Initialise embedding engine
        const embStatus = await initEmbeddings(
          !isTauri() ? cfg.embeddingModelPath || undefined : undefined,
        );
        setEmbeddingStatus(embStatus);
        setEmbeddingBackend(getEmbeddingBackend());

        // Load LiteRT models on Tauri
        if (cfg.lmModelPath || cfg.embeddingModelPath) {
          await loadModels(cfg);
          modelsLoaded.current = true;
        }

        setLlmBackend(getActiveBackend());
        setStatus("ready");
      } catch (err) {
        setError(String(err));
        setStatus("error");
      }
    })();

    return () => { unloadModels().catch(() => {}); };
  }, []);

  // ── Config ───────────────────────────────────────────────────────────────

  const updateConfig = useCallback(async (next: ModelConfig) => {
    await saveConfig(next);
    setConfigState(next);
    if (modelsLoaded.current) { await unloadModels(); modelsLoaded.current = false; }
    if (next.lmModelPath || next.embeddingModelPath) {
      setStatus("loading-models");
      await loadModels(next);
      modelsLoaded.current = true;
      setStatus("ready");
    }
    setLlmBackend(getActiveBackend());
  }, []);

  // ── Preset loader ────────────────────────────────────────────────────────

  const loadPreset = useCallback(async (preset: ModelPreset) => {
    setStatus("loading-models");
    setError(null);
    try {
      // Load embedding model first (smaller, faster)
      if (preset.embedUrl && !isTauri()) {
        const embStatus = await initEmbeddings(preset.embedUrl);
        setEmbeddingStatus(embStatus);
        setEmbeddingBackend(getEmbeddingBackend());
      }
      // Load web LLM
      if (preset.llmUrl && !isTauri()) {
        await loadWebLlm({ modelUrl: preset.llmUrl });
        setLlmBackend(getActiveBackend());
      }
      setStatus("ready");
    } catch (err) {
      setError(String(err));
      setStatus("error");
    }
  }, []);

  // ── Web LLM (MediaPipe) ──────────────────────────────────────────────────

  const loadWebLlmModel = useCallback(async (opts: WebLlmOptions) => {
    setStatus("loading-models");
    try {
      await loadWebLlm(opts);
      setLlmBackend(getActiveBackend());
      setStatus("ready");
    } catch (err) {
      setError(String(err));
      setStatus("error");
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
    const status = await initEmbeddings(liteRtModelUrl);
    setEmbeddingStatus(status);
    setEmbeddingBackend(getEmbeddingBackend());
  }, []);

  // ── Conversations ────────────────────────────────────────────────────────

  const createConversation = useCallback(async (): Promise<string> => {
    const id = uuidv4();
    const now = new Date().toISOString();
    const conv: Conversation = { id, title: "New conversation", createdAt: now, updatedAt: now };
    await saveConversation(conv);
    setConversations((prev) => [conv, ...prev]);
    return id;
  }, []);

  const selectConversation = useCallback(async (id: string) => {
    setActiveConvId(id);
    setLastRagChunks([]);
    const msgs = await listMessages(id);
    setMessages(msgs);
  }, []);

  const renameConversation = useCallback(async (id: string, title: string) => {
    const conv = await getConversation(id);
    if (!conv) return;
    const updated = { ...conv, title, updatedAt: new Date().toISOString() };
    await saveConversation(updated);
    setConversations((prev) => prev.map((c) => (c.id === id ? updated : c)));
  }, []);

  const removeConversation = useCallback(async (id: string) => {
    await deleteConversation(id);
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeConvId === id) { setActiveConvId(null); setMessages([]); }
  }, [activeConvId]);

  // ── Embed a message and save its vector(s) back to CouchbaseLite ─────────
  //
  // Short messages (< CHUNK_SIZE chars) are embedded as a single document.
  // Long messages are split into overlapping chunks; each chunk is saved as
  // a separate message document so the vector index stays fine-grained.
  // The original message document gets the embedding of its first chunk so
  // it remains retrievable even without loading all chunks.

  const embedAndSave = useCallback(async (msg: Message) => {
    try {
      const modelId = modelsLoaded.current ? EMBED_MODEL_ID : undefined;
      const chunks = splitIntoChunks(msg.content);

      if (chunks.length <= 1) {
        // Single chunk — embed in-place on the original message document
        const vec = await embed(msg.content, modelId);
        const updated: Message = { ...msg, embedding: vec };
        await saveMessage(updated);
        setMessages((prev) => prev.map((m) => (m.id === msg.id ? updated : m)));
        return;
      }

      // Multiple chunks — embed each and save as child message documents
      for (let i = 0; i < chunks.length; i++) {
        const vec = await embed(chunks[i], modelId);
        if (i === 0) {
          // Update the original message with the first chunk's embedding
          const updated: Message = { ...msg, embedding: vec };
          await saveMessage(updated);
          setMessages((prev) => prev.map((m) => (m.id === msg.id ? updated : m)));
        } else {
          // Save additional chunks as sibling documents
          const chunkMsg: Message = {
            id: `${msg.id}-chunk-${i}`,
            conversationId: msg.conversationId,
            role: msg.role,
            content: chunks[i],
            createdAt: msg.createdAt,
            embedding: vec,
          };
          await saveMessage(chunkMsg);
        }
      }
    } catch (e) {
      console.warn("[useChat] embed failed:", e);
    }
  }, []);

  // ── Send a message ───────────────────────────────────────────────────────

  const sendMessage = useCallback(async (text: string) => {
    if (!config) return;
    if (status === "generating" || status === "embedding") return;

    let convId = activeConvId;
    if (!convId) {
      convId = await createConversation();
      setActiveConvId(convId);
    }

    // Persist user message
    const userMsg: Message = {
      id: uuidv4(),
      conversationId: convId,
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
    };
    await saveMessage(userMsg);
    setMessages((prev) => [...prev, userMsg]);

    // Auto-title from first user message
    const conv = conversations.find((c) => c.id === convId);
    if (conv?.title === "New conversation") {
      await renameConversation(convId, text.slice(0, 60) + (text.length > 60 ? "…" : ""));
    }

    // Embed user message in background (don't block generation)
    const userEmbedPromise = embedAndSave(userMsg);

    setStatus("generating");
    setStreamingContent("");
    setLastRagChunks([]);

    // ── RAG retrieval ──────────────────────────────────────────────────────
    let ragSourceIds: string[] = [];
    let ragContext = "";

    if (ragEnabled) {
      try {
        setStatus("embedding");
        await userEmbedPromise; // need the vector before retrieval
        const userVec = await embed(
          text,
          modelsLoaded.current ? EMBED_MODEL_ID : undefined,
        );
        const retrieved = await retrieveTopK(
          userVec,
          config.ragTopK,
          0.3,
          convId, // exclude current conversation's own messages
        );
        ragSourceIds = retrieved.map((r) => r.id);
        setLastRagChunks(retrieved);
        if (retrieved.length > 0) {
          ragContext = buildRagPrompt("", retrieved, "").split("User:")[0].trim();
        }
      } catch {
        // Embedding failed — proceed without RAG context
      }
    } else {
      setLastRagChunks([]);
    }

    setStatus("generating");

    // ── Build history for the LLM ──────────────────────────────────────────
    const history = messages
      .concat(userMsg)
      .map((m) => ({ role: m.role, content: m.content }));

    // ── Stream generation ──────────────────────────────────────────────────
    let accumulated = "";
    const assistantId = uuidv4();

    // Add placeholder so the streaming bubble has an ID to update
    const placeholderMsg: Message = {
      id: assistantId,
      conversationId: convId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, placeholderMsg]);

    await generateStream(
      history,
      ragContext,
      {
        modelId: config.lmModelPath ? "rag-lm" : undefined,
        systemInstruction: conv?.systemInstruction ??
          "You are a helpful assistant. Answer using the provided context when relevant.",
        config,
      },
      {
        onChunk: (chunk) => {
          accumulated += chunk;
          setStreamingContent(accumulated);
          setMessages((prev) =>
            prev.map((m) => m.id === assistantId ? { ...m, content: accumulated } : m),
          );
        },
        onDone: async (latencyMs) => {
          setStreamingContent(null);
          const assistantMsg: Message = {
            ...placeholderMsg,
            content: accumulated,
            latencyMs,
            ragSourceIds,
          };
          await saveMessage(assistantMsg);
          setMessages((prev) =>
            prev.map((m) => m.id === assistantId ? assistantMsg : m),
          );

          // Embed the completed assistant message (index both sides)
          embedAndSave(assistantMsg);

          // Update conversation timestamp
          if (conv) {
            await saveConversation({ ...conv, updatedAt: new Date().toISOString() });
          }
          setStatus("ready");
        },
        onError: (err) => {
          setStreamingContent(null);
          setError(err);
          setStatus("error");
        },
      },
    );
  }, [
    config, status, activeConvId, conversations, messages,
    createConversation, renameConversation, embedAndSave,
  ]);

  // ── Knowledge base ───────────────────────────────────────────────────────

  const ingestText = useCallback(async (source: string, rawText: string) => {
    setStatus("embedding");
    const chunks = splitIntoChunks(rawText);
    for (const text of chunks) {
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
      setKnowledgeChunks((prev) => [chunk, ...prev]);
    }
    setStatus("ready");
  }, []);

  const removeKnowledgeChunk = useCallback(async (id: string) => {
    await deleteKnowledgeChunk(id);
    setKnowledgeChunks((prev) => prev.filter((c) => c.id !== id));
  }, []);

  return {
    status, error,
    config, conversations, activeConvId, messages, knowledgeChunks,
    streamingContent, lastRagChunks,
    ragEnabled, setRagEnabled,
    embeddingStatus, embeddingBackend, llmBackend,
    updateConfig,
    loadPreset,
    loadWebLlmModel, unloadWebLlmModel,
    configureApi, initEmbeddingEngine,
    createConversation, selectConversation, renameConversation, removeConversation,
    sendMessage,
    ingestText, removeKnowledgeChunk,
    clearError: () => setError(null),
  };
}
