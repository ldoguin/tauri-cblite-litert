import { useState } from "react";
import type { ModelConfig } from "../lib/types";
import { getWebApiConfig, setWebApiConfig, isWeb } from "../lib/llm";

interface Props {
  config: ModelConfig;
  onSave: (config: ModelConfig) => Promise<void>;
  onClose: () => void;
}

export function SettingsPanel({ config, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<ModelConfig>({ ...config });
  const [saving, setSaving] = useState(false);

  const webApi = getWebApiConfig();
  const [webApiUrl, setWebApiUrl] = useState(webApi.url);
  const [webApiKey, setWebApiKey] = useState(webApi.apiKey);

  const set = <K extends keyof ModelConfig>(key: K, value: ModelConfig[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    setSaving(true);
    try {
      if (isWeb()) {
        setWebApiConfig(webApiUrl, webApiKey);
      }
      await onSave(draft);
      onClose();
    } finally {
      setSaving(false);
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

            {!isWeb() && (
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
                isWeb()
                  ? "https://example.com/model.tflite"
                  : "/path/to/embedding.tflite"
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
          </section>

          {/* Web API fallback */}
          {isWeb() && (
            <section className="panel-section">
              <h3>Web API fallback</h3>
              <p className="hint">
                LiteRT-LM is not available in the browser. Configure an
                OpenAI-compatible endpoint (Groq, OpenRouter, Ollama, etc.).
              </p>

              <label className="field-label">API base URL</label>
              <input
                className="field-input"
                value={webApiUrl}
                onChange={(e) => setWebApiUrl(e.target.value)}
                placeholder="https://api.groq.com/openai/v1"
              />

              <label className="field-label">API key</label>
              <input
                className="field-input"
                type="password"
                value={webApiKey}
                onChange={(e) => setWebApiKey(e.target.value)}
                placeholder="sk-…"
              />
            </section>
          )}
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
