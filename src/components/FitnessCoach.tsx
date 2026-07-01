import { useState, useRef, useCallback } from "react";
import { loadModel, unloadModel, runInference } from "tauri-plugin-litert-api";
import { preprocessImage, parsePose, drawPoseSkeleton, TASK_CATALOGUE } from "../lib/taskModels";
import type { PoseKeypoint } from "../lib/taskModels";
import { isTauri } from "../lib/llm";

const ENTRY = TASK_CATALOGUE.find((e) => e.id === "movenet-lightning")!;
const MODEL_ID = "demo-movenet";
const EXERCISES = ["Squat", "Deadlift", "Push-up", "Plank", "Lunge", "Overhead Press"];

// ── Joint angle calculation ───────────────────────────────────────────────────

function angleDeg(a: PoseKeypoint, b: PoseKeypoint, c: PoseKeypoint): number | null {
  if (a.score < 0.25 || b.score < 0.25 || c.score < 0.25) return null;
  const ax = a.x - b.x, ay = a.y - b.y;
  const cx = c.x - b.x, cy = c.y - b.y;
  const dot = ax * cx + ay * cy;
  const cross = Math.abs(ax * cy - ay * cx);
  return Math.round(Math.atan2(cross, dot) * 180 / Math.PI);
}

function formatAngles(kp: PoseKeypoint[]): string {
  const lines: string[] = [];
  const add = (label: string, a: number, b: number, c: number) => {
    const deg = angleDeg(kp[a], kp[b], kp[c]);
    if (deg !== null) lines.push(`  ${label}: ${deg}°`);
  };
  add("Left knee  (hip→knee→ankle)",     11, 13, 15);
  add("Right knee (hip→knee→ankle)",     12, 14, 16);
  add("Left hip   (shoulder→hip→knee)",   5, 11, 13);
  add("Right hip  (shoulder→hip→knee)",   6, 12, 14);
  add("Left elbow (shoulder→elbow→wrist)", 5,  7,  9);
  add("Right elbow(shoulder→elbow→wrist)", 6,  8, 10);
  return lines.length > 0 ? lines.join("\n") : "  No joints detected with sufficient confidence";
}

// ── Component ─────────────────────────────────────────────────────────────────

const COACH_SYSTEM =
  "You are a fitness coach expert in biomechanics and injury prevention.\n" +
  "Analyze the given joint angles from a single exercise photo and provide concise bullet points.\n" +
  "Each point: start with ✓ if good or ⚠ if needs correction, then 1-2 sentences.\n" +
  "Be specific about the numbers when relevant. Focus on the most impactful safety/form points for the stated exercise.";

interface Props {
  onBack: () => void;
  onAnalyze?: (userText: string, systemPrompt: string) => Promise<string>;
}

export function FitnessCoach({ onBack, onAnalyze }: Props) {
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [exercise, setExercise] = useState(EXERCISES[0]);
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "error">("idle");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef    = useRef<HTMLImageElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const cameraRef  = useRef<HTMLInputElement>(null);

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      setImageDataUrl(e.target?.result as string);
      setFeedback(null);
      setErrorMsg(null);
      setPhase("idle");
      // Clear skeleton canvas
      const ctx = canvasRef.current?.getContext("2d");
      if (ctx && canvasRef.current) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    };
    reader.readAsDataURL(file);
  };

  const analyze = useCallback(async () => {
    if (!imageDataUrl || !isTauri()) return;
    setPhase("running");
    setFeedback(null);
    setErrorMsg(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const modelPath = await invoke<string | null>("get_model_path", { fileName: ENTRY.fileName }).catch(() => null);
      if (!modelPath) {
        setErrorMsg(
          "MoveNet Lightning not found. Open the Tasks panel and download it — " +
          "or follow the Kaggle link in the model description."
        );
        setPhase("error");
        return;
      }
      await loadModel({ modelId: MODEL_ID, modelPath, accelerator: "cpu" });
      try {
        // MoveNet's inputShape is always [batch, h, w, channels].
        const [, h, w] = ENTRY.inputShape as [number, number, number, number];
        const tensor = await preprocessImage(imageDataUrl, h, w, "raw");
        const result = await runInference({
          modelId: MODEL_ID,
          inputs: [Array.from(tensor)],
          inputTypes: ENTRY.inputDtype === "uint8" ? ["uint8"] : undefined,
        });
        setLatencyMs(result.latencyMs);
        const kp = parsePose(result.outputs[0] ?? []);

        // Draw skeleton overlay (clearRect inside makes canvas transparent → img shows through)
        const canvas = canvasRef.current;
        const img    = imgRef.current;
        if (canvas && img) {
          canvas.width  = img.naturalWidth  || 192;
          canvas.height = img.naturalHeight || 192;
          const ctx = canvas.getContext("2d");
          if (ctx) drawPoseSkeleton(ctx, kp, canvas.width, canvas.height);
        }

        // LLM form analysis
        if (onAnalyze) {
          const prompt =
            `Exercise: ${exercise}\n\n` +
            `Joint angles detected (confidence threshold 0.25):\n${formatAngles(kp)}\n\n` +
            `Provide 3 form feedback points for this ${exercise}.`;
          const resp = await onAnalyze(prompt, COACH_SYSTEM);
          setFeedback(resp);
        } else {
          setFeedback(`Pose detected in ${result.latencyMs} ms. Load a language model to get form feedback.`);
        }
        setPhase("done");
      } finally {
        await unloadModel(MODEL_ID).catch(() => {});
      }
    } catch (e) {
      setErrorMsg(String(e));
      setPhase("error");
    }
  }, [imageDataUrl, exercise, onAnalyze]);

  return (
    <div className="demo-screen fitness-screen">
      <header className="demo-header">
        <button className="demo-back" onClick={onBack}>← Back</button>
        <div className="demo-header-text">
          <h1 className="demo-title">Fitness Coach</h1>
          <p className="demo-subtitle">Upload an exercise photo — AI analyzes your form on device</p>
        </div>
      </header>

      <div className="fitness-body">
        {/* Left: controls */}
        <div className="fitness-controls">
          <section className="fitness-section">
            {!imageDataUrl ? (
              <div className="demo-dropzone" onClick={() => galleryRef.current?.click()}>
                <span className="demo-dropzone-icon">🏋️</span>
                <p>Upload a photo of your exercise</p>
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
              </div>
            ) : (
              <button
                className="btn-sm secondary"
                onClick={() => { setImageDataUrl(null); setFeedback(null); setPhase("idle"); setLatencyMs(null); }}
              >
                Change photo
              </button>
            )}
            <input ref={galleryRef} type="file" accept="image/*" style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
          </section>

          {imageDataUrl && (
            <>
              <section className="fitness-section">
                <label className="fitness-label">Exercise</label>
                <div className="fitness-chips">
                  {EXERCISES.map((ex) => (
                    <button
                      key={ex}
                      className={`fitness-chip ${exercise === ex ? "active" : ""}`}
                      onClick={() => setExercise(ex)}
                    >
                      {ex}
                    </button>
                  ))}
                </div>
              </section>

              <section className="fitness-section">
                <button
                  className="demo-action-btn"
                  onClick={analyze}
                  disabled={phase === "running" || !isTauri()}
                >
                  {phase === "running" ? "Analyzing…" : "Analyze Form"}
                </button>
                {!isTauri() && <p className="demo-notice">Requires the native app.</p>}
              </section>

              {latencyMs !== null && phase === "done" && (
                <p className="fitness-latency">Pose detected in {latencyMs} ms</p>
              )}
            </>
          )}
        </div>

        {/* Right: image + skeleton + feedback */}
        <div className="fitness-visual">
          {imageDataUrl && (
            <div className="fitness-canvas-wrap">
              <img ref={imgRef} src={imageDataUrl} alt="Exercise" className="fitness-photo" />
              <canvas ref={canvasRef} className="fitness-skeleton" />
            </div>
          )}

          {errorMsg && <div className="demo-error">{errorMsg}</div>}

          {feedback && (
            <div className="fitness-feedback">
              <h3 className="fitness-feedback-title">Form Feedback — {exercise}</h3>
              <p className="fitness-feedback-text">{feedback}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
