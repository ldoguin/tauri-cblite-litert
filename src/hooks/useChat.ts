/**
 * useChat — central state and logic for the RAG chatbot.
 *
 * Manages:
 *   - Database initialisation
 *   - Model loading / unloading
 *   - Conversation CRUD
 *   - Message streaming with RAG retrieval
 *   - Knowledge base ingestion
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
  embedText,
  retrieveTopK,
  buildRagPrompt,
  splitIntoChunks,
} from "../lib/rag";
import {
  loadModels,
  unloadModels,
  streamGenerate,
  EMBED_MODEL_ID,
  isWeb,
} from "../lib/llm";
import type {
  Conversation,
  Message,
  KnowledgeChunk,
  ModelConfig,
  AppStatus,
} from "../lib/types";

// Resolve the database directory at runtime.
// On Tauri desktop/mobile, use the app data dir; on web, use a relative path.
async function resolveDbDir(): Promise<string> {
  if (isWeb()) return "/tmp/rag-chatbot";
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

  // Streaming assistant message being built token-by-token
  const [streamingContent, setStreamingContent] = useState<string | null>(null);

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

        if (cfg.lmModelPath || cfg.embeddingModelPath) {
          await loadModels(cfg);
          modelsLoaded.current = true;
        }

        setStatus("ready");
      } catch (err) {
        setError(String(err));
        setStatus("error");
      }
    })();

    return () => {
      unloadModels().catch(() => {});
    };
  }, []);

  // ── Config ───────────────────────────────────────────────────────────────

  const updateConfig = useCallback(
    async (next: ModelConfig) => {
      await saveConfig(next);
      setConfigState(next);

      // Reload models if paths changed
      if (modelsLoaded.current) {
        await unloadModels();
        modelsLoaded.current = false;
      }
      if (next.lmModelPath || next.embeddingModelPath) {
        setStatus("loading-models");
        await loadModels(next);
        modelsLoaded.current = true;
        setStatus("ready");
      }
    },
    [],
  );

  // ── Conversations ────────────────────────────────────────────────────────

  const createConversation = useCallback(async (): Promise<string> => {
    const id = uuidv4();
    const now = new Date().toISOString();
    const conv: Conversation = {
      id,
      title: "New conversation",
      createdAt: now,
      updatedAt: now,
    };
    await saveConversation(conv);
    setConversations((prev) => [conv, ...prev]);
    return id;
  }, []);

  const selectConversation = useCallback(async (id: string) => {
    setActiveConvId(id);
    const msgs = await listMessages(id);
    setMessages(msgs);
  }, []);

  const renameConversation = useCallback(
    async (id: string, title: string) => {
      const conv = await getConversation(id);
      if (!conv) return;
      const updated = { ...conv, title, updatedAt: new Date().toISOString() };
      await saveConversation(updated);
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? updated : c)),
      );
    },
    [],
  );

  const removeConversation = useCallback(
    async (id: string) => {
      await deleteConversation(id);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeConvId === id) {
        setActiveConvId(null);
        setMessages([]);
      }
    },
    [activeConvId],
  );

  // ── Sending a message ────────────────────────────────────────────────────

  const sendMessage = useCallback(
    async (text: string) => {
      if (!config) return;
      if (status === "generating") return;

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

      // Auto-title the conversation from the first user message
      const conv = conversations.find((c) => c.id === convId);
      if (conv && conv.title === "New conversation") {
        const title = text.slice(0, 60) + (text.length > 60 ? "…" : "");
        await renameConversation(convId, title);
      }

      setStatus("generating");
      setStreamingContent("");

      // ── RAG retrieval ──────────────────────────────────────────────────
      let ragSourceIds: string[] = [];
      let prompt = text;

      if (modelsLoaded.current && config.embeddingModelPath) {
        try {
          setStatus("embedding");
          const queryEmbedding = await embedText(EMBED_MODEL_ID, text);
          const retrieved = await retrieveTopK(queryEmbedding, config.ragTopK);
          ragSourceIds = retrieved.map((r) => r.chunk.id);

          const systemInstruction =
            conv?.systemInstruction ??
            "You are a helpful assistant. Answer using only the provided context when relevant.";

          prompt = buildRagPrompt(text, retrieved, systemInstruction);
        } catch {
          // Embedding failed — fall back to plain generation
        }
      }

      setStatus("generating");

      // ── LLM generation ─────────────────────────────────────────────────
      let accumulated = "";
      const assistantId = uuidv4();

      await streamGenerate({
        prompt,
        systemInstruction:
          conv?.systemInstruction ??
          "You are a helpful assistant.",
        config,
        onChunk: (chunk) => {
          accumulated += chunk;
          setStreamingContent(accumulated);
        },
        onDone: async (latencyMs) => {
          setStreamingContent(null);
          const assistantMsg: Message = {
            id: assistantId,
            conversationId: convId!,
            role: "assistant",
            content: accumulated,
            createdAt: new Date().toISOString(),
            latencyMs,
            ragSourceIds,
          };
          await saveMessage(assistantMsg);
          setMessages((prev) => [...prev, assistantMsg]);

          // Update conversation timestamp
          if (conv) {
            await saveConversation({
              ...conv,
              updatedAt: new Date().toISOString(),
            });
          }
          setStatus("ready");
        },
        onError: (err) => {
          setStreamingContent(null);
          setError(err);
          setStatus("error");
        },
      });
    },
    [
      config,
      status,
      activeConvId,
      conversations,
      createConversation,
      renameConversation,
    ],
  );

  // ── Knowledge base ───────────────────────────────────────────────────────

  const ingestText = useCallback(
    async (source: string, rawText: string) => {
      if (!config?.embeddingModelPath || !modelsLoaded.current) {
        throw new Error("Embedding model not loaded. Configure it in Settings.");
      }

      setStatus("embedding");
      const chunks = splitIntoChunks(rawText);

      for (const text of chunks) {
        const embedding = await embedText(EMBED_MODEL_ID, text);
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
    },
    [config],
  );

  const removeKnowledgeChunk = useCallback(async (id: string) => {
    await deleteKnowledgeChunk(id);
    setKnowledgeChunks((prev) => prev.filter((c) => c.id !== id));
  }, []);

  return {
    // State
    status,
    error,
    config,
    conversations,
    activeConvId,
    messages,
    knowledgeChunks,
    streamingContent,
    // Actions
    updateConfig,
    createConversation,
    selectConversation,
    renameConversation,
    removeConversation,
    sendMessage,
    ingestText,
    removeKnowledgeChunk,
    clearError: () => setError(null),
  };
}
