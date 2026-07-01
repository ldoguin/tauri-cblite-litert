import { useState, useEffect, useRef, useCallback } from "react";
import { loadModel, unloadModel, runInference } from "tauri-plugin-litert-api";
import { preprocessImage, parseDetections, COCO_LABELS, TASK_CATALOGUE } from "../lib/taskModels";
import type { DetectionResult } from "../lib/taskModels";
import {
  saveAnnotation, listAnnotations, deleteAnnotation,
  searchAnnotations, listAnnotationsWithEmbeddings,
  saveImageAsBlob, loadImageFromBlob,
} from "../lib/db";
import { embed, cosineSimilarity } from "../lib/rag";
import type { AnnotationRecord, AnnotationBox, AnnotationStatus } from "../lib/types";
import { isTauri } from "../lib/llm";
import { SyncPanel } from "./SyncPanel";
import { SYNC_COLLECTIONS } from "../lib/db";

const DETECT_ENTRY = TASK_CATALOGUE.find((e) => e.id === "efficientdet-lite0")!;
const DETECT_MODEL_ID = "annot-efficientdet";

const STATUS_LABELS: Record<AnnotationStatus, string> = {
  unannotated: "Unannotated", "in-progress": "In Progress", done: "Done", review: "Review",
};
const STATUS_COLORS: Record<AnnotationStatus, string> = {
  unannotated: "#6b7280", "in-progress": "#f59e0b", done: "#22c55e", review: "#8b5cf6",
};

const BOX_COLORS = [
  "#ef4444","#f97316","#eab308","#22c55e","#06b6d4",
  "#6366f1","#ec4899","#8b5cf6","#14b8a6","#f59e0b",
];
function labelColor(label: string): string {
  let h = 0;
  for (const c of label) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return BOX_COLORS[h % BOX_COLORS.length];
}

const MIN_BOX = 0.02;

function uid() { return `ann-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }
function boxUid() { return `box-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }

function makeThumbnail(dataUrl: string, size = 240): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(size / img.width, size / img.height);
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", 0.75));
    };
    img.src = dataUrl;
  });
}

function exportCoco(records: AnnotationRecord[]): string {
  const catNames = [...new Set(records.flatMap((r) => (r.boxes ?? []).map((b) => b.label)))].sort();
  const catMap = Object.fromEntries(catNames.map((n, i) => [n, i + 1]));
  const categories = catNames.map((name, i) => ({ id: i + 1, name, supercategory: "object" }));
  const images = records.map((r, i) => ({
    id: i + 1, file_name: r.id + ".jpg",
    date_captured: r.createdAt,
  }));
  let annId = 1;
  const annotations = records.flatMap((r, imgIdx) =>
    (r.boxes ?? []).map((b) => ({
      id: annId++, image_id: imgIdx + 1,
      category_id: catMap[b.label] ?? 0,
      bbox: [b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1],
      area: (b.x2 - b.x1) * (b.y2 - b.y1),
      segmentation: [], iscrowd: 0,
      annotator: b.annotatorId, source: b.source,
    }))
  );
  return JSON.stringify({ info: { description: "CouchbaseLite Annotator export", date: new Date().toISOString() }, images, annotations, categories }, null, 2);
}

interface Props {
  onBack: () => void;
  embedModelId?: string;
}

// ── Sub-component: canvas bounding box editor ─────────────────────────────

interface EditorProps {
  imageUrl: string;
  boxes: AnnotationBox[];
  suggestions: DetectionResult[];
  labelSet: string[];
  annotatorId: string;
  onBoxesChange: (boxes: AnnotationBox[]) => void;
}

function BoxEditor({ imageUrl, boxes, suggestions, labelSet, annotatorId, onBoxesChange }: EditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [imgLoaded, setImgLoaded] = useState(0);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const [liveBox, setLiveBox] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [pendingBox, setPendingBox] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [pendingLabel, setPendingLabel] = useState("");
  const labelInputRef = useRef<HTMLInputElement>(null);

  // Returns the image's rect relative to the canvas top-left corner.
  // The canvas covers the full container; the image may be smaller and centered.
  function getImgRect() {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return null;
    const cr = canvas.getBoundingClientRect();
    const ir = img.getBoundingClientRect();
    return { left: ir.left - cr.left, top: ir.top - cr.top, width: ir.width, height: ir.height };
  }

  // Redraw canvas whenever anything changes
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const W = container.clientWidth;
    const H = container.clientHeight;
    if (!W || !H) return;
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, W, H);

    // Map image-relative [0,1] coords to canvas pixels, accounting for letterbox.
    const ir = getImgRect();
    const iL = ir?.left ?? 0;
    const iT = ir?.top ?? 0;
    const iW = ir?.width ?? W;
    const iH = ir?.height ?? H;

    const drawRect = (x1: number, y1: number, x2: number, y2: number, color: string, dashed: boolean, label: string, dim?: string) => {
      const px = iL + x1 * iW, py = iT + y1 * iH, pw = (x2 - x1) * iW, ph = (y2 - y1) * iH;
      ctx.setLineDash(dashed ? [6, 3] : []);
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      ctx.strokeRect(px, py, pw, ph);
      if (label) {
        const text = dim ? `${label} ${dim}` : label;
        ctx.font = "bold 11px sans-serif";
        const tw = ctx.measureText(text).width + 8;
        const ty = py > 18 ? py - 18 : py + ph;
        ctx.fillStyle = color;
        ctx.fillRect(px, ty, tw, 16);
        ctx.fillStyle = "#fff";
        ctx.fillText(text, px + 4, ty + 11);
      }
    };

    // Suggestions (dashed amber)
    for (const s of suggestions) {
      const { x1, y1, x2, y2 } = s.box;
      drawRect(x1, y1, x2, y2, "#f59e0b", true, s.label, `${Math.round(s.score * 100)}%`);
    }
    // Confirmed boxes
    for (const b of boxes) {
      drawRect(b.x1, b.y1, b.x2, b.y2, labelColor(b.label), false, b.label,
        b.source === "model" ? "✓" : b.annotatorId ? `@${b.annotatorId}` : "");
    }
    // Pending box (green dashed)
    if (pendingBox) {
      ctx.setLineDash([5, 3]);
      ctx.strokeStyle = "#22c55e"; ctx.lineWidth = 2;
      const { x1, y1, x2, y2 } = pendingBox;
      ctx.strokeRect(iL + x1 * iW, iT + y1 * iH, (x2 - x1) * iW, (y2 - y1) * iH);
    }
    // Live drag (blue translucent)
    if (liveBox) {
      const { x1, y1, x2, y2 } = liveBox;
      const px = iL + x1 * iW, py = iT + y1 * iH, pw = (x2 - x1) * iW, ph = (y2 - y1) * iH;
      ctx.setLineDash([4, 2]); ctx.strokeStyle = "#6c8ef5"; ctx.lineWidth = 2;
      ctx.fillStyle = "rgba(108,142,245,0.10)";
      ctx.fillRect(px, py, pw, ph);
      ctx.strokeRect(px, py, pw, ph);
    }
    ctx.setLineDash([]);
  }, [boxes, suggestions, liveBox, pendingBox, imgLoaded]);

  function coords(e: React.MouseEvent<HTMLCanvasElement>) {
    const r = canvasRef.current!.getBoundingClientRect();
    const ir = getImgRect();
    const iL = ir?.left ?? 0;
    const iT = ir?.top ?? 0;
    const iW = ir?.width ?? r.width;
    const iH = ir?.height ?? r.height;
    const x = Math.max(0, Math.min(1, (e.clientX - r.left - iL) / iW));
    const y = Math.max(0, Math.min(1, (e.clientY - r.top - iT) / iH));
    return { x, y };
  }

  function hitBox(x: number, y: number): AnnotationBox | undefined {
    return [...boxes].reverse().find((b) => x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2);
  }

  function hitSuggestion(x: number, y: number): DetectionResult | undefined {
    return suggestions.find((s) => x >= s.box.x1 && x <= s.box.x2 && y >= s.box.y1 && y <= s.box.y2);
  }

  function onMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    e.preventDefault();
    const { x, y } = coords(e);
    if (hitBox(x, y) || hitSuggestion(x, y)) return; // handled by click
    dragStart.current = { x, y };
  }

  function onMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!dragStart.current) return;
    const { x, y } = coords(e);
    const { x: x0, y: y0 } = dragStart.current;
    setLiveBox({ x1: Math.min(x0, x), y1: Math.min(y0, y), x2: Math.max(x0, x), y2: Math.max(y0, y) });
  }

  function onMouseUp(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!dragStart.current) return;
    const { x, y } = coords(e);
    const start = dragStart.current;
    dragStart.current = null;
    setLiveBox(null);
    const box = { x1: Math.min(start.x, x), y1: Math.min(start.y, y), x2: Math.max(start.x, x), y2: Math.max(start.y, y) };
    if (box.x2 - box.x1 < MIN_BOX || box.y2 - box.y1 < MIN_BOX) return;
    setPendingBox(box);
    setPendingLabel("");
    setTimeout(() => labelInputRef.current?.focus(), 50);
  }

  function onClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const { x, y } = coords(e);
    const hit = hitSuggestion(x, y);
    if (hit) {
      // Accept suggestion → add as human box
      const newBox: AnnotationBox = {
        id: boxUid(), label: hit.label,
        x1: hit.box.x1, y1: hit.box.y1, x2: hit.box.x2, y2: hit.box.y2,
        source: "model", annotatorId,
      };
      onBoxesChange([...boxes, newBox]);
      return;
    }
    const hitB = hitBox(x, y);
    if (hitB) {
      if (confirm(`Delete box: "${hitB.label}"?`)) {
        onBoxesChange(boxes.filter((b) => b.id !== hitB.id));
      }
    }
  }

  function confirmBox() {
    if (!pendingBox || !pendingLabel.trim()) { setPendingBox(null); return; }
    const newBox: AnnotationBox = {
      id: boxUid(), label: pendingLabel.trim(),
      ...pendingBox, source: "human", annotatorId,
    };
    onBoxesChange([...boxes, newBox]);
    setPendingBox(null);
    setPendingLabel("");
  }

  return (
    <div className="annot-editor">
      <div ref={containerRef} className="annot-canvas-wrap">
        <img ref={imgRef} className="annot-img" src={imageUrl} alt="annotation target" draggable={false} onLoad={() => setImgLoaded((n) => n + 1)} />
        <canvas
          ref={canvasRef}
          className="annot-canvas"
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onClick={onClick}
        />
      </div>
      {suggestions.length > 0 && (
        <p className="annot-hint">
          💡 <strong>{suggestions.length}</strong> model suggestion{suggestions.length !== 1 ? "s" : ""} (dashed) — click to accept · drag to draw your own
        </p>
      )}
      {!suggestions.length && !pendingBox && (
        <p className="annot-hint">Drag to draw a bounding box · click a box label to delete</p>
      )}
      {pendingBox && (
        <div className="annot-label-row">
          <span className="annot-label-prompt">Label:</span>
          <input
            ref={labelInputRef}
            className="inspect-input annot-label-input"
            list="annot-datalist"
            placeholder="Type label…"
            value={pendingLabel}
            onChange={(e) => setPendingLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") confirmBox();
              if (e.key === "Escape") { setPendingBox(null); setPendingLabel(""); }
            }}
          />
          <datalist id="annot-datalist">
            {labelSet.map((l) => <option key={l} value={l} />)}
          </datalist>
          <button className="demo-action-btn" onClick={confirmBox}>Add</button>
          <button className="btn-sm" onClick={() => { setPendingBox(null); setPendingLabel(""); }}>✕</button>
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────

export function DatasetAnnotator({ onBack, embedModelId }: Props) {
  const [records, setRecords] = useState<AnnotationRecord[]>([]);
  const [view, setView] = useState<"queue" | "annotate">("queue");
  const [current, setCurrent] = useState<AnnotationRecord | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<AnnotationBox[]>([]);
  const [suggestions, setSuggestions] = useState<DetectionResult[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [similar, setSimilar] = useState<AnnotationRecord[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<AnnotationStatus | "all">("all");
  const [annotatorId, setAnnotatorId] = useState(() => localStorage.getItem("annot-id") ?? "");
  const [importing, setImporting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [labelSet, setLabelSet] = useState<string[]>([
    "person","car","truck","bus","bicycle","motorcycle","dog","cat",
    "chair","table","laptop","phone","bottle","book","bag",
  ]);
  const [newLabel, setNewLabel] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const loadRecords = useCallback(async () => {
    if (query.trim()) {
      setRecords(await searchAnnotations(query.trim()));
    } else if (statusFilter !== "all") {
      setRecords(await listAnnotations(statusFilter));
    } else {
      setRecords(await listAnnotations());
    }
  }, [query, statusFilter]);

  useEffect(() => { loadRecords(); }, [loadRecords]);

  useEffect(() => {
    const t = setTimeout(loadRecords, 300);
    return () => clearTimeout(t);
  }, [query, loadRecords]);

  async function openRecord(rec: AnnotationRecord) {
    setCurrent(rec);
    setBoxes(rec.boxes ?? []);
    setSuggestions([]);
    setDirty(false);
    setView("annotate");
    const url = await loadImageFromBlob(rec.imageRef);
    setImageUrl(url ?? rec.thumb);
    // Find similar
    const all = await listAnnotationsWithEmbeddings();
    const ref = all.find((r) => r.id === rec.id);
    if (ref?.embedding?.length) {
      const scored = all
        .filter((r) => r.id !== rec.id && r.status === "unannotated" && (r.embedding?.length ?? 0) > 0)
        .map((r) => ({ r, s: cosineSimilarity(ref.embedding, r.embedding) }))
        .filter((x) => x.s >= 0.45)
        .sort((a, b) => b.s - a.s)
        .slice(0, 6);
      setSimilar(scored.map((x) => x.r));
    } else {
      setSimilar([]);
    }
  }

  async function saveRecord(status?: AnnotationStatus) {
    if (!current) return;
    const labels = [...new Set(boxes.map((b) => b.label))];
    const updated: AnnotationRecord = {
      ...current,
      boxes,
      labels,
      status: status ?? (boxes.length > 0 ? "in-progress" : current.status),
      annotatorId,
      updatedAt: new Date().toISOString(),
      synced: false,
    };
    await saveAnnotation(updated);
    setCurrent(updated);
    setDirty(false);
    await loadRecords();
  }

  async function markDone() {
    await saveRecord("done");
  }

  const handleImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    e.target.value = "";
    setImporting(true);
    for (const file of files) {
      const dataUrl: string = await new Promise((res) => {
        const r = new FileReader(); r.onload = () => res(r.result as string); r.readAsDataURL(file);
      });
      const thumb = await makeThumbnail(dataUrl);
      let embedding: number[] = [];
      try { embedding = await embed(file.name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " "), embedModelId); } catch { /* skip */ }
      const photoRef = await saveImageAsBlob(dataUrl);
      const rec: AnnotationRecord = {
        id: uid(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        imageRef: photoRef, thumb, labels: [], embedding, boxes: [],
        status: "unannotated", annotatorId, synced: false,
      };
      await saveAnnotation(rec);
    }
    setImporting(false);
    await loadRecords();
  }, [annotatorId, embedModelId, loadRecords]);

  async function autoPropose() {
    if (!imageUrl || !isTauri()) return;
    setSuggesting(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const modelPath = await invoke<string | null>("get_model_path", { fileName: DETECT_ENTRY.fileName }).catch(() => null);
      if (!modelPath) { alert("EfficientDet-Lite0 not found. Download it from Task Models first."); return; }
      await loadModel({ modelId: DETECT_MODEL_ID, modelPath, accelerator: "cpu" });
      try {
        const shape = DETECT_ENTRY.inputShape as [number, number, number, number];
        const tensor = await preprocessImage(imageUrl, shape[1], shape[2], DETECT_ENTRY.normalizeMode);
        const result = await runInference({ modelId: DETECT_MODEL_ID, inputs: [Array.from(tensor)] });
        const dets = parseDetections(result.outputs, COCO_LABELS, 0.3, shape[1], shape[2]) ?? [];
        setSuggestions(dets);
        // Auto-expand label set
        const newLabels = dets.map((d) => d.label).filter((l) => !labelSet.includes(l));
        if (newLabels.length) setLabelSet((prev) => [...new Set([...prev, ...newLabels])]);
      } finally {
        await unloadModel(DETECT_MODEL_ID).catch(() => {});
      }
    } catch (e) { console.error("Auto-propose failed", e); }
    setSuggesting(false);
  }

  function acceptAllSuggestions() {
    const newBoxes: AnnotationBox[] = suggestions.map((s) => ({
      id: boxUid(), label: s.label,
      x1: s.box.x1, y1: s.box.y1, x2: s.box.x2, y2: s.box.y2,
      source: "model" as const, annotatorId,
    }));
    setBoxes((prev) => [...prev, ...newBoxes]);
    setSuggestions([]);
    setDirty(true);
  }

  function handleBoxesChange(newBoxes: AnnotationBox[]) {
    setBoxes(newBoxes);
    setDirty(true);
  }

  async function handleDelete() {
    if (!current) return;
    if (!confirm("Delete this image and all annotations?")) return;
    await deleteAnnotation(current.id);
    setView("queue");
    setCurrent(null);
    await loadRecords();
  }

  function doExport() {
    const json = exportCoco(records.filter((r) => r.status === "done"));
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `annotations-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const doneCount = records.filter((r) => r.status === "done").length;

  // ── Annotate view ──────────────────────────────────────────────────────────
  if (view === "annotate" && current) {
    return (
      <div className="annot-screen">
        <div className="annot-topbar">
          <button className="demo-back" onClick={async () => {
            if (dirty) await saveRecord();
            setView("queue"); setCurrent(null); setImageUrl(null); setSuggestions([]);
          }}>← Queue</button>
          <span className="annot-topbar-title">{current.id}</span>
          <div className="annot-topbar-actions">
            <button className="btn-sm" onClick={autoPropose} disabled={suggesting || !isTauri()}>
              {suggesting ? "Detecting…" : "⚡ Auto-propose"}
            </button>
            {suggestions.length > 0 && (
              <button className="btn-sm" onClick={acceptAllSuggestions}>Accept all ({suggestions.length})</button>
            )}
            {suggestions.length > 0 && (
              <button className="btn-sm danger" onClick={() => setSuggestions([])}>Clear</button>
            )}
            <button className="demo-action-btn" onClick={markDone} disabled={!boxes.length}>✓ Done</button>
            <button className="btn-sm danger" onClick={handleDelete}>🗑</button>
          </div>
        </div>

        <div className="annot-body">
          <div className="annot-main">
            {imageUrl
              ? <BoxEditor
                  imageUrl={imageUrl} boxes={boxes} suggestions={suggestions}
                  labelSet={labelSet} annotatorId={annotatorId}
                  onBoxesChange={handleBoxesChange}
                />
              : <div className="annot-loading">Loading image…</div>}

            {/* Box list */}
            {boxes.length > 0 && (
              <div className="annot-box-list">
                <p className="annot-box-list-label">Annotations ({boxes.length})</p>
                <div className="annot-box-chips">
                  {boxes.map((b) => (
                    <span key={b.id} className="annot-box-chip" style={{ borderColor: labelColor(b.label) }}>
                      <span className="annot-chip-dot" style={{ background: labelColor(b.label) }} />
                      {b.label}
                      {b.source === "model" && <span className="annot-chip-src">model</span>}
                      <button className="annot-chip-del" onClick={() => {
                        handleBoxesChange(boxes.filter((x) => x.id !== b.id));
                      }}>×</button>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Save / status */}
            <div className="annot-save-row">
              <span className={`annot-status-badge`} style={{ background: STATUS_COLORS[current.status] + "22", color: STATUS_COLORS[current.status], border: `1px solid ${STATUS_COLORS[current.status]}44` }}>
                {STATUS_LABELS[current.status]}
              </span>
              {dirty && <button className="btn-sm" onClick={() => saveRecord()}>Save</button>}
              {!dirty && <span className="annot-saved">✓ Saved</span>}
            </div>
          </div>

          {/* Sidebar: label set + similar */}
          <div className="annot-sidebar">
            <div className="annot-sidebar-section">
              <p className="annot-sidebar-title">Label set</p>
              <div className="annot-label-tags">
                {labelSet.map((l) => (
                  <span key={l} className="annot-label-tag" style={{ borderColor: labelColor(l) + "80" }}>
                    <span className="annot-chip-dot" style={{ background: labelColor(l) }} />{l}
                  </span>
                ))}
              </div>
              <div className="annot-add-label">
                <input className="inspect-input" placeholder="Add label…" value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newLabel.trim()) {
                      setLabelSet((p) => [...new Set([...p, newLabel.trim()])]);
                      setNewLabel("");
                    }
                  }} />
              </div>
            </div>

            {similar.length > 0 && (
              <div className="annot-sidebar-section">
                <p className="annot-sidebar-title">Similar unannotated</p>
                <p className="annot-sidebar-sub">Click to label next — same scene, batch faster.</p>
                <div className="annot-similar-grid">
                  {similar.map((r) => (
                    <button key={r.id} className="annot-similar-card" onClick={async () => {
                      if (dirty) await saveRecord();
                      await openRecord(r);
                    }}>
                      <img src={r.thumb} alt={r.id} />
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="annot-sidebar-section">
              <p className="annot-sidebar-title">Annotator</p>
              <input className="inspect-input" placeholder="Your name…" value={annotatorId}
                onChange={(e) => { setAnnotatorId(e.target.value); localStorage.setItem("annot-id", e.target.value); }} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Queue view ─────────────────────────────────────────────────────────────
  const allStatuses: Array<AnnotationStatus | "all"> = ["all", "unannotated", "in-progress", "done", "review"];

  return (
    <div className="annot-screen">
      <div className="annot-topbar">
        <button className="demo-back" onClick={onBack}>← Back</button>
        <span className="annot-topbar-title">Dataset Annotator</span>
        <div className="annot-topbar-actions">
          {doneCount > 0 && (
            <button className="btn-sm" onClick={doExport}>⬇ COCO JSON ({doneCount})</button>
          )}
          <SyncPanel
            collection={SYNC_COLLECTIONS.annotations.primary}
            onActivity={(a) => { if (a === "idle" || a === "stopped") listAnnotations(statusFilter || undefined).then(setRecords); }}
          />
          <button className="demo-action-btn" onClick={() => fileRef.current?.click()} disabled={importing}>
            {importing ? "Importing…" : "+ Add images"}
          </button>
          <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={handleImport} />
        </div>
      </div>

      <div className="annot-privacy-banner">
        🤖 EfficientDet auto-proposes boxes on-device · Annotations stored in CouchbaseLite · Sync to shared team bucket
      </div>

      <div className="annot-toolbar">
        <div className="annot-search-wrap">
          <input className="inspect-input" placeholder="Search labels (FTS)…"
            value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && <button className="sidebar-search-clear" onClick={() => setQuery("")}>✕</button>}
        </div>
        <div className="annot-status-tabs">
          {allStatuses.map((s) => (
            <button key={s} className={`annot-status-tab ${statusFilter === s ? "active" : ""}`}
              onClick={() => setStatusFilter(s)}>
              {s === "all" ? "All" : STATUS_LABELS[s]}
              {s !== "all" && <span className="annot-tab-count">{records.filter((r) => r.status === s).length || ""}</span>}
            </button>
          ))}
        </div>
        <div className="annot-annotator-row">
          <span className="annot-annotator-label">Annotator:</span>
          <input className="inspect-input annot-annotator-input" placeholder="Your name…"
            value={annotatorId}
            onChange={(e) => { setAnnotatorId(e.target.value); localStorage.setItem("annot-id", e.target.value); }} />
        </div>
      </div>

      {records.length === 0 ? (
        <div className="photo-empty">
          <p className="photo-empty-icon">🏷️</p>
          <p className="photo-empty-title">{query ? "No images match" : "No images yet"}</p>
          {!query && <p className="photo-empty-desc">Add images to start annotating. EfficientDet will auto-propose bounding boxes. Sync shares annotations with the whole team via CouchbaseLite.</p>}
        </div>
      ) : (
        <div className="annot-queue-grid">
          {records.map((r) => (
            <button key={r.id} className="annot-queue-card" onClick={() => openRecord(r)}>
              <img className="annot-queue-thumb" src={r.thumb} alt={r.id} loading="lazy" />
              <div className="annot-queue-footer">
                <span className="annot-status-pill" style={{ color: STATUS_COLORS[r.status] }}>
                  ● {STATUS_LABELS[r.status]}
                </span>
                <span className="annot-box-count">{(r.boxes ?? []).length} box{(r.boxes ?? []).length !== 1 ? "es" : ""}</span>
              </div>
              {(r.labels ?? []).length > 0 && (
                <div className="annot-queue-labels">
                  {r.labels.slice(0, 3).map((l) => (
                    <span key={l} className="annot-queue-label-chip" style={{ borderColor: labelColor(l) + "80", color: labelColor(l) }}>{l}</span>
                  ))}
                  {r.labels.length > 3 && <span className="annot-queue-label-chip">+{r.labels.length - 3}</span>}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
