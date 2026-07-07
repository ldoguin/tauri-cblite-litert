import { useEffect, useRef, useState, useCallback } from "react";
import {
  getCachedModels,
  syncCacheRegistry,
  downloadModel,
  cancelDownload,
  deleteModel,
  totalCachedBytes,
  formatBytes,
  isDownloading,
  MODEL_CATALOGUE,
  type CachedModel,
  type DownloadProgress,
  type ModelKind,
} from "../lib/modelCache";
import { isTauri } from "../lib/llm";

// ── RAM badge ─────────────────────────────────────────────────────────────────

interface MemInfo { totalBytes: number; availableBytes: number; }

/** Estimated RAM a model needs at runtime: weights (≈ file size, mmap'd) +
 *  ~30 % headroom for KV cache at typical context lengths and activations. */
function ramEstimate(sizeBytes: number): number {
  return Math.round(sizeBytes * 1.3);
}

function RamBadge({ sizeBytes, mem }: { sizeBytes: number; mem: MemInfo | null }) {
  const needed = ramEstimate(sizeBytes);
  const label = `~${formatBytes(needed)} RAM`;
  if (!mem) {
    return <span className="ram-badge ram-neutral" title="Device RAM unavailable">{label}</span>;
  }
  const { availableBytes, totalBytes } = mem;
  const cls =
    availableBytes >= needed * 1.5 ? "ram-ok"
    : availableBytes >= needed     ? "ram-warn"
    :                                "ram-err";
  const tip = `${formatBytes(availableBytes)} free · ${formatBytes(totalBytes)} total`;
  return <span className={`ram-badge ${cls}`} title={tip}>{label}</span>;
}

interface Props {
  /** Currently active LLM model id (from useChat) */
  activeLlmId?: string;
  /** Currently active embed model id (from useChat) */
  activeEmbedId?: string;
  onLoadLlm: (url: string, modelId: string, onProgress?: (pct: number) => void) => Promise<void>;
  onLoadEmbed: (url: string, modelId: string) => Promise<void>;
  onClose: () => void;
  /** HuggingFace access token — passed to download requests for gated/rate-limited repos. */
  hfToken?: string;
}

const KIND_LABELS: Record<ModelKind, string> = {
  llm: "Language Models",
  embed: "Embedding Models",
  whisper: "Whisper (ASR)",
};

const KIND_ORDER: ModelKind[] = ["llm", "embed", "whisper"];

export function ModelManagerPanel({
  activeLlmId,
  activeEmbedId,
  onLoadLlm,
  onLoadEmbed,
  onClose,
  hfToken,
}: Props) {
  const [models, setModels] = useState<CachedModel[]>(() => getCachedModels());
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  // Progress (0–100) for WASM model loads (fetch + engine init in worker)
  const [wasmProgress, setWasmProgress] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [memInfo, setMemInfo] = useState<MemInfo | null>(null);

  const isMountedRef = useRef(false);
  // Track active download IDs so they can be cancelled when the panel unmounts,
  // preventing onProgress callbacks from firing on an unmounted component.
  const activeDownloadIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      activeDownloadIdsRef.current.forEach((id) => cancelDownload(id));
      activeDownloadIdsRef.current.clear();
    };
  }, []);

  // Sync cache state on mount
  useEffect(() => {
    syncCacheRegistry().then((m) => { if (isMountedRef.current) setModels(m); }).catch(() => {});
  }, []);

  // Fetch device RAM once — used to colour-code the RAM badge on each model card.
  useEffect(() => {
    if (!isTauri()) return;
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<MemInfo | null>("get_memory_info"))
      .then((info) => { if (info) setMemInfo(info); })
      .catch(() => {});
  }, []);

  const handleDownload = useCallback(async (modelId: string) => {
    setError(null);
    activeDownloadIdsRef.current.add(modelId);
    try {
      await downloadModel(
        modelId,
        (p) => { if (isMountedRef.current) setProgress((prev) => ({ ...prev, [modelId]: p })); },
        undefined,
        hfToken || undefined,
      );
      const updated = await syncCacheRegistry();
      if (isMountedRef.current) setModels(updated);
    } catch (err) {
      if ((err as Error).name !== "AbortError" && isMountedRef.current) {
        setError(String(err));
      }
    } finally {
      activeDownloadIdsRef.current.delete(modelId);
      if (isMountedRef.current) setProgress((prev) => {
        const next = { ...prev };
        delete next[modelId];
        return next;
      });
    }
  }, []);

  const handleCancel = useCallback((modelId: string) => {
    cancelDownload(modelId);
    setProgress((prev) => {
      const next = { ...prev };
      delete next[modelId];
      return next;
    });
  }, []);

  const handleDelete = useCallback(async (modelId: string) => {
    try {
      await deleteModel(modelId);
      const updated = await syncCacheRegistry();
      if (isMountedRef.current) setModels(updated);
    } catch (err) {
      if (isMountedRef.current) setError(String(err));
    }
  }, []);

  const handleLoad = useCallback(async (model: CachedModel) => {
    setLoadingId(model.id);
    setWasmProgress((p) => ({ ...p, [model.id]: 0 }));
    setError(null);
    try {
      if (model.kind === "llm") {
        let urlOrPath = model.url;
        if (isTauri() && model.platform !== "web") {
          const { invoke } = await import("@tauri-apps/api/core");
          const fileName = model.fileName ?? model.url.split("/").pop() ?? `${model.id}.bin`;
          const localPath = await invoke<string | null>("get_model_path", { fileName });
          if (!localPath) throw new Error("Model not found on disk — try downloading again");
          urlOrPath = localPath;
        }
        await onLoadLlm(urlOrPath, model.id, (pct) => {
          if (isMountedRef.current) setWasmProgress((p) => ({ ...p, [model.id]: pct }));
        });
      } else if (model.kind === "embed") {
        await onLoadEmbed(model.url, model.id);
      }
    } catch (err) {
      if (isMountedRef.current) setError(String(err));
    } finally {
      if (isMountedRef.current) {
        setLoadingId(null);
        setWasmProgress((p) => { const n = { ...p }; delete n[model.id]; return n; });
      }
    }
  }, [onLoadLlm, onLoadEmbed]);

  const totalBytes = totalCachedBytes(models);
  const byKind = (kind: ModelKind) => models.filter((m) => m.kind === kind);

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-panel model-manager-panel">
        <div className="modal-header">
          <h2>Model Manager</h2>
          <div className="model-manager-disk">
            <span className="disk-icon">💾</span>
            <span className="disk-label">Cached: {formatBytes(totalBytes)}</span>
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {error && (
          <div className="error-bar">
            ⚠️ {error}
            <button onClick={() => setError(null)}>✕</button>
          </div>
        )}

        <div className="model-manager-body">
          {KIND_ORDER.map((kind) => (
            <section key={kind} className="model-kind-section">
              <h3 className="model-kind-heading">{KIND_LABELS[kind]}</h3>
              <div className="model-list">
                {byKind(kind).map((model) => {
                  const dl = progress[model.id];
                  const downloading = !!dl || isDownloading(model.id);
                  const wasmPct = wasmProgress[model.id];
                  const isWasmLoading = loadingId === model.id && wasmPct !== undefined;
                  const isWebModel = model.platform === "web";
                  const isActiveLlm = kind === "llm" && activeLlmId === model.id;
                  const isActiveEmbed = kind === "embed" && activeEmbedId === model.id;
                  const isActive = isActiveLlm || isActiveEmbed;

                  return (
                    <div
                      key={model.id}
                      className={`model-card ${isActive ? "model-card-active" : ""}`}
                    >
                      <div className="model-card-header">
                        <div className="model-card-info">
                          <span className="model-card-label">
                            {model.label}
                            {isActive && <span className="model-active-badge">active</span>}
                          </span>
                          <span className="model-card-desc">{model.description}</span>
                          {model.contextLength && (
                            <span className="model-card-meta">
                              {(model.contextLength / 1000).toFixed(0)}k ctx
                            </span>
                          )}
                        </div>
                        <div className="model-card-size">
                          {model.cached
                            ? formatBytes(model.cachedBytes)
                            : `~${formatBytes(model.sizeBytes)}`}
                        </div>
                      </div>

                      {/* Download progress bar */}
                      {downloading && dl && (
                        <div className="model-progress-wrap">
                          <div className="model-progress-bar">
                            <div
                              className="model-progress-fill"
                              style={{ width: `${(dl.fraction * 100).toFixed(1)}%` }}
                            />
                          </div>
                          <span className="model-progress-label">
                            {formatBytes(dl.receivedBytes)} / {formatBytes(dl.totalBytes)}
                            {" "}({(dl.fraction * 100).toFixed(0)}%)
                          </span>
                        </div>
                      )}
                      {/* WASM load progress bar */}
                      {isWasmLoading && (
                        <div className="model-progress-wrap">
                          <div className="model-progress-bar">
                            <div
                              className="model-progress-fill"
                              style={{ width: `${wasmPct}%` }}
                            />
                          </div>
                          <span className="model-progress-label">
                            {wasmPct < 92
                              ? `Downloading… ${wasmPct}%`
                              : wasmPct < 96
                              ? "Initializing engine…"
                              : wasmPct < 100
                              ? "Warming up GPU (first run may take a minute)…"
                              : "Ready"}
                          </span>
                        </div>
                      )}

                      <div className="model-card-actions">
                        {kind === "llm" && (
                          <RamBadge sizeBytes={model.sizeBytes} mem={memInfo} />
                        )}
                        {downloading ? (
                          <button
                            className="btn-sm danger"
                            onClick={() => handleCancel(model.id)}
                          >
                            Cancel
                          </button>
                        ) : model.cached || isWebModel ? (
                          <>
                            {(kind === "llm" || kind === "embed") && (
                              <button
                                className={`btn-sm ${isActive ? "secondary" : "primary"}`}
                                onClick={() => handleLoad(model)}
                                disabled={loadingId === model.id}
                              >
                                {loadingId === model.id
                                  ? "Loading…"
                                  : isActive
                                  ? "Reload"
                                  : "Load"}
                              </button>
                            )}
                            {model.cached && (
                              <button
                                className="btn-sm danger"
                                onClick={() => handleDelete(model.id)}
                                title="Remove from cache"
                              >
                                Delete
                              </button>
                            )}
                          </>
                        ) : (
                          <button
                            className="btn-sm primary"
                            onClick={() => handleDownload(model.id)}
                          >
                            Download
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}

          {/* Custom URL entry */}
          <section className="model-kind-section">
            <h3 className="model-kind-heading">Custom URL</h3>
            <CustomUrlLoader onLoadLlm={onLoadLlm} onLoadEmbed={onLoadEmbed} />
          </section>
        </div>
      </div>
    </div>
  );
}

// ── Custom URL sub-component ───────────────────────────────────────────────

function CustomUrlLoader({
  onLoadLlm,
  onLoadEmbed,
}: {
  onLoadLlm: (url: string, id: string) => Promise<void>;
  onLoadEmbed: (url: string, id: string) => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<"llm" | "embed">("llm");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isMountedRef = useRef(false);
  useEffect(() => { isMountedRef.current = true; return () => { isMountedRef.current = false; }; }, []);

  const handleLoad = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const id = `custom-${Date.now()}`;
    setLoading(true);
    setErr(null);
    try {
      if (kind === "llm") await onLoadLlm(trimmed, id);
      else await onLoadEmbed(trimmed, id);
      if (isMountedRef.current) setUrl("");
    } catch (e) {
      if (isMountedRef.current) setErr(String(e));
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  };

  return (
    <div className="custom-url-loader">
      <div className="custom-url-row">
        <select
          className="field-select"
          value={kind}
          onChange={(e) => setKind(e.target.value as "llm" | "embed")}
        >
          <option value="llm">{isTauri() ? "LLM (.litertlm)" : "LLM (.task)"}</option>
          <option value="embed">Embedder (.tflite)</option>
        </select>
        <input
          className="field-input"
          type="url"
          placeholder={isTauri() ? "/path/to/model.litertlm" : "https://huggingface.co/…/model.task"}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleLoad()}
        />
        <button className="btn-sm primary" onClick={handleLoad} disabled={!url.trim() || loading}>
          {loading ? "Loading…" : "Load"}
        </button>
      </div>
      {err && <p className="field-error" style={{ marginTop: 4 }}>{err}</p>}
    </div>
  );
}

// ── Catalogue size summary (used in toolbar) ───────────────────────────────

export function ModelCacheSummary() {
  const [bytes, setBytes] = useState(0);
  useEffect(() => {
    let cancelled = false;
    syncCacheRegistry()
      .then((m) => { if (!cancelled) setBytes(totalCachedBytes(m)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  if (bytes === 0) return null;
  return (
    <span className="model-cache-summary" title="Cached model storage">
      💾 {formatBytes(bytes)}
    </span>
  );
}

// ── Catalogue entry count for a given kind ─────────────────────────────────

export function modelCountByKind(kind: ModelKind): number {
  return MODEL_CATALOGUE.filter((m) => m.kind === kind).length;
}
