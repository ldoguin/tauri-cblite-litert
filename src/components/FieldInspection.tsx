import { useState, useEffect, useRef, useCallback } from "react";
import { loadModel, unloadModel, runInference } from "tauri-plugin-litert-api";
import { preprocessImage, parseDetections, COCO_LABELS, TASK_CATALOGUE } from "../lib/taskModels";
import {
  listInspections,
  getInspection,
  saveInspection,
  deleteInspection,
  searchInspections,
  saveImageAsBlob,
  loadImageFromBlob,
} from "../lib/db";
import type { InspectionRecord, InspectionSeverity, InspectionCategory } from "../lib/types";
import { isTauri } from "../lib/llm";
import { SyncPanel } from "./SyncPanel";
import { SYNC_COLLECTIONS } from "../lib/db";

const DETECTION_ENTRY = TASK_CATALOGUE.find((e) => e.id === "efficientdet-lite0")!;
const DETECT_MODEL_ID = "inspect-efficientdet";

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES: InspectionCategory[] = [
  "structural", "electrical", "mechanical", "safety", "environmental", "other",
];

const SEVERITIES: { value: InspectionSeverity; label: string }[] = [
  { value: "ok",       label: "OK" },
  { value: "low",      label: "Low" },
  { value: "medium",   label: "Medium" },
  { value: "high",     label: "High" },
  { value: "critical", label: "Critical" },
];

const SEVERITY_CLASS: Record<InspectionSeverity, string> = {
  ok:       "sev-ok",
  low:      "sev-low",
  medium:   "sev-medium",
  high:     "sev-high",
  critical: "sev-critical",
};

const EXAMPLE_INSPECTIONS: { location: string; assetId: string; category: InspectionCategory; severity: InspectionSeverity; notes: string }[] = [
  {
    location: "Building A — Basement Level B2",
    assetId: "Pump-P01",
    category: "mechanical",
    severity: "high",
    notes:
      "Centrifugal pump P01 showing heavy vibration during operation — bearing noise audible from 3 m. " +
      "Visible oil leak from the mechanical seal, pooling approx. 500 mL on the floor. " +
      "Motor surface temperature 78 °C (rated max 65 °C). Coupling guard cracked and partially missing. " +
      "Last maintenance log: 14 months ago (overdue). Pump feeds primary cooling circuit for server room SR-01.",
  },
  {
    location: "Rooftop — HVAC Plant Room 3",
    assetId: "DB-RTU-07",
    category: "electrical",
    severity: "critical",
    notes:
      "Distribution board DB-RTU-07 shows scorch marks on breakers 4 and 6, indicating prior arc fault. " +
      "Breaker 6 trips repeatedly under load — manually reset three times this week. " +
      "Burning smell present inside enclosure. Insulation on L2 bus bar visibly degraded. " +
      "Ambient temperature inside cabinet 54 °C with door closed. " +
      "Affected circuit feeds roof-mounted air handling unit AHU-3 serving floors 8–10. " +
      "Immediate isolation recommended pending full rewire.",
  },
  {
    location: "Warehouse C — North Wall, Grid F4",
    assetId: "STR-WAL-F4",
    category: "structural",
    severity: "medium",
    notes:
      "Diagonal crack observed in north perimeter wall at grid reference F4, approx. 4 m above floor level. " +
      "Crack width 3–5 mm, length ~1.8 m — consistent with differential settlement. " +
      "Efflorescence visible around crack edges indicating historic water ingress. " +
      "No spalling observed at crack faces. Adjacent column C14 shows no visible distress. " +
      "Area was subject to forklift impact 6 months ago per maintenance log. " +
      "Recommend structural engineer review before next heavy-load storage cycle.",
  },
  {
    location: "Site Perimeter — Retention Pond East",
    assetId: "ENV-POND-E",
    category: "environmental",
    severity: "high",
    notes:
      "Retention pond E showing visible sheen on surface — iridescent oil film approx. 20 m² extent. " +
      "Discolouration of inlet channel from stormwater drain D-12 (grey-brown, odour of hydrocarbons). " +
      "Dead aquatic vegetation along eastern bank over ~15 m. Two dead birds observed near inlet. " +
      "Likely source: overflow from vehicle wash-down bay VW-3 — bund seal appears compromised. " +
      "No overflow detected to external waterway at time of inspection. " +
      "Site environmental manager notified. Spill kit deployed at inlet. Regulatory reporting may be required.",
  },
];

const INSPECT_SYSTEM =
  "You are a field inspection AI assistant. Write a structured, professional inspection report " +
  "based on the technician's on-site findings.\n\n" +
  "Format:\n" +
  "SUMMARY: One sentence describing the overall situation.\n" +
  "FINDINGS:\n• (2-4 bullet points based on detections and notes)\n" +
  "RECOMMENDED ACTIONS:\n• (1-3 prioritised action items)\n\n" +
  "Be specific and actionable. Under 200 words. Do not mention AI or model names.";

function buildReportPrompt(rec: Omit<InspectionRecord, "id" | "photoRef" | "synced" | "aiReport">): string {
  const detStr = rec.detections.length > 0
    ? rec.detections.map((d) => `  - ${d.label} (${(d.score * 100).toFixed(0)}%)`).join("\n")
    : "  (no objects detected)";
  return (
    `Location: ${rec.location || "N/A"}\n` +
    `Asset / Area: ${rec.assetId || "N/A"}\n` +
    `Category: ${rec.category}\n` +
    `Severity: ${rec.severity.toUpperCase()}\n` +
    `Technician Notes: ${rec.notes || "(none)"}\n\n` +
    `Detected items (on-device AI):\n${detStr}\n\n` +
    `Write the inspection report now.`
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

function uid(): string {
  return `insp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

type InspView = "list" | "compose" | "detail";

interface Props {
  onBack: () => void;
  onReport?: (userText: string, systemPrompt: string) => Promise<string>;
}

export function FieldInspection({ onBack, onReport }: Props) {
  // ── View routing ───────────────────────────────────────────────────────────
  const [view, setView]         = useState<InspView>("list");
  const [detailId, setDetailId] = useState<string | null>(null);

  // ── List state ─────────────────────────────────────────────────────────────
  const [records, setRecords]     = useState<InspectionRecord[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [searchQ, setSearchQ]     = useState("");

  // ── Compose state ──────────────────────────────────────────────────────────
  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(null);
  const [location, setLocation]         = useState("");
  const [assetId, setAssetId]           = useState("");
  const [category, setCategory]         = useState<InspectionCategory>("structural");
  const [severity, setSeverity]         = useState<InspectionSeverity>("medium");
  const [notes, setNotes]               = useState("");
  const [detections, setDetections]     = useState<InspectionRecord["detections"]>([]);
  const [aiReport, setAiReport]         = useState("");
  const [composePhase, setComposePhase] = useState<"idle" | "detecting" | "reporting" | "saving">("idle");
  const [errorMsg, setErrorMsg]         = useState<string | null>(null);

  // ── Detail state ───────────────────────────────────────────────────────────
  const [detailPhoto, setDetailPhoto] = useState<string | null>(null);
  const [detailRecord, setDetailRecord] = useState<InspectionRecord | null>(null);

  // ── Refs ───────────────────────────────────────────────────────────────────
  const galleryRef = useRef<HTMLInputElement>(null);
  const cameraRef  = useRef<HTMLInputElement>(null);

  // ── Load / reload list ─────────────────────────────────────────────────────

  const reload = useCallback(async (q = "") => {
    setListLoading(true);
    try {
      const list = q.trim() ? await searchInspections(q) : await listInspections();
      setRecords(list);
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const handleSearch = (q: string) => {
    setSearchQ(q);
    reload(q);
  };

  // ── Open detail ────────────────────────────────────────────────────────────

  const openDetail = async (id: string) => {
    const rec = await getInspection(id);
    if (!rec) return;
    setDetailRecord(rec);
    setDetailId(id);
    setDetailPhoto(null);
    setView("detail");
    if (rec.photoRef) {
      const url = await loadImageFromBlob(rec.photoRef);
      setDetailPhoto(url);
    }
  };

  const handleDelete = async () => {
    if (!detailId) return;
    await deleteInspection(detailId);
    setView("list");
    setDetailRecord(null);
    reload();
  };

  // ── New inspection form ────────────────────────────────────────────────────

  const resetCompose = () => {
    setPhotoDataUrl(null);
    setLocation("");
    setAssetId("");
    setCategory("structural");
    setSeverity("medium");
    setNotes("");
    setDetections([]);
    setAiReport("");
    setComposePhase("idle");
    setErrorMsg(null);
  };

  const openCompose = () => { resetCompose(); setView("compose"); };

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      setPhotoDataUrl(e.target?.result as string);
      setDetections([]);
      setAiReport("");
      setErrorMsg(null);
    };
    reader.readAsDataURL(file);
  };

  const runDetection = useCallback(async () => {
    if (!photoDataUrl || !isTauri()) return;
    setComposePhase("detecting");
    setErrorMsg(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const modelPath = await invoke<string | null>("get_model_path", {
        fileName: DETECTION_ENTRY.fileName,
      }).catch(() => null);
      if (!modelPath) {
        setErrorMsg("EfficientDet-Lite0 not found. Open Task Models and download it first.");
        setComposePhase("idle");
        return;
      }
      await loadModel({ modelId: DETECT_MODEL_ID, modelPath, accelerator: "cpu" });
      try {
        const shape = DETECTION_ENTRY.inputShape as [number, number, number, number];
        const tensor = await preprocessImage(photoDataUrl, shape[1], shape[2], DETECTION_ENTRY.normalizeMode);
        const result = await runInference({ modelId: DETECT_MODEL_ID, inputs: [Array.from(tensor)] });
        const found  = parseDetections(result.outputs, COCO_LABELS, 0.25, shape[1], shape[2]) ?? [];
        setDetections(found.map((d) => ({ label: d.label, score: d.score })));
      } finally {
        await unloadModel(DETECT_MODEL_ID).catch(() => {});
      }
    } catch (e) {
      setErrorMsg(String(e));
    }
    setComposePhase("idle");
  }, [photoDataUrl]);

  const runReport = useCallback(async () => {
    if (!onReport) { setAiReport("Load a language model to generate reports."); return; }
    setComposePhase("reporting");
    setErrorMsg(null);
    try {
      const prompt = buildReportPrompt({ createdAt: "", updatedAt: "", location, assetId, category, severity, notes, detections });
      const report = await onReport(prompt, INSPECT_SYSTEM);
      setAiReport(report);
    } catch (e) {
      setErrorMsg(String(e));
    }
    setComposePhase("idle");
  }, [onReport, location, assetId, category, severity, notes, detections]);

  const handleSave = useCallback(async () => {
    setComposePhase("saving");
    setErrorMsg(null);
    try {
      const photoRef = photoDataUrl ? await saveImageAsBlob(photoDataUrl) : "";
      const now = new Date().toISOString();
      const rec: InspectionRecord = {
        id: uid(),
        createdAt: now,
        updatedAt: now,
        location,
        assetId,
        category,
        severity,
        notes,
        photoRef,
        detections,
        aiReport,
        synced: false,
      };
      await saveInspection(rec);
      resetCompose();
      await reload();
      setView("list");
    } catch (e) {
      setErrorMsg(String(e));
      setComposePhase("idle");
    }
  }, [photoDataUrl, location, assetId, category, severity, notes, detections, aiReport, reload]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="demo-screen inspect-screen">
      {/* ── List ── */}
      {view === "list" && (
        <>
          <header className="demo-header">
            <button className="demo-back" onClick={onBack}>← Back</button>
            <div className="demo-header-text">
              <h1 className="demo-title">Field Inspection</h1>
              <p className="demo-subtitle">Capture, detect, report — works offline, syncs when connected</p>
            </div>
            <SyncPanel
              collection={SYNC_COLLECTIONS.inspections.primary}
              onActivity={(a) => { if (a === "idle" || a === "stopped") listInspections().then(setRecords); }}
            />
            <button className="demo-action-btn inspect-new-btn" onClick={openCompose}>+ New</button>
          </header>

          <div className="inspect-list-body">
            <div className="inspect-search-row">
              <input
                className="inspect-search"
                type="search"
                placeholder="Search inspections…"
                value={searchQ}
                onChange={(e) => handleSearch(e.target.value)}
              />
              <span className="inspect-count">{records.length} record{records.length !== 1 ? "s" : ""}</span>
            </div>

            {listLoading ? (
              <div className="inspect-empty">Loading…</div>
            ) : records.length === 0 ? (
              <div className="inspect-empty">
                <span>🔦</span>
                <p>{searchQ ? "No results found." : "No inspections yet. Tap + New to begin."}</p>
              </div>
            ) : (
              <div className="inspect-cards">
                {records.map((r) => (
                  <button key={r.id} className="inspect-card" onClick={() => openDetail(r.id)}>
                    <div className="inspect-card-left">
                      <span className={`inspect-sev-badge ${SEVERITY_CLASS[r.severity]}`}>
                        {r.severity.toUpperCase()}
                      </span>
                      <span className="inspect-card-cat">{r.category}</span>
                    </div>
                    <div className="inspect-card-body">
                      <p className="inspect-card-location">{r.location || "Unknown location"}</p>
                      <p className="inspect-card-preview">
                        {r.aiReport
                          ? r.aiReport.replace(/^SUMMARY:\s*/i, "").split("\n")[0].slice(0, 100)
                          : r.notes || "No notes."}
                      </p>
                      {(r.detections?.length ?? 0) > 0 && (
                        <p className="inspect-card-dets">
                          {r.detections.slice(0, 4).map((d) => d.label).join(" · ")}
                          {r.detections.length > 4 ? ` +${r.detections.length - 4}` : ""}
                        </p>
                      )}
                    </div>
                    <div className="inspect-card-right">
                      <span className="inspect-card-time">{relativeTime(r.createdAt)}</span>
                      {!r.synced && <span className="inspect-sync-dot" title="Not yet synced" />}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Compose ── */}
      {view === "compose" && (
        <>
          <header className="demo-header">
            <button className="demo-back" onClick={() => { resetCompose(); setView("list"); }}>← List</button>
            <div className="demo-header-text">
              <h1 className="demo-title">New Inspection</h1>
              <p className="demo-subtitle">Photo · AI detection · Report · Save to CouchbaseLite</p>
            </div>
          </header>

          {errorMsg && <div className="demo-error" style={{ margin: "0 1.25rem 0.5rem" }}>{errorMsg}</div>}

          <div className="inspect-compose-body">
            {/* Left: form */}
            <div className="inspect-form-col">
              {/* Photo */}
              <section className="inspect-form-section">
                <label className="inspect-form-label">Photo</label>
                {!photoDataUrl ? (
                  <div className="demo-dropzone inspect-dropzone" onClick={() => galleryRef.current?.click()}>
                    <span className="demo-dropzone-icon">📷</span>
                    <p>Capture or upload a photo of the site</p>
                    <div className="demo-dropzone-actions">
                      <button className="btn-sm" onClick={(e) => { e.stopPropagation(); galleryRef.current?.click(); }}>
                        Gallery
                      </button>
                      {isTauri() && (
                        <button className="btn-sm secondary" onClick={(e) => { e.stopPropagation(); cameraRef.current?.click(); }}>
                          Camera
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="inspect-photo-thumb-row">
                    <img src={photoDataUrl} alt="Inspection site" className="inspect-photo-thumb" />
                    <div className="inspect-thumb-actions">
                      <button
                        className="btn-sm"
                        onClick={runDetection}
                        disabled={composePhase !== "idle" || !isTauri()}
                      >
                        {composePhase === "detecting" ? "Detecting…" : "Detect Items"}
                      </button>
                      <button className="btn-sm secondary" onClick={() => { setPhotoDataUrl(null); setDetections([]); }}>
                        Change
                      </button>
                    </div>
                    {detections.length > 0 && (
                      <div className="inspect-det-chips">
                        {detections.map((d, i) => (
                          <span key={i} className="inspect-det-chip">
                            {d.label} <em>{(d.score * 100).toFixed(0)}%</em>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </section>

              {/* Location + Asset */}
              <section className="inspect-form-section inspect-form-row">
                <div className="inspect-form-field">
                  <label className="inspect-form-label">Location</label>
                  <input
                    className="inspect-input"
                    type="text"
                    placeholder="e.g. Building A — Basement"
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                  />
                </div>
                <div className="inspect-form-field">
                  <label className="inspect-form-label">Asset / Area ID</label>
                  <input
                    className="inspect-input"
                    type="text"
                    placeholder="e.g. Pump-P01"
                    value={assetId}
                    onChange={(e) => setAssetId(e.target.value)}
                  />
                </div>
              </section>

              {/* Category */}
              <section className="inspect-form-section">
                <label className="inspect-form-label">Category</label>
                <div className="inspect-chip-row">
                  {CATEGORIES.map((c) => (
                    <button
                      key={c}
                      className={`fitness-chip ${category === c ? "active" : ""}`}
                      onClick={() => setCategory(c)}
                    >
                      {c.charAt(0).toUpperCase() + c.slice(1)}
                    </button>
                  ))}
                </div>
              </section>

              {/* Severity */}
              <section className="inspect-form-section">
                <label className="inspect-form-label">Severity</label>
                <div className="inspect-chip-row">
                  {SEVERITIES.map(({ value, label }) => (
                    <button
                      key={value}
                      className={`fitness-chip inspect-sev-chip ${SEVERITY_CLASS[value]} ${severity === value ? "active" : ""}`}
                      onClick={() => setSeverity(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </section>

              {/* Notes */}
              <section className="inspect-form-section">
                <div className="inspect-form-label-row">
                  <label className="inspect-form-label">Notes</label>
                  <button className="btn-sm secondary" onClick={() => {
                    const ex = EXAMPLE_INSPECTIONS[Math.floor(Math.random() * EXAMPLE_INSPECTIONS.length)];
                    setLocation(ex.location);
                    setAssetId(ex.assetId);
                    setCategory(ex.category);
                    setSeverity(ex.severity);
                    setNotes(ex.notes);
                    setAiReport("");
                  }}>Fill example</button>
                </div>
                <textarea
                  className="inspect-textarea"
                  placeholder="Describe the issue — what you saw, smelled, heard…"
                  rows={4}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </section>

              {/* Actions */}
              <section className="inspect-form-section inspect-actions">
                <button
                  className="btn-sm secondary"
                  onClick={runReport}
                  disabled={composePhase !== "idle"}
                >
                  {composePhase === "reporting" ? "Generating…" : "Generate AI Report"}
                </button>
                <button
                  className="demo-action-btn"
                  onClick={handleSave}
                  disabled={composePhase !== "idle" || !photoDataUrl}
                >
                  {composePhase === "saving" ? "Saving…" : "Save Inspection"}
                </button>
                {!isTauri() && <p className="demo-notice">Detection requires the native app.</p>}
              </section>
            </div>

            {/* Right: photo + AI report */}
            <div className="inspect-preview-col">
              {photoDataUrl ? (
                <img src={photoDataUrl} alt="Site" className="inspect-preview-photo" />
              ) : (
                <div className="inspect-preview-empty">Photo appears here</div>
              )}
              {aiReport && (
                <div className="inspect-ai-report">
                  <h3 className="inspect-report-title">AI Report</h3>
                  <pre className="inspect-report-body">{aiReport}</pre>
                </div>
              )}
            </div>
          </div>

          <input ref={galleryRef} type="file" accept="image/*" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
        </>
      )}

      {/* ── Detail ── */}
      {view === "detail" && detailRecord && (
        <>
          <header className="demo-header">
            <button className="demo-back" onClick={() => { setView("list"); setDetailRecord(null); setDetailPhoto(null); }}>
              ← List
            </button>
            <div className="demo-header-text">
              <h1 className="demo-title">Inspection Report</h1>
              <p className="demo-subtitle">{relativeTime(detailRecord.createdAt)}</p>
            </div>
            <button className="btn-sm danger" onClick={handleDelete}>Delete</button>
          </header>

          <div className="inspect-detail-body">
            {/* Left: meta + report */}
            <div className="inspect-detail-meta">
              <div className="inspect-detail-badges">
                <span className={`inspect-sev-badge ${SEVERITY_CLASS[detailRecord.severity]}`}>
                  {detailRecord.severity.toUpperCase()}
                </span>
                <span className="inspect-detail-cat">{detailRecord.category}</span>
                <span className={`inspect-sync-badge ${detailRecord.synced ? "synced" : "local"}`}>
                  {detailRecord.synced ? "✓ Synced" : "○ Local only"}
                </span>
              </div>

              {detailRecord.location && (
                <p className="inspect-detail-row"><strong>Location:</strong> {detailRecord.location}</p>
              )}
              {detailRecord.assetId && (
                <p className="inspect-detail-row"><strong>Asset:</strong> {detailRecord.assetId}</p>
              )}
              <p className="inspect-detail-row">
                <strong>Date:</strong> {new Date(detailRecord.createdAt).toLocaleString()}
              </p>

              {(detailRecord.detections?.length ?? 0) > 0 && (
                <div className="inspect-detail-section">
                  <h3 className="inspect-detail-section-title">Detected Items</h3>
                  <div className="inspect-det-chips">
                    {(detailRecord.detections ?? []).map((d, i) => (
                      <span key={i} className="inspect-det-chip">
                        {d.label} <em>{(d.score * 100).toFixed(0)}%</em>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {detailRecord.aiReport && (
                <div className="inspect-detail-section">
                  <h3 className="inspect-detail-section-title">AI Report</h3>
                  <pre className="inspect-report-body">{detailRecord.aiReport}</pre>
                </div>
              )}

              {detailRecord.notes && (
                <div className="inspect-detail-section">
                  <h3 className="inspect-detail-section-title">Technician Notes</h3>
                  <p className="inspect-detail-notes">{detailRecord.notes}</p>
                </div>
              )}
            </div>

            {/* Right: photo */}
            <div className="inspect-detail-photo-col">
              {detailPhoto ? (
                <img src={detailPhoto} alt="Inspection" className="inspect-detail-photo" />
              ) : (
                <div className="inspect-preview-empty">Loading photo…</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
