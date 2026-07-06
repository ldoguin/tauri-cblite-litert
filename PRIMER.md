# Primer: Build an Offline AI Desktop App

A deep-dive companion to the workshop. Read this before or after the slides — it covers every topic at the level of understanding rather than the level of demonstration.

---

## Contents

1. [Why offline-first matters](#1-why-offline-first-matters)
2. [Tauri: a different kind of desktop framework](#2-tauri-a-different-kind-of-desktop-framework)
3. [How large language models actually work](#3-how-large-language-models-actually-work)
4. [Quantization: making models fit on real hardware](#4-quantization-making-models-fit-on-real-hardware)
5. [Embeddings and semantic search](#5-embeddings-and-semantic-search)
6. [Tokenization: text to numbers](#6-tokenization-text-to-numbers)
7. [RAG: giving an LLM access to your documents](#7-rag-giving-an-llm-access-to-your-documents)
8. [Hybrid search: vector + BM25](#8-hybrid-search-vector--bm25)
9. [Tool use and the ReAct loop](#9-tool-use-and-the-react-loop)
10. [Agent routing](#10-agent-routing)
11. [TensorFlow Lite, LiteRT, and MediaPipe: a lineage](#11-tensorflow-lite-litert-and-mediapipe-a-lineage)
12. [Couchbase Lite: offline-first document storage](#12-couchbase-lite-offline-first-document-storage)
13. [Platform support and the isomorphic architecture](#13-platform-support-and-the-isomorphic-architecture)

---

## 1. Why offline-first matters

Most software is built around the assumption of a network connection. Databases live in the cloud. AI inference happens on remote servers. The application on your machine is mostly a thin client that renders what the server sends back.

This works until it doesn't. The failure modes are well-known but often treated as edge cases: a hospital ward with spotty Wi-Fi, a field engineer in a basement, an aircraft in flight, a lawyer who cannot legally send client documents to a third-party server. These are not edge cases — they are the normal operating conditions for a large class of real applications.

The cloud dependency problem has two distinct dimensions that are usually solved separately but compound each other when both are present.

**The AI dimension.** When you call a cloud LLM API, your input — the user's query, the document you're summarising, the conversation history — leaves your machine and travels to a datacenter. The provider's terms of service may permit training on that data. Regulatory frameworks like HIPAA, GDPR, and various financial regulations may prohibit it entirely. Beyond privacy, there is latency: a round-trip to a remote server adds 200–2000 ms before the first token appears. There is cost: at scale, token pricing is non-trivial. And there is availability: if the API is down or the network is unreachable, the feature simply does not work.

**The data dimension.** The same logic applies to where you store the data the AI works with. If conversation history, ingested documents, and vector embeddings all live in a cloud database, you have the same privacy exposure, the same availability dependency, and the same latency on every read and write. An app that runs inference locally but stores its context in a remote database has solved half the problem.

The solution is to treat both inference and storage as local-first resources. The model runs on the device. The database lives on the device. The network, when available, is used for optional sync — not as a hard dependency.

This is not a new idea in the database world. CouchDB and its mobile descendant Couchbase Lite were built around exactly this model in the early 2010s. What is new is that the same pattern is now viable for LLM inference, because quantization has made it possible to run capable language models on consumer hardware without a GPU cluster.

The workshop builds an application that demonstrates both halves working together: LiteRT for on-device inference, Couchbase Lite for on-device storage, and Tauri as the shell that packages the whole thing as a native desktop application.

## 2. Tauri: a different kind of desktop framework

The dominant way to build cross-platform desktop apps with web technology has been Electron. Electron bundles a full copy of Chromium and a Node.js runtime into every application. The result is a binary that is 150–200 MB before you write a single line of your own code, and a process that uses 200+ MB of RAM at idle. The tradeoff was considered acceptable because it made web developers productive on the desktop without learning a native UI toolkit.

Tauri takes a different approach. Instead of bundling a browser engine, it uses the operating system's own WebView: WebKit on macOS and Linux, WebView2 (Chromium-based, but already installed on Windows 10+) on Windows. The application shell is written in Rust rather than Node.js. The result is a binary that is typically 5–15 MB and uses 30–60 MB of RAM at idle.

The tradeoff is that you lose rendering consistency across platforms — WebKit and WebView2 are not identical. For most applications this is not a practical problem. For pixel-perfect cross-platform rendering you would use Electron or a native toolkit.

**The IPC model.** The web frontend and the Rust backend communicate through a message-passing interface called IPC (inter-process communication). From JavaScript you call `invoke("command_name", { arg: value })`, which serialises the arguments to JSON, sends them over a postMessage channel to the Rust process, and returns a promise that resolves with the deserialised response. The round-trip is typically under 1 ms for small payloads.

On the Rust side, a command is just an async function annotated with `#[tauri::command]`. Tauri's macro system generates the glue code that routes the IPC message to the right function and serialises the return value back.

```rust
#[tauri::command]
async fn get_model_path(app: AppHandle, file_name: String) -> Result<Option<String>, String> {
    let path = app.path().app_local_data_dir()?.join("models").join(&file_name);
    Ok(path.exists().then(|| path.to_string_lossy().into_owned()))
}
```

```typescript
const path = await invoke<string | null>("get_model_path", { fileName: "gemma3-1b-it-int4.litertlm" });
```

**The security model.** Tauri v2 introduced an explicit capability system. Every command that the frontend can call must be listed in a capabilities file. Without an entry, `invoke()` returns an error. This is a meaningful improvement over Electron, where the Node.js backend has broad filesystem and network access by default and the security boundary between the renderer and the backend is easy to accidentally remove.

Plugin commands (from `tauri-plugin-cblite`, `tauri-plugin-litert`, etc.) are grouped into named permission sets. `cblite:default` expands to a list of specific allowed operations. You can grant fine-grained access — allow reading documents but not deleting them — without writing any custom middleware.

**The isomorphic pattern.** Because the frontend is a web application, it can run in a plain browser as well as inside Tauri. This application exploits that by implementing every feature twice: a Tauri path that uses the native plugins, and a web fallback that uses localStorage and a WebAssembly model runner. The gate is a single function:

```typescript
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
```

The practical benefit is development speed. You can iterate on the UI in a browser with hot-reload in milliseconds, without waiting for a Rust compile. You switch to the desktop binary only when you need to test native features like LiteRT inference or Couchbase Lite persistence.

## 3. How large language models actually work

An LLM is, at its core, a function that takes a sequence of tokens and returns a probability distribution over what the next token should be. That is the entire job. Everything else — the apparent reasoning, the ability to follow instructions, the conversational fluency — emerges from doing that one thing very well on a very large amount of text.

**Tokens, not words.** The model does not operate on characters or words. It operates on tokens, which are subword units produced by a tokenizer. The word "unaffable" might become three tokens: "un", "##aff", "##able". Common words like "the" are single tokens. Rare words and proper nouns get split into more pieces. A rough rule of thumb is that one token is about four characters of English text, so 1000 tokens ≈ 750 words.

The model has a fixed vocabulary — typically 32,000 to 256,000 tokens — and its output is a probability score for each vocabulary entry. To generate text, you sample from that distribution (or take the highest-probability token), append the result to the input, and run the model again. This is called autoregressive generation.

**The transformer architecture.** Modern LLMs are built on the transformer architecture, introduced in the 2017 paper "Attention Is All You Need". The key mechanism is self-attention: for each token in the input, the model computes how much it should "attend to" every other token when predicting the next one. This allows the model to capture long-range dependencies — the pronoun "it" at position 200 can attend to the noun it refers to at position 50.

A transformer is a stack of identical layers. Each layer has two components: a multi-head self-attention block and a feed-forward network. The depth of the stack (number of layers) and the width of the attention heads are the primary parameters that determine model capacity. Gemma 3 1B has 18 layers and 256M attention parameters; Gemma 3 27B has 62 layers.

**The KV-cache.** During generation, the model processes the entire context on the first forward pass (called prefill). For subsequent tokens, it only needs to process the new token — but it needs the key and value matrices from all previous tokens to compute attention. These are stored in a structure called the KV-cache. The cache grows linearly with context length and is the primary memory bottleneck for long conversations. A 1B model with a 4096-token context uses roughly 500 MB of KV-cache in FP16.

**Context window.** The context window is the maximum number of tokens the model can process in a single forward pass. Tokens outside the window are simply not visible to the model — it has no memory of them. This is why long conversations eventually lose their early context, and why RAG (injecting relevant document chunks into the prompt) is necessary for document-aware applications.

**Temperature and sampling.** The raw output of the model is a vector of logits (unnormalised log-probabilities). To get a probability distribution you apply softmax. Temperature is a scalar that divides the logits before softmax: low temperature (< 1) makes the distribution sharper (more deterministic), high temperature (> 1) makes it flatter (more random). At temperature 0 you always pick the highest-probability token; at temperature 1 you sample proportionally to the model's raw probabilities.

Top-K sampling restricts the sample to the K highest-probability tokens. Top-P (nucleus) sampling restricts it to the smallest set of tokens whose cumulative probability exceeds P. Both are ways of preventing the model from sampling very low-probability tokens that produce incoherent output.

**Instruction tuning.** A base LLM trained on raw text is good at completing text but not at following instructions. Instruction-tuned models (the "-it" suffix in "gemma3-1b-it-int4") are fine-tuned on datasets of (instruction, response) pairs, often with reinforcement learning from human feedback (RLHF). This is what makes the model behave like a chat assistant rather than a text autocomplete engine.

**System prompts.** The system prompt is a special message prepended to the conversation that sets the model's persona, constraints, and available tools. It is not shown to the user. The model is trained to treat the system prompt as authoritative instructions. In this application, each agent has its own system prompt that defines its role and the tools it can use.

## 4. Quantization: making models fit on real hardware

A neural network is a large collection of floating-point numbers called weights (or parameters). During training these are stored in 32-bit floating-point format (FP32), which gives enough precision to compute gradients accurately. At inference time, that precision is largely unnecessary — the model's behaviour is determined by the relative magnitudes of weights, not their exact values.

Quantization is the process of representing weights in a lower-precision format. The goal is to reduce memory usage and increase throughput, at the cost of a small, bounded reduction in output quality.

**The precision ladder.** The common formats, from highest to lowest precision:

- **FP32** (32 bits): training precision. Every weight is a 32-bit IEEE 754 float. A 1B-parameter model requires 4 GB.
- **FP16 / BF16** (16 bits): half precision. 2× smaller, negligible quality loss. Most inference today starts here.
- **INT8** (8 bits): 4× smaller than FP32. Quality loss is typically 1–2% on standard benchmarks. Widely used in production.
- **INT4** (4 bits): 8× smaller than FP32. Quality loss is typically 3–5%. This is what the workshop uses for Gemma.
- **INT2** (2 bits): 16× smaller. Quality loss becomes significant and task-dependent.

**How it works mechanically.** An INT4 weight can represent 16 distinct values (0–15). To map a floating-point weight to one of those 16 values, you need a scale factor and a zero-point:

```
quantized = round((float_weight - zero_point) / scale)
dequantized = quantized * scale + zero_point
```

The scale and zero-point are stored alongside the quantized weights. At inference time, the integer is dequantized back to a float before the matrix multiplication. The arithmetic itself stays in float — only the storage is compressed.

**Block-wise quantization.** If you use a single scale factor for an entire weight matrix, the quantization error accumulates badly for matrices with a wide range of values. The standard solution is block-wise quantization: divide the weight matrix into blocks of N weights (typically 32 or 128), and compute a separate scale and zero-point for each block. This limits the error to within each block. Gemma INT4 uses 128-weight blocks.

**Activations vs. weights.** Quantization can be applied to weights (the stored parameters) or to activations (the intermediate values computed during a forward pass). Weight-only quantization (W4A16: 4-bit weights, 16-bit activations) is the most common approach for LLMs because activations have a much wider dynamic range and are harder to quantize without quality loss. This is what LiteRT uses for Gemma.

**Why it matters for on-device deployment.** The practical consequence is that a model that would require a 40 GB GPU to run in FP32 can run in 5 GB of RAM in INT4. Gemma 3 1B goes from ~4 GB to ~700 MB — small enough to fit comfortably on a phone or a laptop with 8 GB of RAM. The throughput improvement is also significant: INT4 matrix multiplications are faster than FP32 on hardware with INT4 support (most modern mobile SoCs and Apple Silicon).

**Quality loss in practice.** The 3–5% quality loss figure comes from aggregate benchmarks like MMLU and HellaSwag. For conversational tasks, the perceptual difference between FP32 and INT4 Gemma 3 1B is difficult to notice in normal use. The degradation is more visible on tasks that require precise arithmetic, long-range reasoning, or rare factual recall. For the RAG use case in this workshop — where the model is primarily synthesising information injected into the prompt — INT4 is entirely adequate.

## 5. Embeddings and semantic search

A word embedding is a vector of floating-point numbers that represents the meaning of a piece of text. The key property is that texts with similar meanings have vectors that are close together in the embedding space, regardless of whether they share any words.

This is not obvious. "Dog" and "canine" share no characters, but a well-trained embedding model places their vectors very close together. "Dog" and "stock market" are far apart. The model has learned, from the statistical patterns of how words co-occur in large text corpora, that "dog" and "canine" appear in similar contexts.

**From words to sentences.** Early embedding models (Word2Vec, GloVe) produced one vector per word. Modern sentence embedding models produce one vector for an entire passage of text. The model used in this application is BERT-base-uncased, which produces a 768-dimensional vector for each input (though the application uses a projection layer to reduce this to 128 dimensions for storage efficiency).

**How BERT produces embeddings.** BERT (Bidirectional Encoder Representations from Transformers) is a transformer model trained with a masked language modelling objective: given a sentence with some words hidden, predict the hidden words. This forces the model to build rich contextual representations of each token.

To get a single vector for a sentence, BERT uses a special token called `[CLS]` (classification) prepended to every input. After the forward pass, the output vector at the `[CLS]` position is used as the sentence embedding. It has been trained to summarise the meaning of the entire input.

**Cosine similarity.** To measure how similar two embeddings are, you compute the cosine of the angle between them:

```
similarity(A, B) = (A · B) / (|A| × |B|)
```

This gives a value between -1 and 1. Two identical vectors have similarity 1. Two orthogonal vectors (completely unrelated) have similarity 0. The dot product in the numerator measures how much the vectors point in the same direction; dividing by the magnitudes normalises for length so that a long document and a short one can still be compared fairly.

In practice, for retrieval you often skip the division and just use the dot product, because if all vectors are normalised to unit length (which is standard practice), the dot product and cosine similarity are equivalent.

**Why 128 dimensions?** The full BERT-base output is 768 dimensions. Storing 768 floats per document chunk is expensive at scale, and the extra dimensions often encode noise rather than signal for retrieval tasks. A projection layer (a learned linear transformation) maps 768 → 128 while preserving the most retrieval-relevant structure. The quality loss is small for the document sizes typical in this application.

**The embedding model is separate from the LLM.** This is a common source of confusion. The LLM (Gemma) generates text. The embedding model (BERT) converts text to vectors for storage and retrieval. They are different models with different architectures and different purposes. The embedding model is much smaller (~25 MB vs ~700 MB) and runs much faster, which is why it can be run in the browser without noticeable latency.

## 6. Tokenization: text to numbers

Before any neural network can process text, the text must be converted to integers. This conversion is called tokenization, and the algorithm used matters more than it might seem.

**Why not just use characters or words?** Character-level tokenization produces very long sequences (every character is a token), which is expensive for transformers whose attention cost scales quadratically with sequence length. Word-level tokenization has the opposite problem: the vocabulary must be enormous to cover all words in all languages, and any word not in the vocabulary is simply unknown.

**WordPiece.** BERT uses an algorithm called WordPiece, which finds a middle ground. It starts with a vocabulary of individual characters and iteratively merges the most frequent adjacent pairs into new vocabulary entries, until the vocabulary reaches a target size (30,522 for bert-base-uncased). The result is a vocabulary of common words, common word fragments, and individual characters as a fallback.

When tokenizing a new word, the algorithm greedily matches the longest known prefix, then the longest known continuation (marked with `##` to indicate it is a continuation, not a word start), and so on:

```
"unaffable" → ["un", "##aff", "##able"]
"Tauri"     → ["tau", "##ri"]
"the"       → ["the"]
```

**Special tokens.** BERT uses several special tokens with fixed IDs:

- `[CLS]` (ID 101): prepended to every input. Its output vector is used as the sentence embedding.
- `[SEP]` (ID 102): marks the end of a sentence or the boundary between two sentences.
- `[PAD]` (ID 0): pads shorter sequences to a fixed length so batches can be processed together.
- `[UNK]` (ID 100): represents any character that is not in the vocabulary.

A tokenized input for BERT looks like:

```
[CLS] the  dog  barked [SEP] [PAD] [PAD] ...
 101   the  dog  ##ed   102    0     0
```

**Why implement it in TypeScript?** The application implements the WordPiece tokenizer in about 100 lines of TypeScript, running entirely in the browser. The alternative would be to use a WASM-compiled tokenizer library, which adds ~2 MB to the bundle and requires an async initialisation step. The TypeScript implementation is fast enough for the document sizes in this application (a few hundred tokens per chunk) and has no dependencies.

The vocabulary file (`vocab.txt`) is 230 KB and is fetched once and cached in the browser's Cache API. Subsequent loads are instant.

## 7. RAG: giving an LLM access to your documents

An LLM's knowledge is frozen at its training cutoff. It knows nothing about documents you wrote last week, your company's internal policies, or the specific patient record you are trying to summarise. Fine-tuning the model on your data is one solution, but it is expensive, slow, and requires retraining every time the data changes.

Retrieval-Augmented Generation (RAG) is a simpler and more practical approach: at query time, retrieve the most relevant passages from your document collection and inject them into the prompt as context. The model then generates its answer based on both its trained knowledge and the injected passages.

**The two phases.** RAG has an offline phase (ingestion) and an online phase (retrieval).

During ingestion, each document is split into chunks, each chunk is converted to an embedding vector, and the vector is stored in a database alongside the original text. This happens once per document, or whenever the document changes.

During retrieval, the user's query is converted to an embedding vector, and the database is searched for the chunks whose vectors are most similar to the query vector. The top-K chunks are retrieved and injected into the LLM prompt.

**Why chunking?** A 50-page PDF contains roughly 25,000 tokens. Most LLMs have context windows of 4,096–32,768 tokens, and even if the document fits, injecting the entire thing into every prompt is wasteful and slow. More importantly, the model's ability to attend to relevant information degrades when the context is very long — a phenomenon called "lost in the middle", where information in the middle of a long context is attended to less reliably than information at the beginning or end.

Chunking splits the document into passages of 256–512 tokens with some overlap between adjacent chunks (typically 50–100 tokens). The overlap ensures that sentences that fall on a chunk boundary are not lost. Each chunk is embedded independently.

**The retrieval step.** Given a query embedding, the database returns the K chunks with the highest cosine similarity. K is typically 3–10. These chunks are concatenated and injected into the prompt as a "context" block before the user's question.

**What the model does with the context.** The model is instructed (via the system prompt) to answer based on the provided context and to say when the context does not contain the answer. This grounding is important: without it, the model will happily hallucinate an answer that sounds plausible but is not supported by the documents.

**Limitations.** RAG works well when the answer to a question is contained in a single chunk or a small number of chunks. It works less well for questions that require synthesising information spread across many documents, or for questions that require multi-step reasoning over the retrieved passages. For those cases, more sophisticated approaches like iterative retrieval or chain-of-thought prompting are needed.

The quality of retrieval is also bounded by the quality of the embedding model. If the embedding model does not capture the semantic relationship between the query and the relevant passage, the passage will not be retrieved. This is why hybrid search (combining vector similarity with keyword matching) often outperforms pure vector search.

## 8. Hybrid search: vector + BM25

Pure vector search has a blind spot: it finds semantically similar passages but can miss exact keyword matches. If a user searches for "RFC 7231" and the document contains that exact string, a vector search might rank it lower than a passage that talks about HTTP specifications in general terms. The embedding model has learned that "RFC 7231" and "HTTP specification" are related, but the exact string match is lost in the semantic compression.

BM25 (Best Match 25, also called Okapi BM25) is a classical keyword-based ranking algorithm that does not have this problem. It scores documents based on term frequency and inverse document frequency, with corrections for document length.

**How BM25 works.** For a query with terms t₁, t₂, ..., tₙ and a document d:

```
score(q, d) = Σ IDF(tᵢ) × tf(tᵢ, d) × (k1 + 1)
                          ─────────────────────────────────────
                          tf(tᵢ, d) + k1 × (1 - b + b × |d|/avgdl)
```

Where:
- `tf(t, d)` is how many times term t appears in document d
- `IDF(t)` is the inverse document frequency: log((N - df + 0.5) / (df + 0.5)), where N is the total number of documents and df is the number containing term t. Rare terms get higher IDF scores.
- `|d|` is the length of the document, `avgdl` is the average document length
- `k1 = 1.5` controls term frequency saturation — doubling the term count does not double the score
- `b = 0.75` controls length normalisation — longer documents are penalised slightly

The key insight is that IDF gives high weight to rare terms. A term that appears in every document (like "the") contributes almost nothing. A term that appears in only one document (like "RFC 7231") contributes a lot.

**Combining the two signals.** The standard approach is Reciprocal Rank Fusion (RRF). Instead of trying to normalise the scores from two different systems (which have different scales and distributions), RRF works on ranks:

```
RRF(d) = Σᵢ  weightᵢ / (k + rankᵢ(d))
```

Where `rankᵢ(d)` is the position of document d in the i-th ranked list, and k = 60 is a constant that dampens the effect of rank differences at the top of the list. A document ranked #1 in one list and #3 in another will score higher than a document ranked #1 in only one list.

The constant k = 60 was chosen empirically and is remarkably robust across different retrieval tasks. The intuition is that the difference between rank 1 and rank 2 should not be treated as more important than the difference between rank 10 and rank 11.

**In practice.** This application uses a BM25 weight of 0.3 by default, meaning the final score is 70% vector similarity and 30% BM25. For keyword-heavy corpora (legal documents, medical records, technical specifications with precise terminology), increasing the BM25 weight improves recall. For conversational or conceptual queries, the vector component dominates and the BM25 weight matters less.

## 9. Tool use and the ReAct loop

An LLM by itself can only produce text. It cannot look up the current weather, execute code, query a database, or fetch a web page. Tool use is the mechanism by which an LLM can invoke external functions and incorporate their results into its response.

**The basic mechanism.** The model is given a list of available tools in its system prompt, along with a description of what each tool does and what arguments it takes. When the model determines that it needs to use a tool, it outputs a structured tool call in its response — a block of text in a specific format that the application can parse and execute.

```
System: You have access to the following tools:
  - calculator(expression: string): evaluates a mathematical expression
  - wikipedia(query: string): searches Wikipedia and returns a summary

User: What is the square root of the population of France?

LLM: I need to find the population of France and then compute its square root.
<tool_call>{"name":"wikipedia","args":{"query":"France population"}}</tool_call>
```

The application detects the `<tool_call>` block, executes the Wikipedia search, and appends the result to the conversation:

```
Tool result: France has a population of approximately 68 million (2024).

LLM: The square root of 68,000,000 is approximately 8,246.
<tool_call>{"name":"calculator","args":{"expression":"sqrt(68000000)"}}</tool_call>

Tool result: 8246.21

LLM: The square root of France's population (~68 million) is approximately 8,246.
```

**Why XML-like tags rather than JSON?** The tool call format uses `<tool_call>...</tool_call>` tags rather than embedding JSON directly in the response. This is because small models (1B parameters) are more reliable at producing well-formed structured output when it is clearly delimited from prose. A JSON block embedded in a sentence is easy for the model to accidentally corrupt with surrounding text. The tags make the boundary unambiguous.

**The ReAct pattern.** ReAct (Reason + Act) is a prompting strategy that interleaves reasoning steps with tool calls. The model is encouraged to think out loud before each tool call, explaining what it needs and why. This improves reliability because the reasoning step helps the model plan the correct sequence of tool calls, and it makes the model's behaviour more interpretable.

The name comes from the 2022 paper "ReAct: Synergizing Reasoning and Acting in Language Models" by Yao et al. The core insight is that reasoning without acting (chain-of-thought prompting) and acting without reasoning (pure tool use) are both less effective than interleaving the two.

**Safety limits.** Tool use introduces a risk of infinite loops: the model calls a tool, gets a result, calls another tool, gets another result, and never produces a final answer. This application enforces three limits:

1. A maximum of 5 tool call iterations per message. After 5 iterations, the model is forced to produce a final answer with whatever information it has.
2. Identical repeated tool calls are detected and break the loop. If the model calls `wikipedia("France population")` twice in a row, the second call is suppressed and the model is told to proceed.
3. Tool execution time is tracked separately from LLM latency, so slow tool calls (web searches, PDF fetches) do not inflate the reported inference time.

**Security considerations.** Tools that execute code or make network requests are potential attack vectors. A malicious document in the knowledge base could contain instructions that cause the model to call a tool with attacker-controlled arguments. This application mitigates this by implementing a safe math evaluator (no `eval()`, no arbitrary code execution) and by not exposing any tool that can write to the filesystem or make authenticated requests.

## 10. Agent routing

A single LLM with a single system prompt can handle a wide range of tasks, but it cannot be simultaneously an expert customer support agent, a technical documentation assistant, and a sales advisor. Each role requires a different persona, different constraints, and a different set of tools.

The solution is a multi-agent architecture: multiple agents, each with their own system prompt and tool set, and a router that decides which agent should handle each incoming message.

**What an agent is.** In this application, an agent is simply a named configuration: a system prompt, a list of tools, and optionally a temperature setting. There is no separate model per agent — all agents share the same underlying LLM. The "agent" is just the context in which the model operates.

```typescript
const agents = {
  Support: {
    systemPrompt: "You are a customer support specialist...",
    tools: ["knowledge_search", "web_search"],
  },
  Technical: {
    systemPrompt: "You are a technical documentation expert...",
    tools: ["knowledge_search", "calculator", "wikipedia"],
  },
  General: {
    systemPrompt: "You are a helpful general assistant.",
    tools: ["calculator", "wikipedia", "web_search"],
  },
};
```

**The router.** Before every message is processed, a separate LLM call is made to determine which agent should handle it. The router receives the list of available agents and the user's message, and returns a JSON object with the selected agent name:

```
System: You are a routing assistant. Given the following agents and their descriptions,
        select the most appropriate agent for the user's message.
        Agents: Support (customer issues), Technical (docs/code), General (everything else)
        Respond with JSON: {"agent": "<name>"}

User: My invoice shows the wrong amount.

Router: {"agent": "Support"}
```

The router uses the same model as the agents. On a 1B model, a routing call is fast — roughly 50 input tokens and 10 output tokens — adding about 200 ms of latency. This is acceptable for most interactive applications.

**Why not just use one agent with all the tools?** You could. For a small number of tools and a capable model, a single agent with a comprehensive system prompt works well. The multi-agent approach becomes valuable when:

- Different tasks require genuinely different personas (a support agent should be empathetic; a technical agent should be precise)
- You want to restrict which tools are available for which tasks (the support agent should not have access to code execution)
- The system prompt would become too long if it described all possible roles and all possible tools
- You want to route to specialised fine-tuned models in the future without changing the application architecture

**Fallback behaviour.** If the router returns invalid JSON, or an agent name that does not exist in the configuration, the application falls back to the General agent. This is important for robustness: a 1B model will occasionally produce malformed output, and the application should degrade gracefully rather than crash.

**The full message flow.** Putting it all together, a single user message goes through this sequence:

1. Router LLM call → select agent
2. Load agent system prompt and tool list
3. Retrieve relevant document chunks (RAG)
4. Inject chunks into prompt
5. LLM call → response (may include tool calls)
6. For each tool call: execute tool, append result, continue LLM call
7. Strip tool call tags from final response
8. Stream tokens to UI
9. Save conversation to Couchbase Lite

Steps 1–4 happen before the user sees any output. Steps 5–8 happen in parallel with streaming. Step 9 happens after the response is complete.

## 11. TensorFlow Lite, LiteRT, and MediaPipe: a lineage

Understanding why there are two different model formats (`.litertlm` and `.task`) and two different runtime APIs requires knowing a bit of history.

**TensorFlow Lite (2017).** Google's original on-device ML runtime. The goal was to run TensorFlow models on mobile hardware — Android phones, iOS devices, embedded systems — where a full TensorFlow installation was impractical. Models were compiled to a compact flatbuffer format (`.tflite`) and executed by a lightweight C++ interpreter. The runtime supported CPU inference from the start; GPU acceleration via delegate plugins came later.

TF Lite was tightly coupled to the TensorFlow ecosystem. You trained a model in TensorFlow, converted it to `.tflite` with a converter tool, and deployed it with the TF Lite runtime. This worked well for the models of the time — image classifiers, object detectors, keyword spotters — but the coupling became a liability as the ML landscape diversified.

**MediaPipe (2019).** A separate Google project, originally built for real-time video processing pipelines (hand tracking, face mesh, pose estimation). MediaPipe used TF Lite as its inference engine but added a higher-level abstraction: the Tasks API. Instead of loading a raw model and managing tensors manually, you called `HandLandmarker.detect(image)` and got back structured results.

MediaPipe introduced the `.task` bundle format: a zip archive containing the model weights, a metadata file describing the model's inputs and outputs, and any preprocessing/postprocessing code. The bundle is self-contained — you do not need to know the tensor layout to use it.

In 2023–2024, MediaPipe Tasks added support for generative AI models (LLMs) through the GenAI extension. This brought the same Tasks API pattern to text generation: load a `.task` bundle, call `generateResponse(prompt)`, get back text. Crucially, the GenAI extension runs in the browser via WebGPU or WebAssembly, making it the only option for browser-based LLM inference without a server.

**LiteRT (2023).** Google renamed TensorFlow Lite to LiteRT under the Google AI Edge umbrella. The rename signalled two things: independence from the TensorFlow training framework (you can now use models trained in JAX, PyTorch, or other frameworks), and a broader hardware target (CPU, GPU, NPU, DSP, with a unified delegate API).

The `.tflite` format was retained for compatibility. The runtime API changed minimally. The main practical difference for developers is that the package names changed (`org.tensorflow.lite` → `com.google.ai.edge.litert`) and the hardware acceleration story became more coherent.

**LiteRT-LM (2024).** A new layer on top of LiteRT, specifically designed for large language models. LiteRT-LM handles the LLM-specific concerns that the base runtime does not: KV-cache management, INT4 weight quantization, streaming token generation via callbacks, and multi-turn conversation state. It introduces the `.litertlm` format, which packages the quantized weights alongside the KV-cache configuration and sampling parameters.

LiteRT-LM is what powers Gemma on Android, iOS, and desktop (macOS, Linux). It is exposed to Rust through the `litert-lm-sys` FFI bindings and to application code through the `tauri-plugin-litert` Tauri plugin.

**How they relate today.**

```
                    Google AI Edge
                         │
          ┌──────────────┴──────────────┐
          │                             │
       LiteRT                      MediaPipe
   (native C++ runtime)        (pipeline framework)
          │                             │
     LiteRT-LM                  Tasks GenAI API
   (.litertlm format)           (.task format)
          │                             │
   Rust FFI → Tauri plugin      JavaScript → WebGPU/Wasm
   macOS, Linux, Android        Browser, Windows WebView
```

Both branches run the same Gemma weights. The split is about deployment target. The native path (LiteRT-LM) gives better performance and hardware acceleration but requires a compiled binary. The browser path (MediaPipe Tasks GenAI) runs anywhere a modern browser runs, including inside the Tauri WebView on Windows where no native LiteRT-LM DLL is available.

This is why the application has two model files for the same model: `gemma3-1b-it-int4.litertlm` for the native path and a `.task` bundle for the browser path. They contain the same weights in different containers.

## 12. Couchbase Lite: offline-first document storage

Couchbase Lite is an embedded NoSQL database designed for mobile and edge applications. "Embedded" means it runs in the same process as your application — there is no separate database server to install, configure, or connect to. The database is a set of files on the local filesystem.

**Document model.** Couchbase Lite stores JSON documents, each identified by a string key. A document is a flat or nested JSON object with no fixed schema. You can store any JSON-serialisable data: conversation history, document chunks, embedding vectors, user preferences. There are no tables, no columns, no migrations.

```json
{
  "_id": "conv_20240115_abc123",
  "title": "Discussion about RAG",
  "messages": [
    { "role": "user", "content": "What is RAG?" },
    { "role": "assistant", "content": "RAG stands for..." }
  ],
  "createdAt": "2024-01-15T10:30:00Z"
}
```

Documents are organised into collections (analogous to tables) within named scopes. The default scope and collection (`_default._default`) is always available. This application uses named collections: `_default.conversations`, `_default.chunks`, `_default.sources`.

**Blobs.** Binary data (images, audio, raw file content) is stored as blobs — separate from the document JSON but linked to it by a digest reference. Blobs are stored efficiently and can be streamed without loading the entire document. This application stores PDF content and embedding vectors as blobs.

**N1QL queries.** Couchbase Lite supports a SQL-like query language called N1QL (Non-first Normal Form Query Language). N1QL can query nested JSON fields, filter on array contents, and perform aggregations:

```sql
SELECT meta().id, title, createdAt
FROM _default.conversations
WHERE array_length(messages) > 0
ORDER BY createdAt DESC
LIMIT 20
```

N1QL also supports vector search via the `APPROX_VECTOR_DISTANCE` function, which performs approximate nearest-neighbour search on stored embedding vectors using an IVF (Inverted File Index) structure. This is what powers the semantic retrieval step in RAG.

**Sync.** Couchbase Lite can synchronise with Couchbase Server (the server-side database) through a component called Sync Gateway. Sync is bidirectional, conflict-aware, and works over HTTP. The application continues to function when the network is unavailable; changes are queued and synced when connectivity is restored.

Sync is entirely optional. This application does not configure sync by default — the database is purely local. If you want to add sync (for example, to share conversation history across devices), you add a replicator configuration pointing at a Sync Gateway endpoint. No other code changes are required.

**The JavaScript adapter.** Couchbase Lite also has a JavaScript SDK that runs in the browser. It implements the same API surface as the native plugin — `openDatabase`, `saveDocument`, `executeQuery`, `startReplication` — so the same application code works in both environments. The web adapter uses IndexedDB for local persistence and WebSockets for replication, giving the browser target the same offline-first semantics as the native target. This is how the `cblite-tauri-universal-app` reference project achieves a clean web/native split: the `@cblite` Vite alias points at the native plugin in the Tauri build and at the JS adapter in the web build, with no runtime branching in the shared application code.

**Why not SQLite?** SQLite is the obvious alternative for an embedded database. It is more widely known, has broader tooling support, and is already included in most operating systems. The reasons to choose Couchbase Lite for this application are:

1. **Native vector search.** SQLite does not have built-in vector search. You would need an extension (sqlite-vss, sqlite-vec) that adds complexity and a separate build dependency. Couchbase Lite's vector search is built in and integrated with the query language.
2. **JSON-native.** Storing LLM conversation history as JSON documents is natural in Couchbase Lite. In SQLite you would either use a JSON column (losing query capability) or normalise the data into relational tables (adding schema complexity).
3. **Sync.** If you ever need to sync data across devices or to a server, Couchbase Lite's sync protocol handles conflict resolution automatically. SQLite has no equivalent.
4. **Same API in the browser.** The JavaScript adapter means the web target gets real database semantics, not a localStorage shim. This is not possible with SQLite without a WASM port that lacks sync and vector search.

The tradeoff is that Couchbase Lite is a larger dependency (~15 MB native library) and less familiar to most developers.

## 13. Platform support and the isomorphic architecture

One of the less obvious design decisions in this application is that it runs in two fundamentally different environments — a native desktop binary and a plain web browser — using the same TypeScript codebase. Understanding why this is worth the complexity requires understanding what each environment can and cannot do.

**The native path.** When running as a Tauri desktop application, the app has access to the full native plugin stack: LiteRT-LM for inference (via a Rust FFI binding to the C library), Couchbase Lite for storage (via another Rust FFI binding), and the full filesystem and network APIs. Performance is as good as it gets on the device. The LLM runs at hardware speed with GPU acceleration where available.

**The browser path.** When running in a plain browser (or in the Tauri WebView on Windows, where no native LiteRT-LM DLL exists), the app falls back to browser-compatible alternatives: MediaPipe Tasks GenAI for inference (running the model in WebAssembly or WebGPU inside the browser sandbox), and a Couchbase Lite JavaScript adapter for persistence. Performance is lower — WebAssembly inference is roughly 3–5× slower than native — but the app is fully functional, including real database queries and replication.

**The platform matrix.** The combination of these two paths gives the following coverage:

| Platform | LLM runtime | Model format | Acceleration | Storage |
|---|---|---|---|---|
| macOS Apple Silicon | LiteRT-LM native | `.litertlm` | Metal GPU | Couchbase Lite (native) |
| macOS Intel | LiteRT-LM native | `.litertlm` | CPU | Couchbase Lite (native) |
| Linux x86\_64 | LiteRT-LM native | `.litertlm` | Vulkan / CPU | Couchbase Lite (native) |
| Linux aarch64 | LiteRT-LM native | `.litertlm` | CPU | Couchbase Lite (native) |
| Windows x86\_64 | MediaPipe WebGPU/Wasm | `.task` | WebGPU / Wasm | Couchbase Lite (native) |
| Android arm64 | LiteRT-LM native | `.litertlm` | GPU delegate | Couchbase Lite (native) |
| Browser (any OS) | MediaPipe WebGPU/Wasm | `.task` | WebGPU / Wasm | Couchbase Lite (JS) |

Windows uses the browser path for inference because Google has not shipped a `LiteRtLmC.dll` for Windows as of the time of writing. The Rust bindings compile — stub implementations satisfy the linker — but any call to the native inference functions panics at runtime. The application detects this at startup and falls back to MediaPipe. When Google ships a Windows DLL, the native path will activate automatically with no code changes.

**How the LLM fallback detection works.** The application tries to load the native LiteRT-LM model at startup. If the load succeeds, `activeLmModelId` is set and subsequent calls use the native path. If it fails (or if no model file is present), the app checks whether a MediaPipe model is available in the browser cache. The `getActiveBackend()` function encodes this priority:

```typescript
export function getActiveBackend(): LlmBackend {
  if (activeLmModelId) return "tauri";      // native LiteRT-LM
  if (webLlm)          return "mediapipe";  // WebGPU/Wasm
  if (apiConfig)       return "api";        // cloud API fallback
  return "mock";                            // echo for development
}
```

The `mock` backend simply echoes the last message back. It exists so that UI development can proceed without any model loaded.

**How the storage separation works: the Vite alias pattern.** The cleaner approach to web/native separation — used in the reference `cblite-tauri-universal-app` project — is to make the split entirely a build-time concern rather than a runtime branch. Both the Tauri app and the web app import from the same module alias:

```typescript
// identical in both tauri-app/src/main.ts and web-app/src/main.ts
import { openDatabase, saveDocument, executeQuery } from "@cblite";
```

The `@cblite` alias is resolved differently by each app's `vite.config.ts`:

```typescript
// tauri-cblite-example/vite.config.ts
"@cblite": "tauri-plugin-cblite/index.js"   // native Tauri plugin guest JS

// web-cblite-example/vite.config.ts
"@cblite": "../packages/cblite-adapter/src/web.ts"  // Couchbase Lite JS adapter
```

The web adapter (`web.ts`) is a full JavaScript implementation of the same `DatabaseAdapter` interface — not a localStorage shim, but a real Couchbase Lite JS SDK running in the browser, supporting N1QL queries, replication, blobs, and predictive models. The shared application logic never contains an `isTauri()` check; it simply calls `openDatabase()` and `saveDocument()` and the correct implementation is injected at build time.

This is a meaningful architectural improvement over runtime branching. The shared code has no knowledge of which platform it is running on. There is no risk of accidentally calling a Tauri-only API from a code path that also runs in the browser. The two implementations are kept in sync by the shared `DatabaseAdapter` TypeScript interface — if you add a method to the interface, both implementations must implement it or the build fails.

**Why this architecture is worth the complexity.** The isomorphic pattern pays for itself in several ways.

Development speed is the most immediate benefit. Iterating on the UI in a browser with Vite's hot-reload takes milliseconds. A Rust compile takes 10–30 seconds. Being able to develop and test the entire UI layer without touching Rust is a significant productivity gain.

Testability is the second benefit. The same test suite runs against both paths. A bug in the conversation history logic will surface in the browser tests, which run in CI without any native dependencies. Native-specific bugs (GPU acceleration, file I/O) are a smaller surface area that can be tested separately.

Graceful degradation is the third benefit. A user on an unsupported platform, or a user who has not yet downloaded a model, gets a working application rather than an error screen.

---

*This primer covers the concepts behind the workshop. The slides and the source code are the authoritative reference for implementation details.*

