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
}

export interface ModelConfig {
  /** Path to the .litertlm LLM file */
  lmModelPath: string;
  /** Path to the .tflite embedding model file */
  embeddingModelPath: string;
  accelerator: "cpu" | "gpu" | "npu";
  /** Max tokens for LLM generation */
  maxTokens: number;
  temperature: number;
  topP: number;
  topK: number;
  /** Number of knowledge chunks to retrieve per query */
  ragTopK: number;
}

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  lmModelPath: "",
  embeddingModelPath: "",
  accelerator: "cpu",
  maxTokens: 1024,
  temperature: 0.8,
  topP: 0.95,
  topK: 40,
  ragTopK: 3,
};

export type AppStatus =
  | "idle"
  | "loading-models"
  | "ready"
  | "generating"
  | "embedding"
  | "error";
