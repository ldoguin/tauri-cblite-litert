import { useState, useEffect, useRef, useCallback } from "react";
import type { Product } from "../lib/types";
import { searchProducts, listProductsWithEmbeddings, listProductsWithImageEmbeddings, listProductsNeedingImageEmbedding, saveProduct, saveProductImageEmbedding, getProductImage, resetProductCatalog, exportProductEmbeddings, inferGender, dispatchDbProgress } from "../lib/db";
import { embed, cosineSimilarity } from "../lib/rag";
import { useVoiceInput } from "../hooks/useVoiceInput";
import { DB_PROGRESS_EVENT } from "../lib/db";

interface Props {
  onBack: () => void;
  /** Optional: ask the LLM to describe an uploaded image. Returns a text description. */
  onDescribeImage?: (dataUrl: string) => Promise<string>;
  /** Optional: call the LLM with text (no image). Used by the search agent. */
  onAnalyze?: (userText: string, systemPrompt: string) => Promise<string>;
  /** Model ID to use for embedding; leave undefined to use the current active backend */
  embedModelId?: string;
  /** Whisper model ID for voice input; leave undefined for default (whisper-tiny.en) */
  whisperModelId?: string;
}

type SearchMode = "text" | "image";

const CATEGORIES = ["All", "Tops", "Bottoms", "Dresses", "Outerwear", "Activewear", "Formal", "Footwear"];
const GENDERS = ["All", "Men", "Women", "Kids"];

const AGENT_SYSTEM = `You are a fashion product search classifier. Given an item description, output search parameters.
Reply with ONLY valid JSON on one line, no explanation:
{"category":"Footwear","gender":"All","color":"white","keywords":"sneakers running"}
category must be exactly one of: Tops, Bottoms, Dresses, Outerwear, Activewear, Formal, Footwear, All
gender must be exactly one of: Men, Women, Kids, All. Use All unless the description clearly targets a specific gender.
color: single dominant color (e.g. black, white, red, blue, green, beige, grey, brown, pink, yellow, orange, purple, multicolor). Empty string if unclear.
keywords: 2-4 key descriptive words for text search, do NOT repeat the color here`;

export function RetailScreen({ onBack, onDescribeImage, onAnalyze, embedModelId, whisperModelId }: Props) {
  const [results, setResults] = useState<Product[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [gender, setGender] = useState("All");
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [searchMode, setSearchMode] = useState<SearchMode>("text");
  const [loading, setLoading] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<string>("");
  const [resetting, setResetting] = useState(false);
  const [embeddingImages, setEmbeddingImages] = useState(false);
  const [exportingEmbeddings, setExportingEmbeddings] = useState(false);
  const abortImageEmbedRef = useRef(false);
  const cameraInputRef  = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);

  // Track the latest search to abort stale background re-ranks
  const searchIdRef = useRef(0);
  // Refs for latest category/gender — avoids stale closures in voice/agent callbacks
  const categoryRef = useRef(category);
  const genderRef = useRef(gender);
  useEffect(() => { categoryRef.current = category; }, [category]);
  useEffect(() => { genderRef.current = gender; }, [gender]);

  // Filter products by gender using the stored field (if available) or inferring from text
  const filterByGender = useCallback((products: Product[], g: string): Product[] => {
    if (g === "All") return products;
    return products.filter((p) => {
      const pg = p.gender ?? inferGender(p.name, p.description);
      if (g === "Kids") return pg === "Kids";
      if (g === "Men")  return pg === "Men";
      if (g === "Women") return pg === "Women";
      return true;
    });
  }, []);

  /**
   * Core search function.
   *
   * Empty query: browse mode — show all products, no ranking.
   *
   * Non-empty query:
   * 1. FTS (MATCH) for immediate display while embedding runs.
   * 2. If text embeddings exist: vector search over ALL embedded products, sorted by
   *    cosine similarity. FTS-only candidates (not yet embedded) appended at the bottom.
   * 3. Back-fill: embed any FTS candidates that are missing vectors and persist them.
   */
  const runSearch = useCallback(async (searchQuery: string, cat: string) => {
    const searchId = ++searchIdRef.current;
    setLoading(true);

    try {
      const g = genderRef.current;

      // Empty query → browse mode
      if (!searchQuery.trim()) {
        const all = filterByGender(await searchProducts("", cat), g);
        if (searchId === searchIdRef.current) setResults(all);
        return;
      }

      // Step 1: FTS for fast initial results
      const ftsCandidates = filterByGender(await searchProducts(searchQuery, cat), g);
      if (searchId !== searchIdRef.current) return;
      setResults(ftsCandidates);

      // Step 2: Vector search over all embedded products
      const queryVec = await embed(searchQuery, embedModelId);
      if (searchId !== searchIdRef.current) return;

      const allEmbedded = await listProductsWithEmbeddings();
      if (searchId !== searchIdRef.current) return;

      if (allEmbedded.length > 0) {
        const pool = filterByGender(
          cat === "All" ? allEmbedded : allEmbedded.filter((p) => p.category === cat),
          g,
        );
        const ranked = pool
          .map((p) => ({ p, score: cosineSimilarity(queryVec, p.embedding!) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 30)
          .map((r) => r.p);

        // Append FTS-only products (not yet embedded) so they're still visible
        const rankedIds = new Set(ranked.map((p) => p.id));
        const ftsOnly = ftsCandidates.filter((p) => !rankedIds.has(p.id) && !p.embedding?.length);

        if (searchId !== searchIdRef.current) return;
        setResults([...ranked, ...ftsOnly]);

        // Step 3: Back-fill embeddings for FTS-only candidates (fire-and-forget)
        for (const p of ftsOnly) {
          embed(`${p.name} ${p.description} ${p.category}`, embedModelId)
            .then((vec) => saveProduct({ ...p, embedding: vec }))
            .catch(() => {});
        }
      } else {
        // No embeddings yet — keep FTS results, back-fill incrementally
        for (const p of ftsCandidates.filter((p) => !p.embedding?.length)) {
          if (searchId !== searchIdRef.current) break;
          try {
            const vec = await embed(`${p.name} ${p.description} ${p.category}`, embedModelId);
            saveProduct({ ...p, embedding: vec }).catch(() => {});
          } catch { /* skip */ }
        }
      }
    } catch { /* keep whatever was last rendered */ }
    finally {
      if (searchId === searchIdRef.current) setLoading(false);
    }
  }, [embedModelId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load all products on mount — placed after runSearch declaration to avoid forward reference.
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(() => { runSearch("", "All"); }, []);

  // Stable ref so the voice callback always calls the latest runSearch
  const runSearchRef = useRef(runSearch);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { runSearchRef.current = runSearch; }, [runSearch]);

  // Stable ref for the agent — populated after runSearchAgent is defined below
  const runSearchAgentRef = useRef<((desc: string) => Promise<void>) | null>(null);

  // Show DB progress events (migration / seed) inside the retail screen
  const [dbMsg, setDbMsg] = useState<string | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const msg = (e as CustomEvent<{ message: string }>).detail.message;
      setDbMsg(msg);
      if (msg.startsWith("Product catalog ready") || msg.startsWith("Cleared")) {
        runSearch("", categoryRef.current);
      }
    };
    window.addEventListener(DB_PROGRESS_EVENT, handler);
    return () => window.removeEventListener(DB_PROGRESS_EVENT, handler);
  }, []);

  const voice = useVoiceInput({
    onResult: useCallback((text: string) => {
      setQuery(text);
      setVoiceError(null);
      if (runSearchAgentRef.current) {
        runSearchAgentRef.current(text);
      } else {
        runSearchRef.current(text, categoryRef.current);
      }
    }, []),
    onError: useCallback((msg: string) => setVoiceError(msg), []),
    whisperModelId,
  });

  const handleSearch = useCallback(() => {
    if (runSearchAgentRef.current) {
      runSearchAgentRef.current(query);
    } else {
      runSearch(query, category);
    }
  }, [query, category, runSearch]);

  const handleCategoryChange = useCallback((cat: string) => {
    setCategory(cat);
    runSearch(query, cat);
  }, [query, runSearch]);

  const handleImageUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const dataUrl = ev.target?.result as string;
      setImageDataUrl(dataUrl);
      setSearchMode("image");
      if (!onDescribeImage) return;
      setDescribing(true);
      try {
        const desc = await onDescribeImage(dataUrl);
        setQuery(desc);
        setSearchMode("text");
        // Use the stable ref so this callback doesn't need runSearchAgent in scope.
        await runSearchAgentRef.current?.(desc);
      } catch {
        // leave image shown — user can tap "Re-describe" to retry
      } finally {
        setDescribing(false);
      }
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }, [onDescribeImage]);

  /**
   * Search agent: given an image description, uses the LLM to extract the product
   * category and keywords, then runs three searches in parallel and merges them:
   *   1. Category-filtered vector search  (highest priority — right category, right semantics)
   *   2. FTS with extracted keywords       (keyword matches within detected category)
   *   3. Broad vector search              (semantic fallback across all categories)
   *
   * Results are deduplicated: category-vector wins ties, FTS fills gaps, broad fills the rest.
   */
  const runSearchAgent = useCallback(async (desc: string) => {
    const searchId = ++searchIdRef.current;
    setLoading(true);

    // Step 1: classify with LLM
    let detectedCategory = "All";
    let detectedGender = "All";
    let keywords = desc;
    if (onAnalyze) {
      try {
        setAgentStatus("Classifying query…");
        const raw = await onAnalyze(`Fashion item description: "${desc}"`, AGENT_SYSTEM);
        const m = raw.match(/\{[^}]*\}/s);
        if (m) {
          const parsed = JSON.parse(m[0]) as { category?: string; gender?: string; color?: string; keywords?: string };
          if (parsed.category && CATEGORIES.includes(parsed.category)) {
            detectedCategory = parsed.category;
          }
          if (parsed.gender && GENDERS.includes(parsed.gender)) {
            detectedGender = parsed.gender;
          }
          const color = parsed.color?.trim() ?? "";
          keywords = [color, parsed.keywords].filter(Boolean).join(" ").trim() || desc;
        }
        setAgentStatus(`Searching ${detectedCategory !== "All" ? detectedCategory : "all categories"}…`);
      } catch { /* use full description as fallback */ }
    }

    if (searchId !== searchIdRef.current) return;

    // Update filter chips so the user sees what the agent detected
    if (detectedCategory !== "All") { setCategory(detectedCategory); categoryRef.current = detectedCategory; }
    if (detectedGender   !== "All") { setGender(detectedGender);     genderRef.current   = detectedGender; }

    try {
      // Step 2: embed description + load all products with embeddings (once)
      const [queryVec, imageEmbedded] = await Promise.all([
        embed(desc, embedModelId),
        listProductsWithImageEmbeddings(),
      ]);
      if (searchId !== searchIdRef.current) return;

      const embedded = imageEmbedded.length > 0 ? imageEmbedded : await listProductsWithEmbeddings();
      const getVec = (p: Product) => (imageEmbedded.length > 0 ? p.imageEmbedding! : p.embedding!);

      if (searchId !== searchIdRef.current) return;

      // Step 3: three searches in parallel
      const applyFilters = (products: Product[]) =>
        filterByGender(
          detectedCategory === "All" ? products : products.filter((p) => p.category === detectedCategory),
          detectedGender,
        );

      const [catVecResult, ftsResult, broadVecResult] = await Promise.allSettled([
        // 1. category + gender filtered vector search
        Promise.resolve(
          applyFilters(embedded)
            .map((p) => ({ p, score: cosineSimilarity(queryVec, getVec(p)) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 20)
            .map((r) => r.p),
        ),
        // 2. FTS with extracted keywords in the detected category, then gender-filtered in JS
        searchProducts(keywords, detectedCategory).then((r) => filterByGender(r, detectedGender)),
        // 3. broad vector across all categories, gender-filtered
        Promise.resolve(
          filterByGender(embedded, detectedGender)
            .map((p) => ({ p, score: cosineSimilarity(queryVec, getVec(p)) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 30)
            .map((r) => r.p),
        ),
      ]);

      if (searchId !== searchIdRef.current) return;

      // Step 4: merge — priority: category-vector > FTS > broad-vector
      const seen = new Set<string>();
      const merged: Product[] = [];
      for (const result of [catVecResult, ftsResult, broadVecResult]) {
        for (const p of result.status === "fulfilled" ? result.value : []) {
          if (!seen.has(p.id)) { seen.add(p.id); merged.push(p); }
        }
      }

      setResults(merged);
      setAgentStatus("");
    } catch {
      setAgentStatus("");
      runSearchRef.current(desc, detectedCategory);
    } finally {
      if (searchId === searchIdRef.current) setLoading(false);
    }
  }, [onAnalyze, embedModelId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep agent ref current so the voice callback (defined earlier) always calls the latest version
  useEffect(() => { runSearchAgentRef.current = runSearchAgent; }, [runSearchAgent]);

  const handleDescribeImage = useCallback(async () => {
    if (!imageDataUrl || !onDescribeImage) return;
    setDescribing(true);
    try {
      const desc = await onDescribeImage(imageDataUrl);
      setQuery(desc);
      setSearchMode("text");
      await runSearchAgent(desc);
    } catch {
      // ignore
    } finally {
      setDescribing(false);
    }
  }, [imageDataUrl, onDescribeImage, runSearchAgent]);

  const clearImage = useCallback(() => {
    setImageDataUrl(null);
    setSearchMode("text");
  }, []);

  /**
   * Bulk image embedding job.
   * For each product with a thumb and no imageEmbedding:
   *   1. Send the thumbnail to the LLM for a short description.
   *   2. Embed the description with BERT.
   *   3. Persist imageEmbedding on the product doc.
   * Runs sequentially (Gemma is single-session). Can be aborted.
   */
  const handleEmbedImages = useCallback(async () => {
    if (!onDescribeImage) return;
    abortImageEmbedRef.current = false;
    setEmbeddingImages(true);
    try {
      const products = await listProductsNeedingImageEmbedding();
      const total = products.length;
      if (total === 0) {
        dispatchDbProgress("All product images already embedded");
        return;
      }
      dispatchDbProgress(`Image embedding: 0/${total}`);
      let done = 0;
      for (const p of products) {
        if (abortImageEmbedRef.current) {
          dispatchDbProgress(`Image embedding stopped: ${done}/${total}`);
          break;
        }
        try {
          const dataUrl = await getProductImage(p.id);
          if (!dataUrl) continue;
          const desc = await onDescribeImage(dataUrl);
          const vec = await embed(desc, embedModelId);
          await saveProductImageEmbedding(p.id, vec, desc);
          done++;
          dispatchDbProgress(`Image embedding: ${done}/${total}`);
        } catch {
          // skip product on error; continue to next
        }
      }
      if (!abortImageEmbedRef.current) dispatchDbProgress(`Image embedding complete: ${done}/${total}`);
    } finally {
      setEmbeddingImages(false);
    }
  }, [onDescribeImage, embedModelId]); // eslint-disable-line react-hooks/exhaustive-deps

  const [gridEl, setGridEl] = useState<HTMLDivElement | null>(null);

  return (
    <div className="retail-screen">
      <header className="retail-header">
        <button className="retail-back-btn" onClick={onBack} aria-label="Back to home">
          ←
        </button>
        <h1 className="retail-title">Fashion Shop</h1>
        {onDescribeImage && (
          <button
            className="retail-reset-btn"
            disabled={embeddingImages}
            onClick={() => {
              if (embeddingImages) {
                abortImageEmbedRef.current = true;
              } else {
                handleEmbedImages();
              }
            }}
            title={embeddingImages ? "Stop image embedding" : "Generate image embeddings for all products"}
          >
            {embeddingImages ? "⏹" : "⊛"}
          </button>
        )}
        <button
          className="retail-reset-btn"
          disabled={exportingEmbeddings}
          onClick={async () => {
            setExportingEmbeddings(true);
            try {
              const n = await exportProductEmbeddings();
              dispatchDbProgress(`Exported ${n} product embeddings`);
            } catch (e) {
              dispatchDbProgress(`Export failed: ${String(e)}`);
            } finally {
              setExportingEmbeddings(false);
            }
          }}
          title="Export embeddings to embeddings.json"
        >
          {exportingEmbeddings ? "…" : "⬇"}
        </button>
        <button
          className="retail-reset-btn"
          disabled={resetting}
          onClick={() => {
            setResetting(true);
            setDbMsg(null);
            resetProductCatalog().finally(() => setResetting(false));
          }}
          title="Reset product catalog"
        >
          {resetting ? "…" : "↺"}
        </button>
      </header>
      {dbMsg && (
        <div className="retail-db-msg">{dbMsg}</div>
      )}

      <div className="retail-search-bar">
        {imageDataUrl && (
          <div className="retail-image-preview">
            <img src={imageDataUrl} alt="Search by image" className="retail-image-thumb" />
            <button className="retail-image-clear" onClick={clearImage} aria-label="Clear image">✕</button>
            {onDescribeImage && (
              <button
                className="retail-describe-btn"
                onClick={handleDescribeImage}
                disabled={describing}
              >
                {describing ? "Searching…" : "Re-describe"}
              </button>
            )}
          </div>
        )}
        <div className="retail-search-row">
          <input
            className="retail-search-input"
            type="text"
            placeholder={
              voice.state === "recording"  ? "Listening…" :
              voice.state === "processing" ? "Transcribing…" :
              describing                   ? "Describing image…" :
              searchMode === "image"       ? "Or type a description…" :
              "Search by description…"
            }
            value={voice.state === "recording" ? voice.transcript : query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
            readOnly={voice.state !== "idle"}
          />
          <button
            className={`retail-mic-btn ${voice.state !== "idle" ? "active" : ""}`}
            onPointerDown={(e) => { e.preventDefault(); voice.start(); }}
            onPointerUp={() => voice.stop()}
            onPointerLeave={() => { if (voice.state === "recording") voice.stop(); }}
            title="Hold to speak"
            aria-label="Push to talk"
          >
            {voice.state === "processing" ? <span className="spinner-sm" /> : "🎤"}
          </button>
          <button
            className="retail-image-btn"
            onClick={() => cameraInputRef.current?.click()}
            title="Take a photo to search"
            aria-label="Take photo to search"
          >
            📷
          </button>
          <button
            className="retail-image-btn"
            onClick={() => galleryInputRef.current?.click()}
            title="Pick from gallery to search"
            aria-label="Pick image from gallery"
          >
            🖼️
          </button>
          <button
            className="retail-search-btn"
            onClick={handleSearch}
            disabled={loading || voice.state !== "idle"}
          >
            {loading ? "…" : "Search"}
          </button>
        </div>
        {agentStatus && (
          <div className="retail-agent-status">
            <span className="spinner-sm" />
            {agentStatus}
          </div>
        )}
        {voiceError && (
          <div className="retail-voice-error">
            {voiceError}
            <button onClick={() => setVoiceError(null)} aria-label="Dismiss">✕</button>
          </div>
        )}
        {/* Camera: opens rear camera directly */}
        <input ref={cameraInputRef}  type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={handleImageUpload} />
        {/* Gallery: opens file picker so the user can choose an existing image */}
        <input ref={galleryInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleImageUpload} />
      </div>

      <div className="retail-categories">
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            className={`retail-category-pill ${category === cat ? "active" : ""}`}
            onClick={() => handleCategoryChange(cat)}
          >
            {cat}
          </button>
        ))}
      </div>
      <div className="retail-categories">
        {GENDERS.map((g) => (
          <button
            key={g}
            className={`retail-category-pill ${gender === g ? "active" : ""}`}
            onClick={() => {
              setGender(g);
              genderRef.current = g;
              runSearch(query, categoryRef.current);
            }}
          >
            {g}
          </button>
        ))}
      </div>

      <div className="retail-grid" ref={setGridEl}>
        {results.length === 0 && !loading && (
          <p className="retail-empty">No products found. Try a different search.</p>
        )}
        {results.map((product) => (
          <ProductCard key={product.id} product={product} gridEl={gridEl} />
        ))}
      </div>
    </div>
  );
}

function ProductCard({ product, gridEl }: { product: Product; gridEl?: HTMLElement | null }) {
  const [fullSrc, setFullSrc] = useState<string | null>(null);
  const [fullLoaded, setFullLoaded] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!product.id) return;
    let cancelled = false;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        if (cancelled) return;
        getProductImage(product.id)
          .then((src) => { if (src && !cancelled) setFullSrc(src); })
          .catch(() => {});
      },
      { root: gridEl ?? null, rootMargin: "200px" },
    );
    if (cardRef.current) observer.observe(cardRef.current);
    return () => { cancelled = true; observer.disconnect(); };
  }, [product.id, gridEl]);

  return (
    <>
      <div className="product-card" ref={cardRef} onClick={() => setShowModal(true)}>
        <div className="product-image-wrap">
          {/* Layer 1 — 32×32 thumb: immediate blurry placeholder */}
          {product.thumb && (
            <img
              src={product.thumb}
              aria-hidden
              className={`product-image product-thumb${fullLoaded ? " product-thumb--out" : ""}`}
            />
          )}
          {/* Layer 2 — full blob image: fades in over the thumb */}
          {fullSrc && (
            <img
              src={fullSrc}
              alt={product.name}
              className={`product-image product-full${fullLoaded ? " product-full--in" : ""}`}
              onLoad={() => setFullLoaded(true)}
            />
          )}
          {/* Fallback when no thumb and no full image yet */}
          {!product.thumb && !fullSrc && (
            <div className="product-image-placeholder"><span>👗</span></div>
          )}
          <span className="product-category-tag">{product.category}</span>
        </div>
        <div className="product-info">
          <h3 className="product-name">{product.name}</h3>
          <p className="product-desc">{product.description}</p>
          {product.price != null && (
            <span className="product-price">${product.price.toFixed(2)}</span>
          )}
        </div>
      </div>

      {showModal && (
        <ProductModal
          product={product}
          imageSrc={fullSrc ?? product.thumb ?? null}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  );
}

function ProductModal({
  product,
  imageSrc,
  onClose,
}: {
  product: Product;
  imageSrc: string | null;
  onClose: () => void;
}) {
  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="panel-overlay product-modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="panel product-modal">
        <div className="panel-header">
          <h2 className="product-modal-title">{product.name}</h2>
          <button className="panel-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="product-modal-body">
          <div className="product-modal-image-wrap">
            {imageSrc ? (
              <img src={imageSrc} alt={product.name} className="product-modal-image" />
            ) : (
              <div className="product-modal-image-placeholder">👗</div>
            )}
          </div>

          <div className="product-modal-details">
            <div className="product-modal-row">
              <span className="product-modal-label">Category</span>
              <span className="product-category-tag">{product.category}</span>
            </div>

            {product.price != null && (
              <div className="product-modal-row">
                <span className="product-modal-label">Price</span>
                <span className="product-modal-price">${product.price.toFixed(2)}</span>
              </div>
            )}

            <div className="product-modal-row product-modal-desc-row">
              <span className="product-modal-label">Description</span>
              <p className="product-modal-desc">{product.description}</p>
            </div>

            {product.createdAt && (
              <div className="product-modal-row">
                <span className="product-modal-label">Added</span>
                <span className="product-modal-meta">
                  {new Date(product.createdAt).toLocaleDateString()}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
