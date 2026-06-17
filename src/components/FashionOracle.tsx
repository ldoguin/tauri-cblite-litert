import { useCallback, useEffect, useRef, useState } from "react";
import { type Product } from "../lib/types";
import { embed, cosineSimilarity } from "../lib/rag";
import {
  searchProducts,
  listProductsWithImageEmbeddings,
  listProductsWithEmbeddings,
  getProductImage,
} from "../lib/db";
import { useVoiceInput } from "../hooks/useVoiceInput";

// ── Types ─────────────────────────────────────────────────────────────────────

type OracleState = "idle" | "listening" | "thinking" | "results" | "error";

interface Props {
  onBack: () => void;
  onDescribeImage?: (dataUrl: string) => Promise<string>;
  onAnalyze?: (userText: string, systemPrompt: string) => Promise<string>;
  embedModelId?: string;
  whisperModelId?: string;
}

// ── Agent system prompt ───────────────────────────────────────────────────────

const AGENT_SYSTEM = `You are a fashion product search classifier. Given an item description, output search parameters.
Reply with ONLY valid JSON on one line, no explanation:
{"category":"Footwear","gender":"All","color":"white","keywords":"sneakers running"}
category must be exactly one of: Tops, Bottoms, Dresses, Outerwear, Activewear, Formal, Footwear, All
gender must be exactly one of: Men, Women, Kids, All. Use All unless the description clearly targets a specific gender.
color: single dominant color (e.g. black, white, red, blue, green, beige, grey, brown, pink, yellow, orange, purple, multicolor). Empty string if unclear.
keywords: 2-4 key descriptive words for text search, do NOT repeat the color here`;

const CATEGORIES = ["All", "Tops", "Bottoms", "Dresses", "Outerwear", "Activewear", "Formal", "Footwear"];
const GENDERS    = ["All", "Men", "Women", "Kids"];

// ── Product card in carousel ──────────────────────────────────────────────────

function OracleCard({ product }: { product: Product }) {
  const [src, setSrc] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getProductImage(product.id).then((s) => { if (s && !cancelled) setSrc(s); }).catch(() => {});
    return () => { cancelled = true; };
  }, [product.id]);

  return (
    <div className="oracle-card">
      <div className="oracle-card-img">
        {src ? (
          <img
            src={src}
            alt={product.name}
            className={loaded ? "loaded" : ""}
            onLoad={() => setLoaded(true)}
          />
        ) : (
          <span className="oracle-card-placeholder">—</span>
        )}
        <span className="oracle-card-tag">{product.category}</span>
      </div>
      <div className="oracle-card-info">
        <p className="oracle-card-name">{product.name}</p>
        {product.price != null && (
          <p className="oracle-card-price">${product.price.toFixed(2)}</p>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function FashionOracle({ onBack, onDescribeImage, onAnalyze, embedModelId, whisperModelId }: Props) {
  const [state, setState] = useState<OracleState>("idle");
  const [statusText, setStatusText] = useState("Ready");
  const [results, setResults] = useState<Product[]>([]);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const cameraRef  = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const carouselRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef(false);

  const runSearch = useCallback(async (desc: string) => {
    abortRef.current = false;
    setState("thinking");
    setStatusText("Analyzing…");

    let category = "All";
    let gender   = "All";
    let keywords = desc;

    if (onAnalyze) {
      try {
        setStatusText("Curating…");
        const raw = await onAnalyze(`Fashion item description: "${desc}"`, AGENT_SYSTEM);
        const m = raw.match(/\{[^}]*\}/s);
        if (m) {
          const p = JSON.parse(m[0]) as { category?: string; gender?: string; color?: string; keywords?: string };
          if (p.category && CATEGORIES.includes(p.category)) category = p.category;
          if (p.gender   && GENDERS.includes(p.gender))       gender   = p.gender;
          const color = p.color?.trim() ?? "";
          keywords = [color, p.keywords].filter(Boolean).join(" ").trim() || desc;
        }
      } catch { /* fallback to full desc */ }
    }

    if (abortRef.current) return;
    setStatusText("Searching…");

    try {
      const [queryVec, imageEmbedded] = await Promise.all([
        embed(desc, embedModelId),
        listProductsWithImageEmbeddings(),
      ]);

      if (abortRef.current) return;

      const pool = imageEmbedded.length > 0 ? imageEmbedded : await listProductsWithEmbeddings();
      const getVec = (p: Product) => (imageEmbedded.length > 0 ? p.imageEmbedding! : p.embedding!);

      const filterGender = (ps: Product[]) =>
        gender === "All" ? ps : ps.filter((p) => {
          const g = p.gender ?? "Unisex";
          return g === gender || g === "Unisex";
        });

      const [catVec, fts, broadVec] = await Promise.allSettled([
        Promise.resolve(
          filterGender(category === "All" ? pool : pool.filter((p) => p.category === category))
            .map((p) => ({ p, score: cosineSimilarity(queryVec, getVec(p)) }))
            .sort((a, b) => b.score - a.score).slice(0, 12).map((r) => r.p)
        ),
        searchProducts(keywords, category).then(filterGender),
        Promise.resolve(
          filterGender(pool)
            .map((p) => ({ p, score: cosineSimilarity(queryVec, getVec(p)) }))
            .sort((a, b) => b.score - a.score).slice(0, 20).map((r) => r.p)
        ),
      ]);

      if (abortRef.current) return;

      const seen = new Set<string>();
      const merged: Product[] = [];
      for (const r of [catVec, fts, broadVec]) {
        for (const p of r.status === "fulfilled" ? r.value : []) {
          if (!seen.has(p.id)) { seen.add(p.id); merged.push(p); }
        }
      }

      setResults(merged.slice(0, 30));
      setState("results");
      setStatusText(`${merged.length} pieces found`);
      setTimeout(() => carouselRef.current?.scrollTo({ left: 0, behavior: "smooth" }), 100);
    } catch {
      setState("error");
      setStatusText("Something went wrong");
    }
  }, [onAnalyze, embedModelId]);

  const handleImage = useCallback(async (file: File) => {
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const dataUrl = ev.target?.result as string;
      setImageDataUrl(dataUrl);
      setState("thinking");
      setStatusText("Reading image…");
      try {
        if (!onDescribeImage) throw new Error("no model");
        const desc = await onDescribeImage(dataUrl);
        setStatusText("Image analyzed");
        await runSearch(desc);
      } catch {
        setState("error");
        setStatusText("Could not read image");
      }
    };
    reader.readAsDataURL(file);
  }, [onDescribeImage, runSearch]);

  const voice = useVoiceInput({
    onResult: useCallback((text: string) => {
      setState("thinking");
      setStatusText("Processing…");
      runSearch(text);
    }, [runSearch]),
    onError: useCallback(() => {
      setState("error");
      setStatusText("Voice unavailable");
    }, []),
    whisperModelId,
  });

  // update status text while recording/processing
  useEffect(() => {
    if (voice.state === "recording")   setStatusText("Listening…");
    if (voice.state === "processing")  setStatusText("Transcribing…");
  }, [voice.state]);

  const reset = () => {
    abortRef.current = true;
    setState("idle");
    setStatusText("Ready");
    setResults([]);
    setImageDataUrl(null);
  };

  const isActive = state !== "idle" && state !== "error";

  return (
    <div className="oracle-screen">
      {/* Header */}
      <header className="oracle-header">
        <button className="oracle-back" onClick={onBack}>← Back</button>
        <span className="oracle-title">The Oracle</span>
        {state !== "idle" && (
          <button className="oracle-back" onClick={reset}>Clear</button>
        )}
      </header>

      {/* AI orb */}
      <div className={`oracle-orb-wrap ${isActive ? "active" : ""} ${voice.state === "recording" ? "recording" : ""}`}>
        <div className="oracle-orb">
          {imageDataUrl && state !== "idle" ? (
            <img src={imageDataUrl} alt="" className="oracle-orb-img" />
          ) : (
            <div className="oracle-orb-core" />
          )}
        </div>
        <div className="oracle-orb-ring r1" />
        <div className="oracle-orb-ring r2" />
        <div className="oracle-orb-ring r3" />
      </div>

      {/* Status */}
      <p className="oracle-status">{statusText}</p>

      {/* Controls */}
      {(state === "idle" || state === "error") && (
        <div className="oracle-controls">
          <button
            className={`oracle-btn oracle-btn-voice ${voice.state === "recording" ? "recording" : ""}`}
            onPointerDown={(e) => { e.preventDefault(); setState("listening"); voice.start(); }}
            onPointerUp={() => voice.stop()}
            onPointerLeave={() => { if (voice.state === "recording") voice.stop(); }}
          >
            <span className="oracle-btn-icon">
              {voice.state === "processing" ? <span className="oracle-spinner" /> : "◉"}
            </span>
            <span className="oracle-btn-label">Voice</span>
          </button>

          <button className="oracle-btn oracle-btn-scan" onClick={() => cameraRef.current?.click()}>
            <span className="oracle-btn-icon">⊡</span>
            <span className="oracle-btn-label">Camera</span>
          </button>

          <button className="oracle-btn oracle-btn-scan" onClick={() => galleryRef.current?.click()}>
            <span className="oracle-btn-icon">⊞</span>
            <span className="oracle-btn-label">Gallery</span>
          </button>
        </div>
      )}

      {state === "thinking" && (
        <div className="oracle-thinking">
          <span className="oracle-spinner" />
        </div>
      )}

      {/* Carousel */}
      {state === "results" && results.length > 0 && (
        <div className="oracle-carousel-wrap">
          <div className="oracle-carousel" ref={carouselRef}>
            {results.map((p) => <OracleCard key={p.id} product={p} />)}
          </div>
          <button className="oracle-again" onClick={reset}>New search</button>
        </div>
      )}

      {/* Hidden file inputs */}
      <input ref={cameraRef}  type="file" accept="image/*" capture="environment"
        style={{ display: "none" }} onChange={(e) => e.target.files?.[0] && handleImage(e.target.files[0])} />
      <input ref={galleryRef} type="file" accept="image/*"
        style={{ display: "none" }} onChange={(e) => e.target.files?.[0] && handleImage(e.target.files[0])} />
    </div>
  );
}
