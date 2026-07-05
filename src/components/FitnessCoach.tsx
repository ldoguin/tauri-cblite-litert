import { useState, useRef, useCallback } from "react";
import { loadModel, unloadModel, runInference } from "tauri-plugin-litert-api";
import { preprocessImage, parsePose, drawPoseSkeleton, TASK_CATALOGUE } from "../lib/taskModels";
import type { PoseKeypoint } from "../lib/taskModels";
import { isTauri } from "../lib/llm";

// Bypass TypeScript's module resolver for CDN URL imports.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const importFromUrl = (url: string): Promise<any> => new Function("u", "return import(u)")(url);

const ENTRY = TASK_CATALOGUE.find((e) => e.id === "movenet-lightning")!;
const MODEL_ID = "demo-movenet";
const EXERCISES = ["Squat", "Deadlift", "Push-up", "Plank", "Lunge", "Overhead Press"];

// CDN base for @mediapipe/tasks-vision WASM (web path only)
const MP_VISION_WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
// Lite model — ~6 MB, no GPU required
const MP_POSE_MODEL  = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

// ── MediaPipe PoseLandmarker → MoveNet-compatible PoseKeypoint mapping ────────
//
// MediaPipe uses 33 landmarks; we remap the 17 we need to MoveNet indices so
// formatAngles() and drawPoseSkeleton() work unchanged on both paths.
//
//   MoveNet idx  name              MediaPipe idx
//   0            nose              0
//   5            left_shoulder     11
//   6            right_shoulder    12
//   7            left_elbow        13
//   8            right_elbow       14
//   9            left_wrist        15
//   10           right_wrist       16
//   11           left_hip          23
//   12           right_hip         24
//   13           left_knee         25
//   14           right_knee        26
//   15           left_ankle        27
//   16           right_ankle       28

type MPLandmark = { x: number; y: number; z: number; visibility?: number };

// MoveNet keypoint names (index 0–16)
const MN_NAMES = [
  "nose","left_eye","right_eye","left_ear","right_ear",
  "left_shoulder","right_shoulder","left_elbow","right_elbow",
  "left_wrist","right_wrist","left_hip","right_hip",
  "left_knee","right_knee","left_ankle","right_ankle",
];

// MoveNet index → MediaPipe landmark index (-1 = no equivalent)
const MN_TO_MP = [0, -1, -1, -1, -1, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

function mpLandmarksToKeypoints(landmarks: MPLandmark[]): PoseKeypoint[] {
  return MN_TO_MP.map((mpIdx, mnIdx) => {
    if (mpIdx < 0 || mpIdx >= landmarks.length) return { name: MN_NAMES[mnIdx], x: 0, y: 0, score: 0 };
    const lm = landmarks[mpIdx];
    return { name: MN_NAMES[mnIdx], x: lm.x, y: lm.y, score: lm.visibility ?? 1 };
  });
}

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
  add("Left knee  (hip→knee→ankle)",      11, 13, 15);
  add("Right knee (hip→knee→ankle)",      12, 14, 16);
  add("Left hip   (shoulder→hip→knee)",    5, 11, 13);
  add("Right hip  (shoulder→hip→knee)",    6, 12, 14);
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
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const imgRef     = useRef<HTMLImageElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const cameraRef  = useRef<HTMLInputElement>(null);

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      setImageDataUrl(e.target?.result as string);
      setFeedback(null);
      setErrorMsg(null);
      setPhase("idle");
      const ctx = canvasRef.current?.getContext("2d");
      if (ctx && canvasRef.current) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    };
    reader.readAsDataURL(file);
  };

  // ── Shared helpers ────────────────────────────────────────────────────────

  function drawSkeleton(kp: PoseKeypoint[]) {
    const canvas = canvasRef.current;
    const img    = imgRef.current;
    if (canvas && img) {
      canvas.width  = img.naturalWidth  || 192;
      canvas.height = img.naturalHeight || 192;
      const ctx = canvas.getContext("2d");
      if (ctx) drawPoseSkeleton(ctx, kp, canvas.width, canvas.height);
    }
  }

  async function runLlm(kp: PoseKeypoint[]) {
    if (onAnalyze) {
      const prompt =
        `Exercise: ${exercise}\n\n` +
        `Joint angles detected (confidence threshold 0.25):\n${formatAngles(kp)}\n\n` +
        `Provide 3 form feedback points for this ${exercise}.`;
      const resp = await onAnalyze(prompt, COACH_SYSTEM);
      setFeedback(resp);
    } else {
      setFeedback("Pose detected. Load a language model to get form feedback.");
    }
  }

  function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  // ── Native path: MoveNet via tauri-plugin-litert ──────────────────────────

  const analyzeNative = useCallback(async () => {
    if (!imageDataUrl) return;
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
        const [, h, w] = ENTRY.inputShape as [number, number, number, number];
        const tensor = await preprocessImage(imageDataUrl, h, w, "raw");
        const result = await runInference({
          modelId: MODEL_ID,
          inputs: [Array.from(tensor)],
          inputTypes: ENTRY.inputDtype === "uint8" ? ["uint8"] : undefined,
        });
        setLatencyMs(result.latencyMs);
        const kp = parsePose(result.outputs[0] ?? []);
        drawSkeleton(kp);
        await runLlm(kp);
        setPhase("done");
      } finally {
        await unloadModel(MODEL_ID).catch(() => {});
      }
    } catch (e) {
      setErrorMsg(String(e));
      setPhase("error");
    }
  }, [imageDataUrl, exercise, onAnalyze]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Web path: PoseLandmarker via @mediapipe/tasks-vision (CDN) ───────────

  const analyzeWeb = useCallback(async () => {
    if (!imageDataUrl) return;
    setPhase("running");
    setFeedback(null);
    setErrorMsg(null);
    try {
      // Loaded from CDN at runtime — no npm install, no bundle impact.
      // importFromUrl is a thin wrapper that calls the native dynamic import()
      // with a string URL, bypassing TypeScript's module resolver.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mpVision: any = await importFromUrl(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs"
      );
      const FilesetResolver = mpVision.FilesetResolver as {
        forVisionTasks(wasmPath: string): Promise<unknown>;
      };
      const PoseLandmarker = mpVision.PoseLandmarker as {
        createFromOptions(vision: unknown, opts: object): Promise<{
          detect(img: HTMLImageElement): { landmarks: MPLandmark[][] };
          close(): void;
        }>;
      };

      const vision = await FilesetResolver.forVisionTasks(MP_VISION_WASM);
      const landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MP_POSE_MODEL, delegate: "CPU" },
        runningMode: "IMAGE",
        numPoses: 1,
      });

      const img = await loadImage(imageDataUrl);
      const t0 = performance.now();
      const result = landmarker.detect(img);
      setLatencyMs(Math.round(performance.now() - t0));
      landmarker.close();

      if (!result.landmarks || result.landmarks.length === 0) {
        setErrorMsg("No person detected. Try a clearer full-body photo.");
        setPhase("error");
        return;
      }

      const kp = mpLandmarksToKeypoints(result.landmarks[0]);
      drawSkeleton(kp);
      await runLlm(kp);
      setPhase("done");
    } catch (e) {
      setErrorMsg("Pose detection failed: " + String(e));
      setPhase("error");
    }
  }, [imageDataUrl, exercise, onAnalyze]); // eslint-disable-line react-hooks/exhaustive-deps

  const analyze = isTauri() ? analyzeNative : analyzeWeb;

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
                  disabled={phase === "running"}
                >
                  {phase === "running" ? "Analyzing…" : "Analyze Form"}
                </button>
                {!isTauri() && (
                  <p className="demo-notice" style={{ marginTop: 6, fontSize: "0.8rem", opacity: 0.7 }}>
                    Pose detection runs in-browser via MediaPipe — no download required.
                  </p>
                )}
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
