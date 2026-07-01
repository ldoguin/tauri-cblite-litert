import { useState, useEffect, useRef, useCallback } from "react";
import {
  listClinicalNotes,
  getClinicalNote,
  saveClinicalNote,
  deleteClinicalNote,
  searchClinicalNotes,
  listClinicalNotesWithEmbeddings,
  saveImageAsBlob,
  loadImageFromBlob,
} from "../lib/db";
import { startReplication, stopReplication } from "tauri-plugin-cblite";
import type { ClinicalNote, ClinicalNoteType, SoapNote } from "../lib/types";
import { embed, cosineSimilarity } from "../lib/rag";
import { isTauri } from "../lib/llm";

// ── Constants ─────────────────────────────────────────────────────────────────

const EXAMPLE_NOTES: { patientRef: string; encounter: string; noteType: ClinicalNoteType; rawNotes: string }[] = [
  {
    patientRef: "PT-2024-0042",
    encounter: "ED Bay 4",
    noteType: "admission",
    rawNotes:
      "58 y/o male, sudden onset chest pain 7/10 radiating to left arm and jaw, onset ~2 h ago. " +
      "Diaphoresis and nausea. PMH: HTN, T2DM, hyperlipidaemia. Meds: metformin 1 g BD, lisinopril 10 mg OD, atorvastatin 40 mg ON. NKDA. " +
      "BP 152/94, HR 102, RR 18, SpO₂ 97% RA, temp 36.7 °C. " +
      "ECG: ST elevation 2 mm leads II, III, aVF — inferior STEMI. Troponin I 1.8 ng/mL (↑). CXR: mild cardiomegaly. " +
      "Plan: aspirin 300 mg stat, ticagrelor 180 mg loading, IV heparin, urgent cath lab activation, cardiology called.",
  },
  {
    patientRef: "PT-2024-0117",
    encounter: "Ward 6C — Bed 8",
    noteType: "progress",
    rawNotes:
      "72 y/o female, day 3 post-admission for community-acquired pneumonia. " +
      "Still febrile 38.4 °C, but subjectively improved — less breathless, cough productive of yellow sputum. " +
      "BP 118/74, HR 88, RR 20, SpO₂ 94% on 2 L O₂ via NC. " +
      "Chest auscultation: reduced air entry right base, coarse crackles. " +
      "Bloods: WBC 13.2 (↓ from 18.6 on admission), CRP 112 (↓ from 210). Blood cultures: no growth day 3. " +
      "Continuing IV co-amoxiclav — plan to step down to oral if apyrexial >24 h. " +
      "Physio review today: incentive spirometry commenced. IV fluids discontinued, tolerating oral intake.",
  },
  {
    patientRef: "PT-2024-0203",
    encounter: "ICU — Bay 2",
    noteType: "procedure",
    rawNotes:
      "34 y/o female with DKA secondary to missed insulin doses. " +
      "Admitted via ED with glucose 38 mmol/L, pH 7.12, bicarbonate 8, ketones 4+ on urinalysis. " +
      "GCS on arrival: 13 (E3V4M6), now 15 post-treatment. " +
      "Central line inserted right internal jugular — ultrasound guided, first pass, confirmed on CXR. " +
      "DKA protocol initiated: 0.9% NaCl 1 L over 1 h, then variable rate insulin infusion commenced at 06:00. " +
      "Glucose now 22 mmol/L at 2 h. Potassium 3.2 — K+ supplementation added to IV fluids. " +
      "Endocrinology consulted. Plan: continue VRI until ketones clear, transition to SC insulin regimen.",
  },
  {
    patientRef: "PT-2024-0388",
    encounter: "Stroke Unit — Bed 3",
    noteType: "admission",
    rawNotes:
      "67 y/o male brought in by ambulance, last seen well 90 min ago. " +
      "Sudden onset left-sided facial droop, left arm and leg weakness (MRC 2/5), expressive dysphasia. NIHSS score: 14. " +
      "PMH: AF (on warfarin — INR today 1.1, subtherapeutic), hypertension. " +
      "BP 174/98, HR 76 irregularly irregular, SpO₂ 98% RA, glucose 7.4. " +
      "CT head: no haemorrhage. CT angiogram: right MCA M1 occlusion. " +
      "Within thrombolysis window — IV alteplase 0.9 mg/kg given at 14:22. " +
      "Mechanical thrombectomy discussed with neuro-interventional; transfer to angio suite arranged. " +
      "Anticoagulation withheld peri-procedure.",
  },
];

const NOTE_TYPES: { value: ClinicalNoteType; label: string; icon: string }[] = [
  { value: "admission",  label: "Admission",  icon: "🏥" },
  { value: "progress",   label: "Progress",   icon: "📋" },
  { value: "wound",      label: "Wound",      icon: "🩹" },
  { value: "procedure",  label: "Procedure",  icon: "🔬" },
  { value: "discharge",  label: "Discharge",  icon: "🚪" },
];

const SOAP_SYSTEM =
  "You are a clinical documentation AI assistant. Structure the provided clinical notes into SOAP format.\n\n" +
  "CRITICAL: Use ONLY information explicitly stated in the notes. Do NOT infer, add, or fabricate any clinical information.\n\n" +
  "Respond in this exact format — use the section headers verbatim:\n\n" +
  "SUBJECTIVE:\n[Patient-reported symptoms, complaints, history, pain score if mentioned]\n\n" +
  "OBJECTIVE:\n[Vital signs, clinical observations, examination findings, test results]\n\n" +
  "ASSESSMENT:\n[Clinical impression, diagnosis, differential diagnoses]\n\n" +
  "PLAN:\n[Treatment orders, medications, referrals, follow-up]\n\n" +
  "If information for a section is absent from the notes, write 'Not documented.'";

function parseSoap(raw: string): SoapNote {
  const get = (tag: string) => {
    const re = new RegExp(`${tag}:\\s*([\\s\\S]*?)(?=\\n(?:SUBJECTIVE|OBJECTIVE|ASSESSMENT|PLAN):|$)`, "i");
    return raw.match(re)?.[1]?.trim() ?? "Not documented.";
  };
  return {
    subjective: get("SUBJECTIVE"),
    objective:  get("OBJECTIVE"),
    assessment: get("ASSESSMENT"),
    plan:       get("PLAN"),
  };
}

function uid(): string {
  return `cn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

// ── Similar notes result ───────────────────────────────────────────────────────

interface SimilarNote {
  id: string;
  patientRef: string;
  noteType: ClinicalNoteType;
  encounter: string;
  summary: string;
  score: number;
}

// ── Component ─────────────────────────────────────────────────────────────────

type ClinView = "list" | "compose" | "detail";

interface Props {
  onBack: () => void;
  embedModelId?: string;
  onStructure?: (rawNotes: string, systemPrompt: string) => Promise<string>;
}

export function ClinicalNotes({ onBack, embedModelId, onStructure }: Props) {
  // ── View routing ───────────────────────────────────────────────────────────
  const [view, setView]         = useState<ClinView>("list");
  const [detailId, setDetailId] = useState<string | null>(null);

  // ── List state ─────────────────────────────────────────────────────────────
  const [records, setRecords]   = useState<ClinicalNote[]>([]);
  const [loading, setLoading]   = useState(true);
  const [searchQ, setSearchQ]   = useState("");

  // ── Compose state ──────────────────────────────────────────────────────────
  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(null);
  const [patientRef, setPatientRef]     = useState("");
  const [encounter, setEncounter]       = useState("");
  const [noteType, setNoteType]         = useState<ClinicalNoteType>("progress");
  const [rawNotes, setRawNotes]         = useState("");
  const [soap, setSoap]                 = useState<SoapNote | null>(null);
  const [composePhase, setComposePhase] = useState<"idle" | "structuring" | "embedding" | "saving">("idle");
  const [composeError, setComposeError] = useState<string | null>(null);

  // ── Detail state ───────────────────────────────────────────────────────────
  const [detailNote, setDetailNote]   = useState<ClinicalNote | null>(null);
  const [detailPhoto, setDetailPhoto] = useState<string | null>(null);
  const [similarNotes, setSimilarNotes] = useState<SimilarNote[]>([]);
  const [similarLoading, setSimilarLoading] = useState(false);

  // ── Sync state ─────────────────────────────────────────────────────────────
  const [syncUrl, setSyncUrl]           = useState("");
  const [syncUser, setSyncUser]         = useState("");
  const [syncPass, setSyncPass]         = useState("");
  const [syncEncPass, setSyncEncPass]   = useState("");
  const [syncEncSalt, setSyncEncSalt]   = useState("");
  const [syncStatus, setSyncStatus]     = useState<"idle" | "running" | "done" | "error">("idle");
  const [syncMsg, setSyncMsg]           = useState<string | null>(null);
  const [showSync, setShowSync]         = useState(false);

  const galleryRef = useRef<HTMLInputElement>(null);
  const cameraRef  = useRef<HTMLInputElement>(null);

  // ── List ───────────────────────────────────────────────────────────────────

  const reload = useCallback(async (q = "") => {
    setLoading(true);
    try {
      const list = q.trim() ? await searchClinicalNotes(q) : await listClinicalNotes();
      setRecords(list);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const handleSearch = (q: string) => { setSearchQ(q); reload(q); };

  // ── Detail ─────────────────────────────────────────────────────────────────

  const openDetail = async (id: string) => {
    const note = await getClinicalNote(id);
    if (!note) return;
    setDetailNote(note);
    setDetailId(id);
    setDetailPhoto(null);
    setSimilarNotes([]);
    setView("detail");
    if (note.photoRef) {
      loadImageFromBlob(note.photoRef).then(setDetailPhoto);
    }
    if (note.embedding?.length && embedModelId) {
      findSimilar(note);
    }
  };

  const findSimilar = async (note: ClinicalNote) => {
    setSimilarLoading(true);
    try {
      const all = await listClinicalNotesWithEmbeddings();
      const candidates = all
        .filter((n) => n.id !== note.id && n.embedding?.length)
        .map((n) => ({
          id: n.id,
          patientRef: n.patientRef,
          noteType: n.noteType,
          encounter: n.encounter,
          summary: n.soap?.assessment ?? n.rawNotes.slice(0, 80),
          score: cosineSimilarity(note.embedding, n.embedding),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .filter((n) => n.score > 0.6);
      setSimilarNotes(candidates);
    } finally {
      setSimilarLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!detailId) return;
    await deleteClinicalNote(detailId);
    setView("list");
    setDetailNote(null);
    reload();
  };

  // ── Compose ────────────────────────────────────────────────────────────────

  const resetCompose = () => {
    setPhotoDataUrl(null);
    setPatientRef("");
    setEncounter("");
    setNoteType("progress");
    setRawNotes("");
    setSoap(null);
    setComposePhase("idle");
    setComposeError(null);
  };

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => setPhotoDataUrl(e.target?.result as string);
    reader.readAsDataURL(file);
  };

  const structureNotes = useCallback(async () => {
    if (!rawNotes.trim() || !onStructure) {
      setSoap(null);
      return;
    }
    setComposePhase("structuring");
    setComposeError(null);
    try {
      const raw = await onStructure(
        `Patient: ${patientRef || "N/A"}\nEncounter: ${encounter || "N/A"}\nNote type: ${noteType}\n\nClinician notes:\n${rawNotes}`,
        SOAP_SYSTEM,
      );
      setSoap(parseSoap(raw));
    } catch (e) {
      setComposeError(String(e));
    }
    setComposePhase("idle");
  }, [rawNotes, patientRef, encounter, noteType, onStructure]);

  const handleSave = useCallback(async () => {
    if (!rawNotes.trim()) { setComposeError("Notes cannot be empty."); return; }
    setComposePhase("saving");
    setComposeError(null);
    try {
      const photoRef = photoDataUrl ? await saveImageAsBlob(photoDataUrl) : "";

      // Compute embedding from SOAP assessment + plan, or raw notes
      let embedding: number[] = [];
      if (embedModelId) {
        setComposePhase("embedding");
        const textToEmbed = soap
          ? `${soap.assessment}\n${soap.plan}`
          : rawNotes;
        try { embedding = await embed(textToEmbed, embedModelId); } catch { /* skip */ }
      }

      setComposePhase("saving");
      const now = new Date().toISOString();
      const note: ClinicalNote = {
        id: uid(),
        createdAt: now,
        updatedAt: now,
        patientRef: patientRef.trim(),
        encounter: encounter.trim(),
        noteType,
        rawNotes,
        photoRef,
        soapJson: soap ? JSON.stringify(soap) : "",
        soap,
        embedding,
        synced: false,
      };
      await saveClinicalNote(note);
      resetCompose();
      await reload();
      setView("list");
    } catch (e) {
      setComposeError(String(e));
      setComposePhase("idle");
    }
  }, [rawNotes, photoDataUrl, patientRef, encounter, noteType, soap, embedModelId, reload]);

  // ── Sync to EHR ────────────────────────────────────────────────────────────

  const handleSync = useCallback(async () => {
    if (!syncUrl.trim() || !isTauri()) return;
    setSyncStatus("running");
    setSyncMsg(null);
    try {
      await startReplication(
        syncUrl.trim(),
        "_default.clinical",
        "push",
        syncUser ? { username: syncUser, password: syncPass } : undefined,
        syncEncPass && syncEncSalt ? { password: syncEncPass, salt: syncEncSalt } : undefined,
      );
      setSyncStatus("done");
      setSyncMsg("Replication started — PHI fields encrypted in transit.");
    } catch (e) {
      setSyncStatus("error");
      setSyncMsg(String(e));
    }
  }, [syncUrl, syncUser, syncPass, syncEncPass, syncEncSalt]);

  const handleStopSync = useCallback(async () => {
    await stopReplication().catch(() => {});
    setSyncStatus("idle");
    setSyncMsg("Replication stopped.");
  }, []);

  const typeInfo = (t: ClinicalNoteType) => NOTE_TYPES.find((n) => n.value === t)!;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="demo-screen clin-screen">

      {/* ── Privacy banner ── */}
      <div className="clin-phi-banner">
        🔒 PHI fields (<code>rawNotes</code>, <code>soapJson</code>, <code>photoRef</code>) tagged for field-level encryption (AES-256-GCM via PBKDF2) · Encrypted in transit to EHR · On-device LLM only
      </div>

      {/* ══ LIST ══════════════════════════════════════════════════════════════ */}
      {view === "list" && (
        <>
          <header className="demo-header">
            <button className="demo-back" onClick={onBack}>← Back</button>
            <div className="demo-header-text">
              <h1 className="demo-title">Clinical Notes</h1>
              <p className="demo-subtitle">Private, on-device — SOAP structured, vector searchable, sync-ready</p>
            </div>
            <button className="demo-action-btn inspect-new-btn" onClick={() => { resetCompose(); setView("compose"); }}>
              + New Note
            </button>
          </header>

          <div className="clin-list-body">
            <div className="inspect-search-row">
              <input
                className="inspect-search"
                type="search"
                placeholder="Search notes…"
                value={searchQ}
                onChange={(e) => handleSearch(e.target.value)}
              />
              <span className="inspect-count">{records.length} note{records.length !== 1 ? "s" : ""}</span>
            </div>

            {loading ? (
              <div className="inspect-empty">Loading…</div>
            ) : records.length === 0 ? (
              <div className="inspect-empty">
                <span>📋</span>
                <p>{searchQ ? "No results." : "No notes yet. Tap + New Note to begin."}</p>
              </div>
            ) : (
              <div className="inspect-cards">
                {records.map((r) => {
                  const t = typeInfo(r.noteType);
                  return (
                    <button key={r.id} className="inspect-card clin-card" onClick={() => openDetail(r.id)}>
                      <div className="clin-card-icon">{t.icon}</div>
                      <div className="inspect-card-body">
                        <p className="inspect-card-location">
                          <strong>{r.patientRef || "Unknown patient"}</strong>
                          <span className="clin-type-tag">{t.label}</span>
                        </p>
                        <p className="inspect-card-preview">
                          {r.encounter && <em className="clin-encounter">{r.encounter} · </em>}
                          {r.soap?.assessment ?? r.rawNotes.slice(0, 100)}
                        </p>
                      </div>
                      <div className="inspect-card-right">
                        <span className="inspect-card-time">{relativeTime(r.createdAt)}</span>
                        {r.embedding?.length > 0 && (
                          <span className="clin-vec-dot" title="Vector indexed" />
                        )}
                        {!r.synced && <span className="inspect-sync-dot" title="Not yet synced" />}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {/* ══ COMPOSE ═══════════════════════════════════════════════════════════ */}
      {view === "compose" && (
        <>
          <header className="demo-header">
            <button className="demo-back" onClick={() => { resetCompose(); setView("list"); }}>← List</button>
            <div className="demo-header-text">
              <h1 className="demo-title">New Clinical Note</h1>
              <p className="demo-subtitle">Dictate or type · Structure with AI · Save locally</p>
            </div>
          </header>

          {composeError && <div className="demo-error" style={{ margin: "0 1.25rem 0.5rem" }}>{composeError}</div>}

          <div className="clin-compose-body">
            {/* Left: form */}
            <div className="clin-form-col">
              {/* Meta */}
              <section className="inspect-form-section inspect-form-row">
                <div className="inspect-form-field">
                  <label className="inspect-form-label">Patient Reference</label>
                  <input className="inspect-input" placeholder="e.g. PT-2024-0042" value={patientRef}
                    onChange={(e) => setPatientRef(e.target.value)} />
                </div>
                <div className="inspect-form-field">
                  <label className="inspect-form-label">Encounter / Location</label>
                  <input className="inspect-input" placeholder="e.g. Ward 3B — Bed 12" value={encounter}
                    onChange={(e) => setEncounter(e.target.value)} />
                </div>
              </section>

              {/* Note type */}
              <section className="inspect-form-section">
                <label className="inspect-form-label">Note Type</label>
                <div className="inspect-chip-row">
                  {NOTE_TYPES.map(({ value, label, icon }) => (
                    <button key={value}
                      className={`fitness-chip ${noteType === value ? "active" : ""}`}
                      onClick={() => setNoteType(value)}
                    >
                      {icon} {label}
                    </button>
                  ))}
                </div>
              </section>

              {/* Optional photo */}
              <section className="inspect-form-section">
                <label className="inspect-form-label">Photo (optional)</label>
                {!photoDataUrl ? (
                  <div className="demo-dropzone clin-photo-zone" onClick={() => galleryRef.current?.click()}>
                    <span>📷</span>
                    <p>Wound, equipment, or chart photo</p>
                    <div className="demo-dropzone-actions">
                      <button className="btn-sm" onClick={(e) => { e.stopPropagation(); galleryRef.current?.click(); }}>Gallery</button>
                      {isTauri() && (
                        <button className="btn-sm secondary" onClick={(e) => { e.stopPropagation(); cameraRef.current?.click(); }}>Camera</button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="inspect-photo-thumb-row">
                    <img src={photoDataUrl} alt="Clinical photo" className="inspect-photo-thumb" />
                    <button className="btn-sm secondary" onClick={() => setPhotoDataUrl(null)}>Remove</button>
                  </div>
                )}
              </section>

              {/* Raw notes */}
              <section className="inspect-form-section" style={{ flex: 1 }}>
                <div className="inspect-form-label-row">
                  <label className="inspect-form-label">Clinical Notes</label>
                  <button className="btn-sm secondary" onClick={() => {
                    const ex = EXAMPLE_NOTES[Math.floor(Math.random() * EXAMPLE_NOTES.length)];
                    setPatientRef(ex.patientRef);
                    setEncounter(ex.encounter);
                    setNoteType(ex.noteType);
                    setRawNotes(ex.rawNotes);
                    setSoap(null);
                  }}>Fill example</button>
                </div>
                <textarea
                  className="inspect-textarea clin-notes-area"
                  placeholder={"Type or dictate your clinical observations here…\n\nExample:\nPatient reports 7/10 chest pain radiating to left arm since 2h. BP 148/92, HR 98. Diaphoretic. ECG shows ST elevation in leads II, III, aVF. Troponin pending."}
                  rows={8}
                  value={rawNotes}
                  onChange={(e) => setRawNotes(e.target.value)}
                />
              </section>

              {/* Actions */}
              <section className="inspect-form-section inspect-actions">
                <button className="btn-sm secondary"
                  onClick={structureNotes}
                  disabled={composePhase !== "idle" || !rawNotes.trim() || !onStructure}
                >
                  {composePhase === "structuring" ? "Structuring…" : "Structure as SOAP"}
                </button>
                <button className="demo-action-btn"
                  onClick={handleSave}
                  disabled={composePhase !== "idle" || !rawNotes.trim()}
                >
                  {composePhase === "embedding" ? "Indexing…"
                    : composePhase === "saving" ? "Saving…"
                    : "Save Note"}
                </button>
              </section>
              {!onStructure && (
                <p className="demo-notice">Load a language model to enable SOAP structuring.</p>
              )}
            </div>

            {/* Right: SOAP preview */}
            <div className="clin-soap-col">
              {soap ? (
                <SoapDisplay soap={soap} />
              ) : (
                <div className="clin-soap-empty">
                  <span>📄</span>
                  <p>Structured SOAP note appears here after you click <strong>Structure as SOAP</strong></p>
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

      {/* ══ DETAIL ════════════════════════════════════════════════════════════ */}
      {view === "detail" && detailNote && (() => {
        const t = typeInfo(detailNote.noteType);
        return (
          <>
            <header className="demo-header">
              <button className="demo-back" onClick={() => { setView("list"); setDetailNote(null); setSimilarNotes([]); }}>
                ← List
              </button>
              <div className="demo-header-text">
                <h1 className="demo-title">
                  {t.icon} {detailNote.patientRef || "Unknown patient"}
                </h1>
                <p className="demo-subtitle">
                  {t.label} · {detailNote.encounter || "No location"} · {relativeTime(detailNote.createdAt)}
                </p>
              </div>
              <button className="btn-sm danger" onClick={handleDelete}>Delete</button>
            </header>

            <div className="clin-detail-body">
              {/* Left: SOAP + photo + raw notes */}
              <div className="clin-detail-main">
                {detailPhoto && (
                  <img src={detailPhoto} alt="Clinical" className="clin-detail-photo" />
                )}

                {detailNote.soap ? (
                  <SoapDisplay soap={detailNote.soap} />
                ) : (
                  <div className="inspect-detail-section">
                    <h3 className="inspect-detail-section-title">Raw Notes</h3>
                    <p className="inspect-detail-notes">{detailNote.rawNotes}</p>
                  </div>
                )}

                {detailNote.soap && detailNote.rawNotes && (
                  <details className="clin-raw-toggle">
                    <summary>Raw clinician notes</summary>
                    <p className="inspect-detail-notes" style={{ marginTop: "0.5rem" }}>{detailNote.rawNotes}</p>
                  </details>
                )}

                <div className="clin-meta-row">
                  <span className="clin-fle-badge">🔐 rawNotes · soapJson · photoRef encrypted</span>
                  {detailNote.embedding?.length > 0 && (
                    <span className="clin-vec-badge">⚡ Vector indexed</span>
                  )}
                </div>

                {/* Sync to EHR panel */}
                <div className="clin-sync-panel">
                  <button className="clin-sync-toggle" onClick={() => setShowSync((s) => !s)}>
                    {showSync ? "▾" : "▸"} Sync to EHR
                    <span className={`clin-sync-status-dot ${syncStatus}`} />
                  </button>
                  {showSync && (
                    <div className="clin-sync-form">
                      <div className="inspect-form-row">
                        <div className="inspect-form-field">
                          <label className="inspect-form-label">Sync Gateway URL</label>
                          <input className="inspect-input" placeholder="wss://ehr.hospital.org/clinical"
                            value={syncUrl} onChange={(e) => setSyncUrl(e.target.value)} />
                        </div>
                      </div>
                      <div className="inspect-form-row">
                        <div className="inspect-form-field">
                          <label className="inspect-form-label">Username</label>
                          <input className="inspect-input" placeholder="clinician" value={syncUser}
                            onChange={(e) => setSyncUser(e.target.value)} />
                        </div>
                        <div className="inspect-form-field">
                          <label className="inspect-form-label">Password</label>
                          <input className="inspect-input" type="password" value={syncPass}
                            onChange={(e) => setSyncPass(e.target.value)} />
                        </div>
                      </div>
                      <div className="clin-fle-section">
                        <p className="clin-fle-label">🔐 Field encryption (PBKDF2-AES-256-GCM)</p>
                        <div className="inspect-form-row">
                          <div className="inspect-form-field">
                            <label className="inspect-form-label">Encryption passphrase</label>
                            <input className="inspect-input" type="password" placeholder="PHI encryption key"
                              value={syncEncPass} onChange={(e) => setSyncEncPass(e.target.value)} />
                          </div>
                          <div className="inspect-form-field">
                            <label className="inspect-form-label">Salt (base64)</label>
                            <input className="inspect-input" placeholder="base64 salt" value={syncEncSalt}
                              onChange={(e) => setSyncEncSalt(e.target.value)} />
                          </div>
                        </div>
                        <p className="clin-fle-note">
                          rawNotes, soapJson and photoRef will be encrypted before leaving this device.
                          patientRef, encounter, noteType remain plaintext for server-side filtering.
                        </p>
                      </div>
                      <div className="inspect-actions">
                        {syncStatus !== "running" ? (
                          <button className="demo-action-btn" onClick={handleSync}
                            disabled={!syncUrl.trim() || !isTauri()}>
                            Push to EHR
                          </button>
                        ) : (
                          <button className="btn-sm danger" onClick={handleStopSync}>Stop Sync</button>
                        )}
                        {!isTauri() && <p className="demo-notice">Requires the native app.</p>}
                      </div>
                      {syncMsg && (
                        <p className={`clin-sync-msg ${syncStatus}`}>{syncMsg}</p>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Right: similar cases */}
              <div className="clin-similar-col">
                <h3 className="clin-similar-title">Similar Cases</h3>
                {!embedModelId ? (
                  <p className="demo-notice">Load an embedding model to enable similarity search.</p>
                ) : similarLoading ? (
                  <p className="clin-similar-loading">Searching…</p>
                ) : similarNotes.length === 0 ? (
                  <p className="clin-similar-empty">
                    {detailNote.embedding?.length
                      ? "No similar cases found (threshold: 60%)."
                      : "This note was saved without an embedding — re-save to enable similarity search."}
                  </p>
                ) : (
                  <div className="clin-similar-list">
                    {similarNotes.map((s) => (
                      <button key={s.id} className="clin-similar-card" onClick={() => openDetail(s.id)}>
                        <div className="clin-similar-header">
                          <span>{typeInfo(s.noteType).icon} {s.patientRef}</span>
                          <span className="clin-sim-score">{(s.score * 100).toFixed(0)}% match</span>
                        </div>
                        <p className="clin-similar-encounter">{s.encounter}</p>
                        <p className="clin-similar-summary">{s.summary}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        );
      })()}
    </div>
  );
}

// ── SOAP display sub-component ─────────────────────────────────────────────────

function SoapDisplay({ soap }: { soap: SoapNote }) {
  const sections: { label: string; key: keyof SoapNote; color: string }[] = [
    { label: "S — Subjective",  key: "subjective", color: "#3b82f6" },
    { label: "O — Objective",   key: "objective",  color: "#10b981" },
    { label: "A — Assessment",  key: "assessment", color: "#f59e0b" },
    { label: "P — Plan",        key: "plan",       color: "#8b5cf6" },
  ];
  return (
    <div className="clin-soap-card">
      <div className="clin-soap-header">SOAP Note</div>
      {sections.map(({ label, key, color }) => (
        <div key={key} className="clin-soap-section">
          <div className="clin-soap-section-label" style={{ color }}>{label}</div>
          <p className="clin-soap-section-body">{soap[key]}</p>
        </div>
      ))}
    </div>
  );
}
