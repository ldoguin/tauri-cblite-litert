import { useEffect, useRef, useState } from "react";
import type { ModelConfig } from "../lib/types";
import { isTauri } from "../lib/llm";
import { pickBestSearxInstance } from "../lib/tools";

interface Props {
  config: ModelConfig;
  onSave: (config: ModelConfig) => Promise<void>;
  onClose: () => void;
  /** When true, renders inline (no overlay/modal wrapper). onClose becomes a no-op. */
  embedded?: boolean;
}

export function SettingsPanel({ config, onSave, onClose, embedded }: Props) {
  const [draft, setDraft] = useState<ModelConfig>({ ...config });
  const [saving, setSaving] = useState(false);
  const [pickingInstance, setPickingInstance] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const isMountedRef = useRef(false);
  useEffect(() => { isMountedRef.current = true; return () => { isMountedRef.current = false; }; }, []);

  const handleAutoPickSearx = async () => {
    setPickingInstance(true);
    setPickError(null);
    try {
      const url = await pickBestSearxInstance();
      if (isMountedRef.current) set("searxngUrl", url);
    } catch (e) {
      if (isMountedRef.current) setPickError(String(e));
    } finally {
      if (isMountedRef.current) setPickingInstance(false);
    }
  };

  const set = <K extends keyof ModelConfig>(key: K, value: ModelConfig[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(draft);
      if (isMountedRef.current) onClose();
    } finally {
      if (isMountedRef.current) setSaving(false);
    }
  };

  const inner = (
    <div className={embedded ? "panel embedded-panel" : "panel"} onClick={embedded ? undefined : (e) => e.stopPropagation()}>
      <div className="panel-header">
        <h2>⚙️ Settings</h2>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <div className="panel-body">
          {/* Model paths */}
          <section id="settings-models" className="panel-section">
            <h3>Models</h3>

            {isTauri() && (
              <>
                <label className="field-label">
                  LLM model path (.litertlm)
                </label>
                <input
                  className="field-input"
                  placeholder="/path/to/gemma4.litertlm"
                  value={draft.lmModelPath}
                  onChange={(e) => set("lmModelPath", e.target.value)}
                />
                <p className="hint">
                  Download from{" "}
                  <a
                    href="https://huggingface.co/litert-community"
                    target="_blank"
                    rel="noreferrer"
                  >
                    huggingface.co/litert-community
                  </a>
                  . Gemma 3 1B is a good starting point.
                </p>
              </>
            )}

            <label className="field-label">
              WASM LLM model URL <span className="field-optional">(web / Windows fallback)</span>
            </label>
            <input
              className="field-input"
              placeholder="https://huggingface.co/…/model.litertlm"
              value={draft.wasmModelUrl}
              onChange={(e) => set("wasmModelUrl", e.target.value)}
            />
            <p className="hint">
              URL of a .litertlm model loaded via WebAssembly in the browser.
              Loaded automatically on startup when set. No GPU required.
            </p>

            <label className="field-label">
              Embedding model path (.tflite)
            </label>
            <input
              className="field-input"
              placeholder={
                isTauri()
                  ? "/path/to/embedding.tflite"
                  : "https://example.com/model.tflite"
              }
              value={draft.embeddingModelPath}
              onChange={(e) => set("embeddingModelPath", e.target.value)}
            />
            <p className="hint">
              Any sentence-embedding .tflite model. Try{" "}
              <a
                href="https://www.kaggle.com/models?framework=tfLite"
                target="_blank"
                rel="noreferrer"
              >
                Kaggle TFLite models
              </a>
              .
            </p>

            <label className="field-label" style={{ marginTop: 12 }}>
              Whisper model <span className="field-optional">(voice input)</span>
            </label>
            <input
              className="field-input"
              placeholder="Xenova/whisper-tiny.en"
              value={draft.whisperModelId}
              onChange={(e) => set("whisperModelId", e.target.value)}
            />
            <p className="hint">
              HuggingFace model ID used for on-device transcription on Tauri and
              browsers without the Web Speech API. The model is downloaded once
              and cached. Try{" "}
              <a
                href="https://huggingface.co/Xenova/whisper-tiny.en"
                target="_blank"
                rel="noreferrer"
              >
                Xenova/whisper-tiny.en
              </a>{" "}
              (~40 MB) or{" "}
              <a
                href="https://huggingface.co/Xenova/whisper-base.en"
                target="_blank"
                rel="noreferrer"
              >
                Xenova/whisper-base.en
              </a>{" "}
              (~75 MB) for better accuracy.
            </p>

            <label className="field-label" style={{ marginTop: 12 }}>
              TTS model <span className="field-optional">(text-to-speech)</span>
            </label>
            <input
              className="field-input"
              placeholder="Xenova/mms-tts-eng"
              value={draft.ttsModelId ?? ""}
              onChange={(e) => set("ttsModelId", e.target.value)}
            />
            <p className="hint">
              HuggingFace model ID for on-device speech synthesis. Downloaded
              once and cached. Default:{" "}
              <a
                href="https://huggingface.co/Xenova/mms-tts-eng"
                target="_blank"
                rel="noreferrer"
              >
                Xenova/mms-tts-eng
              </a>{" "}
              (~50 MB).
            </p>

            {isTauri() && (
              <>
                <label className="field-label" style={{ marginTop: 12 }}>
                  Model folder <span className="field-optional">(scan for .litertlm files)</span>
                </label>
                <input
                  className="field-input"
                  placeholder="/home/user/models"
                  value={draft.modelFolder ?? ""}
                  onChange={(e) => set("modelFolder", e.target.value)}
                />
                <p className="hint">
                  Folder to scan for <code>.litertlm</code> files. Discovered models
                  appear in the conversation model picker. Leave empty to use the single
                  path above.
                </p>
              </>
            )}

            <label className="field-label">FTS language</label>
            <input
              className="field-input"
              placeholder="en"
              value={draft.ftsLanguage ?? "en"}
              onChange={(e) => set("ftsLanguage", e.target.value)}
            />
            <p className="hint">
              BCP-47 language code for full-text search stemming (e.g. <code>en</code>, <code>fr</code>, <code>de</code>, <code>es</code>).
              Takes effect after the database is re-opened. Default: <code>en</code>.
            </p>

            <label className="field-label">Accelerator</label>
            <select
              className="field-select"
              value={draft.accelerator}
              onChange={(e) =>
                set("accelerator", e.target.value as ModelConfig["accelerator"])
              }
            >
              <option value="cpu">CPU</option>
              <option value="gpu">GPU</option>
              <option value="npu">NPU</option>
            </select>
          </section>

          {/* Generation parameters */}
          <section id="settings-generation" className="panel-section">
            <h3>Generation</h3>

            <label className="field-label">
              Context window: {draft.contextLength > 0 ? `${draft.contextLength.toLocaleString()} tokens` : "Auto-detect"}
            </label>
            <input
              className="field-input"
              type="number"
              min={0}
              step={512}
              placeholder="0 = auto-detect from model catalogue"
              value={draft.contextLength || ""}
              onChange={(e) => set("contextLength", Number(e.target.value) || 0)}
            />
            <p className="hint">
              Full context window size (input + output). Set automatically when loading from the model manager.
              Override here for custom model paths. 0 = hidden bar.
            </p>

            <label className="field-label">
              Max tokens: {draft.maxTokens}
            </label>
            <input
              type="range"
              min={64}
              max={8192}
              step={64}
              value={draft.maxTokens}
              onChange={(e) => set("maxTokens", Number(e.target.value))}
            />

            <label className="field-label">
              Temperature: {draft.temperature.toFixed(2)}
            </label>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={draft.temperature}
              onChange={(e) => set("temperature", Number(e.target.value))}
            />

            <label className="field-label">Top-P: {draft.topP.toFixed(2)}</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={draft.topP}
              onChange={(e) => set("topP", Number(e.target.value))}
            />

            <label className="field-label">Top-K: {draft.topK}</label>
            <input
              type="range"
              min={1}
              max={100}
              step={1}
              value={draft.topK}
              onChange={(e) => set("topK", Number(e.target.value))}
            />

            <label className="field-label">
              RAG top-K chunks: {draft.ragTopK}
            </label>
            <input
              type="range"
              min={1}
              max={10}
              step={1}
              value={draft.ragTopK}
              onChange={(e) => set("ragTopK", Number(e.target.value))}
            />

            <label className="field-label" style={{ marginTop: 12 }}>
              RAG similarity threshold: {(draft.ragThreshold ?? 0.3).toFixed(2)}
            </label>
            <input
              type="range"
              min={0}
              max={0.95}
              step={0.05}
              value={draft.ragThreshold ?? 0.3}
              onChange={(e) => set("ragThreshold", Number(e.target.value))}
            />
            <p className="hint">
              Minimum cosine similarity for a chunk to be included. Higher = stricter relevance.
            </p>

            <label className="field-label" style={{ marginTop: 12 }}>RAG source types</label>
            <div className="rag-source-types">
              {(["knowledge", "message"] as const).map((t) => {
                const checked = (draft.ragSourceTypes ?? ["knowledge", "message"]).includes(t);
                return (
                  <label key={t} className="rag-source-type-label">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const current = draft.ragSourceTypes ?? ["knowledge", "message"];
                        const next = e.target.checked
                          ? [...current, t]
                          : current.filter((x) => x !== t);
                        set("ragSourceTypes", next as ("knowledge" | "message")[]);
                      }}
                    />
                    {t === "knowledge" ? "📚 Knowledge base chunks" : "💬 Past conversation messages"}
                  </label>
                );
              })}
            </div>

            <label className="field-label" style={{ marginTop: 16 }}>
              Chunk size: {draft.chunkSize ?? 400} chars
            </label>
            <input
              type="range" min={100} max={2000} step={50}
              value={draft.chunkSize ?? 400}
              onChange={(e) => set("chunkSize", Number(e.target.value))}
            />

            <label className="field-label" style={{ marginTop: 8 }}>
              Chunk overlap: {draft.chunkOverlap ?? 80} chars
            </label>
            <input
              type="range" min={0} max={400} step={20}
              value={draft.chunkOverlap ?? 80}
              onChange={(e) => set("chunkOverlap", Number(e.target.value))}
            />
            <p className="hint">
              Larger chunks preserve more context per retrieval; more overlap reduces boundary artifacts.
              Changes apply to newly ingested documents only — use "Re-embed all" in the Knowledge Base to update existing chunks.
            </p>

            <label className="field-label" style={{ marginTop: 12 }}>
              Hybrid search BM25 weight: {((draft.hybridBm25Weight ?? 0.3) * 100).toFixed(0)}%
            </label>
            <input
              type="range" min={0} max={1} step={0.05}
              value={draft.hybridBm25Weight ?? 0.3}
              onChange={(e) => set("hybridBm25Weight", Number(e.target.value))}
            />
            <p className="hint">
              0% = pure vector similarity · 100% = pure keyword (BM25). 30% is a good default.
            </p>
          </section>

          {!isTauri() && (
            <section id="settings-web-search" className="panel-section">
              <h3>Web backends</h3>
              <p className="hint">
                Use the toolbar to configure the LLM backend (on-device via
                MediaPipe, or an OpenAI-compatible API) and the embedding model URL.
              </p>
            </section>
          )}

          {/* ── Web search ── */}
          {isTauri() && (
            <section id="settings-web-search" className="panel-section">
              <h3>Web search</h3>
              <p className="hint">
                SearXNG is an open-source meta-search engine with no API key required.
                Enter the URL of any public or self-hosted instance.{" "}
                <a href="https://searx.space/" target="_blank" rel="noreferrer">Browse instances</a>.
                Leave empty to use DuckDuckGo (may be unreliable on some networks).
              </p>
              <label className="field-label">SearXNG instance URL</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  className="field-input"
                  placeholder="https://searx.be"
                  value={draft.searxngUrl ?? ""}
                  onChange={(e) => set("searxngUrl", e.target.value.trim())}
                  style={{ flex: 1 }}
                />
                <button
                  className="btn-secondary"
                  onClick={handleAutoPickSearx}
                  disabled={pickingInstance}
                  style={{ whiteSpace: "nowrap" }}
                >
                  {pickingInstance ? "Picking…" : "Auto-pick"}
                </button>
              </div>
              {pickError && <p className="hint" style={{ color: "var(--error)" }}>{pickError}</p>}
            </section>
          )}

          {/* ── Wake word ── */}
          <section id="settings-wake-word" className="panel-section">
            <h3>Wake word</h3>
            <p className="hint">
              Say this phrase to automatically start voice recording. Detected
              locally using Whisper — no API key needed.
            </p>

            <label className="field-label">Wake phrase</label>
            <input
              className="field-input"
              type="text"
              placeholder="e.g. jarvis, hey computer"
              value={draft.wakePhrase ?? "jarvis"}
              onChange={(e) => set("wakePhrase", e.target.value)}
            />
            <p className="hint">
              Leave empty to disable wake word detection. The phrase is matched
              case-insensitively against the Whisper transcript.
            </p>
          </section>
        </div>

        <div className="panel-footer">
          {!embedded && (
            <button className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
          )}
          <button
            className="btn-primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save & reload models"}
          </button>
        </div>
      </div>
  );

  if (embedded) return inner;
  return <div className="panel-overlay" onClick={onClose}>{inner}</div>;
}
