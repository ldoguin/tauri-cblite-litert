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
  /** Override LM model path for this conversation; undefined = use global config */
  modelPath?: string;
}

/** A .litertlm file discovered in the model folder. Re-exported from modelCache. */
export type { ScannedModelMeta as ScannedModel } from "./modelCache";

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
// ── Dataset Annotation ─────────────────────────────────────────────────────

export interface AnnotationBox {
  id: string;
  label: string;
  x1: number; y1: number; x2: number; y2: number; // normalized [0-1]
  source: "human" | "model";
  annotatorId: string;
}

export type AnnotationStatus = "unannotated" | "in-progress" | "done" | "review";

export interface AnnotationRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  imageRef: string;
  thumb: string;
  labels: string[];        // unique label names from boxes — FTS field
  embedding: number[];     // caption embedding for vector similarity
  boxes: AnnotationBox[];
  status: AnnotationStatus;
  annotatorId: string;     // last editor
  synced: boolean;
}

// ── Photo Library ───────────────────────────────────────────────────────────

export interface FaceEntry {
  id: string;
  x1: number; y1: number; x2: number; y2: number; // normalized BlazeFace box
  thumb: string;       // base64 64×64 JPEG face crop
  embedding: number[]; // 1024-dim grayscale pixel vector (32×32) for similarity
  personId: string | null;
  personName: string | null;
}

export interface PersonRecord {
  id: string;
  name: string;
  faceThumb: string; // representative face crop
  createdAt: string;
}

export interface PhotoDoc {
  id: string;
  createdAt: string;
  caption: string;
  labels: string[];
  scores: number[];
  embedding: number[];
  photoRef: string;
  thumb: string;
  faces: FaceEntry[];  // BlazeFace detections with pixel embeddings
  synced: boolean;
}

// ── Sync ───────────────────────────────────────────────────────────────────

export interface SyncConfig {
  url: string;
  username: string;
  password: string;
  direction: "push" | "pull" | "both";
  continuous: boolean;
  lastSyncedAt: string | null;
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  url: "", username: "", password: "",
  direction: "both", continuous: false, lastSyncedAt: null,
};

// ── Clinical Notes ─────────────────────────────────────────────────────────

export type ClinicalNoteType =
  | "admission" | "progress" | "wound" | "procedure" | "discharge";

export interface SoapNote {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

export interface ClinicalNote {
  id: string;
  createdAt: string;
  updatedAt: string;
  patientRef: string;    // anonymised identifier, e.g. "PT-2024-0042"
  encounter: string;     // ward/room/clinic
  noteType: ClinicalNoteType;
  rawNotes: string;      // FLE-encrypted field
  photoRef: string;      // FLE-encrypted field; cbl-blob ref or data URL; "" if none
  soapJson: string;      // FLE-encrypted field; JSON-serialised SoapNote or ""
  soap: SoapNote | null; // runtime only — derived from soapJson, not stored directly
  embedding: number[];   // for vector similarity search
  synced: boolean;
}

// ── Field Inspection ────────────────────────────────────────────────────────

export type InspectionSeverity = "ok" | "low" | "medium" | "high" | "critical";
export type InspectionCategory =
  | "structural" | "electrical" | "mechanical" | "safety" | "environmental" | "other";

export interface InspectionRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  location: string;
  assetId: string;
  category: InspectionCategory;
  severity: InspectionSeverity;
  notes: string;
  photoRef: string;       // cbl-blob ref or data URL
  detections: Array<{ label: string; score: number }>;
  aiReport: string;
  synced: boolean;
}

export type CropType = "tomato" | "potato" | "apple" | "corn" | "grape" | "other";

export interface LeafResult {
  /** Normalised [0-1] bounding box from Stage 1 detector */
  box: { y1: number; x1: number; y2: number; x2: number };
  leafConfidence: number;
  /** Plant species identified by marginalising over all 38 disease classes, e.g. "Tomato" */
  plant: string;
  /** P(plant) = sum of softmax scores for all classes of that plant */
  plantConfidence: number;
  /** Empty string when disease classifier model is absent */
  disease: string;
  /** P(disease | plant) = raw class score / P(plant) */
  diseaseConfidence: number;
}

export interface CropDiseaseRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  photoRef: string;
  cropType: CropType;
  location: string;
  notes: string;
  leaves: LeafResult[];
  synced: boolean;
}

// ── Disease knowledge base (seeded from plantkb/build/couchbase) ──────────────
//
// Reference documents, not user data: produced offline by the plantkb pipeline
// (see plantkb/README.md) and loaded read-only via seedDiseaseKbIfEmpty(). Shape
// mirrors plantkb/src/agronomy_pipeline/models.py's empty_disease_profile /
// empty_healthy_profile builders exactly — keep the two in sync.

export interface DiseaseEvidence {
  source_name: string;
  source_url: string;
  quote: string;
  field: string;
}

export interface DiseaseValueFact<T> {
  value: T;
  evidence: DiseaseEvidence[];
}

export interface DiseaseTextFact {
  description: string;
  evidence: DiseaseEvidence[];
}

export interface DiseaseSymptomFact {
  stage: string;
  description: string;
  evidence: DiseaseEvidence[];
}

export interface DiseaseTreatmentFact {
  name: string;
  evidence: DiseaseEvidence[];
  regions: string[];
}

export interface DiseaseSourceRef {
  name: string;
  url: string;
}

export interface DiseaseReview {
  status: "machine_generated" | "needs_review" | "expert_reviewed" | "rejected";
  reviewed_by: string | null;
  reviewed_at: string | null;
}

export interface DiseaseConflict {
  field: string;
  values: string[];
  sources: string[];
  resolution: string;
}

export interface DiseaseProfile {
  type: "disease_profile";
  id: string;
  version: number;
  crop: string;
  disease: string;
  taxonomy: {
    pathogen_type: DiseaseValueFact<string>;
    scientific_name: DiseaseValueFact<string>;
  };
  symptoms: DiseaseSymptomFact[];
  conditions: {
    temperature_c: DiseaseValueFact<number[]>;
    humidity: DiseaseValueFact<string>;
    environment: DiseaseTextFact[];
  };
  severity: DiseaseValueFact<string>;
  treatment: {
    organic: DiseaseTreatmentFact[];
    chemical: DiseaseTreatmentFact[];
    cultural: DiseaseTreatmentFact[];
  };
  prevention: DiseaseTextFact[];
  images: string[];
  sources: DiseaseSourceRef[];
  confidence: { taxonomy: number; symptoms: number; conditions: number; treatment: number; prevention: number; overall: number };
  conflicts: DiseaseConflict[];
  review: DiseaseReview;
  /** Synthesized at seed time (crop + disease + symptoms + treatment text) for FTS search. */
  searchText?: string;
}

export interface HealthyProfile {
  type: "healthy_profile";
  id: string;
  version: number;
  crop: string;
  class: "healthy";
  visual_traits: DiseaseTextFact[];
  common_false_positives: DiseaseTextFact[];
  images: string[];
  sources: DiseaseSourceRef[];
  confidence: { visual_traits: number; false_positives: number; overall: number };
  review: DiseaseReview;
  searchText?: string;
}

export type DiseaseKbDoc = DiseaseProfile | HealthyProfile;

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
  /** Wake phrase matched against Whisper transcript (e.g. "jarvis"). Empty = disabled. */
  wakePhrase: string;
  /** HuggingFace model ID for TTS synthesis. Defaults to Xenova/mms-tts-eng when empty. */
  ttsModelId: string;
  /** BCP-47 language code used for FTS stemming (e.g. "en", "fr", "de"). Default "en". */
  ftsLanguage: string;
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
  /** Folder path scanned for .litertlm model files */
  modelFolder: string;
}

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  lmModelPath: "",
  embeddingModelPath: "",
  accelerator: "gpu",
  maxTokens: 4096,
  contextLength: 0,
  ragThreshold: 0.3,
  ragSourceTypes: ["knowledge", "message"] as ("knowledge" | "message")[],
  activeAgentId: null,
  whisperModelId: "",
  wakePhrase: "jarvis",
  ttsModelId: "",
  ftsLanguage: "en",
  temperature: 0.8,
  topP: 0.95,
  topK: 40,
  ragTopK: 3,
  chunkSize: 400,
  chunkOverlap: 80,
  hybridBm25Weight: 0.3,
  searxngUrl: "",
  modelFolder: "",
};

export interface Product {
  id: string;
  name: string;
  description: string;
  category: string;
  price?: number;
  /** CBL blob ref or data URL for the product image */
  imageRef?: string;
  /** 32×32 JPEG base64 thumbnail — stored directly in the document for instant blur-up */
  thumb?: string;
  /** BERT/BoW embedding for vector search (in-session only; not returned by listProducts) */
  embedding?: number[];
  /** True when an embedding has been persisted for this product */
  hasEmbedding?: boolean;
  /** BERT embedding of LLM-generated image description — used for image-query vector search */
  imageEmbedding?: number[];
  /** True when an imageEmbedding has been persisted for this product */
  hasImageEmbedding?: boolean;
  /** LLM-generated textual description of the product image */
  imageDescription?: string;
  /** Inferred gender audience: Men | Women | Kids | Unisex */
  gender?: string;
  createdAt: string;
}

export type AppStatus =
  | "idle"
  | "loading-models"
  | "ready"
  | "generating"
  | "embedding"
  | "error";
