import { useState, useEffect, useRef, useCallback } from "react";
import { loadModel, unloadModel, runInference } from "tauri-plugin-litert-api";
import { preprocessImage, parseDetections, COCO_LABELS, TASK_CATALOGUE } from "../lib/taskModels";
import {
  savePhoto, listPhotos, deletePhoto, searchPhotos, listPhotosWithEmbeddings,
  listPhotosWithFaces, getPhoto,
  savePerson, listPeople, deletePerson,
  saveImageAsBlob, loadImageFromBlob,
} from "../lib/db";
import { embed, cosineSimilarity } from "../lib/rag";
import type { PhotoDoc, FaceEntry, PersonRecord } from "../lib/types";
import { isTauri } from "../lib/llm";
import { SyncPanel } from "./SyncPanel";
import { SYNC_COLLECTIONS } from "../lib/db";

const DETECT_ENTRY    = TASK_CATALOGUE.find((e) => e.id === "efficientdet-lite0")!;
const BLAZE_ENTRY     = TASK_CATALOGUE.find((e) => e.id === "blaze-face")!;
const ARCFACE_ENTRY   = TASK_CATALOGUE.find((e) => e.id === "arcface-resnet50");
const EFFNET_ENTRY    = TASK_CATALOGUE.find((e) => e.id === "efficientnet-lite2") ?? TASK_CATALOGUE.find((e) => e.id === "efficientnet-lite0");
const DETECT_MODEL_ID   = "photo-efficientdet";
const BLAZE_MODEL_ID    = "photo-blazeface";
const FACE_EMB_MODEL_ID = "photo-facenet";
const DETECT_THRESHOLD = 0.25;
const SIMILAR_THRESHOLD = 0.50;
const SIMILAR_TOP_K = 8;
const FACE_EMB_SIZE = 32;     // 32×32 grayscale pixel fallback (len=1024)
const MIN_FACE_SIZE = 0.05;   // minimum face width AND height as fraction of image

// ArcFace=512-dim metric embeddings (best); EfficientNet=1000-dim classification; pixel=1024-dim fallback
function faceThreshold(emb: number[]) {
  if (emb.length === 512)  return 0.40; // ArcFace — L2-normalised, cosine ~EER at 0.28-0.40
  if (emb.length === 1000) return 0.70; // EfficientNet classification features
  return 0.82;                          // raw pixel fallback
}

const CAPTION_SYSTEM = `You are a concise photo captioning assistant.
Given a list of detected objects, write one natural sentence (max 12 words) describing the scene.
Output only the caption — no quotes, no labels list.`;

type ImportState = "idle" | "detecting" | "faces" | "embedding" | "saving";

interface Props {
  onBack: () => void;
  onCaption?: (userText: string, systemPrompt: string) => Promise<string>;
  embedModelId?: string;
}

function uid() { return `photo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }

function makeThumbnail(dataUrl: string, size = 240): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(size / img.width, size / img.height);
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * s);
      c.height = Math.round(img.height * s);
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", 0.75));
    };
    img.src = dataUrl;
  });
}

function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function faceUid() { return `face-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = src; });
}

function cropTile(img: HTMLImageElement, sx: number, sy: number, sw: number, sh: number, size: number): string {
  const c = document.createElement("canvas"); c.width = c.height = size;
  c.getContext("2d")!.drawImage(img, sx * img.naturalWidth, sy * img.naturalHeight, sw * img.naturalWidth, sh * img.naturalHeight, 0, 0, size, size);
  return c.toDataURL("image/jpeg", 0.9);
}

type RawDet = { box: { x1: number; y1: number; x2: number; y2: number }; score: number };

function detIou(a: RawDet["box"], b: RawDet["box"]): number {
  const ix1 = Math.max(a.x1, b.x1), iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2), iy2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  if (!inter) return 0;
  return inter / ((a.x2-a.x1)*(a.y2-a.y1) + (b.x2-b.x1)*(b.y2-b.y1) - inter);
}

function globalNms(cands: RawDet[], iouThresh = 0.3): RawDet[] {
  const sorted = [...cands].sort((a, b) => b.score - a.score);
  const keep: RawDet[] = [];
  const sup = new Set<number>();
  for (let i = 0; i < sorted.length; i++) {
    if (sup.has(i)) continue;
    keep.push(sorted[i]);
    for (let j = i + 1; j < sorted.length; j++) {
      if (!sup.has(j) && detIou(sorted[i].box, sorted[j].box) > iouThresh) sup.add(j);
    }
  }
  return keep;
}

function cropFaceFromUrl(dataUrl: string, box: { x1: number; y1: number; x2: number; y2: number }): Promise<{ thumb: string; embedding: number[] }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      // Add 15% padding around the box
      const pad = 0.15;
      const pw = (box.x2 - box.x1) * pad;
      const ph = (box.y2 - box.y1) * pad;
      const x = Math.max(0, box.x1 - pw);
      const y = Math.max(0, box.y1 - ph);
      const w = Math.min(1 - x, box.x2 - box.x1 + 2 * pw);
      const h = Math.min(1 - y, box.y2 - box.y1 + 2 * ph);
      const sx = x * img.width, sy = y * img.height, sw = w * img.width, sh = h * img.height;

      // 64×64 display thumbnail
      const tc = document.createElement("canvas"); tc.width = 64; tc.height = 64;
      tc.getContext("2d")!.drawImage(img, sx, sy, sw, sh, 0, 0, 64, 64);
      const thumb = tc.toDataURL("image/jpeg", 0.82);

      // 32×32 grayscale pixel embedding
      const ec = document.createElement("canvas"); ec.width = FACE_EMB_SIZE; ec.height = FACE_EMB_SIZE;
      const ectx = ec.getContext("2d")!;
      ectx.drawImage(img, sx, sy, sw, sh, 0, 0, FACE_EMB_SIZE, FACE_EMB_SIZE);
      const d = ectx.getImageData(0, 0, FACE_EMB_SIZE, FACE_EMB_SIZE).data;
      const vec: number[] = [];
      for (let i = 0; i < d.length; i += 4) {
        vec.push((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255);
      }
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
      resolve({ thumb, embedding: vec.map((v) => v / norm) });
    };
    img.src = dataUrl;
  });
}

async function detectFaces(dataUrl: string): Promise<FaceEntry[]> {
  if (!isTauri() || !BLAZE_ENTRY) return [];
  const { invoke } = await import("@tauri-apps/api/core");

  // Step 1: BlazeFace with tiled detection for better group-photo coverage
  let dets: RawDet[] = [];
  try {
    const blazePath = await invoke<string | null>("get_model_path", { fileName: BLAZE_ENTRY.fileName }).catch(() => null);
    if (!blazePath) return [];
    await loadModel({ modelId: BLAZE_MODEL_ID, modelPath: blazePath, accelerator: "cpu" });
    try {
      const shape = BLAZE_ENTRY.inputShape as [number, number, number, number];
      const H = shape[1], W = shape[2];
      const img = await loadImage(dataUrl);
      const THRESHOLD = 0.50; // lower than before to catch more faces

      // Full image + 2×2 grid with 20% overlap (60% tile size each)
      const tiles: Array<[number, number, number, number]> = [[0, 0, 1, 1]];
      if (img.naturalWidth > 400 || img.naturalHeight > 400) {
        const t = 0.60; // tile fraction
        const s = 1 - t; // step between tile origins = 0.40
        for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 2; tx++) {
          tiles.push([tx * s, ty * s, t, t]);
        }
      }

      const candidates: RawDet[] = [];
      for (const [sx, sy, sw, sh] of tiles) {
        try {
          const tileUrl = cropTile(img, sx, sy, sw, sh, H);
          const tensor = await preprocessImage(tileUrl, H, W, BLAZE_ENTRY.normalizeMode);
          const result = await runInference({ modelId: BLAZE_MODEL_ID, inputs: [Array.from(tensor)] });
          const tileDets = parseDetections(result.outputs, COCO_LABELS, THRESHOLD, H, W) ?? [];
          for (const d of tileDets) {
            // Remap from tile-relative to full-image-relative coordinates
            candidates.push({
              score: d.score,
              box: {
                x1: Math.max(0, sx + d.box.x1 * sw),
                y1: Math.max(0, sy + d.box.y1 * sh),
                x2: Math.min(1, sx + d.box.x2 * sw),
                y2: Math.min(1, sy + d.box.y2 * sh),
              },
            });
          }
        } catch { /* skip tile */ }
      }

      dets = globalNms(candidates, 0.3).filter(
        (d) => (d.box.x2 - d.box.x1) >= MIN_FACE_SIZE && (d.box.y2 - d.box.y1) >= MIN_FACE_SIZE
      );
    } finally {
      await unloadModel(BLAZE_MODEL_ID).catch(() => {});
    }
  } catch { return []; }

  if (dets.length === 0) return [];

  // Step 2: load the best available face embedding model (ArcFace > EfficientNet > pixel)
  let embEntry: typeof ARCFACE_ENTRY | undefined = undefined;
  let embModelReady = false;

  for (const candidate of [ARCFACE_ENTRY, EFFNET_ENTRY]) {
    if (!candidate) continue;
    const p = await invoke<string | null>("get_model_path", { fileName: candidate.fileName }).catch(() => null);
    if (!p) continue;
    try {
      await loadModel({ modelId: FACE_EMB_MODEL_ID, modelPath: p, accelerator: "cpu" });
      embEntry = candidate;
      embModelReady = true;
      break;
    } catch { /* try next */ }
  }

  // Step 3: crop each face and embed
  const faces: FaceEntry[] = [];
  for (const d of dets) {
    const { thumb, embedding: pixelEmb } = await cropFaceFromUrl(dataUrl, d.box);
    let embedding = pixelEmb;

    if (embModelReady && embEntry) {
      try {
        const shape = embEntry.inputShape as [number, number, number, number];
        const tensor = await preprocessImage(thumb, shape[1], shape[2], embEntry.normalizeMode);
        const result = await runInference({ modelId: FACE_EMB_MODEL_ID, inputs: [Array.from(tensor)] });
        const raw = result.outputs[0];
        const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0)) || 1;
        embedding = raw.map((v) => v / norm);
      } catch { /* keep pixel embedding */ }
    }

    faces.push({ id: faceUid(), x1: d.box.x1, y1: d.box.y1, x2: d.box.x2, y2: d.box.y2, thumb, embedding, personId: null, personName: null });
  }

  if (embModelReady) await unloadModel(FACE_EMB_MODEL_ID).catch(() => {});
  return faces;
}

export function PhotoLibrary({ onBack, onCaption, embedModelId }: Props) {
  const [photos, setPhotos] = useState<PhotoDoc[]>([]);
  const [view, setView] = useState<"grid" | "detail">("grid");
  const [detail, setDetail] = useState<PhotoDoc | null>(null);
  const [detailUrl, setDetailUrl] = useState<string | null>(null);
  const [similar, setSimilar] = useState<PhotoDoc[]>([]);
  const [query, setQuery] = useState("");
  const [importState, setImportState] = useState<ImportState>("idle");
  const [importMsg, setImportMsg] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // People tab
  const [tab, setTab] = useState<"photos" | "people">("photos");
  const [allFaces, setAllFaces] = useState<Array<FaceEntry & { photoId: string; photoThumb: string }>>([]);
  const [people, setPeople] = useState<PersonRecord[]>([]);
  const [focusFace, setFocusFace] = useState<(FaceEntry & { photoId: string }) | null>(null);
  const [similarFaces, setSimilarFaces] = useState<Array<FaceEntry & { photoId: string }>>([]);
  const [nameInput, setNameInput] = useState("");
  const [namingSaving, setNamingSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadPhotos = useCallback(async () => {
    setPhotos(await listPhotos());
  }, []);

  const loadPeople = useCallback(async () => {
    const photosWithFaces = await listPhotosWithFaces();
    const faces: Array<FaceEntry & { photoId: string; photoThumb: string }> = [];
    for (const p of photosWithFaces) {
      for (const f of (p.faces ?? [])) {
        faces.push({ ...f, photoId: p.id, photoThumb: p.thumb });
      }
    }
    setAllFaces(faces);
    setPeople(await listPeople());
  }, []);

  useEffect(() => { loadPhotos(); }, [loadPhotos]);

  useEffect(() => {
    if (!query.trim()) { loadPhotos(); return; }
    const t = setTimeout(async () => {
      setPhotos(await searchPhotos(query.trim()));
    }, 300);
    return () => clearTimeout(t);
  }, [query, loadPhotos]);

  useEffect(() => { if (tab === "people") loadPeople(); }, [tab, loadPeople]);

  async function openDetail(photo: PhotoDoc) {
    const all = await listPhotosWithEmbeddings();
    const full = all.find((p) => p.id === photo.id) ?? { ...photo };
    setDetail(full);
    setView("detail");

    const url = await loadImageFromBlob(photo.photoRef);
    setDetailUrl(url ?? photo.thumb);

    if (full.embedding?.length) {
      const others = all.filter((p) => p.id !== full.id && (p.embedding?.length ?? 0) > 0);
      const scored = others
        .map((p) => ({ p, score: cosineSimilarity(full.embedding, p.embedding) }))
        .filter((x) => x.score >= SIMILAR_THRESHOLD)
        .sort((a, b) => b.score - a.score)
        .slice(0, SIMILAR_TOP_K);
      setSimilar(scored.map((x) => x.p));
    } else {
      setSimilar([]);
    }
  }

  function closeDetail() {
    setView("grid");
    setDetail(null);
    setDetailUrl(null);
    setSimilar([]);
  }

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    e.target.value = "";

    // Load EfficientDet once for the whole batch if available
    let modelPath: string | null = null;
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      modelPath = await invoke<string | null>("get_model_path", { fileName: DETECT_ENTRY.fileName }).catch(() => null);
      if (modelPath) await loadModel({ modelId: DETECT_MODEL_ID, modelPath, accelerator: "cpu" }).catch(() => { modelPath = null; });
    }

    // Snapshot of already-named faces for auto-matching during this import batch
    const photosForMatch = await listPhotosWithFaces();
    const knownFaces: Array<{ embedding: number[]; personId: string; personName: string }> = [];
    for (const p of photosForMatch) {
      for (const f of (p.faces ?? [])) {
        if (f.personId && f.personName && f.embedding?.length) {
          knownFaces.push({ embedding: f.embedding, personId: f.personId, personName: f.personName });
        }
      }
    }

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const prefix = files.length > 1 ? `[${i + 1}/${files.length}] ` : "";

      const dataUrl: string = await new Promise((res) => {
        const r = new FileReader();
        r.onload = () => res(r.result as string);
        r.readAsDataURL(file);
      });

      const thumb = await makeThumbnail(dataUrl);
      let labels: string[] = [];
      let scores: number[] = [];

      if (modelPath) {
        setImportState("detecting");
        setImportMsg(`${prefix}Detecting objects…`);
        try {
          const shape = DETECT_ENTRY.inputShape as [number, number, number, number];
          const tensor = await preprocessImage(dataUrl, shape[1], shape[2], DETECT_ENTRY.normalizeMode);
          const result = await runInference({ modelId: DETECT_MODEL_ID, inputs: [Array.from(tensor)] });
          const dets = parseDetections(result.outputs, COCO_LABELS, DETECT_THRESHOLD, shape[1], shape[2]) ?? [];
          labels = dets.map((d) => d.label);
          scores = dets.map((d) => Math.round(d.score * 100) / 100);
        } catch { /* skip */ }
      }

      setImportState("faces");
      setImportMsg(`${prefix}Detecting faces…`);
      const rawFaces = await detectFaces(dataUrl);

      // Auto-assign faces to known people when similarity exceeds threshold
      const faces = rawFaces.map((face) => {
        if (!face.embedding?.length || !knownFaces.length) return face;
        const compatible = knownFaces.filter((k) => k.embedding.length === face.embedding.length);
        if (!compatible.length) return face;
        const best = compatible
          .map((k) => ({ k, s: cosineSimilarity(face.embedding, k.embedding) }))
          .sort((a, b) => b.s - a.s)[0];
        if (best.s >= faceThreshold(face.embedding)) {
          return { ...face, personId: best.k.personId, personName: best.k.personName };
        }
        return face;
      });

      setImportState("embedding");
      setImportMsg(`${prefix}Embedding…`);

      let caption = labels.length
        ? labels.slice(0, 6).join(", ")
        : file.name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");

      if (onCaption && labels.length) {
        try {
          caption = await onCaption(`Detected objects: ${labels.join(", ")}. Write a scene caption.`, CAPTION_SYSTEM);
        } catch { /* label join fallback */ }
      }

      let embedding: number[] = [];
      try { embedding = await embed(caption, embedModelId); } catch { /* skip */ }

      setImportState("saving");
      setImportMsg(`${prefix}Saving…`);

      const photoRef = await saveImageAsBlob(dataUrl);
      await savePhoto({ id: uid(), createdAt: new Date().toISOString(), caption, labels, scores, embedding, photoRef, thumb, faces, synced: false });
    }

    if (modelPath) await unloadModel(DETECT_MODEL_ID).catch(() => {});
    await loadPhotos();
    setImportState("idle");
    setImportMsg("");
  }, [onCaption, embedModelId, loadPhotos]);

  async function pruneOrphanedPeople() {
    const photosWithFaces = await listPhotosWithFaces();
    const referenced = new Set<string>();
    for (const p of photosWithFaces) {
      for (const f of (p.faces ?? [])) { if (f.personId) referenced.add(f.personId); }
    }
    const current = await listPeople();
    await Promise.all(current.filter((p) => !referenced.has(p.id)).map((p) => deletePerson(p.id)));
  }

  async function handleDelete() {
    if (!detail) return;
    await deletePhoto(detail.id);
    await pruneOrphanedPeople();
    closeDetail();
    await loadPhotos();
  }

  function focusOnFace(face: FaceEntry & { photoId: string }) {
    setFocusFace(face);
    setNameInput(face.personName ?? "");
    const threshold = faceThreshold(face.embedding);
    const similar = allFaces
      .filter((f) => f.id !== face.id && (f.embedding?.length ?? 0) === face.embedding.length)
      .map((f) => ({ f, s: cosineSimilarity(face.embedding, f.embedding) }))
      .filter((x) => x.s >= threshold)
      .sort((a, b) => b.s - a.s)
      .slice(0, 8);
    setSimilarFaces(similar.map((x) => x.f));
  }

  async function applyName(forcePersonId?: string) {
    if (!focusFace) return;
    setNamingSaving(true);

    let personId: string;
    let name: string;

    if (forcePersonId) {
      // Reassign to an existing person chosen from the picker
      const person = people.find((p) => p.id === forcePersonId);
      if (!person) { setNamingSaving(false); return; }
      personId = forcePersonId;
      name = person.name;
    } else {
      name = nameInput.trim();
      if (!name) { setNamingSaving(false); return; }
      // Reuse existing person record if the name already exists (case-insensitive)
      const existing = people.find((p) => p.name.toLowerCase() === name.toLowerCase());
      personId = existing?.id ?? `person-${Date.now()}`;
    }

    await savePerson({ id: personId, name, faceThumb: focusFace.thumb, createdAt: new Date().toISOString() });

    // Picker = assign this face only; typing a name = cascade to similar faces
    const affected = forcePersonId ? [focusFace] : [focusFace, ...similarFaces];
    const byPhoto = new Map<string, typeof affected>();
    for (const f of affected) {
      if (!byPhoto.has(f.photoId)) byPhoto.set(f.photoId, []);
      byPhoto.get(f.photoId)!.push(f);
    }
    for (const [photoId, facesToUpdate] of byPhoto) {
      const photo = await getPhoto(photoId);
      if (!photo) continue;
      const faceIds = new Set(facesToUpdate.map((f) => f.id));
      const updatedFaces = (photo.faces ?? []).map((f) =>
        faceIds.has(f.id) ? { ...f, personId, personName: name } : f
      );
      await savePhoto({ ...photo, faces: updatedFaces });
    }

    setNamingSaving(false);
    setFocusFace(null);
    setSimilarFaces([]);
    await loadPeople();
  }

  async function unassignFace() {
    if (!focusFace) return;
    setNamingSaving(true);
    const photo = await getPhoto(focusFace.photoId);
    if (photo) {
      const updatedFaces = (photo.faces ?? []).map((f) =>
        f.id === focusFace.id ? { ...f, personId: null, personName: null } : f
      );
      await savePhoto({ ...photo, faces: updatedFaces });
    }
    setNamingSaving(false);
    setFocusFace(null);
    setSimilarFaces([]);
    await loadPeople();
  }

  async function handleDeleteSelected() {
    if (!selected.size) return;
    await Promise.all([...selected].map((id) => deletePhoto(id)));
    await pruneOrphanedPeople();
    setSelected(new Set());
    setSelectMode(false);
    await loadPhotos();
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelected(new Set());
  }

  const importing = importState !== "idle";


  // ── Detail view ────────────────────────────────────────────────────────────
  if (view === "detail" && detail) {
    return (
      <div className="photo-screen">
        <div className="photo-topbar">
          <button className="demo-back" onClick={closeDetail}>← Grid</button>
          <span className="photo-topbar-title">{detail.caption}</span>
          <button className="photo-delete-btn" onClick={handleDelete} title="Delete">🗑</button>
        </div>

        <div className="photo-detail-body">
          <div className="photo-detail-img-wrap" style={{ position: "relative" }}>
            {detailUrl
              ? <img className="photo-detail-img" src={detailUrl} alt={detail.caption} />
              : <div className="photo-detail-placeholder">Loading…</div>}
            {/* Face overlays */}
            {(detail.faces ?? []).map((f) => (
              <div key={f.id} className="photo-face-box" style={{
                left: `${f.x1 * 100}%`, top: `${f.y1 * 100}%`,
                width: `${(f.x2 - f.x1) * 100}%`, height: `${(f.y2 - f.y1) * 100}%`,
              }}>
                {f.personName && <span className="photo-face-label">{f.personName}</span>}
              </div>
            ))}
          </div>

          <div className="photo-detail-meta">
            <p className="photo-detail-time">{relativeTime(detail.createdAt)}</p>
            <p className="photo-detail-caption">{detail.caption}</p>

            {detail.labels.length > 0 && (
              <div className="photo-label-chips">
                {detail.labels.map((l, i) => (
                  <span key={l} className="photo-label-chip">
                    {l}
                    {detail.scores[i] !== undefined && (
                      <span className="photo-label-score">{Math.round(detail.scores[i] * 100)}%</span>
                    )}
                  </span>
                ))}
              </div>
            )}

            <div className="photo-detail-badges">
              {detail.embedding?.length > 0 && <span className="clin-vec-badge">⚡ Vector indexed</span>}
              <span className={`inspect-sync-badge ${detail.synced ? "synced" : "local"}`}>
                {detail.synced ? "✓ Synced" : "○ Local only"}
              </span>
            </div>
          </div>

          {similar.length > 0 && (
            <div className="photo-similar">
              <p className="photo-similar-label">Similar photos</p>
              <div className="photo-similar-strip">
                {similar.map((p) => (
                  <button key={p.id} className="photo-similar-thumb" onClick={() => openDetail(p)}>
                    <img src={p.thumb} alt={p.caption} title={p.caption} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── People tab ─────────────────────────────────────────────────────────────
  if (tab === "people") {
    // Group faces by personId for named people; collect unknowns
    const namedMap = new Map<string, { person: PersonRecord; faces: typeof allFaces }>();
    const unknowns: typeof allFaces = [];
    for (const f of allFaces) {
      if (f.personId && f.personName) {
        const person = people.find((p) => p.id === f.personId);
        if (person) {
          if (!namedMap.has(f.personId)) namedMap.set(f.personId, { person, faces: [] });
          namedMap.get(f.personId)!.faces.push(f);
        } else unknowns.push(f);
      } else unknowns.push(f);
    }

    return (
      <div className="photo-screen">
        <div className="photo-topbar">
          <button className="demo-back" onClick={onBack}>← Back</button>
          <span className="photo-topbar-title">People</span>
          <div className="photo-tab-bar">
            <button className="photo-tab" onClick={() => { setTab("photos"); setFocusFace(null); }}>Photos</button>
            <button className="photo-tab photo-tab--active">People</button>
          </div>
        </div>

        <div className="photo-people-body">
          <div className="photo-people-list">
            {allFaces.length > 0 && allFaces[0].embedding.length !== 512 && (
              <div className="photo-quality-hint">
                ⚡ Download <strong>ArcFace ResNet50</strong> in Task Models for accurate face recognition (96.87% LFW). Re-import photos after downloading.
              </div>
            )}
            {namedMap.size === 0 && unknowns.length === 0 && (
              <div className="photo-empty">
                <p className="photo-empty-icon">👤</p>
                <p className="photo-empty-title">No faces detected yet</p>
                <p className="photo-empty-desc">Import photos — BlazeFace will detect faces on-device. Click any face to name it.</p>
              </div>
            )}

            {[...namedMap.values()].map(({ person, faces }) => (
              <div key={person.id} className="photo-person-group">
                <div className="photo-person-header">
                  <img src={person.faceThumb} className="photo-person-avatar" alt={person.name} />
                  <span className="photo-person-name">{person.name}</span>
                  <span className="photo-person-count">{faces.length} photo{faces.length !== 1 ? "s" : ""}</span>
                  <button className="btn-sm danger" onClick={async () => { await deletePerson(person.id); await loadPeople(); }}>Remove</button>
                </div>
                <div className="photo-face-strip">
                  {faces.map((f) => (
                    <button key={f.id} className="photo-face-thumb" onClick={() => focusOnFace(f)}>
                      <img src={f.thumb} alt={person.name} />
                    </button>
                  ))}
                </div>
              </div>
            ))}

            {unknowns.length > 0 && (
              <div className="photo-person-group">
                <div className="photo-person-header">
                  <span className="photo-person-name" style={{ color: "var(--text-2)" }}>Unknown faces</span>
                  <span className="photo-person-count">{unknowns.length}</span>
                </div>
                <div className="photo-face-strip">
                  {unknowns.map((f) => (
                    <button key={f.id} className="photo-face-thumb photo-face-thumb--unknown" onClick={() => focusOnFace(f)}>
                      <img src={f.thumb} alt="Unknown" />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Face detail / name panel */}
          {focusFace && (
            <div className="photo-name-panel">
              <div className="photo-name-panel-header">
                <img src={focusFace.thumb} className="photo-name-face" alt="face" />
                <div>
                  <p className="photo-name-panel-title">{focusFace.personName ?? "Unknown person"}</p>
                  <p className="photo-name-panel-sub">{similarFaces.length > 0 ? `${similarFaces.length + 1} similar faces found` : "No other matches"}</p>
                </div>
                <button className="btn-sm" onClick={() => { setFocusFace(null); setSimilarFaces([]); }}>✕</button>
              </div>

              {/* Assign to existing person */}
              {people.length > 0 && (
                <div className="photo-name-similar">
                  <p className="photo-name-similar-label">Assign to existing person</p>
                  <div className="photo-face-strip">
                    {people.map((p) => (
                      <button
                        key={p.id}
                        className={`photo-face-thumb ${focusFace.personId === p.id ? "photo-face-thumb--active" : ""}`}
                        title={p.name}
                        onClick={() => applyName(p.id)}
                        disabled={namingSaving}
                      >
                        <img src={p.faceThumb} alt={p.name} />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {similarFaces.length > 0 && (
                <div className="photo-name-similar">
                  <p className="photo-name-similar-label">Also this person?</p>
                  <div className="photo-face-strip">
                    {similarFaces.map((f) => (
                      <span key={f.id} className="photo-face-thumb photo-face-thumb--match">
                        <img src={f.thumb} alt="" />
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="photo-name-input-row">
                <input
                  className="inspect-input"
                  placeholder="New name…"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") applyName(); }}
                  autoFocus
                />
                <button className="demo-action-btn" onClick={() => applyName()} disabled={!nameInput.trim() || namingSaving}>
                  {namingSaving ? "Saving…" : "Save"}
                </button>
              </div>
              {focusFace.personId && (
                <div style={{ padding: "0 0.85rem 0.75rem" }}>
                  <button className="btn-sm danger" onClick={unassignFace} disabled={namingSaving} style={{ width: "100%" }}>
                    Unassign from {focusFace.personName}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Grid view ──────────────────────────────────────────────────────────────
  return (
    <div className="photo-screen">
      <div className="photo-topbar">
        {selectMode ? (
          <>
            <button className="demo-back" onClick={exitSelectMode}>✕ Cancel</button>
            <span className="photo-topbar-title">{selected.size} selected</span>
            <button className="btn-sm" onClick={() => setSelected(new Set(photos.map((p) => p.id)))}>All</button>
            {selected.size > 0 && (
              <button className="btn-sm danger" onClick={handleDeleteSelected}>
                🗑 Delete ({selected.size})
              </button>
            )}
          </>
        ) : (
          <>
            <button className="demo-back" onClick={onBack}>← Back</button>
            <span className="photo-topbar-title">Photo Library</span>
            <div className="photo-tab-bar">
              <button className="photo-tab photo-tab--active">Photos</button>
              <button className="photo-tab" onClick={() => { setSelectMode(false); setTab("people"); }}>People</button>
            </div>
            <button className="btn-sm" onClick={() => setSelectMode(true)}>Select</button>
            <SyncPanel
              collection={SYNC_COLLECTIONS.photos.primary}
              extraCollections={[...SYNC_COLLECTIONS.photos.extra]}
              onActivity={(a) => { if (a === "idle") loadPhotos(); }}
            />
            <button className="demo-action-btn" onClick={() => fileRef.current?.click()} disabled={importing}>
              {importing ? importMsg : "+ Import"}
            </button>
          </>
        )}
        <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={handleFileChange} />
      </div>

      <div className="photo-privacy-banner">
        📷 On-device only · EfficientDet object detection · Embeddings in CouchbaseLite · No cloud upload
      </div>

      <div className="photo-search-wrap">
        <input
          className="inspect-input"
          placeholder="Search by label or description…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && <button className="sidebar-search-clear" onClick={() => setQuery("")}>✕</button>}
      </div>

      {importing && (
        <div className="photo-import-bar">
          <span className="photo-import-spinner" />
          {importMsg}
        </div>
      )}

      <div className={`photo-grid ${selectMode ? "photo-grid--select" : ""}`}>
        {photos.length === 0 ? (
          <div className="photo-empty">
            <p className="photo-empty-icon">📷</p>
            <p className="photo-empty-title">{query ? "No photos match" : "No photos yet"}</p>
            {!query && (
              <p className="photo-empty-desc">
                Import a photo — EfficientDet detects objects on-device, embeds the scene for
                semantic search, and stores everything in CouchbaseLite. Nothing leaves your device.
              </p>
            )}
          </div>
        ) : photos.map((p) => {
          const isSelected = selected.has(p.id);
          return (
            <button
              key={p.id}
              className={`photo-card ${isSelected ? "photo-card--selected" : ""}`}
              onClick={() => selectMode ? toggleSelect(p.id) : openDetail(p)}
            >
              <img className="photo-card-thumb" src={p.thumb} alt={p.caption} loading="lazy" />
              {selectMode && (
                <div className="photo-card-check">
                  {isSelected ? "✓" : ""}
                </div>
              )}
              <div className="photo-card-overlay">
                <p className="photo-card-caption">{p.caption}</p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
