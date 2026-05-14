import { useEffect, useRef, useState } from "react";
import type { ModelConfig } from "../lib/types";
import { isTauri } from "../lib/llm";

interface Props {
  config: ModelConfig;
  onSave: (config: ModelConfig) => Promise<void>;
  onClose: () => void;
}

export function SettingsPanel({ config, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<ModelConfig>({ ...config });
  const [saving, setSaving] = useState(false);
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

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

  return (
    <div className="panel-overlay" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-header">
          <h2>⚙️ Settings</h2>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <div className="panel-body">
          {/* Model paths */}
          <section className="panel-section">
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
          <section className="panel-section">
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
              max={4096}
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
            <section className="panel-section">
              <h3>Web backends</h3>
              <p className="hint">
                Use the toolbar to configure the LLM backend (on-device via
                MediaPipe, or an OpenAI-compatible API) and the embedding model URL.
              </p>
            </section>
          )}

          {/* ── Wake word ── */}
          <section className="panel-section">
            <h3>Wake word</h3>
            <p className="hint">
              Porcupine listens for a keyword and automatically starts voice
              recording. Requires a free{" "}
              <a href="https://console.picovoice.ai/" target="_blank" rel="noreferrer">
                Picovoice AccessKey
              </a>
              . Inference runs entirely on-device after the first load.
            </p>

            <label className="field-label">Picovoice AccessKey</label>
            <input
              className="field-input"
              type="password"
              autoComplete="off"
              placeholder="Paste your AccessKey here"
              value={draft.porcupineAccessKey ?? ""}
              onChange={(e) => set("porcupineAccessKey", e.target.value)}
            />

            <label className="field-label" style={{ marginTop: 12 }}>Keyword</label>
            <select
              className="field-input"
              value={draft.porcupineKeyword ?? "Jarvis"}
              onChange={(e) => set("porcupineKeyword", e.target.value)}
            >
              {[
                "Alexa", "Americano", "Blueberry", "Bumblebee", "Computer",
                "Grapefruit", "Grasshopper", "Hey Google", "Hey Siri", "Jarvis",
                "Ok Google", "Picovoice", "Porcupine", "Terminator",
              ].map((kw) => (
                <option key={kw} value={kw}>{kw}</option>
              ))}
            </select>

            <label className="field-label" style={{ marginTop: 12 }}>
              Sensitivity: {(draft.porcupineSensitivity ?? 0.5).toFixed(2)}
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={draft.porcupineSensitivity ?? 0.5}
              onChange={(e) => set("porcupineSensitivity", Number(e.target.value))}
            />
            <p className="hint">
              Higher sensitivity = fewer missed detections, more false positives.
            </p>
          </section>
        </div>

        <div className="panel-footer">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save & reload models"}
          </button>
        </div>
      </div>
    </div>
  );
}
