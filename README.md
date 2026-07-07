# Offline RAG Chatbot

A cross-platform chatbot that runs entirely on-device: no cloud required.

| Layer | Technology | Role |
|---|---|---|
| UI | React + TypeScript (Tauri 2) | Chat interface, knowledge management |
| LLM inference | [tauri-plugin-litert](https://github.com/ldoguin/tauri-plugin-litert) | Streaming token generation from `.litertlm` models |
| Embeddings | tauri-plugin-litert (`.tflite`) | Sentence embeddings for RAG retrieval |
| Storage | [tauri-plugin-cblite](https://github.com/ldoguin/tauri-plugin-cblite) | Offline-first NoSQL — conversations, messages, knowledge chunks |
| Web fallback | OpenAI-compatible API (Groq, OpenRouter, Ollama) | LLM generation when running in a browser |

**Platforms:** Linux ✓ · macOS ✓ · Windows ✓ · Android ✓ · Web ✓

---

## How it works

```
User query
    │
    ▼
Embed query (.tflite model via LiteRT)
    │
    ▼
Cosine similarity search over KnowledgeChunks stored in CouchbaseLite
    │
    ▼
Top-K chunks injected into prompt
    │
    ▼
LLM generation (.litertlm model via LiteRT-LM)   ← streaming tokens
    │
    ▼
Response saved to CouchbaseLite (messages collection)
```

All data — conversations, messages, knowledge chunks with their embedding vectors — is persisted in a local CouchbaseLite database. The database can optionally sync to Couchbase Sync Gateway for multi-device use.

---

## Prerequisites

- Rust stable + Cargo
- Node.js 22 + pnpm
- Tauri Linux deps (see Dockerfile or [Tauri docs](https://tauri.app/start/prerequisites/))
- For Android: Android SDK + NDK, Java 17

The devcontainer installs everything automatically.

---

## Getting started

### 1. Install dependencies

```bash
pnpm install
```

### 2. Download models

**LLM** — pick a model from [huggingface.co/litert-community](https://huggingface.co/litert-community):

```bash
# Example: Gemma 3 1B (requires ~1 GB disk)
huggingface-cli download litert-community/Gemma3-1B-IT \
  --include "gemma3-1b-it-int4.litertlm" --local-dir models/
```

**Embedding model** — MediaPipe BERT embedder (int32 input tensors, works in browser and on-device):

```bash
# Web: paste this URL into "Embed model" in the toolbar
# https://storage.googleapis.com/mediapipe-models/text_embedder/bert_embedder/float32/1/bert_embedder.tflite

# Desktop / Android: download locally
curl -L -o models/bert_embedder.tflite \
  "https://storage.googleapis.com/mediapipe-models/text_embedder/bert_embedder/float32/1/bert_embedder.tflite"
```

> The Universal Sentence Encoder `.tflite` uses STRING input tensors which LiteRT Wasm does not support. Use the BERT embedder above instead.

### 3. Configure

Open the app → **Settings** → set the model paths and accelerator.

### 4. Run

```bash
# Desktop (dev)
pnpm tauri dev

# Desktop (release build)
pnpm tauri build

# Android (requires Android SDK)
pnpm tauri android dev

# Web only (no LLM — uses API fallback)
pnpm dev
```

#### macOS: `dyld: Library not loaded: @rpath/libLiteRtLmC.dylib`

The build script downloads `libLiteRtLmC.dylib` from GitHub on first build. If it fails or the cache is stale:

```bash
# Option 1 — force re-download by clearing the Cargo build cache
cd src-tauri && cargo clean && cd .. && pnpm tauri dev

# Option 2 — download manually and point the build at it
curl -L -o /tmp/libLiteRtLmC.dylib \
  https://github.com/offbit-ai/LiteRT/releases/download/litert-lm-v0.10.2/libLiteRtLmC.dylib
export LITERT_LM_LIB_DIR=/tmp
pnpm tauri dev
```

---

## CouchbaseLite collections

| Collection | Contents |
|---|---|
| `_default.conversations` | Conversation metadata (title, timestamps) |
| `_default.messages` | Chat messages with role, content, latency, RAG source IDs |
| `_default.knowledge` | Knowledge chunks: text + embedding vector |
| `_default.config` | App configuration (model paths, generation params) |

### Optional sync

To sync across devices, start a Couchbase Sync Gateway and call `startReplication` from the app (or add it to `useChat.ts`):

```typescript
import { startReplication } from "tauri-plugin-cblite";

await startReplication(
  "wss://your-sync-gateway/rag-chatbot",
  "_default.conversations",
  "both",
  { username: "alice", password: "secret" }
);
```

---

## Project structure

```
src/
  lib/
    types.ts        — Domain types (Message, Conversation, KnowledgeChunk, …)
    db.ts           — CouchbaseLite persistence layer
    rag.ts          — Chunking, embedding, cosine retrieval, prompt building
    llm.ts          — LiteRT-LM generation + web API fallback
  hooks/
    useChat.ts      — Central state: DB init, model loading, RAG pipeline
  components/
    Sidebar.tsx     — Conversation list
    ChatPane.tsx    — Message thread + input bar
    MessageBubble.tsx — Individual message with streaming support
    KnowledgePanel.tsx — Document ingestion + chunk management
    SettingsPanel.tsx  — Model paths, generation params, web API key
src-tauri/
  src/lib.rs        — Tauri app entry: registers both plugins
  Cargo.toml        — tauri-plugin-cblite + tauri-plugin-litert
  tauri.conf.json   — App metadata, window config
  capabilities/     — Permission grants for both plugins
  gen/android/      — Android project (MainActivity.kt, build.gradle.kts)
```

---

## Adding documents to the knowledge base

1. Open **Knowledge Base** (sidebar footer).
2. Paste text or upload a `.txt` / `.md` file.
3. The text is split into overlapping 400-character chunks, each embedded with your `.tflite` model and stored in CouchbaseLite.
4. On the next query, the top matching chunks are retrieved and injected into the LLM prompt automatically.

> **Tokeniser note:** `rag.ts` ships a simple whitespace tokeniser. For best embedding quality, replace `naiveTokenise()` with a tokeniser that matches your embedding model's vocabulary (e.g. a BPE tokeniser for MobileBERT/BERT-family models).

---

## License

MIT
