import { useState, useEffect, useRef, useCallback } from "react";
import { loadModel, unloadModel, runInference } from "tauri-plugin-litert-api";
import { preprocessImage, parseDetections, COCO_LABELS, TASK_CATALOGUE } from "../lib/taskModels";
import type { DetectionResult } from "../lib/taskModels";
import {
  listCropDiseases, getCropDisease, saveCropDisease, deleteCropDisease, searchCropDiseases,
  saveImageAsBlob, loadImageFromBlob, getDiseaseProfile,
} from "../lib/db";
import { SYNC_COLLECTIONS } from "../lib/db";
import type { CropDiseaseRecord, CropType, LeafResult, DiseaseProfile } from "../lib/types";
import { isTauri } from "../lib/llm";
import { SyncPanel } from "./SyncPanel";

// ── Constants ─────────────────────────────────────────────────────────────────

const DETECTOR_ENTRY = TASK_CATALOGUE.find((e) => e.id === "efficientdet-lite2")!;
const DETECTOR_MODEL_ID = "crop-disease-detector";
const CLASSIFIER_MODEL_ID = "crop-disease-classifier";
const CLASSIFIER_FILENAME = "disease_classifier.tflite";

const CROP_OPTIONS: { value: CropType; label: string; icon: string }[] = [
  { value: "tomato",  label: "Tomato",  icon: "🍅" },
  { value: "potato",  label: "Potato",  icon: "🥔" },
  { value: "apple",   label: "Apple",   icon: "🍎" },
  { value: "corn",    label: "Corn",    icon: "🌽" },
  { value: "grape",   label: "Grape",   icon: "🍇" },
  { value: "other",   label: "Other",   icon: "🌿" },
];

// PlantVillage 38-class labels — order matches LABEL_MAP in training/classifier/config.py.
// Must stay in sync with the labels.txt produced by export.py.
export const DISEASE_LABELS: string[] = [
  "Apple Scab", "Apple Black Rot", "Apple Cedar Rust", "Apple Healthy",
  "Blueberry Healthy",
  "Cherry Powdery Mildew", "Cherry Healthy",
  "Corn Cercospora Leaf Spot", "Corn Common Rust", "Corn Northern Leaf Blight", "Corn Healthy",
  "Grape Black Rot", "Grape Esca", "Grape Leaf Blight", "Grape Healthy",
  "Orange Haunglongbing",
  "Peach Bacterial Spot", "Peach Healthy",
  "Bell Pepper Bacterial Spot", "Bell Pepper Healthy",
  "Potato Early Blight", "Potato Late Blight", "Potato Healthy",
  "Raspberry Healthy",
  "Soybean Healthy",
  "Squash Powdery Mildew",
  "Strawberry Leaf Scorch", "Strawberry Healthy",
  "Tomato Bacterial Spot", "Tomato Early Blight", "Tomato Late Blight",
  "Tomato Leaf Mold", "Tomato Septoria Leaf Spot", "Tomato Spider Mites",
  "Tomato Target Spot", "Tomato Yellow Leaf Curl Virus", "Tomato Mosaic Virus",
  "Tomato Healthy",
];

// Maps each of the 38 PlantVillage class indices to a plant type.
// Must stay in sync with DISEASE_LABELS order.
const CLASS_PLANT: string[] = [
  "Apple","Apple","Apple","Apple",                          //  0-3
  "Blueberry",                                              //  4
  "Cherry","Cherry",                                        //  5-6
  "Corn","Corn","Corn","Corn",                              //  7-10
  "Grape","Grape","Grape","Grape",                          // 11-14
  "Orange",                                                 // 15
  "Peach","Peach",                                          // 16-17
  "Bell Pepper","Bell Pepper",                              // 18-19
  "Potato","Potato","Potato",                               // 20-22
  "Raspberry",                                              // 23
  "Soybean",                                                // 24
  "Squash",                                                 // 25
  "Strawberry","Strawberry",                                // 26-27
  "Tomato","Tomato","Tomato","Tomato","Tomato",             // 28-32
  "Tomato","Tomato","Tomato","Tomato","Tomato",             // 33-37
];

/**
 * Two-stage probabilistic classification from a single 38-class softmax output.
 *
 * Stage 1 — Plant identification:
 *   P(plant) = Σ scores[i] for all i where CLASS_PLANT[i] === plant
 *   (marginal probability; correct because softmax scores are calibrated probs)
 *
 * Stage 2 — Disease identification:
 *   P(disease | plant) = scores[i] / P(plant)
 *   Pick argmax within the identified plant's classes.
 *
 * This fixes "tomato misidentified as bell pepper": 9 tomato classes aggregate
 * more evidence than 2 bell pepper classes even when individual tomato disease
 * scores are lower.
 */
function identifyPlantDisease(scores: number[]): {
  plant: string; plantConfidence: number;
  disease: string; diseaseConfidence: number;
} {
  // Stage 1: marginalise over disease classes to get P(plant)
  const plantTotals: Record<string, number> = {};
  for (let i = 0; i < scores.length; i++) {
    const p = CLASS_PLANT[i] ?? "Unknown";
    plantTotals[p] = (plantTotals[p] ?? 0) + (scores[i] ?? 0);
  }
  const [plant, plantConfidence] = Object.entries(plantTotals)
    .sort((a, b) => b[1] - a[1])[0] ?? ["", 0];

  // Stage 2: best disease within that plant (conditional probability)
  let bestIdx = -1, bestScore = -1;
  for (let i = 0; i < scores.length; i++) {
    if (CLASS_PLANT[i] === plant && (scores[i] ?? 0) > bestScore) {
      bestIdx = i; bestScore = scores[i] ?? 0;
    }
  }
  const fullLabel = bestIdx >= 0 ? DISEASE_LABELS[bestIdx] : "";
  const disease = fullLabel.startsWith(plant)
    ? fullLabel.slice(plant.length).trim() || "Healthy"
    : fullLabel;
  const diseaseConfidence = plantConfidence > 0 ? bestScore / plantConfidence : 0;

  return { plant, plantConfidence, disease, diseaseConfidence };
}

function diseaseColor(label: string): string {
  return label.endsWith("Healthy") ? "#22c55e" : label ? "#ef4444" : "#f59e0b";
}

/** Maps a classifier-identified plant (CLASS_PLANT) to the Crop selector's CropType.
 *  Plants the classifier knows but the form doesn't have a chip for (Blueberry,
 *  Cherry, Orange, Peach, Bell Pepper, Raspberry, Soybean, Squash, Strawberry)
 *  fall back to "other". */
function cropTypeForPlant(plant: string): CropType {
  const known: Record<string, CropType> = {
    tomato: "tomato", potato: "potato", apple: "apple", corn: "corn", grape: "grape",
  };
  return known[plant.trim().toLowerCase()] ?? "other";
}

function uid() { return `cd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }

function relativeTime(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

// ── plantkb reference lookup ─────────────────────────────────────────────────
//
// Maps a classifier (plant, disease) label pair to the plantkb document id,
// e.g. ("Tomato", "Late Blight") → "tomato_late_blight". Must stay in sync
// with disease_profile_id()/slugify() in plantkb/src/agronomy_pipeline/ids.py —
// both lowercase and replace whitespace with underscores, nothing fancier.
function diseaseIdForLabel(plant: string, disease: string): string {
  const cropSlug = plant.trim().toLowerCase().replace(/\s+/g, "_");
  if (!disease || disease.toLowerCase() === "healthy") return `${cropSlug}_healthy`;
  const diseaseSlug = disease.trim().toLowerCase().replace(/\s+/g, "_");
  return `${cropSlug}_${diseaseSlug}`;
}

/**
 * Looks up plantkb reference profiles (symptoms/treatment/evidence) for every
 * distinct diagnosed disease among `leaves`. Healthy leaves are skipped — the
 * reference card only has something useful to add for an actual diagnosis.
 * Results are cached across calls so re-scanning the same disease is free.
 */
function useDiseaseProfiles(leaves: LeafResult[]): Record<string, DiseaseProfile | null> {
  const [profiles, setProfiles] = useState<Record<string, DiseaseProfile | null>>({});
  const ids = [...new Set(
    leaves
      .filter((l) => l.disease && l.disease.toLowerCase() !== "healthy")
      .map((l) => diseaseIdForLabel(l.plant, l.disease)),
  )];
  const idsKey = ids.join("|");

  useEffect(() => {
    const missing = ids.filter((id) => !(id in profiles));
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        missing.map(async (id) => {
          const doc = await getDiseaseProfile(id).catch(() => null);
          return [id, doc && doc.type === "disease_profile" ? doc : null] as const;
        }),
      );
      if (cancelled) return;
      setProfiles((prev) => {
        const next = { ...prev };
        for (const [id, doc] of entries) next[id] = doc;
        return next;
      });
    })();
    return () => { cancelled = true; };
    // Re-fetch only when the *set* of needed ids changes — `profiles` is read
    // for incremental caching, not as a re-fetch trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  return profiles;
}

// ── Canvas overlay (read-only bounding boxes) ─────────────────────────────────

interface OverlayProps {
  imageUrl: string;
  leaves: LeafResult[];
  pending?: DetectionResult[];
}

function LeafOverlay({ imageUrl, leaves, pending = [] }: OverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef       = useRef<HTMLImageElement>(null);
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const [imgLoaded, setImgLoaded] = useState(0);

  function getImgRect() {
    const canvas = canvasRef.current; const img = imgRef.current;
    if (!canvas || !img) return null;
    const cr = canvas.getBoundingClientRect(); const ir = img.getBoundingClientRect();
    return { left: ir.left - cr.left, top: ir.top - cr.top, width: ir.width, height: ir.height };
  }

  useEffect(() => {
    const canvas = canvasRef.current; const container = containerRef.current;
    if (!canvas || !container) return;
    const W = container.clientWidth; const H = container.clientHeight;
    if (!W || !H) return;
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, W, H);

    const ir = getImgRect();
    const iL = ir?.left ?? 0; const iT = ir?.top ?? 0;
    const iW = ir?.width ?? W; const iH = ir?.height ?? H;

    const drawBox = (
      x1: number, y1: number, x2: number, y2: number,
      color: string, label: string, dashed = false,
    ) => {
      const px = iL + x1 * iW, py = iT + y1 * iH;
      const pw = (x2 - x1) * iW,  ph = (y2 - y1) * iH;
      ctx.setLineDash(dashed ? [6, 3] : []);
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      ctx.strokeRect(px, py, pw, ph);
      if (label) {
        ctx.font = "bold 11px sans-serif";
        const tw = ctx.measureText(label).width + 8;
        const ty = py > 18 ? py - 18 : py + ph;
        ctx.fillStyle = color; ctx.fillRect(px, ty, tw, 16);
        ctx.fillStyle = "#fff"; ctx.fillText(label, px + 4, ty + 11);
      }
      ctx.setLineDash([]);
    };

    // Pending detections (amber dashed — stage 1 complete, stage 2 pending)
    for (const d of pending) {
      const { x1, y1, x2, y2 } = d.box;
      drawBox(x1, y1, x2, y2, "#f59e0b", `${d.label} ${Math.round(d.score * 100)}%`, true);
    }
    // Confirmed leaves with disease labels
    for (const l of leaves) {
      const { x1, y1, x2, y2 } = l.box;
      const color = diseaseColor(l.disease);
      const label = l.disease
        ? `${l.plant ? l.plant + " · " : ""}${l.disease} ${Math.round(l.diseaseConfidence * 100)}%`
        : `leaf ${Math.round(l.leafConfidence * 100)}%`;
      drawBox(x1, y1, x2, y2, color, label);
    }
  }, [leaves, pending, imgLoaded]);

  return (
    <div ref={containerRef} className="cd-overlay-wrap">
      <img
        ref={imgRef}
        className="cd-overlay-img"
        src={imageUrl}
        alt="Crop scan"
        draggable={false}
        onLoad={() => setImgLoaded((n) => n + 1)}
      />
      <canvas ref={canvasRef} className="cd-overlay-canvas" />
    </div>
  );
}

// ── plantkb reference card ───────────────────────────────────────────────────

function DiseaseReferenceCard({ profile }: { profile: DiseaseProfile }) {
  const sci = profile.taxonomy.scientific_name.value;
  const pathogenType = profile.taxonomy.pathogen_type.value;
  const treatments = [
    ...profile.treatment.organic.map((t) => ({ ...t, kind: "organic" as const })),
    ...profile.treatment.chemical.map((t) => ({ ...t, kind: "chemical" as const })),
    ...profile.treatment.cultural.map((t) => ({ ...t, kind: "cultural" as const })),
  ];

  return (
    <div className="cd-reference-card">
      <div className="cd-reference-header">
        <div>
          <p className="cd-reference-title">{sci || pathogenType || "Reference info"}</p>
          {(pathogenType || profile.severity.value) && (
            <p className="cd-reference-subtitle">
              {pathogenType}
              {pathogenType && profile.severity.value ? " · " : ""}
              {profile.severity.value && `${profile.severity.value} severity`}
            </p>
          )}
        </div>
        <span className="cd-reference-badge" title="Source-extraction confidence — not a diagnosis confidence">
          {Math.round(profile.confidence.overall * 100)}%
        </span>
      </div>

      {profile.review.status !== "expert_reviewed" && (
        <p className="cd-reference-disclaimer">
          ⚠ Machine-extracted from public sources
          {profile.review.status === "needs_review" ? " — verify before applying any chemical treatment." : "."}
        </p>
      )}

      {profile.symptoms.length > 0 && (
        <div className="cd-reference-section">
          <p className="cd-reference-section-title">Symptoms</p>
          <ul className="cd-reference-list">
            {profile.symptoms.map((s, i) => <li key={i}>{s.description}</li>)}
          </ul>
        </div>
      )}

      {treatments.length > 0 && (
        <div className="cd-reference-section">
          <p className="cd-reference-section-title">Treatment</p>
          <ul className="cd-reference-list">
            {treatments.map((t, i) => (
              <li key={i}>
                <span className={`cd-reference-tag cd-reference-tag--${t.kind}`}>{t.kind}</span> {t.name}
              </li>
            ))}
          </ul>
        </div>
      )}

      {profile.prevention.length > 0 && (
        <div className="cd-reference-section">
          <p className="cd-reference-section-title">Prevention</p>
          <ul className="cd-reference-list">
            {profile.prevention.map((p, i) => <li key={i}>{p.description}</li>)}
          </ul>
        </div>
      )}

      {profile.sources.length > 0 && (
        <p className="cd-reference-sources">
          Source{profile.sources.length > 1 ? "s" : ""}:{" "}
          {profile.sources.map((s, i) => (
            <span key={s.url}>
              {i > 0 && ", "}
              <a href={s.url} target="_blank" rel="noreferrer">{s.name}</a>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

/** Renders one DiseaseReferenceCard per distinct diagnosed disease among `leaves`. */
function DiseaseReferencePanel({
  leaves, profiles,
}: { leaves: LeafResult[]; profiles: Record<string, DiseaseProfile | null> }) {
  const ids = [...new Set(
    leaves
      .filter((l) => l.disease && l.disease.toLowerCase() !== "healthy")
      .map((l) => diseaseIdForLabel(l.plant, l.disease)),
  )];
  const found = ids.map((id) => profiles[id]).filter((p): p is DiseaseProfile => !!p);
  if (found.length === 0) return null;
  return (
    <div className="cd-reference-panel">
      {found.map((p) => <DiseaseReferenceCard key={p.id} profile={p} />)}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

type CDView = "list" | "scan" | "detail";

interface Props { onBack: () => void; }

export function CropDisease({ onBack }: Props) {
  const [view, setView]         = useState<CDView>("list");
  const [records, setRecords]   = useState<CropDiseaseRecord[]>([]);
  const [loading, setLoading]   = useState(true);
  const [searchQ, setSearchQ]   = useState("");

  // Scan form
  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(null);
  const [cropType, setCropType]         = useState<CropType>("tomato");
  const [location, setLocation]         = useState("");
  const [notes, setNotes]               = useState("");
  const [pendingDets, setPendingDets]   = useState<DetectionResult[]>([]);
  const [leaves, setLeaves]             = useState<LeafResult[]>([]);
  const [phase, setPhase]               = useState<"idle" | "detecting" | "classifying" | "saving">("idle");
  const [hasClassifier, setHasClassifier] = useState<boolean | null>(null);
  const [errorMsg, setErrorMsg]         = useState<string | null>(null);

  // Detail
  const [detailRecord, setDetailRecord] = useState<CropDiseaseRecord | null>(null);
  const [detailPhoto, setDetailPhoto]   = useState<string | null>(null);

  // plantkb reference lookups — covers whichever leaf set is on screen (scan
  // results or a saved record's leaves), keyed by distinct diagnosed disease.
  const activeLeaves = view === "detail" ? (detailRecord?.leaves ?? []) : leaves;
  const diseaseProfiles = useDiseaseProfiles(activeLeaves);

  const galleryRef = useRef<HTMLInputElement>(null);
  const cameraRef  = useRef<HTMLInputElement>(null);

  const reload = useCallback(async (q = "") => {
    setLoading(true);
    try {
      setRecords(q.trim() ? await searchCropDiseases(q) : await listCropDiseases());
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const handleSearch = (q: string) => { setSearchQ(q); reload(q); };

  const openDetail = async (id: string) => {
    const rec = await getCropDisease(id);
    if (!rec) return;
    setDetailRecord(rec);
    setDetailPhoto(null);
    setView("detail");
    if (rec.photoRef) {
      const url = await loadImageFromBlob(rec.photoRef);
      setDetailPhoto(url);
    }
  };

  const handleDelete = async () => {
    if (!detailRecord || !confirm("Delete this scan?")) return;
    await deleteCropDisease(detailRecord.id);
    setView("list");
    setDetailRecord(null);
    reload();
  };

  const resetScan = () => {
    setPhotoDataUrl(null); setCropType("tomato"); setLocation(""); setNotes("");
    setPendingDets([]); setLeaves([]); setPhase("idle"); setErrorMsg(null);
    setHasClassifier(null);
  };

  const handleFile = (file: File) => {
    const r = new FileReader();
    r.onload = (e) => { setPhotoDataUrl(e.target?.result as string); setPendingDets([]); setLeaves([]); setErrorMsg(null); };
    r.readAsDataURL(file);
  };

  // ── Crop each detected leaf from the source image ──────────────────────────
  async function cropLeaf(
    sourceDataUrl: string,
    box: { y1: number; x1: number; y2: number; x2: number },
  ): Promise<string> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const pad = 0.05;
        const x1 = Math.max(0, box.x1 - pad) * img.width;
        const y1 = Math.max(0, box.y1 - pad) * img.height;
        const x2 = Math.min(1, box.x2 + pad) * img.width;
        const y2 = Math.min(1, box.y2 + pad) * img.height;
        const c = document.createElement("canvas");
        c.width = 224; c.height = 224;
        c.getContext("2d")!.drawImage(img, x1, y1, x2 - x1, y2 - y1, 0, 0, 224, 224);
        resolve(c.toDataURL("image/jpeg", 0.9));
      };
      img.src = sourceDataUrl;
    });
  }

  const runScan = useCallback(async () => {
    if (!photoDataUrl || !isTauri()) return;
    setErrorMsg(null); setPendingDets([]); setLeaves([]);

    // ── Stage 1: Leaf detection ───────────────────────────────────────────────
    setPhase("detecting");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const detPath = await invoke<string | null>("get_model_path", { fileName: DETECTOR_ENTRY.fileName }).catch(() => null);
      if (!detPath) {
        setErrorMsg("EfficientDet-Lite0 not found — download it from Task Models first.");
        setPhase("idle"); return;
      }
      await loadModel({ modelId: DETECTOR_MODEL_ID, modelPath: detPath, accelerator: "cpu" });
      let dets: DetectionResult[] = [];
      try {
        const shape = DETECTOR_ENTRY.inputShape as [number, number, number, number];
        const tensor = await preprocessImage(photoDataUrl, shape[1], shape[2], DETECTOR_ENTRY.normalizeMode);
        const result = await runInference({ modelId: DETECTOR_MODEL_ID, inputs: [Array.from(tensor)] });
        dets = parseDetections(result.outputs, COCO_LABELS, 0.15, shape[1], shape[2]) ?? [];
      } finally {
        await unloadModel(DETECTOR_MODEL_ID).catch(() => {});
      }
      if (dets.length === 0) {
        // No objects found — treat the whole image as a single leaf crop.
        // This is the right path for PlantVillage-style photos where the leaf
        // already fills the frame and COCO object detection adds no value.
        dets = [{ label: "leaf", score: 1, box: { x1: 0, y1: 0, x2: 1, y2: 1 } }];
      }
      setPendingDets(dets);

      // ── Stage 2: Disease classification per crop ──────────────────────────
      setPhase("classifying");
      const { invoke: inv2 } = await import("@tauri-apps/api/core");
      const clsPath = await inv2<string | null>("get_model_path", { fileName: CLASSIFIER_FILENAME }).catch(() => null);
      setHasClassifier(!!clsPath);

      const results: LeafResult[] = [];
      if (clsPath) {
        const { topKClassifications } = await import("../lib/taskModels");
        await loadModel({ modelId: CLASSIFIER_MODEL_ID, modelPath: clsPath, accelerator: "cpu" });
        try {
          for (const d of dets) {
            const crop = await cropLeaf(photoDataUrl, d.box);
            // Model re-exported without Rescaling layer (XNNPACK produced NaN with it).
            // Backbone expects [-1,1] directly; send neg-one-one normalised input.
            const tensor = await preprocessImage(crop, 224, 224, "neg-one-one");
            const out = await runInference({ modelId: CLASSIFIER_MODEL_ID, inputs: [Array.from(tensor)] });
            const rawOut = out.outputs[0] ?? [];
            console.log("[CropDisease] raw[0..4]:", rawOut.slice(0, 4), "sum:", rawOut.reduce((a: number, b: number) => a + (b ?? 0), 0).toFixed(3));
            const top3 = topKClassifications(rawOut, DISEASE_LABELS, 3);
            console.log("[CropDisease] top3:", top3.map(r => `${r.label}=${(r.score ?? 0).toFixed(3)}`).join(", "));
            const { plant, plantConfidence, disease, diseaseConfidence } = identifyPlantDisease(rawOut);
            console.log(`[CropDisease] plant=${plant}(${plantConfidence.toFixed(3)}) disease=${disease}(${diseaseConfidence.toFixed(3)})`);
            results.push({
              box: d.box, leafConfidence: d.score,
              plant, plantConfidence, disease, diseaseConfidence,
            });
          }
        } finally {
          await unloadModel(CLASSIFIER_MODEL_ID).catch(() => {});
        }
      } else {
        for (const d of dets) {
          results.push({ box: d.box, leafConfidence: d.score, plant: "", plantConfidence: 0, disease: "", diseaseConfidence: 0 });
        }
      }
      // Sort by plant confidence descending; drop results where the model is
      // essentially guessing (below 60% plant confidence) UNLESS it's the only
      // result or all results are below threshold.
      const PLANT_CONF_MIN = 0.60;
      const sorted = [...results].sort((a, b) => b.plantConfidence - a.plantConfidence);
      const confident = sorted.filter(r => r.plantConfidence >= PLANT_CONF_MIN);
      setPendingDets([]);
      setLeaves(confident.length > 0 ? confident : sorted);
      // Auto-select the Crop chip from the most plant-confident detection.
      if (sorted[0]?.plant && sorted[0].plantConfidence > 0) {
        setCropType(cropTypeForPlant(sorted[0].plant));
      }
    } catch (e) {
      setErrorMsg(String(e));
    }
    setPhase("idle");
  }, [photoDataUrl]);

  const handleSave = useCallback(async () => {
    setPhase("saving"); setErrorMsg(null);
    try {
      const photoRef = photoDataUrl ? await saveImageAsBlob(photoDataUrl) : "";
      const now = new Date().toISOString();
      const rec: CropDiseaseRecord = {
        id: uid(), createdAt: now, updatedAt: now,
        photoRef, cropType, location, notes, leaves, synced: false,
      };
      await saveCropDisease(rec);
      resetScan(); await reload(); setView("list");
    } catch (e) {
      setErrorMsg(String(e)); setPhase("idle");
    }
  }, [photoDataUrl, cropType, location, notes, leaves, reload]);

  const cropInfo = (c: CropType) => CROP_OPTIONS.find((o) => o.value === c)!;
  const diseaseCount = (leaves: LeafResult[]) => leaves.filter((l) => l.disease && !l.disease.endsWith("Healthy")).length;

  // ── List ──────────────────────────────────────────────────────────────────

  if (view === "list") return (
    <div className="demo-screen cd-screen">
      <header className="demo-header">
        <button className="demo-back" onClick={onBack}>← Back</button>
        <div className="demo-header-text">
          <h1 className="demo-title">Crop Disease Detection</h1>
          <p className="demo-subtitle">Two-stage edge AI: leaf detection → disease classification · offline · CouchbaseLite</p>
        </div>
        <SyncPanel
          collection={SYNC_COLLECTIONS.cropDisease.primary}
          onActivity={(a) => { if (a === "idle" || a === "stopped") reload(); }}
        />
        <button className="demo-action-btn" onClick={() => { resetScan(); setView("scan"); }}>+ New Scan</button>
      </header>

      <div className="cd-pipeline-banner">
        <span className="cd-pipeline-step cd-step-1">📷 Photo</span>
        <span className="cd-pipeline-arrow">→</span>
        <span className="cd-pipeline-step">🔍 Leaf Detector <em>(EfficientDet-Lite0)</em></span>
        <span className="cd-pipeline-arrow">→</span>
        <span className="cd-pipeline-step">✂️ Crop each leaf</span>
        <span className="cd-pipeline-arrow">→</span>
        <span className="cd-pipeline-step">🧬 Disease Classifier <em>(MobileNetV3)</em></span>
        <span className="cd-pipeline-arrow">→</span>
        <span className="cd-pipeline-step">📊 Result</span>
      </div>

      <div className="inspect-list-body">
        <div className="inspect-search-row">
          <input className="inspect-search" type="search" placeholder="Search scans…"
            value={searchQ} onChange={(e) => handleSearch(e.target.value)} />
          <span className="inspect-count">{records.length} scan{records.length !== 1 ? "s" : ""}</span>
        </div>
        {loading ? (
          <div className="inspect-empty">Loading…</div>
        ) : records.length === 0 ? (
          <div className="inspect-empty">
            <span>🌿</span>
            <p>{searchQ ? "No results." : "No scans yet. Tap + New Scan to begin."}</p>
          </div>
        ) : (
          <div className="cd-record-grid">
            {records.map((r) => {
              const ci = cropInfo(r.cropType);
              const sick = diseaseCount(r.leaves);
              return (
                <button key={r.id} className="cd-record-card" onClick={() => openDetail(r.id)}>
                  {r.photoRef && <img className="cd-record-thumb" src={r.photoRef.startsWith("cbl-blob:") ? undefined : r.photoRef} alt="" />}
                  <div className="cd-record-body">
                    <p className="cd-record-crop">{ci.icon} {ci.label}</p>
                    <p className="cd-record-loc">{r.location || "No location"}</p>
                    <div className="cd-record-stats">
                      <span className="cd-stat">{r.leaves.length} leaf{r.leaves.length !== 1 ? "ves" : ""}</span>
                      {sick > 0
                        ? <span className="cd-stat cd-stat--sick">⚠ {sick} diseased</span>
                        : r.leaves.length > 0
                          ? <span className="cd-stat cd-stat--ok">✓ All healthy</span>
                          : null}
                    </div>
                    <p className="cd-record-time">{relativeTime(r.createdAt)}</p>
                  </div>
                  {!r.synced && <span className="inspect-sync-dot" title="Not synced" />}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  // ── Scan ──────────────────────────────────────────────────────────────────

  if (view === "scan") return (
    <div className="demo-screen cd-screen">
      <header className="demo-header">
        <button className="demo-back" onClick={() => { resetScan(); setView("list"); }}>← List</button>
        <div className="demo-header-text">
          <h1 className="demo-title">New Scan</h1>
          <p className="demo-subtitle">Detect leaves → classify diseases, fully on-device</p>
        </div>
      </header>

      {errorMsg && <div className="demo-error" style={{ margin: "0 1.25rem 0.5rem" }}>{errorMsg}</div>}

      <div className="cd-scan-body">
        {/* Left: form */}
        <div className="cd-form-col">
          <section className="inspect-form-section inspect-form-row">
            <div className="inspect-form-field">
              <label className="inspect-form-label">Crop</label>
              <div className="inspect-chip-row">
                {CROP_OPTIONS.map(({ value, label, icon }) => (
                  <button key={value}
                    className={`fitness-chip ${cropType === value ? "active" : ""}`}
                    onClick={() => setCropType(value)}
                  >{icon} {label}</button>
                ))}
              </div>
            </div>
          </section>

          <section className="inspect-form-section">
            <label className="inspect-form-label">Location</label>
            <input className="inspect-input" placeholder="e.g. Field 3B — Row 12"
              value={location} onChange={(e) => setLocation(e.target.value)} />
          </section>

          <section className="inspect-form-section">
            <label className="inspect-form-label">Notes</label>
            <textarea className="inspect-textarea" rows={3}
              placeholder="Observations — watering schedule, previous treatments, weather conditions…"
              value={notes} onChange={(e) => setNotes(e.target.value)} />
          </section>

          <section className="inspect-form-section">
            <label className="inspect-form-label">Photo</label>
            {!photoDataUrl ? (
              <div className="demo-dropzone" onClick={() => galleryRef.current?.click()}>
                <span className="demo-dropzone-icon">🌿</span>
                <p>Photo of the crop leaves</p>
                <div className="demo-dropzone-actions">
                  <button className="btn-sm" onClick={(e) => { e.stopPropagation(); galleryRef.current?.click(); }}>Gallery</button>
                  {isTauri() && (
                    <button className="btn-sm secondary" onClick={(e) => { e.stopPropagation(); cameraRef.current?.click(); }}>Camera</button>
                  )}
                </div>
              </div>
            ) : (
              <div className="inspect-thumb-actions">
                <button className="btn-sm secondary" onClick={() => { setPhotoDataUrl(null); setPendingDets([]); setLeaves([]); }}>Change photo</button>
              </div>
            )}
          </section>

          <section className="inspect-form-section inspect-actions">
            <button className="btn-sm secondary" onClick={runScan}
              disabled={!photoDataUrl || phase !== "idle" || !isTauri()}>
              {phase === "detecting" ? "Stage 1: Detecting leaves…"
                : phase === "classifying" ? "Stage 2: Classifying diseases…"
                : "⚡ Run scan"}
            </button>
            <button className="demo-action-btn" onClick={handleSave}
              disabled={phase !== "idle" || (!photoDataUrl && leaves.length === 0)}>
              {phase === "saving" ? "Saving…" : "Save scan"}
            </button>
            {!isTauri() && <p className="demo-notice">Inference requires the native app.</p>}
          </section>

          {hasClassifier === false && leaves.length > 0 && (
            <div className="cd-classifier-notice">
              💡 <strong>{CLASSIFIER_FILENAME}</strong> not found — leaf positions shown, disease labels unavailable.
              Train a MobileNetV3 classifier on PlantVillage data (Phase 4 of the plan) and place it in your model folder.
            </div>
          )}
        </div>

        {/* Right: photo + overlay + results */}
        <div className="cd-preview-col">
          {photoDataUrl ? (
            <>
              <LeafOverlay imageUrl={photoDataUrl} leaves={leaves} pending={pendingDets} />
              {(leaves.length > 0 || pendingDets.length > 0) && (
                <div className="cd-results-list">
                  <p className="cd-results-title">
                    {leaves.length > 0 ? `${leaves.length} leaf${leaves.length !== 1 ? "ves" : ""} detected` : `${pendingDets.length} detection${pendingDets.length !== 1 ? "s" : ""}…`}
                  </p>
                  {leaves.map((l, i) => (
                    <div key={i} className="cd-leaf-row">
                      <span className="cd-leaf-num">#{i + 1}</span>
                      <span className="cd-leaf-conf">{Math.round(l.leafConfidence * 100)}%</span>
                      {l.disease
                        ? <span className="cd-leaf-disease">
                            {l.plant && (
                              <span className="cd-leaf-plant" style={{ opacity: l.plantConfidence < 0.60 ? 0.5 : 1 }}>
                                🌿 {l.plant} <em>{Math.round(l.plantConfidence * 100)}%</em>
                                {l.plantConfidence < 0.60 && " ⚠"}
                                {" · "}
                              </span>
                            )}
                            <span style={{ color: diseaseColor(l.disease) }}>
                              {l.disease} <em>{Math.round(l.diseaseConfidence * 100)}%</em>
                            </span>
                          </span>
                        : <span className="cd-leaf-disease cd-leaf-disease--pending">
                            — needs {CLASSIFIER_FILENAME}
                          </span>}
                    </div>
                  ))}
                  <DiseaseReferencePanel leaves={leaves} profiles={diseaseProfiles} />
                </div>
              )}
            </>
          ) : (
            <div className="inspect-preview-empty">Photo + detection results appear here</div>
          )}
        </div>
      </div>

      <input ref={galleryRef} type="file" accept="image/*" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
    </div>
  );

  // ── Detail ────────────────────────────────────────────────────────────────

  if (view === "detail" && detailRecord) {
    const ci = cropInfo(detailRecord.cropType);
    const sick = diseaseCount(detailRecord.leaves);
    return (
      <div className="demo-screen cd-screen">
        <header className="demo-header">
          <button className="demo-back" onClick={() => { setView("list"); setDetailRecord(null); setDetailPhoto(null); }}>← List</button>
          <div className="demo-header-text">
            <h1 className="demo-title">{ci.icon} {ci.label} · {detailRecord.location || "No location"}</h1>
            <p className="demo-subtitle">{relativeTime(detailRecord.createdAt)} · {detailRecord.leaves.length} leaves · {sick > 0 ? `${sick} diseased` : "all healthy"}</p>
          </div>
          <button className="btn-sm danger" onClick={handleDelete}>Delete</button>
        </header>

        <div className="cd-detail-body">
          <div className="cd-detail-main">
            {detailPhoto
              ? <LeafOverlay imageUrl={detailPhoto} leaves={detailRecord.leaves} />
              : <div className="inspect-preview-empty">Loading photo…</div>}

            {detailRecord.notes && (
              <div className="cd-detail-notes">
                <p className="inspect-detail-section-title">Notes</p>
                <p>{detailRecord.notes}</p>
              </div>
            )}
          </div>

          <div className="cd-detail-sidebar">
            <p className="cd-results-title">Leaf Results ({detailRecord.leaves.length})</p>
            {detailRecord.leaves.length === 0
              ? <p className="demo-notice">No leaves were detected in this scan.</p>
              : detailRecord.leaves.map((l, i) => (
                  <div key={i} className="cd-leaf-row">
                    <span className="cd-leaf-num">#{i + 1}</span>
                    <span className="cd-leaf-conf">{Math.round(l.leafConfidence * 100)}%</span>
                    {l.disease
                      ? <span className="cd-leaf-disease">
                          {l.plant && (
                            <span className="cd-leaf-plant">
                              🌿 {l.plant} <em>{Math.round(l.plantConfidence * 100)}%</em>{" · "}
                            </span>
                          )}
                          <span style={{ color: diseaseColor(l.disease) }}>
                            {l.disease} <em>{Math.round(l.diseaseConfidence * 100)}%</em>
                          </span>
                        </span>
                      : <span className="cd-leaf-disease cd-leaf-disease--pending">unclassified</span>}
                  </div>
                ))
            }

            {sick > 0 && (
              <div className="cd-disease-summary">
                {[...new Set(detailRecord.leaves.filter((l) => l.disease && !l.disease.endsWith("Healthy")).map((l) => l.disease))].map((d) => (
                  <div key={d} className="cd-disease-chip" style={{ borderColor: diseaseColor(d) + "80", color: diseaseColor(d) }}>
                    ⚠ {d}
                  </div>
                ))}
              </div>
            )}

            <DiseaseReferencePanel leaves={detailRecord.leaves} profiles={diseaseProfiles} />
          </div>
        </div>
      </div>
    );
  }

  return null;
}
