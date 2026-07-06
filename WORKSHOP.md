# Workshop: Build an Offline AI Desktop App with Tauri, LiteRT & Couchbase Lite

<!-- SECTION MARKERS — do not remove, used by build tooling -->
<!-- §1 INTRO -->

## Part 1 — Introduction & Problem Statement (Slides 1–5)

### Slide 1 — Title

**Build an Offline AI Desktop App**
*Tauri · LiteRT · Couchbase Lite*

> Speaker note: Introduce yourself. Ask the audience two questions: "Who has shipped an LLM feature to production?" and "Who has had to deal with data-privacy constraints — either for AI inference or for where your data is stored?" This workshop addresses both. The insight is that cloud AI and cloud data are the same class of problem: a dependency on remote infrastructure that breaks privacy, offline use, and cost predictability.

---

### Slide 2 — The Problem with Cloud Dependencies

The same dependency on remote infrastructure affects both AI and data.

**Cloud AI:**
```
User query ──► Cloud API ──► Response
                  │
            Your data leaves
            your machine
```

Pain points:
- **Privacy**: medical, legal, financial data cannot leave the device
- **Latency**: round-trip to a remote datacenter adds 200–2000 ms
- **Cost**: token pricing at scale is non-trivial
- **Availability**: no network = no AI

**Cloud data:**
```
App ──► Remote DB ──► Query result
            │
      Your data lives
      on someone else's server
```

Pain points:
- **Privacy**: documents, embeddings, and conversation history sent to a third party
- **Latency**: every read/write crosses the network
- **Offline**: app is broken without connectivity
- **Sync complexity**: conflict resolution, eventual consistency, schema migrations

> Speaker note: These two problems compound each other. An app that sends queries to a cloud LLM *and* stores its data in a cloud database has two separate privacy exposure points, two availability dependencies, and two sources of latency. Solving one without the other is only half the answer.

---

### Slide 3 — The Solution: On-Device AI and Data

```
User query ──► Local Model ──► Response
                  │
            Data never leaves
            the device

App ──► Local DB ──► Query result
            │
      Data stays on device,
      syncs when online
```

What we need:
1. A **runtime** that can execute quantized LLMs on CPU/GPU — **LiteRT**
2. A **database** that stores vectors and documents offline — **Couchbase Lite**
3. A **shell** that packages a web UI as a native desktop app — **Tauri**

Together they eliminate the cloud dependency for both inference and storage. The app works fully offline; sync is optional and additive.

> Speaker note: Each of these is production-grade and used in real apps. LiteRT powers Google's on-device AI across Android. Couchbase Lite is used in healthcare and field-service apps where offline-first is a hard requirement (clinics, field engineers, aircraft). Tauri is used by 1Password, Cloudflare, and others.

---

### Slide 4 — What We're Building

**Architecture overview:**

```
┌─────────────────────────────────────────────────────┐
│  React UI  (Vite + TypeScript)                      │
│  Chat · Knowledge base · Model manager · Agents     │
├─────────────────────────────────────────────────────┤
│  Tauri v2 IPC bridge                                │
├──────────────────────┬──────────────────────────────┤
│  tauri-plugin-litert │  tauri-plugin-cblite         │
│  LLM inference       │  Document + vector storage   │
├──────────────────────┴──────────────────────────────┤
│  Rust process (reqwest, tokio)                      │
│  Model download · HTTP client · File I/O            │
└─────────────────────────────────────────────────────┘
```

Features we'll build step by step:
- One-shot chat with a local Gemma model
- Persistent conversation history in Couchbase Lite (no cloud DB)
- RAG over ingested documents (PDF, URL, text) — embeddings stored locally
- Tool use (calculator, web search, Wikipedia)
- Multi-agent routing

Both the AI and the data are fully on-device. Couchbase Lite can sync to Couchbase Server when a network is available, but the app never requires it.

> Speaker note: The app is isomorphic — every module has a Tauri path and a web fallback. You can open it in a browser and it still works with localStorage and TF.js. This makes development much faster.

---

### Slide 5 — Repository & Prerequisites

**Clone:**
```bash
git clone https://github.com/ldoguin/tauri-cblite-litert
cd tauri-cblite-litert
pnpm install
```

**Prerequisites:**
| Tool | Version | Purpose |
|------|---------|---------|
| Rust | ≥ 1.77 | Tauri backend |
| Node.js | ≥ 20 | Frontend build |
| pnpm | ≥ 9 | Package manager |
| Tauri CLI | v2 | `cargo tauri dev` |
| patchelf | any | Linux `.so` RUNPATH fixup |

**Run in browser (no Rust needed):**
```bash
pnpm dev
# open http://localhost:1420
```

**Run as desktop app:**
```bash
cargo tauri dev
```

> Speaker note: The browser mode is great for live-coding demos. Switch to the desktop binary when you want to show LiteRT inference — the browser can't load `.tflite` models natively.
<!-- §2 TAURI -->

---

## Part 2 — Tauri (Slides 6–10)

### Slide 6 — What is Tauri?

Tauri is a framework for building desktop (and mobile) apps with a web frontend and a Rust backend.

```
┌──────────────────────────────────────┐
│  WebView  (OS-native renderer)       │
│  Your React / Vue / Svelte app       │
├──────────────────────────────────────┤
│  Tauri IPC  (JSON over postMessage)  │
├──────────────────────────────────────┤
│  Rust process                        │
│  File system · HTTP · Native APIs    │
└──────────────────────────────────────┘
```

**vs Electron:**
| | Tauri | Electron |
|--|-------|----------|
| Binary size | ~10 MB | ~150 MB |
| Memory | ~50 MB | ~200 MB |
| Renderer | OS WebView | Bundled Chromium |
| Backend | Rust | Node.js |
| Security | ACL per command | Broad Node access |

> Speaker note: Tauri uses the OS WebView (WebKit on macOS/Linux, WebView2 on Windows). This means no bundled browser engine — the binary is tiny. The tradeoff is slight rendering differences across platforms.

---

### Slide 7 — Tauri Project Structure

```
tauri-cblite-litert/
├── src/                    # React frontend
│   ├── App.tsx
│   ├── hooks/useChat.ts    # Central state
│   └── lib/                # Business logic
├── src-tauri/
│   ├── src/lib.rs          # Rust commands
│   ├── Cargo.toml          # Rust deps
│   ├── tauri.conf.json     # App config
│   ├── capabilities/       # ACL permissions
│   │   └── default.json
│   └── build.rs            # Build-time fixups
└── packages/
    ├── tauri-plugin-cblite/     # CouchbaseLite JS API
    └── tauri-plugin-litert-api/ # LiteRT isomorphic API
```

> Speaker note: The `packages/` directory contains the JS guest APIs for the two Tauri plugins. These are thin wrappers around `invoke()` calls — they make the Rust commands feel like regular async functions.

---

### Slide 8 — Tauri IPC: Calling Rust from JavaScript

**Define a command in Rust:**
```rust
// src-tauri/src/lib.rs
#[tauri::command]
async fn get_model_path(
    app: AppHandle,
    file_name: String,
) -> Result<Option<String>, String> {
    let models_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("models");
    let path = models_dir.join(&file_name);
    Ok(path.exists().then(|| path.to_string_lossy().into_owned()))
}
```

**Register it:**
```rust
tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![get_model_path])
    .run(tauri::generate_context!())
```

**Call it from TypeScript:**
```typescript
import { invoke } from "@tauri-apps/api/core";

const path = await invoke<string | null>("get_model_path", {
  fileName: "gemma3-1b-it-int4.litertlm",
});
```

> Speaker note: The `invoke()` call serializes arguments to JSON, sends them over a postMessage channel to the Rust process, and deserializes the response. The round-trip is typically < 1 ms for small payloads.

---

### Slide 9 — Tauri ACL: Security by Default

Tauri v2 requires explicit permission for every command. Without a capability entry, `invoke()` returns `"not found"`.

**`src-tauri/capabilities/default.json`:**
```json
{
  "identifier": "default",
  "platforms": ["linux", "macOS", "windows"],
  "windows": ["main"],
  "permissions": [
    "core:default",
    "os:default",
    "cblite:default",
    "litert:default"
  ]
}
```

`cblite:default` expands to:
```
allow-open-database, allow-close-database,
allow-get-document, allow-save-document,
allow-execute-query, allow-save-blob,
allow-get-blob-data, ...
```

> Speaker note: App-level commands (registered via `invoke_handler`) are automatically allowed — only plugin commands need explicit ACL entries. This is a common source of confusion when first using Tauri v2.

---

### Slide 10 — Isomorphic Pattern: Tauri + Web Fallback

Every module in this app works in both Tauri and a plain browser. The gate:

```typescript
// src/lib/db.ts
export function isTauri(): boolean {
  return typeof window !== "undefined"
    && "__TAURI_INTERNALS__" in window;
}
```

**Example — saving a document:**
```typescript
export async function saveConversation(conv: Conversation) {
  const { id, ...body } = conv;

  if (!isTauri()) {
    // Web: localStorage-backed in-memory store
    webStore.set("conversations", id, body);
    return;
  }

  // Tauri: CouchbaseLite via plugin IPC
  const { saveDocument } = await import("tauri-plugin-cblite");
  await saveDocument("_default.conversations", id, body);
}
```

**Benefits:**
- Fast iteration in the browser (no Rust compile)
- Same test suite covers both paths
- Graceful degradation if Tauri APIs are unavailable

> Speaker note: The dynamic `import("tauri-plugin-cblite")` is intentional — it prevents the module from being evaluated in the browser where the Tauri IPC doesn't exist. Tree-shaking removes it from the web bundle.
<!-- §3 AI_FUNDAMENTALS -->

---

## Part 3 — AI Fundamentals (Slides 11–18)

### Slide 11 — Large Language Models in One Slide

An LLM is a function: `tokens_in → probability_distribution_over_next_token`.

```
"The capital of France is" → ["Paris": 0.94, "Lyon": 0.02, ...]
```

**Key concepts for this workshop:**

| Concept | What it means in practice |
|---------|--------------------------|
| **Context window** | Max tokens the model can "see" at once (e.g. 8192) |
| **Quantization** | Compress weights: FP32 → INT4 = 8× smaller, ~5% quality loss |
| **Temperature** | Randomness of sampling (0 = deterministic, 1 = creative) |
| **System prompt** | Instructions prepended before the conversation |
| **Streaming** | Emit tokens one by one instead of waiting for full response |

> Speaker note: For this workshop, the model is Gemma 3 1B INT4 (~700 MB). It runs at ~30 tok/s on a modern laptop CPU, ~130 tok/s with GPU. That's fast enough for interactive chat.

---

### Slide 12 — Quantization: Fitting a 7B Model in Your Pocket

A neural network is a large array of floating-point numbers called **weights**. Quantization reduces the precision of those numbers to shrink the model and speed up inference.

**Precision formats:**
```
FP32  — 32 bits per weight  (training precision, full accuracy)
FP16  — 16 bits per weight  (2× smaller, negligible quality loss)
INT8  —  8 bits per weight  (4× smaller, ~1–2% quality loss)
INT4  —  4 bits per weight  (8× smaller, ~3–5% quality loss)  ← this app
INT2  —  2 bits per weight  (16× smaller, significant quality loss)
```

**What changes, what doesn't:**
```
Before quantization:   weight = 0.31415926...  (32-bit float)
After INT4:            weight = 5               (4-bit integer, 0–15)
                                │
                         scale factor maps 5 → ≈ 0.314
```

The model stores a small **scale** and **zero-point** per block of weights. At inference time the integer is dequantized on the fly — the arithmetic stays in float, only storage is compressed.

**Why it matters for on-device:**

| Model | FP32 size | INT4 size | Fits in RAM? |
|---|---|---|---|
| Gemma 3 1B | ~4 GB | ~700 MB | ✅ phone / laptop |
| Gemma 3 4B | ~16 GB | ~2.5 GB | ✅ laptop |
| Gemma 3 27B | ~108 GB | ~17 GB | ❌ most devices |

**Quantization schemes used in this app:**
- `INT4` weights + `FP32` activations — best quality/size trade-off for Gemma
- Block-wise quantization (128 weights per block) — limits accuracy loss vs. per-tensor

> Speaker note: The quality loss numbers (~5%) are averages across benchmarks. For chat tasks the perceptual difference between FP32 and INT4 Gemma 3 1B is hard to notice. The bigger practical concern is that INT4 models can occasionally produce more repetitive or less coherent output on long contexts — the KV-cache is still in FP16 so that part is unaffected.

---

### Slide 13 — Embeddings: Turning Text into Vectors

An embedding model maps text to a fixed-size vector in a semantic space.

```
"The dog barked"   → [0.12, -0.34, 0.89, ...]  (128 dims)
"A canine howled"  → [0.11, -0.31, 0.91, ...]  (similar!)
"The stock rose"   → [-0.45, 0.67, -0.12, ...]  (different)
```

**Cosine similarity** measures the angle between two vectors:
```
similarity = (A · B) / (|A| × |B|)   ∈ [-1, 1]
```

Semantically similar texts → high cosine similarity (close to 1).

**In this app:** BERT-base-uncased produces 128-dimensional embeddings. The model is ~25 MB — tiny compared to an LLM.

> Speaker note: The key insight is that embeddings capture *meaning*, not just keywords. "dog" and "canine" are close in embedding space even though they share no characters. This is what makes semantic search work.

---

### Slide 14 — The BERT Tokenizer (WordPiece)

Before embedding, text must be tokenized into integer IDs.

```
"unaffable" → ["un", "##aff", "##able"] → [2512, 4593, 3085]
```

**WordPiece algorithm:**
1. Split on whitespace and punctuation
2. If a word is in the vocabulary → use it directly
3. Otherwise → split into the longest known subwords (prefix `##`)

**Special tokens:**
```
[CLS] token1 token2 ... [SEP] [PAD] [PAD] ...
 101                     102   0     0
```

The `[CLS]` token's output vector is used as the sentence embedding.

**In this app:** A full WordPiece tokenizer is implemented in ~100 lines of TypeScript against the `bert-base-uncased` vocabulary (30,522 tokens). No external tokenizer library needed.

```typescript
// src/lib/rag.ts (simplified)
const tokens = wordpieceTokenize(text, vocab);
const inputIds = [CLS_ID, ...tokens.slice(0, 126), SEP_ID];
// pad to 128
while (inputIds.length < 128) inputIds.push(PAD_ID);
```

> Speaker note: Implementing the tokenizer in TypeScript means it runs in the browser with no WASM overhead. The vocab file is ~230 KB and is cached in the Cache API after the first load.

---

### Slide 15 — RAG: Retrieval-Augmented Generation

The problem: LLMs have a fixed knowledge cutoff and a limited context window. They can't know about your documents.

**RAG pipeline:**

```
                    ┌─── Ingest (offline) ───┐
                    │                        │
Document ──► Chunk ──► Embed ──► Store in DB │
                                             │
                    └─── Query (online) ─────┘
                    │                        │
User query ──► Embed ──► Search DB ──► Top-K chunks
                                        │
                              Inject into LLM prompt
                                        │
                              LLM generates answer
```

**Why chunking?** A 50-page PDF doesn't fit in the context window. Split it into overlapping 512-token chunks, embed each chunk separately.

> Speaker note: RAG is the most practical technique for grounding LLMs in private data. It doesn't require fine-tuning — you just need an embedding model and a vector store. Both are included in this app.

---

### Slide 16 — Hybrid Search: Vector + BM25

Pure vector search misses exact keyword matches. Pure BM25 misses semantic similarity. Combine both.

**BM25 (Okapi BM25):**
```
score(q, d) = Σ IDF(t) × (tf(t,d) × (k1+1)) / (tf(t,d) + k1×(1-b+b×|d|/avgdl))
```
- `k1 = 1.5` (term frequency saturation)
- `b = 0.75` (length normalization)

**Reciprocal Rank Fusion (RRF):**
```
RRF(d) = Σ weight_i / (k + rank_i(d))    k = 60
```

```
Vector results:  [doc3, doc1, doc7, doc2, ...]
BM25 results:    [doc1, doc5, doc3, doc8, ...]
                          ↓ RRF fusion
Merged results:  [doc1, doc3, doc5, doc7, ...]
```

**In this app:** `bm25Weight = 0.3` by default. Increase it for keyword-heavy corpora (legal, medical), decrease it for semantic queries.

> Speaker note: RRF is remarkably robust. The `k=60` constant dampens the effect of rank differences at the top of the list. A document ranked #1 in one list and #3 in another beats a document ranked #1 in only one list.

---

### Slide 17 — The ReAct Loop: LLMs That Use Tools

**ReAct** (Reason + Act): the LLM interleaves reasoning and tool calls.

```
System: You have tools: calculator, wikipedia, weather...

User: What is the GDP of France divided by its population?

LLM: I need the GDP and population of France.
<tool_call>{"name":"wikipedia","args":{"query":"France GDP"}}</tool_call>

Tool result: France GDP is $3.1 trillion (2023)
<tool_call>{"name":"wikipedia","args":{"query":"France population"}}</tool_call>

Tool result: France population is 68 million

LLM: GDP per capita = $3.1T / 68M = $45,588
```

**Safety limits in this app:**
- Max 5 iterations per message
- Identical repeated tool calls → loop detected → break
- Tool execution time tracked separately from LLM latency

> Speaker note: The tool call format is XML-like (`<tool_call>...</tool_call>`) because it's more reliably parsed from LLM output than JSON embedded in prose. The app strips these tags from the displayed response.

---

### Slide 18 — Agent Routing

Every message goes through a **router** before the actual response.

```
User message
     │
     ▼
Router LLM call
"Given these agents: [Support, Sales, Technical, General]
 Which agent should handle: 'My invoice is wrong'?"
     │
     ▼
{"agent": "Support"}
     │
     ▼
Support agent system prompt + tools
     │
     ▼
Actual response
```

**Why a router?** Users don't want to manually select an agent. The router adds ~200 ms latency but enables automatic persona selection.

**Fallback:** If the router response isn't valid JSON or the agent name doesn't match, the default system prompt is used.

> Speaker note: The router uses the same LLM as the responder. On a 1B model, routing is fast (~50 tokens in, ~10 tokens out). On slower hardware, you could use a smaller dedicated routing model.
<!-- §4 LITERT_CHAT -->

---

## Part 4 — One-Shot Chat with LiteRT (Slides 19–24)

### Slide 19 — TensorFlow Lite → LiteRT → MediaPipe: A Lineage

```
2017  TensorFlow Lite
      └─ Google's first on-device ML runtime
         Runs .tflite flatbuffer models on mobile (Android/iOS)
         CPU only at launch; GPU delegate added 2018

2019  MediaPipe
      └─ Pipeline framework built on top of TF Lite
         Pre-packaged solutions: face detection, pose, hands, …
         Introduced the .task bundle format (model + metadata + config)

2023  LiteRT  (TensorFlow Lite renamed)
      └─ Same runtime, new brand under Google AI Edge
         Broader hardware support: CPU, GPU, NPU, DSP
         Decoupled from TensorFlow the training framework

2024  LiteRT-LM
      └─ LLM-specific layer on top of LiteRT
         Optimised KV-cache, INT4/INT8 quantisation, streaming tokens
         Introduces the .litertlm model format
         Powers Gemma on-device across Android, iOS, desktop

2024  MediaPipe Tasks GenAI
      └─ LLM inference via the MediaPipe Tasks API
         Runs in the browser over WebGPU or Wasm
         Uses the .task bundle format (same weights, different container)
```

**How they relate today:**

```
                    Google AI Edge
                         │
          ┌──────────────┴──────────────┐
          │                             │
       LiteRT                      MediaPipe
   (native runtime)            (pipeline framework)
          │                             │
     LiteRT-LM                  Tasks GenAI API
   (.litertlm format)           (.task format)
          │                             │
   Tauri plugin (Rust)        Browser / WebView (JS)
```

Both branches run the same Gemma weights. The split is purely about **deployment target**: native binary vs. browser sandbox.

> Speaker note: The rename from TensorFlow Lite to LiteRT in 2023 was partly to signal independence from the TensorFlow training ecosystem — you don't need TF to use LiteRT. MediaPipe was always a separate project (originally for real-time video pipelines at Google) that adopted TF Lite as its inference engine. The Tasks GenAI API is the part of MediaPipe that handles LLMs in the browser; it is what this app uses on Windows and in the web fallback.

---

### Slide 20 — What is LiteRT?

LiteRT (formerly TensorFlow Lite) is Google's on-device ML runtime.

**LiteRT-LM** is the LLM-specific layer on top of LiteRT:
- Loads `.litertlm` model files (quantized, optimized for mobile/desktop)
- Supports CPU, GPU (Metal/Vulkan), and NPU acceleration
- Streaming token generation via callbacks
- KV-cache management

**Model formats:**
```
Gemma 3 1B INT4 (web)     → .task file  (~700 MB)  MediaPipe Tasks
Gemma 3 1B INT4 (native)  → .litertlm   (~700 MB)  LiteRT-LM
Gemma 4 E2B INT4 (native) → .litertlm   (~1.5 GB)  LiteRT-LM
```

> Speaker note: The `.task` format is for the MediaPipe Tasks API (browser/WebGPU). The `.litertlm` format is for the native LiteRT-LM runtime (Tauri). They use the same underlying weights but different packaging.

---

### Slide 21 — Loading a Model

**Download the model** (Tauri — streams to disk with progress):
```typescript
// src/lib/modelCache.ts
const filePath = await invoke<string>("download_model", {
  modelId: "gemma3-1b-it-int4",
  url: "https://huggingface.co/.../gemma3-1b-it-int4.litertlm",
  fileName: "gemma3-1b-it-int4.litertlm",
});
```

**Rust side — atomic download with progress events:**
```rust
// src-tauri/src/lib.rs (simplified)
#[tauri::command]
async fn download_model(app: AppHandle, model_id: String,
                        url: String, file_name: String) -> Result<String, String> {
    let dest = models_dir.join(&file_name);
    let part = dest.with_extension("part");
    let mut stream = reqwest::get(&url).await?.bytes_stream();

    while let Some(chunk) = stream.next().await {
        file.write_all(&chunk?).await?;
        app.emit("model-download-progress", ProgressPayload { ... })?;
    }
    tokio::fs::rename(&part, &dest).await?; // atomic
    Ok(dest.to_string_lossy().into_owned())
}
```

> Speaker note: The `.part` → rename pattern ensures the model file is never in a partially-written state. If the download is interrupted, the `.part` file is left behind and the next download attempt overwrites it.

---

### Slide 22 — Streaming Inference

**Load the model:**
```typescript
// src/lib/llm.ts
import { loadLmModel } from "tauri-plugin-litert-api";

await loadLmModel({
  modelId: "lm-main",
  modelPath: "/path/to/gemma3-1b-it-int4.litertlm",
  accelerator: "gpu",   // or "cpu"
  maxTokens: 2048,
});
```

**Stream a response:**
```typescript
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

// 1. Register listener BEFORE starting generation
const unlisten = await listen<{ token: string; done: boolean }>(
  "litert-lm://chunk",
  ({ payload }) => {
    if (payload.done) { unlisten(); return; }
    onToken(payload.token);
  }
);

// 2. Start generation
await invoke("plugin:litert|generate_stream", {
  modelId: "lm-main",
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user",   content: userMessage },
  ],
});
```

> Speaker note: The listener must be registered before `generate_stream` is invoked. If you register it after, you'll miss the first few tokens. This is a common race condition in event-driven streaming APIs.

---

### Slide 23 — Four LLM Backends, One Interface

The app selects the best available backend automatically:

```typescript
// src/lib/llm.ts
export function getActiveBackend(): LlmBackend {
  if (activeLmModelId) return "tauri";      // LiteRT native
  if (webLlm)          return "mediapipe";  // WebGPU/Wasm
  if (apiConfig)       return "api";        // Cloud API
  return "mock";                            // Echo (dev)
}
```

**`generateStream()` dispatches to the right backend:**
```typescript
export async function* generateStream(
  messages: ChatMessage[],
  opts: GenerateOptions,
): AsyncGenerator<string> {
  const backend = getActiveBackend();
  switch (backend) {
    case "tauri":     yield* generateViaTauri(messages, opts);     break;
    case "mediapipe": yield* generateViaMediaPipe(messages, opts); break;
    case "api":       yield* generateViaApi(messages, opts);       break;
    case "mock":      yield* generateViaMock(messages, opts);      break;
  }
}
```

**Demo checkpoint:** Open the Model Manager panel, download Gemma 3 1B, load it, and send a message. You should see tokens streaming in real time with no network requests.

---

### Slide 24 — Platform Support Matrix

| Platform | LLM runtime | Model format | Hardware acceleration | Storage |
|---|---|---|---|---|
| **macOS (Apple Silicon)** | LiteRT-LM native | `.litertlm` | Metal GPU | Couchbase Lite |
| **macOS (Intel)** | LiteRT-LM native | `.litertlm` | CPU | Couchbase Lite |
| **Linux x86\_64** | LiteRT-LM native | `.litertlm` | Vulkan GPU / CPU | Couchbase Lite |
| **Linux aarch64** | LiteRT-LM native | `.litertlm` | CPU | Couchbase Lite |
| **Windows x86\_64** | MediaPipe (WebGPU/Wasm) | `.task` | WebGPU / Wasm | Couchbase Lite |
| **Android arm64** | LiteRT-LM native | `.litertlm` | GPU delegate / CPU | Couchbase Lite |
| **Browser (any OS)** | MediaPipe (WebGPU/Wasm) | `.task` | WebGPU / Wasm | localStorage |

**Why Windows uses the WASM backend:** Google has not shipped a `LiteRtLmC.dll` for Windows. The native plugin compiles (Rust stubs satisfy the linker) but LLM inference falls back to MediaPipe Tasks running in the WebView's WebGPU context. Performance is lower than native but the app is fully functional.

**Model formats:**
- `.litertlm` — LiteRT-LM binary format, loaded by the native Rust plugin
- `.task` — MediaPipe Tasks bundle, loaded by `@mediapipe/tasks-genai` in the WebView

Both formats package the same Gemma weights; only the container and runtime differ.

> Speaker note: The matrix is the payoff of the isomorphic architecture. The same TypeScript business logic runs everywhere; only the backend selected by `getActiveBackend()` changes. A user on Windows gets a working app today; when Google ships a Windows DLL, the native path activates automatically with no code changes.
<!-- §5 COUCHBASE -->

---

## Part 5 — Persistent Memory with Couchbase Lite (Slides 26–30)

### Slide 25 — What is Couchbase Lite?

Couchbase Lite is an embedded NoSQL database for mobile and desktop apps.

**Key properties:**
- **Document store**: JSON documents with a string ID
- **Collections**: logical groupings (like tables, but schema-free)
- **N1QL queries**: SQL-like query language over JSON
- **Full-text search**: built-in FTS indexes
- **Sync**: optional replication to Couchbase Sync Gateway
- **Offline-first**: works without a network connection

**In this app:**
```
_default.conversations   Conversation metadata
_default.messages        Chat messages + embeddings
_default.knowledge       Ingested document chunks + embeddings
_default.config          App configuration
_default.agents          Agent definitions
```

> Speaker note: Couchbase Lite is used in healthcare (Epic, Philips), field service (Siemens), and retail (Walmart). It's battle-tested for offline-first scenarios. The `_default` scope is the default scope in CBL — you can create additional scopes for multi-tenant scenarios.

---

### Slide 26 — Opening the Database

```typescript
// src/lib/db.ts
import { openDatabase } from "tauri-plugin-cblite";

await openDatabase(
  appDataDir,           // path: where to store the .cblite2 file
  "rag-chatbot",        // name: database name
  undefined,            // encryptionPassword (optional)
  [                     // collections to create on first open
    "_default.conversations",
    "_default.messages",
    "_default.knowledge",
    "_default.config",
    "_default.agents",
  ]
);
```

**The database file lives at:**
```
~/.local/share/com.ldoguin.rag-chatbot/rag-chatbot.cblite2/
```

> Speaker note: The `openDatabase` call is idempotent — if the database already exists, it opens it. If not, it creates it with the specified collections. The encryption password enables AES-256 encryption of the database file at rest.

---

### Slide 27 — CRUD Operations

**Save a document:**
```typescript
import { saveDocument } from "tauri-plugin-cblite";

await saveDocument(
  "_default.conversations",   // collection
  conv.id,                    // document ID
  {                           // body (any JSON-serializable object)
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: new Date().toISOString(),
  }
);
```

**Read a document:**
```typescript
import { getDocument } from "tauri-plugin-cblite";

const doc = await getDocument("_default.conversations", id)
  .catch((e) => {
    // CBL throws "not found" instead of returning null
    if (String(e).toLowerCase().includes("not found")) return null;
    throw e;
  });
```

**Delete (soft-delete tombstone):**
```typescript
// CBL N1QL has no DELETE statement — use a tombstone
await saveDocument("_default.conversations", id, { _deleted: true });

// Queries filter tombstones:
// WHERE (_deleted IS MISSING OR _deleted = false)
```

> Speaker note: The soft-delete pattern is intentional. Tombstones propagate correctly to Couchbase Sync Gateway during replication — the remote server knows the document was deleted, not just missing. Hard deletes would cause sync conflicts.

---

### Slide 28 — N1QL Queries

N1QL is SQL for JSON documents. The `META().id` function returns the document ID.

**List conversations (newest first):**
```typescript
const rows = await executeQuery(
  "N1QL",
  `SELECT META().id AS id, title, createdAt, updatedAt
   FROM \`_default\`.conversations
   WHERE (_deleted IS MISSING OR _deleted = false)
   ORDER BY updatedAt DESC
   LIMIT $limit OFFSET $offset`,
  { limit: 200, offset: 0 }
);
```

**Full-text search over knowledge chunks:**
```typescript
const rows = await executeQuery(
  "N1QL",
  `SELECT META().id AS id, text, source, score() AS score
   FROM \`_default\`.knowledge
   WHERE MATCH(knowledgeFts, $query)
     AND (_deleted IS MISSING OR _deleted = false)
   ORDER BY score() DESC
   LIMIT $k`,
  { query: userQuery, k: 20 }
);
```

**FTS index creation (on startup):**
```typescript
await executeQuery("N1QL",
  `CREATE INDEX knowledgeFts ON \`_default\`.knowledge(text)
   USING FTS IF NOT EXISTS`
);
```

> Speaker note: N1QL is read-only in the plugin — no INSERT, UPDATE, or DELETE. All writes go through `saveDocument`. This is a deliberate constraint: it keeps the plugin API simple and prevents accidental bulk deletes.

---

### Slide 29 — Storing Embeddings

Embeddings are stored as JSON arrays directly on the document:

```typescript
// src/lib/db.ts
await saveDocument("_default.knowledge", chunk.id, {
  text: chunk.text,
  source: chunk.source,
  embedding: Array.from(embeddingVector),  // Float32Array → number[]
  embeddingModel: "bert-base-uncased",
  createdAt: new Date().toISOString(),
});
```

**Retrieval — cosine similarity in TypeScript:**
```typescript
// src/lib/rag.ts
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}
```

> Speaker note: CouchbaseLite doesn't have a native vector index (unlike Couchbase Server). Similarity is computed in TypeScript over the retrieved documents. For corpora up to ~10,000 chunks this is fast enough (~5 ms). For larger corpora, you'd want a dedicated vector index or approximate nearest-neighbor (ANN) algorithm like HNSW.
<!-- §6 RAG -->

---

## Part 6 — RAG with Vector Search (Slides 30–34)

### Slide 30 — Ingesting a Document

The ingest pipeline: text → chunks → embeddings → database.

```typescript
// src/lib/rag.ts (simplified)
export async function ingestText(
  text: string,
  source: string,
  chunkSize = 512,
  overlap = 64,
): Promise<void> {
  const chunks = splitIntoChunks(text, chunkSize, overlap);

  for (const chunk of chunks) {
    const embedding = await embed(chunk);
    await saveKnowledgeChunk({
      id: crypto.randomUUID(),
      text: chunk,
      source,
      embedding: Array.from(embedding),
      createdAt: new Date().toISOString(),
    });
  }
}
```

**Chunking strategy — overlapping windows:**
```
[chunk 0: tokens 0–511  ]
         [chunk 1: tokens 448–959  ]
                  [chunk 2: tokens 896–1407 ]
```

Overlap = 64 tokens ensures context isn't lost at chunk boundaries.

> Speaker note: The chunk size and overlap are configurable in the Knowledge panel. Smaller chunks = more precise retrieval but more DB entries. Larger chunks = more context per result but noisier retrieval. 512 tokens with 64 overlap is a good default for most documents.

---

### Slide 31 — The Embedding Pipeline

Three backends, selected automatically:

```
                    ┌─ Tauri ──────────────────────────────────┐
                    │  tauri-plugin-litert                      │
text ──► tokenize ──► createEmbedding("embed-main", tokens)    │
                    │  BERT-base-uncased .tflite (25 MB)        │
                    └──────────────────────────────────────────┘

                    ┌─ Web (LiteRT WASM) ───────────────────────┐
                    │  @litertjs/core                            │
text ──► tokenize ──► model.run([inputIds, attentionMask, ...]) │
                    │  Same BERT model, WASM runtime             │
                    └───────────────────────────────────────────┘

                    ┌─ Web (TF.js USE) ─────────────────────────┐
                    │  @tensorflow-models/universal-sentence-enc │
text ──────────────► encoder.embed([text])                      │
                    │  Auto-downloads, 512-dim output            │
                    └───────────────────────────────────────────┘

                    ┌─ Offline fallback ────────────────────────┐
text ──────────────► bagOfWords(text)                           │
                    │  djb2 hash → 512-dim sparse vector         │
                    └───────────────────────────────────────────┘
```

> Speaker note: The BoW fallback produces surprisingly useful results for keyword-heavy queries. It's not semantic, but it's fast and requires no model download. It's the right choice for a first-run experience before the user downloads the embedding model.

---

### Slide 32 — Retrieval: From Query to Context

```typescript
// src/lib/rag.ts
export async function retrieveTopK(
  query: string,
  k = 5,
  opts: RetrievalOptions = {},
): Promise<RankedChunk[]> {
  // 1. Embed the query
  const queryVec = await embed(query);

  // 2. Load all chunks from DB (cached by pool version)
  const pool = await getPool(opts.sourceTypes);

  // 3. Vector search: cosine similarity
  const vectorRanked = pool
    .map(chunk => ({
      ...chunk,
      score: cosineSimilarity(queryVec, chunk.embedding),
    }))
    .filter(c => c.score >= (opts.threshold ?? 0.3))
    .sort((a, b) => b.score - a.score);

  // 4. BM25 search
  const bm25Ranked = bm25Search(query, pool);

  // 5. RRF fusion
  return rrfFuse(vectorRanked, bm25Ranked, opts.bm25Weight ?? 0.3)
    .slice(0, k);
}
```

> Speaker note: The `getPool()` call is the key optimization. It loads all chunks from the DB once and caches them in memory. Subsequent queries hit the cache. The cache is invalidated by `bumpRagPoolVersion()` which is called on every DB write.

---

### Slide 33 — Injecting Context into the Prompt

```typescript
// src/lib/llm.ts (simplified)
async function buildSystemPrompt(
  userMessage: string,
  config: ModelConfig,
): Promise<string> {
  const chunks = await retrieveTopK(userMessage, config.ragTopK);

  if (chunks.length === 0) return config.systemInstruction;

  const context = chunks
    .map((c, i) => `[${i + 1}] ${c.text}`)
    .join("\n\n");

  return `${config.systemInstruction}

## Relevant context
${context}

Answer based on the context above. If the context doesn't contain
the answer, say so — do not make up information.`;
}
```

**Token budget management:**
```typescript
// Reserve 25% of maxTokens for the response
const inputBudget = Math.floor(config.maxTokens * 0.75);
const truncated = truncateHistory(messages, inputBudget);
```

> Speaker note: The "do not make up information" instruction is critical. Without it, the LLM will hallucinate answers that sound plausible but aren't in the context. This is the most common failure mode in RAG systems.

---

### Slide 34 — Demo: Ingest a PDF and Query It

**Step 1 — Ingest:**
1. Open the Knowledge panel
2. Click "Add document" → select a PDF
3. Watch the progress bar as chunks are embedded and stored

**Step 2 — Query:**
```
User: What are the main conclusions of the document?
```

**What happens under the hood:**
```
1. embed("What are the main conclusions...")
   → [0.23, -0.41, 0.87, ...]

2. cosine_similarity(query_vec, all_chunk_vecs)
   → chunk_42: 0.91, chunk_17: 0.84, chunk_3: 0.79, ...

3. BM25("main conclusions", all_chunks)
   → chunk_42: 8.3, chunk_17: 6.1, ...

4. RRF fusion → [chunk_42, chunk_17, chunk_3, ...]

5. Inject top-5 chunks into system prompt

6. LLM generates answer grounded in the document
```

**Try it:** Ask a question that's in the document, then ask one that isn't. The model should answer the first and say "I don't know" for the second.
<!-- §7 TOOLS -->

---

## Part 7 — Tools (Slides 35–38)

### Slide 35 — Tool Architecture

Tools are plain TypeScript objects with a schema and an `execute` function:

```typescript
// src/lib/tools.ts
export interface Tool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  execute(args: Record<string, unknown>): Promise<string>;
}
```

**Tool registry — 13 built-in tools:**

| Category | Tools |
|----------|-------|
| Offline math | `calculator`, `unit_converter`, `date_diff`, `date_time` |
| Text utilities | `text_stats`, `base64`, `json_query`, `notes` |
| Network | `wikipedia`, `weather`, `exchange_rates`, `hacker_news` |
| Dynamic (injected) | `knowledge_search`, `web_search`, `get_pdf_page`, `list_knowledge_sources` |

> Speaker note: The split between static and dynamic tools is important. Static tools have no dependencies and can be instantiated at module load time. Dynamic tools need injected dependencies (the RAG retriever, the PDF store) and are created inside `useChat`.

---

### Slide 36 — A Safe Math Evaluator

The `calculator` tool uses a recursive descent parser — no `eval()`.

```typescript
// src/lib/skills/calculator.ts (simplified)
function parseExpr(tokens: Token[]): number {
  return parseAddSub(tokens);
}

function parseAddSub(tokens: Token[]): number {
  let left = parseMulDiv(tokens);
  while (peek(tokens) === "+" || peek(tokens) === "-") {
    const op = consume(tokens);
    const right = parseMulDiv(tokens);
    left = op === "+" ? left + right : left - right;
  }
  return left;
}

// Whitelisted Math functions only
const ALLOWED_FUNCTIONS = new Set([
  "abs", "ceil", "floor", "round", "sqrt",
  "pow", "log", "log2", "log10", "sin", "cos", "tan",
]);
```

**Why not `eval()`?**

A malicious LLM could generate:
```javascript
calculator({ expression: "process.exit(1)" })
// or
calculator({ expression: "require('fs').unlinkSync('/etc/passwd')" })
```

The recursive descent parser only accepts numbers, operators, and whitelisted `Math.*` identifiers. Arbitrary code execution is impossible.

> Speaker note: This is a real security concern. LLMs can be prompted to generate malicious tool calls. Always validate and sanitize tool arguments, especially for tools that execute code or access the filesystem.

---

### Slide 37 — Tool Call Parsing

The LLM emits tool calls as XML embedded in its response:

```xml
I need to check the current weather.
<tool_call>{"name":"weather","args":{"location":"Paris","unit":"celsius"}}</tool_call>
```

**Parser:**
```typescript
// src/lib/tools.ts
const TOOL_CALL_RE = /<tool_call>([\s\S]*?)<\/tool_call>/g;

export function extractToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const match of text.matchAll(TOOL_CALL_RE)) {
    try {
      calls.push(JSON.parse(match[1]));
    } catch {
      // malformed JSON — skip
    }
  }
  return calls;
}
```

**Why XML tags instead of JSON?**

LLMs are more reliable at generating well-formed XML tags than JSON embedded in prose. The `<tool_call>` delimiter is unambiguous — the parser doesn't need to find JSON boundaries in free text.

> Speaker note: Some frameworks use `{"function_call": {...}}` JSON. The problem is that LLMs sometimes generate partial JSON or add prose before/after the JSON object. XML tags are a cleaner delimiter.

---

### Slide 38 — Demo: Calculator + Wikipedia

**Enable tools** in the chat settings, then ask:

```
What is the square root of the population of France?
```

**Expected ReAct trace:**
```
[Iteration 1]
LLM: I need the population of France.
<tool_call>{"name":"wikipedia","args":{"query":"France population 2024"}}</tool_call>

Tool result: France has a population of approximately 68,374,591 (2024).

[Iteration 2]
LLM: Now I can calculate the square root.
<tool_call>{"name":"calculator","args":{"expression":"sqrt(68374591)"}}</tool_call>

Tool result: 8269.01

[Final response]
LLM: The square root of France's population (~68.4 million) is approximately 8,269.
```

**Try breaking it:** Ask for `sqrt(-1)`. The calculator returns `NaN` — the LLM should handle this gracefully.
<!-- §8 AGENTS -->

---

## Part 8 — Agents & Router (Slides 39–43)

### Slide 39 — What is an Agent?

In this app, an agent is a named persona with:
- A **system prompt** (personality, constraints, tone)
- A set of **enabled tools**
- Optional **description** (used by the router)

```typescript
// src/lib/types.ts
export interface Agent {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  toolIds: string[];
  createdAt: string;
  updatedAt: string;
}
```

**Example agents:**
| Agent | System prompt excerpt | Tools |
|-------|----------------------|-------|
| Support | "You are a customer support agent. Be empathetic..." | `knowledge_search` |
| Technical | "You are a senior engineer. Be precise and concise..." | `calculator`, `wikipedia`, `knowledge_search` |
| Research | "You are a research assistant. Cite your sources..." | `wikipedia`, `web_search`, `knowledge_search` |
| General | "You are a helpful assistant." | all |

> Speaker note: Agents are stored in CouchbaseLite like any other document. You can create, edit, and delete them at runtime. The router picks the best agent for each message automatically.

---

### Slide 40 — The Router in Detail

```typescript
// src/lib/llm.ts (simplified)
async function routeToAgent(
  userMessage: string,
  agents: Agent[],
): Promise<Agent | null> {
  if (agents.length === 0) return null;

  const agentList = agents
    .map(a => `- ${a.name}: ${a.description}`)
    .join("\n");

  const routerPrompt = `You are a routing assistant.
Given the user message, select the most appropriate agent.
Respond with JSON only: {"agent": "<agent_name>"}

Available agents:
${agentList}

User message: "${userMessage}"`;

  const response = await generateOnce(routerPrompt);

  try {
    const { agent } = JSON.parse(response);
    return agents.find(a => a.name === agent) ?? null;
  } catch {
    return null;  // fallback to default system prompt
  }
}
```

> Speaker note: `generateOnce()` is a non-streaming single-turn call. It's used for the router because we need the full response before we can proceed. The router call adds ~200 ms on a 1B model — acceptable for interactive chat.

---

### Slide 41 — Full Message Flow

```
User sends message
        │
        ▼
┌─ Router ──────────────────────────────────────────┐
│  generateOnce(routerPrompt)                        │
│  → {"agent": "Technical"}                         │
└────────────────────────────────────────────────────┘
        │
        ▼
┌─ RAG retrieval ───────────────────────────────────┐
│  retrieveTopK(userMessage, k=5)                    │
│  → [chunk_42, chunk_17, chunk_3, ...]              │
└────────────────────────────────────────────────────┘
        │
        ▼
┌─ Build prompt ────────────────────────────────────┐
│  systemPrompt = agent.systemPrompt                 │
│               + tool schemas                       │
│               + RAG context                        │
│  messages = truncated history + user message       │
└────────────────────────────────────────────────────┘
        │
        ▼
┌─ ReAct loop (max 5 iterations) ───────────────────┐
│  generateStream(messages)                          │
│  → stream tokens to UI                             │
│  → detect <tool_call> tags                         │
│  → execute tools                                   │
│  → inject <tool_result> blocks                     │
│  → continue generation                             │
└────────────────────────────────────────────────────┘
        │
        ▼
┌─ Persist ─────────────────────────────────────────┐
│  saveMessage(userMessage)                          │
│  saveMessage(assistantResponse)                    │
│  embed(assistantResponse) → saveMessage(embedding) │
└────────────────────────────────────────────────────┘
```

---

### Slide 42 — Creating a Custom Agent

**Via the UI:**
1. Open the Agents panel
2. Click "New agent"
3. Fill in name, description, system prompt
4. Select tools to enable
5. Save

**Via code:**
```typescript
import { saveAgent } from "./lib/db";

await saveAgent({
  id: crypto.randomUUID(),
  name: "Legal Assistant",
  description: "Handles legal document analysis and contract review",
  systemPrompt: `You are a legal assistant specializing in contract analysis.
- Always cite the specific clause you're referencing
- Flag ambiguous language
- Do not provide legal advice — recommend consulting a lawyer for binding decisions`,
  toolIds: ["knowledge_search", "text_stats"],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
```

> Speaker note: The `toolIds` array references tool names from the registry. If a tool ID doesn't exist in the registry, it's silently ignored. This means you can add tools to the registry later without breaking existing agents.

---

### Slide 43 — Demo: Multi-Agent Routing

**Setup:** Create two agents:
- **Chef**: "You are a professional chef. Answer only questions about cooking and recipes."
- **Mechanic**: "You are an automotive mechanic. Answer only questions about cars and repairs."

**Test routing:**
```
"How do I make a béchamel sauce?"
→ Router selects: Chef
→ Response: detailed recipe with technique

"My car makes a grinding noise when braking."
→ Router selects: Mechanic
→ Response: brake pad diagnosis

"What is the capital of France?"
→ Router selects: General (neither agent matches)
→ Response: "Paris"
```

**Observe:** The router call is visible in the browser DevTools Network tab (or Tauri logs) as a separate LLM invocation before the main response.
<!-- §9 CONCLUSION -->

---

## Part 9 — Conclusion & Limits (Slides 44–46)

### Slide 44 — What We Built

A fully offline AI desktop app with:

| Feature | Technology |
|---------|-----------|
| Native desktop shell | Tauri v2 (Rust + WebView) |
| LLM inference | LiteRT-LM (Gemma 3/4 INT4) |
| Browser LLM fallback | MediaPipe Tasks (WebGPU) |
| Cloud LLM fallback | OpenAI-compatible API |
| Document storage | Couchbase Lite (N1QL + FTS) |
| Vector embeddings | BERT-base-uncased (LiteRT) |
| Hybrid search | Cosine + BM25 + RRF fusion |
| Tool use | ReAct loop (XML tool calls) |
| Agent routing | LLM-based router |
| Voice input | Whisper (Web Worker) |
| Wake word | Porcupine |
| Model download | Rust reqwest streaming |

**Lines of code:** ~8,000 TypeScript + ~300 Rust

---

### Slide 45 — Known Limits & Trade-offs

**Performance:**
- 1B model: ~30 tok/s CPU, ~130 tok/s GPU. Adequate for chat, slow for batch processing.
- Cosine search is O(n) over all chunks. Works up to ~10k chunks; needs ANN (HNSW) beyond that.
- Router adds ~200 ms per message. Disable it for latency-sensitive use cases.

**Quality:**
- 1B models hallucinate more than 7B+ models. Always use RAG to ground responses.
- BERT embeddings are 128-dim — lower quality than modern embedding models (e.g. `nomic-embed-text` at 768-dim).
- BM25 weight (0.3) is a heuristic. Tune it for your corpus.

**Platform:**
- Linux: requires `patchelf` and correct RUNPATH for LiteRT `.so` files.
- Windows: WebView2 must be installed (ships with Windows 11, optional on 10).
- Android: supported via Tauri mobile, but LiteRT-LM native inference not yet tested.

**Security:**
- Tool calls are not sandboxed. A malicious system prompt could trigger unintended tool use.
- The `fetch_url` tool can reach any URL the OS can reach — consider an allowlist for production.

---

### Slide 46 — Resources & Next Steps

**This repository:**
```
https://github.com/ldoguin/tauri-cblite-litert
```

**Key dependencies:**
| Project | URL |
|---------|-----|
| Tauri | https://tauri.app |
| LiteRT | https://ai.google.dev/edge/litert |
| LiteRT-LM | https://github.com/google-ai-edge/LiteRT-LM |
| Couchbase Lite | https://www.couchbase.com/products/lite |
| tauri-plugin-cblite | https://github.com/ldoguin/tauri-plugin-cblite |
| tauri-plugin-litert | https://github.com/ldoguin/tauri-plugin-litert |
| Gemma models | https://huggingface.co/litert-community |

**Next steps:**
1. **Add a vector index** — implement HNSW in Rust for sub-millisecond ANN search at scale
2. **Sync to Couchbase Server** — enable `startReplication()` for multi-device sync
3. **Fine-tune the router** — train a small classifier instead of using the LLM for routing
4. **Add multimodal input** — the MediaPipe backend already supports image input; wire it to the UI
5. **Package for distribution** — `cargo tauri build` produces `.deb`, `.AppImage`, `.dmg`, `.exe`

**Questions?**

---

## Appendix — Architecture Diagrams

### A1 — Full Data Flow

```
                        ┌─────────────────────────────────────────┐
                        │           React UI                       │
                        │  ChatPane  KnowledgePanel  ModelManager  │
                        └──────────────┬──────────────────────────┘
                                       │ useChat hook
                        ┌──────────────▼──────────────────────────┐
                        │         Business Logic                   │
                        │  llm.ts  rag.ts  db.ts  tools.ts        │
                        └──────┬───────────┬────────────┬─────────┘
                               │           │            │
                    ┌──────────▼──┐  ┌─────▼──────┐  ┌─▼──────────────┐
                    │  LLM Layer  │  │  RAG Layer  │  │  Storage Layer │
                    │             │  │             │  │                │
                    │ LiteRT-LM   │  │ BERT embed  │  │ CouchbaseLite  │
                    │ MediaPipe   │  │ Cosine sim  │  │ N1QL queries   │
                    │ Cloud API   │  │ BM25 + RRF  │  │ FTS indexes    │
                    └──────┬──────┘  └─────┬───────┘  └─┬────────────┘
                           │               │             │
                    ┌──────▼───────────────▼─────────────▼────────────┐
                    │              Tauri IPC Bridge                    │
                    │         tauri-plugin-litert                      │
                    │         tauri-plugin-cblite                      │
                    │         invoke_handler (download, path, delete)  │
                    └──────────────────────────────────────────────────┘
```

### A2 — RAG Retrieval Pipeline

```
User query: "What are the side effects of ibuprofen?"
     │
     ▼
embed(query) → q_vec [0.23, -0.41, ...]
     │
     ├─── Vector search ──────────────────────────────────────────────┐
     │    for each chunk c in pool:                                    │
     │      score = cosine(q_vec, c.embedding)                        │
     │    sort by score DESC                                           │
     │    → [chunk_42: 0.91, chunk_17: 0.84, chunk_3: 0.79, ...]     │
     │                                                                 │
     └─── BM25 search ────────────────────────────────────────────────┤
          tokenize("side effects ibuprofen")                           │
          for each chunk c in pool:                                    │
            score = Σ IDF(t) × TF_norm(t, c)                         │
          sort by score DESC                                           │
          → [chunk_42: 8.3, chunk_17: 6.1, chunk_9: 5.8, ...]       │
                                                                       │
                    ┌──────────────────────────────────────────────────┘
                    ▼
          RRF fusion (bm25Weight=0.3)
          score(d) = 0.7/(60+rank_vec) + 0.3/(60+rank_bm25)
          → [chunk_42, chunk_17, chunk_9, chunk_3, ...]
                    │
                    ▼
          Top-5 chunks injected into system prompt
                    │
                    ▼
          LLM generates grounded answer
```

### A3 — ReAct Loop State Machine

```
                    ┌─────────────────┐
                    │   User message  │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  Build prompt   │
                    │  (sys + RAG +   │
                    │   history)      │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
              ┌────►│  Stream LLM     │◄──────────────────┐
              │     └────────┬────────┘                   │
              │              │                            │
              │     ┌────────▼────────┐                   │
              │     │ Tool call found?│                   │
              │     └────┬───────┬────┘                   │
              │          │ YES   │ NO                     │
              │   ┌──────▼──┐  ┌─▼──────────────┐        │
              │   │ Execute │  │ Final response  │        │
              │   │  tool   │  │ → save to DB    │        │
              │   └──────┬──┘  └────────────────┘        │
              │          │                                │
              │   ┌──────▼──────────────────────┐        │
              │   │ Inject <tool_result> block   │        │
              │   │ iteration++                  │        │
              │   └──────┬──────────────────────┘        │
              │          │                                │
              │   ┌──────▼──────────────────────┐        │
              └───┤ iteration < MAX_ITERATIONS? ├────────┘
                  │ AND no duplicate tool call?  │ NO → force final response
                  └─────────────────────────────┘
```

---

## Appendix — Exercises

### Exercise 1 — Add a New Tool

Add a `word_count` tool that counts words, sentences, and paragraphs in a given text.

```typescript
// src/lib/skills/word_count.ts
export const wordCountTool: Tool = {
  name: "word_count",
  description: "Count words, sentences, and paragraphs in text",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to analyze" },
    },
    required: ["text"],
  },
  async execute({ text }) {
    // TODO: implement
  },
};
```

Register it in `src/lib/tools.ts` and test it with:
```
"Count the words in: 'The quick brown fox jumps over the lazy dog.'"
```

---

### Exercise 2 — Add a New Agent

Create a "Code Reviewer" agent that:
- Reviews code snippets for bugs and style issues
- Uses the `knowledge_search` tool to check against coding standards you've ingested
- Always responds with a structured review: Issues / Suggestions / Summary

---

### Exercise 3 — Tune RAG Parameters

Ingest a technical document (e.g. a RFC or API specification) and experiment with:

| Parameter | Default | Try |
|-----------|---------|-----|
| `chunkSize` | 512 | 256, 1024 |
| `overlap` | 64 | 0, 128 |
| `topK` | 5 | 3, 10 |
| `bm25Weight` | 0.3 | 0.0, 0.5, 1.0 |
| `threshold` | 0.3 | 0.1, 0.5 |

Ask the same question with each configuration and compare the retrieved chunks.

---

### Exercise 4 — Add a Rust Command

Add a `list_model_files` command that returns all `.litertlm` and `.task` files in the models directory with their sizes.

```rust
// src-tauri/src/lib.rs
#[tauri::command]
async fn list_model_files(app: AppHandle) -> Result<Vec<ModelFileInfo>, String> {
    // TODO: implement
}

#[derive(serde::Serialize)]
struct ModelFileInfo {
    name: String,
    size_bytes: u64,
    modified: String,
}
```

Call it from TypeScript and display the results in the Model Manager panel.
