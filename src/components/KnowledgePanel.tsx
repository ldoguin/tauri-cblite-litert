import { useRef, useState, useMemo, useEffect } from "react";
import type { KnowledgeChunk, AppStatus } from "../lib/types";

interface Props {
  chunks: KnowledgeChunk[];
  status: AppStatus;
  onIngest: (source: string, text: string) => Promise<void>;
  onIngestPdf: (file: File) => Promise<void>;
  onIngestUrl: (url: string) => Promise<void>;
  onIngestImage: (file: File) => Promise<void>;
  onDelete: (id: string) => void;
  onDeleteBySource: (source: string) => void;
  onReEmbedAll: () => void;
  onCancelReEmbed: () => void;
  reEmbedProgress: { done: number; total: number } | null;
  ingestProgress: { done: number; total: number; source: string } | null;
  onClose: () => void;
  embedded?: boolean;
  filterSource?: string | null;
  onClearFilter?: () => void;
}

type IngestTab = "text" | "file" | "url";

export function KnowledgePanel({
  chunks, status, onIngest, onIngestPdf, onIngestUrl, onIngestImage, onDelete, onDeleteBySource,
  onReEmbedAll, onCancelReEmbed, reEmbedProgress, ingestProgress, onClose, embedded,
  filterSource, onClearFilter,
}: Props) {
  const [tab, setTab] = useState<IngestTab>("file");
  const [pasteText, setPasteText] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [ingesting, setIngesting] = useState(false);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [deleteConfirmSource, setDeleteConfirmSource] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const isMountedRef = useRef(true);
  useEffect(() => { isMountedRef.current = true; return () => { isMountedRef.current = false; }; }, []);

  const isEmbedding = status === "embedding" || ingesting;

  // Group chunks by source
  const grouped = useMemo(() => {
    const map = new Map<string, KnowledgeChunk[]>();
    for (const c of chunks) {
      if (!map.has(c.source)) map.set(c.source, []);
      map.get(c.source)!.push(c);
    }
    return map;
  }, [chunks]);

  // Filter by search and/or selected source
  const filteredSources = useMemo(() => {
    const q = search.toLowerCase();
    return Array.from(grouped.entries()).filter(([source, cs]) => {
      if (filterSource && source !== filterSource) return false;
      return !q || source.toLowerCase().includes(q) || cs.some((c) => c.text.toLowerCase().includes(q));
    });
  }, [grouped, search, filterSource]);

  const withError = async (fn: () => Promise<void>) => {
    if (isMountedRef.current) { setIngesting(true); setIngestError(null); }
    try { await fn(); }
    catch (err) { if (isMountedRef.current) setIngestError(String(err)); }
    finally { if (isMountedRef.current) setIngesting(false); }
  };

  const handleIngestText = () => withError(async () => {
    if (!pasteText.trim() || !sourceName.trim()) return;
    await onIngest(sourceName.trim(), pasteText.trim());
    setPasteText(""); setSourceName("");
  });

  const handleIngestUrl = () => withError(async () => {
    if (!urlInput.trim()) return;
    await onIngestUrl(urlInput.trim());
    setUrlInput("");
  });

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    // Collect errors from all files rather than clearing per-file, so a
    // failure on file N isn't silently overwritten by file N+1 succeeding.
    const errors: string[] = [];
    if (isMountedRef.current) { setIngesting(true); setIngestError(null); }
    for (const file of Array.from(files)) {
      try {
        if (file.type === "application/pdf" || file.name.endsWith(".pdf")) {
          await onIngestPdf(file);
        } else if (file.type.startsWith("image/")) {
          await onIngestImage(file);
        } else {
          const text = await file.text();
          await onIngest(file.name, text);
        }
      } catch (err) {
        errors.push(`${file.name}: ${String(err)}`);
      }
    }
    if (isMountedRef.current) {
      setIngesting(false);
      if (errors.length > 0) setIngestError(errors.join("\n"));
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files).catch((err) => setIngestError(String(err)));
  };

  const inner = (
    <div className={embedded ? "panel panel-wide embedded-panel" : "panel panel-wide"} onClick={(e) => e.stopPropagation()}>
      <div className="panel-header">
        <h2>📚 Knowledge Base</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {ingestProgress && (
            <span className="re-embed-progress" aria-live="polite">
              Embedding "{ingestProgress.source}" — {ingestProgress.done}/{ingestProgress.total} chunks…
            </span>
          )}
          {reEmbedProgress ? (
            <span className="re-embed-progress" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              Re-embedding {reEmbedProgress.done}/{reEmbedProgress.total}…
              <button
                className="btn-sm secondary"
                onClick={onCancelReEmbed}
                title="Cancel re-embedding"
              >
                ✕ Cancel
              </button>
            </span>
          ) : (
            <button
              className="btn-sm secondary"
              onClick={onReEmbedAll}
              disabled={chunks.length === 0 || status === "embedding"}
              title="Re-compute all embeddings with the current model"
            >
              ↺ Re-embed all
            </button>
          )}
          {!embedded && <button className="icon-btn" onClick={onClose}>✕</button>}
        </div>
      </div>

        <div className="panel-body">
          {/* ── Filter breadcrumb ── */}
          {filterSource && (
            <div className="kb-filter-bar">
              <button className="kb-filter-back" onClick={onClearFilter}>← All sources</button>
              <span className="kb-filter-source" title={filterSource}>{filterSource}</span>
            </div>
          )}

          {/* ── Ingest section ── */}
          {!filterSource && <section className="panel-section">
            <h3>Add documents</h3>
            <p className="hint">
              Text is split into chunks, embedded, and stored in CouchbaseLite for offline retrieval.
            </p>

            {/* Tab switcher */}
            <div className="kb-tabs">
              {(["file", "url", "text"] as IngestTab[]).map((t) => (
                <button
                  key={t}
                  className={`kb-tab ${tab === t ? "active" : ""}`}
                  onClick={() => setTab(t)}
                >
                  {t === "file" ? "📄 File / PDF" : t === "url" ? "🌐 URL" : "✏️ Paste text"}
                </button>
              ))}
            </div>

            {/* File / PDF tab */}
            {tab === "file" && (
              <div
                className={`drop-zone ${dragOver ? "drag-over" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileRef.current?.click()}
              >
                <span className="drop-zone-icon">📂</span>
                <span className="drop-zone-label">
                  {isEmbedding ? "Embedding…" : "Drop files here or click to browse"}
                </span>
                <span className="drop-zone-hint">.txt · .md · .csv · .pdf · .jpg · .png · .webp</span>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".txt,.md,.csv,.pdf,.jpg,.jpeg,.png,.webp,image/*"
                  multiple
                  style={{ display: "none" }}
                  onChange={(e) => { handleFiles(e.target.files).catch((err) => setIngestError(String(err))); }}
                />
              </div>
            )}

            {/* URL tab */}
            {tab === "url" && (
              <div className="kb-url-row">
                <input
                  className="field-input"
                  placeholder="https://example.com/article"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleIngestUrl(); }}
                  disabled={isEmbedding}
                />
                <button
                  className="btn-sm"
                  onClick={handleIngestUrl}
                  disabled={isEmbedding || !urlInput.trim()}
                >
                  {isEmbedding ? "Fetching…" : "Fetch & embed"}
                </button>
              </div>
            )}

            {/* Paste text tab */}
            {tab === "text" && (
              <>
                <label className="field-label">Source name</label>
                <input
                  className="field-input"
                  placeholder="e.g. my-notes.txt"
                  value={sourceName}
                  onChange={(e) => setSourceName(e.target.value)}
                  disabled={isEmbedding}
                />
                <label className="field-label" style={{ marginTop: 10 }}>Text</label>
                <textarea
                  className="field-textarea"
                  rows={5}
                  placeholder="Paste document text here…"
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  disabled={isEmbedding}
                />
                <button
                  className="btn-sm"
                  style={{ marginTop: 8 }}
                  onClick={handleIngestText}
                  disabled={isEmbedding || !pasteText.trim() || !sourceName.trim()}
                >
                  {isEmbedding ? "Embedding…" : "Embed & store"}
                </button>
              </>
            )}

            {ingestError && <p className="error-text" style={{ marginTop: 8 }}>{ingestError}</p>}
          </section>}

          {/* ── Chunk list ── */}
          <section className="panel-section">
            <div className="kb-list-header">
              <h3>
                {chunks.length} chunk{chunks.length !== 1 ? "s" : ""}
                {" · "}
                {grouped.size} source{grouped.size !== 1 ? "s" : ""}
              </h3>
              <input
                className="sidebar-search"
                style={{ width: 180 }}
                placeholder="Filter…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            {filteredSources.length === 0 ? (
              <p className="hint">{search ? "No matches." : filterSource ? "No chunks for this source." : "No chunks yet. Add a document above."}</p>
            ) : (
              <ul className="source-list">
                {filteredSources.map(([source, sourceChunks]) => (
                  <li key={source} className="source-item">
                    <div className="source-header">
                      <span className="source-name" title={source}>
                        {sourceChunks.some((c) => c.imageRef) ? "🖼️ " : ""}{source}
                      </span>
                      <span className="source-count">{sourceChunks.length} chunk{sourceChunks.length !== 1 ? "s" : ""}</span>
                      {deleteConfirmSource === source ? (
                        <div className="source-delete-confirm">
                          <button className="btn-sm danger" onClick={() => { onDeleteBySource(source); setDeleteConfirmSource(null); }}>
                            Delete all
                          </button>
                          <button className="btn-sm secondary" onClick={() => setDeleteConfirmSource(null)}>Cancel</button>
                        </div>
                      ) : (
                        <button className="icon-btn danger" title="Delete all chunks from this source"
                          onClick={() => setDeleteConfirmSource(source)}>🗑</button>
                      )}
                    </div>
                    <ul className="chunk-list">
                      {sourceChunks.map((c) => (
                        <li key={c.id} className="chunk-item">
                          <p className="chunk-preview">
                            {c.text.slice(0, 140)}{c.text.length > 140 ? "…" : ""}
                          </p>
                          <div className="chunk-meta">
                            <span className="chunk-date">{new Date(c.createdAt).toLocaleDateString()}</span>
                            <button className="chunk-delete" onClick={() => onDelete(c.id)} title="Remove chunk">✕</button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
  );
  if (embedded) return inner;
  return <div className="panel-overlay" onClick={onClose}>{inner}</div>;
}
