// Core domain types shared across the application.

export type Role = "user" | "assistant" | "system";

export interface Message {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  /** ISO-8601 timestamp */
  createdAt: string;
  /** Latency of the LLM generation step, if applicable */
  latencyMs?: number;
  /** Document IDs that were retrieved and used as context */
  ragSourceIds?: string[];
  /** Embedding vector — set after background vectorisation completes */
  embedding?: number[];
  /** True when the user stopped generation before the response completed */
  stopped?: boolean;
  /** True when the user has bookmarked this message */
  bookmarked?: boolean;
  /** Base64-encoded image attached to this message (data URL, e.g. "data:image/jpeg;base64,…") */
  imageDataUrl?: string;
  /**
   * IDs of sibling chunk documents created when this message was split for
   * embedding. Stored so they can be deleted when the parent is deleted.
   */
  chunkIds?: string[];
  /**
   * True for chunk-sibling documents (index > 0) created during embedding.
   * These are never shown in the chat UI — only the parent message is displayed.
   */
  isChunk?: boolean;
  /** Name of the agent that generated this response */
  agentName?: string;
  /** Tool calls and their results that occurred during generation */
  toolExecutions?: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: string;
    durationMs: number;
  }>;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** System instruction used for this conversation */
  systemInstruction?: string;
}

/** A chunk of text stored in the knowledge base, with its embedding vector. */
export interface KnowledgeChunk {
  id: string;
  /** Human-readable source label (filename, URL, etc.) */
  source: string;
  /** The raw text of this chunk */
  text: string;
  /** Flat float32 embedding vector, stored as a JSON array */
  embedding: number[];
  createdAt: string;
  /** CBL blob ref ("cbl-blob:<digest>:<mime>") or data URL for image chunks */
  imageRef?: string;
  /** 1-based PDF page number this chunk was extracted from; undefined for non-PDF sources */
  pageNumber?: number;
}

/**
 * A named system-prompt persona stored in CouchbaseLite.
 * Selecting an agent sets the system instruction for all new messages
 * in the active conversation.
 */
export interface Agent {
  id: string;
  name: string;
  systemPrompt: string;
  /** Optional short description shown in the list */
  description?: string;
  /** Tool IDs enabled when this agent is active */
  toolIds: string[];
  /** When true, this agent routes messages to other agents instead of answering directly. */
  isRouter?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ModelConfig {
  /** Path to the .litertlm LLM file */
  lmModelPath: string;
  /** Path to the .tflite embedding model file */
  embeddingModelPath: string;
  accelerator: "cpu" | "gpu" | "npu";
  /** Max tokens for LLM generation (output limit) */
  maxTokens: number;
  /**
   * Model context window size in tokens (input + output combined).
   * Used by the context window bar. 0 = unknown (bar hidden).
   * Set automatically when loading from the model catalogue; override
   * manually for custom model paths.
   */
  contextLength: number;
  temperature: number;
  topP: number;
  topK: number;
  /** Number of knowledge chunks to retrieve per query */
  ragTopK: number;
  /** Minimum cosine similarity score for RAG retrieval (0–1) */
  ragThreshold: number;
  /** Which source types to include in RAG retrieval */
  ragSourceTypes: ("knowledge" | "message")[];
  /** ID of the agent whose system prompt is used by default; null = built-in default */
  activeAgentId: string | null;
  /**
   * HuggingFace model ID for Whisper transcription (Whisper backend only).
   * Defaults to Xenova/whisper-tiny.en when empty.
   */
  whisperModelId: string;
  /**
   * Optional model id selecting a text-to-speech voice/engine. Empty = use the
   * browser's built-in Web Speech API (speechSynthesis).
   */
  ttsModelId: string;
  /** Wake phrase matched against Whisper transcript (e.g. "jarvis"). Empty = disabled. */
  wakePhrase: string;
  /** Characters per chunk when splitting documents for embedding (default 400) */
  chunkSize: number;
  /** Overlap between consecutive chunks in characters (default 80) */
  chunkOverlap: number;
  /**
   * Hybrid search weight: fraction of the final score from BM25 keyword search.
   * 0 = pure vector, 1 = pure BM25. Default 0.3.
   */
  hybridBm25Weight: number;
  /**
   * SearXNG instance URL for web search (e.g. "https://searx.be").
   * Leave empty to use the built-in DuckDuckGo fallback.
   */
  searxngUrl: string;
}

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  lmModelPath: "",
  embeddingModelPath: "",
  accelerator: "cpu",
  maxTokens: 4096,
  contextLength: 0,
  ragThreshold: 0.3,
  ragSourceTypes: ["knowledge", "message"] as ("knowledge" | "message")[],
  activeAgentId: null,
  whisperModelId: "",
  ttsModelId: "",
  wakePhrase: "jarvis",
  temperature: 0.8,
  topP: 0.95,
  topK: 40,
  ragTopK: 3,
  chunkSize: 400,
  chunkOverlap: 80,
  hybridBm25Weight: 0.3,
  searxngUrl: "",
};

export type AppStatus =
  | "idle"
  | "loading-models"
  | "ready"
  | "generating"
  | "embedding"
  | "error";
