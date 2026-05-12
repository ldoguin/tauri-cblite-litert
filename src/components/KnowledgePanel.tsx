import { useRef, useState } from "react";
import type { KnowledgeChunk, AppStatus } from "../lib/types";

interface Props {
  chunks: KnowledgeChunk[];
  status: AppStatus;
  onIngest: (source: string, text: string) => Promise<void>;
  onDelete: (id: string) => void;
  onClose: () => void;
}

export function KnowledgePanel({
  chunks,
  status,
  onIngest,
  onDelete,
  onClose,
}: Props) {
  const [pasteText, setPasteText] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [ingesting, setIngesting] = useState(false);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleIngestText = async () => {
    if (!pasteText.trim() || !sourceName.trim()) return;
    setIngesting(true);
    setIngestError(null);
    try {
      await onIngest(sourceName.trim(), pasteText.trim());
      setPasteText("");
      setSourceName("");
    } catch (err) {
      setIngestError(String(err));
    } finally {
      setIngesting(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setIngesting(true);
    setIngestError(null);
    try {
      await onIngest(file.name, text);
    } catch (err) {
      setIngestError(String(err));
    } finally {
      setIngesting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const isEmbedding = status === "embedding" || ingesting;

  return (
    <div className="panel-overlay" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-header">
          <h2>📚 Knowledge Base</h2>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <div className="panel-body">
          {/* Ingest section */}
          <section className="panel-section">
            <h3>Add documents</h3>
            <p className="hint">
              Text is split into chunks, embedded with your LiteRT model, and
              stored in CouchbaseLite for offline retrieval.
            </p>

            <label className="field-label">Source name</label>
            <input
              className="field-input"
              placeholder="e.g. my-notes.txt"
              value={sourceName}
              onChange={(e) => setSourceName(e.target.value)}
              disabled={isEmbedding}
            />

            <label className="field-label">Paste text</label>
            <textarea
              className="field-textarea"
              rows={5}
              placeholder="Paste document text here…"
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              disabled={isEmbedding}
            />

            <div className="row-gap">
              <button
                className="btn-primary"
                onClick={handleIngestText}
                disabled={isEmbedding || !pasteText.trim() || !sourceName.trim()}
              >
                {isEmbedding ? "Embedding…" : "Embed & store"}
              </button>

              <span className="or-divider">or</span>

              <button
                className="btn-secondary"
                onClick={() => fileRef.current?.click()}
                disabled={isEmbedding}
              >
                Upload .txt file
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".txt,.md,.csv"
                style={{ display: "none" }}
                onChange={handleFileChange}
              />
            </div>

            {ingestError && (
              <p className="error-text">{ingestError}</p>
            )}
          </section>

          {/* Chunk list */}
          <section className="panel-section">
            <h3>Stored chunks ({chunks.length})</h3>
            {chunks.length === 0 ? (
              <p className="hint">No chunks yet. Add a document above.</p>
            ) : (
              <ul className="chunk-list">
                {chunks.map((c) => (
                  <li key={c.id} className="chunk-item">
                    <div className="chunk-meta">
                      <span className="chunk-source">{c.source}</span>
                      <span className="chunk-date">
                        {new Date(c.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                    <p className="chunk-preview">
                      {c.text.slice(0, 120)}
                      {c.text.length > 120 ? "…" : ""}
                    </p>
                    <button
                      className="chunk-delete"
                      onClick={() => onDelete(c.id)}
                      title="Remove chunk"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
