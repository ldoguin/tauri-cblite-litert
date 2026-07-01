import { useState, useRef, useCallback } from "react";
import { loadModel, unloadModel, runInference } from "tauri-plugin-litert-api";
import { preprocessImage, parseDetections, COCO_LABELS, TASK_CATALOGUE } from "../lib/taskModels";
import type { DetectionResult } from "../lib/taskModels";
import { isTauri } from "../lib/llm";

const ENTRY = TASK_CATALOGUE.find((e) => e.id === "efficientdet-lite0")!;
const MODEL_ID = "demo-efficientdet-access";

// ── Spatial helpers ───────────────────────────────────────────────────────────

function spatialLabel(box: DetectionResult["box"]): string {
  const cx = (box.x1 + box.x2) / 2;
  const cy = (box.y1 + box.y2) / 2;
  const xTag = cx < 0.33 ? "left" : cx > 0.67 ? "right" : "center";
  const yTag = cy < 0.35 ? "upper" : cy > 0.65 ? "lower" : "middle";
  return `${yTag}-${xTag}`;
}

function formatForLlm(detections: DetectionResult[]): string {
  return detections
    .map((d) => `- ${d.label} (${(d.score * 100).toFixed(0)}%) at ${spatialLabel(d.box)}`)
    .join("\n");
}

// ── Component ─────────────────────────────────────────────────────────────────

const DESCRIBER_SYSTEM =
  "You are an accessibility assistant helping visually impaired users understand images.\n" +
  "Given a list of detected objects with spatial positions, write a clear, natural scene description.\n" +
  "Start with the most prominent subject, then describe context and setting.\n" +
  "Use natural flowing language — NOT a bullet list. 2-4 sentences. Do not mention confidence scores or model names.";

interface Props {
  onBack: () => void;
  onAnalyze?: (userText: string, systemPrompt: string) => Promise<string>;
}

export function AccessibilityDescriber({ onBack, onAnalyze }: Props) {
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [detections, setDetections]     = useState<DetectionResult[] | null>(null);
  const [description, setDescription]   = useState<string | null>(null);
  const [phase, setPhase]               = useState<"idle" | "running" | "done" | "error">("idle");
  const [errorMsg, setErrorMsg]         = useState<string | null>(null);
  const [latencyMs, setLatencyMs]       = useState<number | null>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const cameraRef  = useRef<HTMLInputElement>(null);

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      setImageDataUrl(e.target?.result as string);
      setDetections(null);
      setDescription(null);
      setPhase("idle");
      setErrorMsg(null);
    };
    reader.readAsDataURL(file);
  };

  const analyze = useCallback(async () => {
    if (!imageDataUrl || !isTauri()) return;
    setPhase("running");
    setDetections(null);
    setDescription(null);
    setErrorMsg(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const modelPath = await invoke<string | null>("get_model_path", { fileName: ENTRY.fileName }).catch(() => null);
      if (!modelPath) {
        setErrorMsg("EfficientDet-Lite0 not found. Open the Tasks panel and download it first.");
        setPhase("error");
        return;
      }
      await loadModel({ modelId: MODEL_ID, modelPath, accelerator: "cpu" });
      try {
        const shape = ENTRY.inputShape as [number, number, number, number];
        const tensor = await preprocessImage(imageDataUrl, shape[1], shape[2], ENTRY.normalizeMode);
        const result = await runInference({ modelId: MODEL_ID, inputs: [Array.from(tensor)] });
        setLatencyMs(result.latencyMs);
        const found = parseDetections(result.outputs, COCO_LABELS, 0.3, shape[1], shape[2]) ?? [];
        setDetections(found);

        if (onAnalyze) {
          if (found.length === 0) {
            setDescription("No recognisable objects were detected in this image. The scene may be too dark, abstract, or outside the model's training categories.");
          } else {
            const prompt = `Objects detected in image:\n${formatForLlm(found)}\n\nDescribe this scene naturally for a visually impaired person:`;
            setDescription(await onAnalyze(prompt, DESCRIBER_SYSTEM));
          }
        } else {
          setDescription(
            found.length === 0
              ? "No objects detected."
              : found.map((d) => `${d.label} (${(d.score * 100).toFixed(0)}%) — ${spatialLabel(d.box)}`).join(", "),
          );
        }
        setPhase("done");
      } finally {
        await unloadModel(MODEL_ID).catch(() => {});
      }
    } catch (e) {
      setErrorMsg(String(e));
      setPhase("error");
    }
  }, [imageDataUrl, onAnalyze]);

  const copyText = () => {
    if (description) navigator.clipboard.writeText(description).catch(() => {});
  };

  return (
    <div className="demo-screen access-screen">
      <header className="demo-header">
        <button className="demo-back" onClick={onBack}>← Back</button>
        <div className="demo-header-text">
          <h1 className="demo-title">Scene Describer</h1>
          <p className="demo-subtitle">Detect objects and narrate scenes — on device, for accessibility</p>
        </div>
      </header>

      <div className="access-body">
        {/* Upload area */}
        {!imageDataUrl ? (
          <div className="demo-dropzone access-dropzone" onClick={() => galleryRef.current?.click()}>
            <span className="demo-dropzone-icon">🔍</span>
            <p>Upload any photo to describe the scene</p>
            <div className="demo-dropzone-actions">
              <button className="btn-sm" onClick={(e) => { e.stopPropagation(); galleryRef.current?.click(); }}>
                Choose image
              </button>
              {isTauri() && (
                <button className="btn-sm secondary" onClick={(e) => { e.stopPropagation(); cameraRef.current?.click(); }}>
                  Camera
                </button>
              )}
            </div>
            {!isTauri() && <p className="demo-notice">Requires the native app.</p>}
          </div>
        ) : (
          <div className="access-split">
            <div className="access-image-panel">
              <img src={imageDataUrl} alt="Scene to describe" className="access-image" />
              <div className="access-image-actions">
                <button className="btn-sm secondary"
                  onClick={() => { setImageDataUrl(null); setDetections(null); setDescription(null); setPhase("idle"); }}>
                  Change
                </button>
                <button
                  className="demo-action-btn access-analyze-btn"
                  onClick={analyze}
                  disabled={phase === "running" || !isTauri()}
                >
                  {phase === "running" ? "Describing…" : "Describe Scene"}
                </button>
              </div>
            </div>

            <div className="access-output">
              {errorMsg && <div className="demo-error">{errorMsg}</div>}

              {description && (
                <div className="access-description">
                  <div className="access-description-header">
                    <h3>Scene Description</h3>
                    <button className="btn-sm secondary" onClick={copyText} title="Copy to clipboard">
                      Copy
                    </button>
                  </div>
                  <p className="access-description-text">{description}</p>
                  {latencyMs !== null && (
                    <p className="access-meta">
                      {detections?.length ?? 0} object{detections?.length !== 1 ? "s" : ""} detected · {latencyMs} ms
                    </p>
                  )}
                </div>
              )}

              {detections && detections.length > 0 && (
                <details className="access-detections">
                  <summary>Raw detections ({detections.length})</summary>
                  <ul className="access-detections-list">
                    {detections.map((d, i) => (
                      <li key={i}>
                        <strong>{d.label}</strong>
                        <span className="access-score">{(d.score * 100).toFixed(0)}%</span>
                        <span className="access-pos">{spatialLabel(d.box)}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {phase === "idle" && !description && (
                <div className="access-hint">
                  Press <strong>Describe Scene</strong> to run on-device object detection and generate a natural language description.
                </div>
              )}
            </div>
          </div>
        )}

        <input ref={galleryRef} type="file" accept="image/*" style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
      </div>
    </div>
  );
}
