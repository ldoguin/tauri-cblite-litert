import { useState, useRef, useCallback, useEffect } from "react";
import { isTauri } from "../lib/llm";
import {
  TASK_CATALOGUE,
  COCO_LABELS,
  DEEPLAB_LABELS,
  DEEPLAB_COLORS,
  DETECTION_PALETTE,
  loadTaskModel,
  unloadTaskModel,
  runTaskInference,
  preprocessImage,
  topKClassifications,
  parseDetections,
  parsePose,
  parseSegMask,
  parseDepthMap,
  summariseOutputs,
  fetchLabels,
  captureAudioSample,
  drawPoseSkeleton,
  drawSegMask,
  drawDepthHeatmap,
  tensorToDataUrl,
  type TaskCatalogEntry,
  type ClassificationResult,
  type DetectionResult,
  type RawOutput,
  type PoseKeypoint,
  type SegMask,
  type DepthMap,
  type InferenceResult,
} from "../lib/taskModels";
import type { ModelInfo } from "tauri-plugin-litert-api";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ScannedTfliteModel {
  name: string;
  path: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const TASK_ICONS: Record<string, string> = {
  "image-classification": "🏷️",
  "object-detection": "📦",
  "image-segmentation": "🎨",
  "pose-estimation": "🦴",
  "audio-classification": "🎙️",
  "depth-estimation": "📐",
  "style-transfer": "🖌️",
  "text-qa": "💬",
  "text-classification": "📝",
  "custom": "⚙️",
};

function fmtScore(s: number) {
  return (s * 100).toFixed(1) + "%";
}

// ── Sub-components ────────────────────────────────────────────────────────────

function CatalogCard({
  entry,
  isLoaded,
  isDownloaded,
  onLoad,
  onUnload,
  onDownload,
  downloading,
  downloadProgress,
}: {
  entry: TaskCatalogEntry;
  isLoaded: boolean;
  isDownloaded: boolean;
  onLoad: () => void;
  onUnload: () => void;
  onDownload: () => void;
  downloading: boolean;
  downloadProgress: number | null;
}) {
  const canDownload = !!entry.downloadUrl;

  return (
    <div className={`task-card ${isLoaded ? "task-card-loaded" : ""}`}>
      <div className="task-card-header">
        <span className="task-icon">{TASK_ICONS[entry.task] ?? "⚙️"}</span>
        <div className="task-card-title">
          <strong>{entry.name}</strong>
          <span className="task-source">{entry.source}</span>
        </div>
        <span className="task-size">{entry.sizeMb} MB</span>
      </div>
      <p className="task-card-desc">{entry.description}</p>
      {entry.accuracy && <div className="task-accuracy">{entry.accuracy}</div>}
      {entry.manualDownloadNote && (
        <div className="task-manual-note">{entry.manualDownloadNote}</div>
      )}
      <div className="task-card-actions">
        {!isDownloaded && canDownload ? (
          <button className="btn-sm" onClick={onDownload} disabled={downloading}>
            {downloading
              ? downloadProgress !== null
                ? `${(downloadProgress * 100).toFixed(0)}%`
                : "Downloading..."
              : "⬇ Download"}
          </button>
        ) : isLoaded ? (
          <button className="btn-sm danger" onClick={onUnload}>Unload</button>
        ) : isDownloaded || !canDownload ? (
          <button className="btn-sm primary" onClick={onLoad} disabled={!isDownloaded}>
            {isDownloaded ? "Load model" : "Not downloaded"}
          </button>
        ) : null}
        {isLoaded && <span className="task-loaded-badge">✓ Loaded</span>}
      </div>
    </div>
  );
}

function ImageDropZone({
  onImage,
  imageUrl,
  label,
}: {
  onImage: (url: string) => void;
  imageUrl: string | null;
  label?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = (file: File) => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (e) => { if (e.target?.result) onImage(e.target.result as string); };
    reader.readAsDataURL(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  return (
    <div className="task-drop-zone-wrap">
      {label && <div className="task-drop-label">{label}</div>}
      <div
        className="task-drop-zone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
      >
        {imageUrl ? (
          <img src={imageUrl} className="task-preview-img" alt="input" />
        ) : (
          <div className="task-drop-hint">
            <span>🖼️</span>
            <span>Drop an image or click to browse</span>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
        />
      </div>
    </div>
  );
}

function ResultsDisplay({
  result,
  loadedEntry,
  categoryColors,
  categoryEnabled,
  onColorChange,
  onToggleCategory,
}: {
  result: InferenceResult;
  loadedEntry: TaskCatalogEntry | undefined;
  categoryColors: Record<string, string>;
  categoryEnabled: Record<string, boolean>;
  onColorChange: (label: string, color: string) => void;
  onToggleCategory: (label: string) => void;
}) {
  if (result.kind === "classification" || result.kind === "audio") {
    const items = result.items as ClassificationResult[];
    return (
      <div className="task-results">
        <div className="task-results-header">
          Top {items.length} predictions
          <span className="task-latency">{result.latencyMs.toFixed(0)} ms</span>
        </div>
        {items.map((r) => (
          <div key={r.rank} className="task-result-row">
            <span className="task-result-rank">#{r.rank}</span>
            <span className="task-result-label">{r.label}</span>
            <div className="task-result-bar-wrap">
              <div className="task-result-bar" style={{ width: fmtScore(r.score) }} />
            </div>
            <span className="task-result-score">{fmtScore(r.score)}</span>
          </div>
        ))}
      </div>
    );
  }

  if (result.kind === "detection") {
    const items = result.items as DetectionResult[];
    // Legend shows ALL ever-seen categories (from categoryColors), not just current run
    const legendLabels = Object.keys(categoryColors);

    return (
      <div className="task-results">
        <div className="task-results-header">
          {items.length > 0
            ? `${items.length} detection${items.length !== 1 ? "s" : ""}`
            : "No detections above threshold"}
          <span className="task-latency">{result.latencyMs.toFixed(0)} ms</span>
        </div>
        {items.map((d, i) => {
          const color = categoryColors[d.label] ?? "#00e5ff";
          const active = categoryEnabled[d.label] !== false;
          return (
            <div key={i} className={`task-result-row has-swatch ${active ? "" : "disabled-row"}`}>
              <span className="task-result-rank">#{i + 1}</span>
              <span className="task-result-swatch" style={{ background: active ? color : "transparent", border: active ? "none" : "1px solid currentColor" }} />
              <span className="task-result-label">{d.label}</span>
              <div className="task-result-bar-wrap">
                <div className="task-result-bar" style={{ width: fmtScore(d.score), background: active ? color : "var(--text-dim)" }} />
              </div>
              <span className="task-result-score">{fmtScore(d.score)}</span>
            </div>
          );
        })}
        {legendLabels.length > 0 && (
          <div className="detection-color-legend">
            {legendLabels.map((label) => {
              const color = categoryColors[label] ?? "#00e5ff";
              const active = categoryEnabled[label] !== false;
              return (
                <div
                  key={label}
                  className={`detection-color-chip ${active ? "" : "chip-disabled"}`}
                  title={active ? `Click to hide ${label}` : `Click to show ${label}`}
                  onClick={() => onToggleCategory(label)}
                >
                  <label
                    className="detection-color-picker-trigger"
                    title="Change colour"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="color"
                      value={color}
                      onChange={(e) => onColorChange(label, e.target.value)}
                      className="detection-color-input"
                    />
                    <span className="detection-color-dot" style={{ background: color }} />
                  </label>
                  <span className="detection-color-name">{label}</span>
                  <span className="detection-toggle-icon">{active ? "●" : "○"}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  if (result.kind === "pose") {
    const keypoints = result.keypoints as PoseKeypoint[];
    const visible = keypoints.filter((kp) => kp.score >= 0.3);
    return (
      <div className="task-results">
        <div className="task-results-header">
          Pose — {visible.length} / 17 keypoints visible
          <span className="task-latency">{result.latencyMs.toFixed(0)} ms</span>
        </div>
        {visible.map((kp) => (
          <div key={kp.name} className="task-result-row">
            <span className="task-result-rank" />
            <span className="task-result-label">{kp.name}</span>
            <div className="task-result-bar-wrap">
              <div className="task-result-bar" style={{ width: fmtScore(kp.score) }} />
            </div>
            <span className="task-result-score">{fmtScore(kp.score)}</span>
          </div>
        ))}
      </div>
    );
  }

  if (result.kind === "segmentation") {
    const mask = result.mask as SegMask;
    // Build list of detected classes (for multi-class masks)
    const presentClasses = new Set<number>();
    for (let i = 0; i < mask.classMap.length; i++) {
      presentClasses.add(mask.classMap[i]);
    }
    const isDeepLab = loadedEntry?.fileName === "deeplabv3.tflite";
    const classLabels = isDeepLab ? DEEPLAB_LABELS : ["background", "person"];
    const colors = isDeepLab ? DEEPLAB_COLORS : [[0,0,0],[128,0,128]] as [number,number,number][];

    return (
      <div className="task-results">
        <div className="task-results-header">
          Segmentation mask ({mask.width}x{mask.height})
          <span className="task-latency">{result.latencyMs.toFixed(0)} ms</span>
        </div>
        <div className="task-seg-legend">
          {Array.from(presentClasses).sort().map((cls) => {
            if (cls === 0) return null; // skip background
            const label = classLabels[cls] ?? `class_${cls}`;
            const color = colors[cls % colors.length] ?? [128, 128, 128];
            return (
              <div key={cls} className="task-seg-legend-item">
                <span
                  className="task-seg-legend-swatch"
                  style={{ background: `rgb(${color[0]},${color[1]},${color[2]})` }}
                />
                <span>{label}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (result.kind === "depth") {
    const dm = result.map as DepthMap;
    let minV = Infinity, maxV = -Infinity;
    for (const v of dm.values) {
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    return (
      <div className="task-results">
        <div className="task-results-header">
          Depth map ({dm.width}x{dm.height})
          <span className="task-latency">{result.latencyMs.toFixed(0)} ms</span>
        </div>
        <div className="task-depth-range">
          <span>Min: {minV.toFixed(3)}</span>
          <span>Max: {maxV.toFixed(3)}</span>
          <span className="task-depth-legend">Blue = near | Red = far</span>
        </div>
      </div>
    );
  }

  if (result.kind === "image-output") {
    return (
      <div className="task-results">
        <div className="task-results-header">
          Output image
          <span className="task-latency">{result.latencyMs.toFixed(0)} ms</span>
        </div>
        <img src={result.dataUrl} className="task-image-output" alt="model output" />
      </div>
    );
  }

  // Raw
  const outputs = result.outputs as RawOutput[];
  return (
    <div className="task-results">
      <div className="task-results-header">
        Raw outputs
        <span className="task-latency">{result.latencyMs.toFixed(0)} ms</span>
      </div>
      {outputs.map((o) => (
        <div key={o.index} className="task-raw-output">
          <span className="task-raw-label">
            output[{o.index}] shape [{o.shape.join(", ")}]
          </span>
          <span className="task-raw-values">
            [{o.preview.map((v) => v.toFixed(4)).join(", ")}{o.length > 20 ? " ..." : ""}]
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

interface Props {
  modelFolder?: string;
  onBack?: () => void;
}

export function TaskModelPanel({ modelFolder, onBack }: Props) {
  const [scanned, setScanned] = useState<ScannedTfliteModel[]>([]);
  const [loadedFile, setLoadedFile] = useState<string | null>(null);
  const [loadedInfo, setLoadedInfo] = useState<ModelInfo | null>(null);
  const [labels, setLabels] = useState<string[] | null>(null);
  const [labelsStatus, setLabelsStatus] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [styleImageUrl, setStyleImageUrl] = useState<string | null>(null);
  const [inferring, setInferring] = useState(false);
  const [result, setResult] = useState<InferenceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [categoryColors, setCategoryColors] = useState<Record<string, string>>({});
  const [categoryEnabled, setCategoryEnabled] = useState<Record<string, boolean>>({});

  // Auto-assign palette colours and default enabled state for new detection labels
  useEffect(() => {
    if (result?.kind !== "detection") return;
    const items = result.items as DetectionResult[];
    const newColors: Record<string, string> = {};
    const newEnabled: Record<string, boolean> = {};
    let idx = Object.keys(categoryColors).length;
    for (const d of items) {
      if (!categoryColors[d.label] && !newColors[d.label]) {
        newColors[d.label] = DETECTION_PALETTE[idx % DETECTION_PALETTE.length];
        idx++;
      }
      if (categoryEnabled[d.label] === undefined && newEnabled[d.label] === undefined) {
        newEnabled[d.label] = true;
      }
    }
    if (Object.keys(newColors).length > 0) setCategoryColors((p) => ({ ...p, ...newColors }));
    if (Object.keys(newEnabled).length > 0) setCategoryEnabled((p) => ({ ...p, ...newEnabled }));
  }, [result]); // eslint-disable-line react-hooks/exhaustive-deps

  // Audio
  const [recording, setRecording] = useState(false);
  const [audioSample, setAudioSample] = useState<Float32Array | null>(null);
  const [audioInfo, setAudioInfo] = useState<{ min: number; max: number; samples: number } | null>(null);

  // Style transfer
  const [styleEmbedding, setStyleEmbedding] = useState<number[] | null>(null);

  // Canvas overlay refs
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const changeImgRef = useRef<HTMLInputElement>(null);

  // Download tracking
  const [downloading, setDownloading] = useState<Record<string, boolean>>({});
  const [dlProgress, setDlProgress] = useState<Record<string, number>>({});
  const [downloaded, setDownloaded] = useState<Set<string>>(new Set());

  const loadedEntry = TASK_CATALOGUE.find((e) => e.fileName === loadedFile);

  // Scan for local .tflite files when the folder changes
  useEffect(() => {
    if (!isTauri() || !modelFolder) return;
    import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke<ScannedTfliteModel[]>("scan_tflite_models", { folder: modelFolder })
        .then(setScanned)
        .catch(() => setScanned([])),
    );
  }, [modelFolder]);

  // Check which catalogue models are already downloaded — re-run on mount
  // and again once Rust's background bundled-model seeding finishes (it
  // doesn't block app startup, so it may still be extracting when this
  // component first mounts).
  useEffect(() => {
    if (!isTauri()) return;
    const refresh = () =>
      import("@tauri-apps/api/core").then(({ invoke }) =>
        Promise.all(
          TASK_CATALOGUE.map(async (e) => {
            const path = await invoke<string | null>("get_model_path", { fileName: e.fileName }).catch(() => null);
            return path ? e.fileName : null;
          }),
        ).then((results) => {
          setDownloaded(new Set(results.filter(Boolean) as string[]));
        }),
      );
    refresh();
    const unlistenPromise = import("@tauri-apps/api/event").then(({ listen }) =>
      listen("bundled-models-seeded", refresh),
    );
    return () => { unlistenPromise.then((unlisten) => unlisten()); };
  }, []);

  // Draw canvas overlay when result changes — deferred to next frame so layout is complete
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    if (!result) {
      canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    let rafId: number;
    const draw = () => {
      const img = imageRef.current;
      const imgRect = img?.getBoundingClientRect();
      const w = imgRect?.width ?? 0;
      const h = imgRect?.height ?? 0;
      if (w === 0 || h === 0) { rafId = requestAnimationFrame(draw); return; }

      // Position the canvas to exactly cover the <img>, not the whole wrap.
      // The wrap may be wider (display:block fills parent) while the img is narrower.
      const wrapRect = canvas.parentElement?.getBoundingClientRect();
      canvas.style.left   = ((imgRect?.left ?? 0) - (wrapRect?.left ?? 0)) + "px";
      canvas.style.top    = ((imgRect?.top  ?? 0) - (wrapRect?.top  ?? 0)) + "px";
      canvas.style.width  = w + "px";
      canvas.style.height = h + "px";
      canvas.width  = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      ctx.font = "bold 12px sans-serif";

    if (result.kind === "detection" && result.items.length > 0) {
      ctx.lineWidth = 2;
      for (const det of result.items) {
        if (categoryEnabled[det.label] === false) continue;
        const color = categoryColors[det.label] ?? "#00e5ff";
        const { x1, y1, x2, y2 } = det.box;
        const rx = x1 * w, ry = y1 * h, rw = (x2 - x1) * w, rh = (y2 - y1) * h;
        ctx.strokeStyle = color;
        ctx.strokeRect(rx, ry, rw, rh);
        const label = `${det.label} ${(det.score * 100).toFixed(0)}%`;
        const tw = ctx.measureText(label).width;
        const labelY = ry >= 18 ? ry : ry + rh + 16;
        ctx.fillStyle = "rgba(0,0,0,0.65)";
        ctx.fillRect(rx, labelY - 16, tw + 6, 16);
        ctx.fillStyle = color;
        ctx.fillText(label, rx + 3, labelY - 3);
      }

    } else if (result.kind === "pose") {
      drawPoseSkeleton(ctx, result.keypoints, w, h);
      // Dashed bbox around the detected person derived from visible keypoints
      const visible = result.keypoints.filter((kp) => kp.score > 0.3);
      if (visible.length > 1) {
        const xs = visible.map((kp) => kp.x);
        const ys = visible.map((kp) => kp.y);
        const pad = 0.04;
        const bx1 = Math.max(0, Math.min(...xs) - pad) * w;
        const by1 = Math.max(0, Math.min(...ys) - pad) * h;
        const bx2 = Math.min(1, Math.max(...xs) + pad) * w;
        const by2 = Math.min(1, Math.max(...ys) + pad) * h;
        ctx.strokeStyle = "rgba(0,229,255,0.45)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(bx1, by1, bx2 - bx1, by2 - by1);
        ctx.setLineDash([]);
        const label = `person ${(Math.max(...visible.map((k) => k.score)) * 100).toFixed(0)}%`;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(bx1, by1 - 16, tw + 6, 16);
        ctx.fillStyle = "#00e5ff";
        ctx.fillText(label, bx1 + 3, by1 - 3);
      }

    } else if (result.kind === "segmentation") {
      const isDeepLab = loadedEntry?.fileName === "deeplabv3.tflite";
      const segColors: [number, number, number][] = isDeepLab
        ? DEEPLAB_COLORS
        : [[0, 0, 0], [128, 0, 128]];
      const segLabels: string[] = isDeepLab ? DEEPLAB_LABELS : ["background", "person"];
      drawSegMask(ctx, result.mask, w, h, segColors);
      // Bounding box per detected (non-background) class
      const { classMap, width: mw, height: mh } = result.mask;
      const bboxes = new Map<number, { x1: number; y1: number; x2: number; y2: number }>();
      for (let py = 0; py < mh; py++) {
        for (let px = 0; px < mw; px++) {
          const cls = classMap[py * mw + px];
          if (cls === 0) continue;
          const bb = bboxes.get(cls) ?? { x1: 1, y1: 1, x2: 0, y2: 0 };
          if (px / mw < bb.x1) bb.x1 = px / mw;
          if (py / mh < bb.y1) bb.y1 = py / mh;
          if (px / mw > bb.x2) bb.x2 = px / mw;
          if (py / mh > bb.y2) bb.y2 = py / mh;
          bboxes.set(cls, bb);
        }
      }
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      for (const [cls, bb] of bboxes) {
        const [r, g, b] = segColors[cls] ?? [180, 180, 180];
        ctx.strokeStyle = `rgb(${r},${g},${b})`;
        const rx = bb.x1 * w, ry = bb.y1 * h;
        ctx.strokeRect(rx, ry, (bb.x2 - bb.x1) * w, (bb.y2 - bb.y1) * h);
        const label = segLabels[cls] ?? `class_${cls}`;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = `rgba(${r},${g},${b},0.75)`;
        ctx.fillRect(rx, ry - 16, tw + 6, 16);
        ctx.fillStyle = "#fff";
        ctx.fillText(label, rx + 3, ry - 3);
      }
      ctx.setLineDash([]);

    } else if (result.kind === "depth") {
      drawDepthHeatmap(ctx, result.map, w, h);
    }
    }; // end draw()

    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [result, loadedEntry, categoryColors, categoryEnabled]);

  const handleDownload = useCallback(async (entry: TaskCatalogEntry) => {
    if (!isTauri() || !entry.downloadUrl) return;
    setDownloading((p) => ({ ...p, [entry.id]: true }));
    setDlProgress((p) => ({ ...p, [entry.id]: 0 }));
    setError(null);
    try {
      const { invoke, listen } = await import("@tauri-apps/api/core").then(async (m) => ({
        invoke: m.invoke,
        listen: (await import("@tauri-apps/api/event")).listen,
      }));
      const unlisten = await listen<{ fraction: number }>("model-download-progress", (e) => {
        setDlProgress((p) => ({ ...p, [entry.id]: e.payload.fraction }));
      });
      await invoke("download_model", {
        modelId: entry.id,
        url: entry.downloadUrl,
        fileName: entry.fileName,
      });
      unlisten();
      setDownloaded((s) => new Set([...s, entry.fileName]));
    } catch (e) {
      setError(`Download failed: ${String(e)}`);
    } finally {
      setDownloading((p) => ({ ...p, [entry.id]: false }));
      setDlProgress((p) => ({ ...p, [entry.id]: 0 }));
    }
  }, []);

  const handleLoad = useCallback(async (entry: TaskCatalogEntry) => {
    setError(null);
    setResult(null);
    setLabels(null);
    setLabelsStatus(null);
    setAudioSample(null);
    setAudioInfo(null);
    setStyleEmbedding(null);
    try {
      if (loadedFile) {
        await unloadTaskModel(loadedFile).catch(() => {});
        setLoadedFile(null);
        setLoadedInfo(null);
      }
      const { invoke } = await import("@tauri-apps/api/core");
      const path = await invoke<string | null>("get_model_path", { fileName: entry.fileName });
      if (!path) { setError("Model file not found — download it first."); return; }
      const info = await loadTaskModel(path, entry.fileName);
      setLoadedFile(entry.fileName);
      setLoadedInfo(info);

      if ((entry.task === "image-classification" || entry.task === "audio-classification") && entry.labelsUrl) {
        setLabelsStatus("loading…");
        try {
          const loaded = await fetchLabels(entry.labelsUrl);
          if (loaded.length > 0) {
            setLabels(loaded);
            setLabelsStatus(`${loaded.filter(Boolean).length} labels loaded`);
          } else {
            setLabels(null);
            setLabelsStatus(`ERROR: label file returned no entries`);
          }
        } catch (e) {
          setLabels(null);
          setLabelsStatus(`ERROR: ${e}`);
        }
      } else if (entry.task === "object-detection") {
        setLabels(COCO_LABELS);
      }
    } catch (e) {
      setError(String(e));
    }
  }, [loadedFile]);

  const handleLoadScanned = useCallback(async (model: ScannedTfliteModel) => {
    setError(null);
    setResult(null);
    setLabels(null);
    setLabelsStatus(null);
    setAudioSample(null);
    setAudioInfo(null);
    setStyleEmbedding(null);
    try {
      if (loadedFile) {
        await unloadTaskModel(loadedFile).catch(() => {});
        setLoadedFile(null);
        setLoadedInfo(null);
      }
      const info = await loadTaskModel(model.path, model.name);
      setLoadedFile(model.name);
      setLoadedInfo(info);
    } catch (e) {
      setError(String(e));
    }
  }, [loadedFile]);

  const handleUnload = useCallback(async () => {
    if (!loadedFile) return;
    await unloadTaskModel(loadedFile).catch(() => {});
    setLoadedFile(null);
    setLoadedInfo(null);
    setLabels(null);
    setLabelsStatus(null);
    setResult(null);
    setAudioSample(null);
    setAudioInfo(null);
  }, [loadedFile]);

  const [audioFileName, setAudioFileName] = useState<string | null>(null);
  const audioFileRef = useRef<HTMLInputElement>(null);

  const applyAudioSamples = (samples: Float32Array, name?: string) => {
    setAudioSample(samples);
    setAudioFileName(name ?? null);
    let minV = Infinity, maxV = -Infinity;
    for (const v of samples) {
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    setAudioInfo({ min: minV, max: maxV, samples: samples.length });
  };

  const handleRecord = useCallback(async () => {
    setRecording(true);
    setError(null);
    try {
      const samples = await captureAudioSample(975);
      applyAudioSamples(samples, "microphone");
    } catch (e) {
      setError(`Recording failed: ${String(e)}`);
    } finally {
      setRecording(false);
    }
  }, []);

  const handleAudioFile = useCallback(async (file: File) => {
    setError(null);
    try {
      const { loadAudioFileAsSamples } = await import("../lib/taskModels");
      const samples = await loadAudioFileAsSamples(file);
      applyAudioSamples(samples, file.name);
    } catch (e) {
      setError(`Failed to load audio file: ${String(e)}`);
    }
  }, []);

  const handleLoadPaired = useCallback(async () => {
    if (!loadedEntry?.pairedFileName) return;
    const pairedEntry = TASK_CATALOGUE.find((e) => e.fileName === loadedEntry.pairedFileName);
    if (!pairedEntry) return;
    if (!downloaded.has(pairedEntry.fileName)) {
      setError(`Paired model not downloaded yet: ${pairedEntry.name}`);
      return;
    }
    await handleLoad(pairedEntry);
  }, [loadedEntry, downloaded, handleLoad]);

  const handleInfer = useCallback(async () => {
    if (!loadedFile || !loadedInfo) return;
    setInferring(true);
    setError(null);
    setResult(null);
    try {
      const entry = TASK_CATALOGUE.find((e) => e.fileName === loadedFile);
      const task = entry?.task ?? "custom";
      const normalizeMode = entry?.normalizeMode ?? "zero-one";
      // loadedInfo.inputShapes is empty on Android (loadModel doesn't report
      // it there) — fall back to the catalogue's known-correct shape before
      // the generic 224x224 guess, which is wrong for most non-classifier
      // models (MoveNet is 192x192, BlazeFace 128x128, etc).
      const [, h, w] = loadedInfo.inputShapes[0] ?? entry?.inputShape ?? [1, 224, 224, 3];
      const inputTypes = entry?.inputDtype === "uint8" ? (["uint8"] as const) : undefined;

      // ── Audio classification ───────────────────────────────────────────────
      if (task === "audio-classification") {
        if (!audioSample) { setError("Record an audio sample first."); setInferring(false); return; }
        const flat = Array.from(audioSample);
        const { outputs, outputShapes, latencyMs } = await runTaskInference(loadedFile, [flat]);
        if (outputs[0] && labels?.length) {
          setResult({ kind: "audio", items: topKClassifications(outputs[0], labels, 5), latencyMs });
        } else {
          setResult({ kind: "raw", outputs: summariseOutputs(outputs, outputShapes), latencyMs });
        }
        return;
      }

      // ── Text QA ───────────────────────────────────────────────────────────
      if (task === "text-qa") {
        const seqLen = (loadedInfo.inputShapes[0] ?? [1, 384])[1] ?? 384;
        const zeros = Array<number>(seqLen).fill(0);
        // MobileBERT expects 4 input tensors: input_ids, input_mask, segment_ids, ...
        const numInputs = loadedInfo.inputShapes.length || 4;
        const inputs = Array.from({ length: numInputs }, () => zeros);
        const { outputs, outputShapes, latencyMs } = await runTaskInference(loadedFile, inputs);
        setResult({ kind: "raw", outputs: summariseOutputs(outputs, outputShapes), latencyMs });
        return;
      }

      // ── Style transfer ────────────────────────────────────────────────────
      if (task === "style-transfer") {
        const isPredict = loadedFile === "style_predict_f16.tflite";
        if (isPredict) {
          // Run style prediction on style image
          const styleSrc = styleImageUrl ?? imageUrl;
          if (!styleSrc) { setError("Drop a style image first."); setInferring(false); return; }
          const tensor = await preprocessImage(styleSrc, h, w, normalizeMode);
          const { outputs, outputShapes, latencyMs } = await runTaskInference(loadedFile, [Array.from(tensor)]);
          if (outputs[0]) {
            setStyleEmbedding(outputs[0]);
            setResult({ kind: "raw", outputs: summariseOutputs(outputs, outputShapes), latencyMs });
          }
        } else {
          // Run style transfer: needs content image + style embedding
          if (!imageUrl) { setError("Drop a content image first."); setInferring(false); return; }
          if (!styleEmbedding) { setError("No style embedding — run Style Prediction first."); setInferring(false); return; }
          const tensor = await preprocessImage(imageUrl, h, w, normalizeMode);
          const { outputs, outputShapes, latencyMs } = await runTaskInference(
            loadedFile,
            [Array.from(tensor), styleEmbedding],
          );
          if (outputs[0] && outputShapes[0]) {
            const outH = outputShapes[0][1] ?? h;
            const outW = outputShapes[0][2] ?? w;
            const dataUrl = tensorToDataUrl(outputs[0], outH, outW);
            setResult({ kind: "image-output", dataUrl, latencyMs });
          } else {
            setResult({ kind: "raw", outputs: summariseOutputs(outputs, outputShapes), latencyMs });
          }
        }
        return;
      }

      // ── Image-based tasks ─────────────────────────────────────────────────
      if (!imageUrl) { setError("Drop an image first."); setInferring(false); return; }
      const tensor = await preprocessImage(imageUrl, h, w, normalizeMode);
      const { outputs, outputShapes, latencyMs } = await runTaskInference(
        loadedFile,
        [Array.from(tensor)],
        inputTypes ? [...inputTypes] : undefined,
      );

      if (task === "image-classification" && outputs[0] && labels?.length) {
        setResult({ kind: "classification", items: topKClassifications(outputs[0], labels, 5), latencyMs });
      } else if (task === "object-detection") {
        const detections = parseDetections(outputs, labels ?? [], 0.3, h, w);
        if (detections !== null) {
          setResult({ kind: "detection", items: detections, latencyMs });
        } else {
          setResult({ kind: "raw", outputs: summariseOutputs(outputs, outputShapes), latencyMs });
        }
      } else if (task === "pose-estimation" && outputs[0]) {
        // MoveNet: first output is [1, 1, 17, 3] flattened to 51 values
        const flat = outputs[0].length === 51 ? outputs[0] : outputs[0];
        setResult({ kind: "pose", keypoints: parsePose(flat), latencyMs });
      } else if (task === "image-segmentation") {
        const mask = parseSegMask(outputs, outputShapes, h, w);
        if (mask) {
          setResult({ kind: "segmentation", mask, latencyMs });
        } else {
          setResult({ kind: "raw", outputs: summariseOutputs(outputs, outputShapes), latencyMs });
        }
      } else if (task === "depth-estimation") {
        const dm = parseDepthMap(outputs, outputShapes);
        if (dm) {
          setResult({ kind: "depth", map: dm, latencyMs });
        } else {
          setResult({ kind: "raw", outputs: summariseOutputs(outputs, outputShapes), latencyMs });
        }
      } else {
        setResult({ kind: "raw", outputs: summariseOutputs(outputs, outputShapes), latencyMs });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setInferring(false);
    }
  }, [loadedFile, imageUrl, styleImageUrl, loadedInfo, labels, audioSample, styleEmbedding]);

  const task = loadedEntry?.task;
  const isAudio = task === "audio-classification";
  const isStyle = task === "style-transfer";
  const isTextQA = task === "text-qa";
  const isVisual = task === "image-classification" || task === "object-detection"
    || task === "pose-estimation" || task === "image-segmentation"
    || task === "depth-estimation";


  const canInfer = loadedInfo && !inferring && (
    isAudio ? !!audioSample :
    isTextQA ? true :
    isStyle && loadedFile === "style_transfer_f16.tflite" ? !!imageUrl :
    isStyle ? !!(styleImageUrl ?? imageUrl) :
    !!imageUrl
  );

  return (
    <div className="task-panel">
      {onBack && (
        <div className="task-top-bar">
          <button className="demo-back" onClick={onBack}>← Back</button>
          <span className="task-top-title">On-Device Task Models</span>
        </div>
      )}
      <div className="task-panel-body">
      {/* Left: catalogue + scanned */}
      <div className="task-catalog-col">
        <div className="task-catalog-header">Suggested models</div>
        {TASK_CATALOGUE.map((entry) => (
          <CatalogCard
            key={entry.id}
            entry={entry}
            isLoaded={loadedFile === entry.fileName}
            isDownloaded={downloaded.has(entry.fileName)}
            onLoad={() => handleLoad(entry)}
            onUnload={handleUnload}
            onDownload={() => handleDownload(entry)}
            downloading={!!downloading[entry.id]}
            downloadProgress={dlProgress[entry.id] ?? null}
          />
        ))}

        {scanned.length > 0 && (
          <>
            <div className="task-catalog-header" style={{ marginTop: 16 }}>Local .tflite files</div>
            {scanned.map((m) => (
              <div
                key={m.path}
                className={`task-scanned-row ${loadedFile === m.name ? "task-scanned-loaded" : ""}`}
                onClick={() => handleLoadScanned(m)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && handleLoadScanned(m)}
              >
                <span className="task-scanned-name">⚙️ {m.name}</span>
                {loadedFile === m.name
                  ? <span className="task-loaded-badge">✓ Loaded</span>
                  : <span className="task-scanned-hint">click to load</span>}
              </div>
            ))}
          </>
        )}
      </div>

      {/* Right: inference area */}
      <div className="task-infer-col">
        {loadedInfo ? (
          <>
            <div className="task-model-info">
              <strong>{loadedEntry?.name ?? loadedFile}</strong>
              <span className="task-info-detail">
                In: [{loadedInfo.inputShapes.map((s) => s.join("x")).join("], [")}]
              </span>
              <span className="task-info-detail">
                Out: [{loadedInfo.outputShapes.map((s) => s.join("x")).join("], [")}]
              </span>
              {loadedEntry?.isPairedModel && (
                <button
                  className="btn-sm"
                  onClick={handleLoadPaired}
                  title={`Load ${loadedEntry.pairedFileName}`}
                >
                  Load paired model
                </button>
              )}
              {labelsStatus && (
                <span className={`task-info-detail ${labelsStatus.startsWith("ERROR") ? "task-labels-error" : ""}`}>
                  Labels: {labelsStatus}
                </span>
              )}
            </div>

            {/* Style embedding status */}
            {isStyle && loadedFile === "style_transfer_f16.tflite" && (
              <div className="task-style-status">
                {styleEmbedding
                  ? `✓ Style embedding ready (${styleEmbedding.length} values)`
                  : "⚠ No style embedding — load Style Prediction and run first."}
              </div>
            )}

            {/* Audio task UI */}
            {isAudio && (
              <div className="task-audio-section">
                <div className="task-audio-inputs">
                  <button
                    className={`task-record-btn ${recording ? "recording" : ""}`}
                    onClick={handleRecord}
                    disabled={recording}
                  >
                    {recording ? "Recording…" : "🎙 Record 1 s"}
                  </button>
                  <span className="task-audio-or">or</span>
                  <button
                    className="task-audio-file-btn"
                    onClick={() => audioFileRef.current?.click()}
                    disabled={recording}
                  >
                    📂 Open audio file
                  </button>
                  <input
                    ref={audioFileRef}
                    type="file"
                    accept="audio/*"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleAudioFile(f);
                      e.target.value = "";
                    }}
                  />
                </div>
                {audioInfo && (
                  <div className="task-audio-info">
                    {audioFileName && <strong>{audioFileName}</strong>}
                    {audioFileName && " · "}
                    {audioInfo.samples} samples · min {audioInfo.min.toFixed(3)} · max {audioInfo.max.toFixed(3)}
                  </div>
                )}
              </div>
            )}

            {/* Style transfer: two drop zones */}
            {isStyle && (
              <div className="task-style-section">
                <ImageDropZone
                  onImage={setImageUrl}
                  imageUrl={imageUrl}
                  label={loadedFile === "style_transfer_f16.tflite" ? "Content image" : "Style image"}
                />
                {loadedFile === "style_transfer_f16.tflite" && (
                  <ImageDropZone
                    onImage={setStyleImageUrl}
                    imageUrl={styleImageUrl}
                    label="Style image (for visual ref)"
                  />
                )}
              </div>
            )}

            {/* Text QA UI */}
            {isTextQA && (
              <div className="task-text-section">
                <p className="task-text-note">
                  Note: This model requires BERT tokenization. Without a tokenizer, raw output is shown.
                </p>
              </div>
            )}

            {/* Image area — always a single stable element to avoid layout shift */}
            {(isVisual || (!isAudio && !isStyle && !isTextQA)) && (
              <div
                className={`task-canvas-wrap ${imageUrl ? "has-image" : "empty"}`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const file = e.dataTransfer.files[0];
                  if (!file?.type.startsWith("image/")) return;
                  const reader = new FileReader();
                  reader.onload = (ev) => {
                    if (ev.target?.result) { setImageUrl(ev.target.result as string); setResult(null); setCategoryEnabled({}); }
                  };
                  reader.readAsDataURL(file);
                }}
                onClick={() => changeImgRef.current?.click()}
                title={imageUrl ? "Drop or click to change image" : "Drop an image or click to browse"}
                style={{ cursor: "pointer" }}
              >
                {imageUrl ? (
                  <img ref={imageRef} src={imageUrl} className="task-preview-img" alt="input" />
                ) : (
                  <div className="task-drop-hint">
                    <span>🖼️</span>
                    <span>Drop an image or click to browse</span>
                  </div>
                )}
                <canvas ref={overlayCanvasRef} className="task-overlay-canvas" />
                <input
                  ref={changeImgRef}
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                      if (ev.target?.result) { setImageUrl(ev.target.result as string); setResult(null); setCategoryEnabled({}); }
                    };
                    reader.readAsDataURL(f);
                    e.target.value = "";
                  }}
                />
              </div>
            )}

            <button
              className="btn primary task-run-btn"
              onClick={handleInfer}
              disabled={!canInfer}
            >
              {inferring ? "Running..." : "▶ Run inference"}
            </button>

            {error && <div className="task-error">{error}</div>}
            {result && (
              <ResultsDisplay
                result={result}
                loadedEntry={loadedEntry}
                categoryColors={categoryColors}
                categoryEnabled={categoryEnabled}
                onColorChange={(label, color) => setCategoryColors((prev) => ({ ...prev, [label]: color }))}
                onToggleCategory={(label) => setCategoryEnabled((prev) => ({ ...prev, [label]: prev[label] === false }))}
              />
            )}

            {/* Style output side-by-side */}
            {result?.kind === "image-output" && imageUrl && (
              <div className="task-style-output-wrap">
                <div>
                  <div className="task-drop-label">Content</div>
                  <img src={imageUrl} className="task-image-output" alt="content" />
                </div>
                <div>
                  <div className="task-drop-label">Stylised</div>
                  <img src={result.dataUrl} className="task-image-output" alt="stylised output" />
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="task-empty-state">
            <span>👈</span>
            <p>Download and load a model to start.</p>
            {error && <div className="task-error">{error}</div>}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
