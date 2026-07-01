import { useState, useRef, useCallback, useEffect } from "react";
import { loadModel, unloadModel, runInference, getModelInfo } from "tauri-plugin-litert-api";
import { preprocessImage, parseSegMask, TASK_CATALOGUE } from "../lib/taskModels";
import type { SegMask } from "../lib/taskModels";
import { isTauri } from "../lib/llm";

const ENTRY = TASK_CATALOGUE.find((e) => e.id === "selfie-segmenter")!;
const MODEL_ID = "demo-selfie-studio";

// ── Types ─────────────────────────────────────────────────────────────────────

type BgChoice =
  | { kind: "color"; id: string; color: string }
  | { kind: "image"; id: string; dataUrl: string };

type StudioMode  = "photo" | "live";
type LiveState   = "idle" | "starting" | "running" | "error";
interface BgImage { id: string; dataUrl: string; }

// ── Preset colour swatches ────────────────────────────────────────────────────

const COLOR_PRESETS = [
  { id: "white",  label: "Studio White",  color: "#f8f8f8" },
  { id: "grey",   label: "Studio Grey",   color: "#888888" },
  { id: "black",  label: "Midnight",      color: "#111111" },
  { id: "cream",  label: "Warm Cream",    color: "#f5f0e0" },
  { id: "sky",    label: "Sky Blue",      color: "#87ceeb" },
  { id: "chroma", label: "Green Screen",  color: "#00b140" },
  { id: "dusk",   label: "Dusk Purple",   color: "#5c2d8f" },
  { id: "coral",  label: "Coral",         color: "#ff6b6b" },
];

// ── Photo-mode helpers ────────────────────────────────────────────────────────

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

async function scaleDataUrl(dataUrl: string, maxDim = 1080) {
  const img = await loadImg(dataUrl);
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d")!.drawImage(img, 0, 0, w, h);
  return { dataUrl: c.toDataURL("image/jpeg", 0.9), w, h };
}

async function compositePhoto(
  origDataUrl: string,
  mask: SegMask,
  bg: BgChoice,
  W: number,
  H: number,
): Promise<string> {
  const origImg = await loadImg(origDataUrl);
  const origC = document.createElement("canvas");
  origC.width = W; origC.height = H;
  origC.getContext("2d")!.drawImage(origImg, 0, 0, W, H);
  const origPx = origC.getContext("2d")!.getImageData(0, 0, W, H).data;

  const bgC = document.createElement("canvas");
  bgC.width = W; bgC.height = H;
  const bgCtx = bgC.getContext("2d")!;
  if (bg.kind === "color") {
    bgCtx.fillStyle = bg.color;
    bgCtx.fillRect(0, 0, W, H);
  } else {
    bgCtx.drawImage(await loadImg(bg.dataUrl), 0, 0, W, H);
  }
  const bgPx = bgCtx.getImageData(0, 0, W, H).data;

  const outC = document.createElement("canvas");
  outC.width = W; outC.height = H;
  const outCtx = outC.getContext("2d")!;
  const outId  = outCtx.createImageData(W, H);
  const out = outId.data;

  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const i  = (py * W + px) * 4;
      const mx = Math.min(Math.floor((px / W) * mask.width),  mask.width  - 1);
      const my = Math.min(Math.floor((py / H) * mask.height), mask.height - 1);
      const src = mask.classMap[my * mask.width + mx] === 1 ? origPx : bgPx;
      out[i] = src[i]; out[i+1] = src[i+1]; out[i+2] = src[i+2]; out[i+3] = 255;
    }
  }
  outCtx.putImageData(outId, 0, 0);
  return outC.toDataURL("image/jpeg", 0.92);
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props { onBack: () => void; }

export function BackgroundStudio({ onBack }: Props) {
  // ── React state ────────────────────────────────────────────────────────────
  const [mode, setMode]             = useState<StudioMode>("photo");
  const [bg, setBg]                 = useState<BgChoice>({ kind: "color", id: "white", color: "#f8f8f8" });
  const [bgImages, setBgImages]     = useState<BgImage[]>([]);
  const [selfieDataUrl, setSelfie]  = useState<string | null>(null);
  const [resultDataUrl, setResult]  = useState<string | null>(null);
  const [photoPhase, setPhotoPhase] = useState<"idle" | "running" | "done" | "error">("idle");
  const [photoLatMs, setPhotoLatMs] = useState<number | null>(null);
  const [liveState, setLiveState]   = useState<LiveState>("idle");
  const [errorMsg, setErrorMsg]     = useState<string | null>(null);

  // ── Refs (accessed without closure staleness) ──────────────────────────────
  const videoRef     = useRef<HTMLVideoElement>(null);
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const galleryRef   = useRef<HTMLInputElement>(null);
  const cameraRef    = useRef<HTMLInputElement>(null);
  const bgUploadRef  = useRef<HTMLInputElement>(null);
  // Live inference state
  const streamRef    = useRef<MediaStream | null>(null);
  const rafRef       = useRef<number | null>(null);
  const liveOnRef    = useRef(false);
  const inferringRef = useRef(false);
  const maskRef      = useRef<SegMask | null>(null);
  const outBufRef    = useRef<ImageData | null>(null);
  const modelHRef    = useRef(256);
  const modelWRef    = useRef(256);
  // Keep bg & bitmap current so the RAF loop never reads stale React state
  const bgRef        = useRef<BgChoice>(bg);
  const bgBitmapRef  = useRef<ImageBitmap | null>(null);

  // Sync bg → ref
  useEffect(() => { bgRef.current = bg; }, [bg]);

  // Sync bg image → ImageBitmap for fast drawing in the live loop
  useEffect(() => {
    bgBitmapRef.current = null;
    if (bg.kind !== "image") return;
    let cancelled = false;
    fetch(bg.dataUrl)
      .then((r) => r.blob())
      .then((b) => createImageBitmap(b))
      .then((bm) => { if (!cancelled) bgBitmapRef.current = bm; })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [bg]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      liveOnRef.current = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      unloadModel(MODEL_ID).catch(() => {});
    };
  }, []);

  // ── File handlers ──────────────────────────────────────────────────────────

  const handleSelfie = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      setSelfie(e.target?.result as string);
      setResult(null);
      setPhotoPhase("idle");
      setErrorMsg(null);
    };
    reader.readAsDataURL(file);
  };

  const handleBgUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      const id = `bgimg-${Date.now()}`;
      setBgImages((prev) => [...prev, { id, dataUrl }]);
      setBg({ kind: "image", id, dataUrl });
    };
    reader.readAsDataURL(file);
  };

  // ── Photo mode ─────────────────────────────────────────────────────────────

  const runPhoto = useCallback(async () => {
    if (!selfieDataUrl || !isTauri()) return;
    setPhotoPhase("running");
    setResult(null);
    setErrorMsg(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const modelPath = await invoke<string | null>("get_model_path", { fileName: ENTRY.fileName }).catch(() => null);
      if (!modelPath) {
        setErrorMsg("Selfie Segmenter not found. Open the Tasks panel and download it first.");
        setPhotoPhase("error");
        return;
      }
      const { dataUrl: scaled, w, h } = await scaleDataUrl(selfieDataUrl);
      await loadModel({ modelId: MODEL_ID, modelPath, accelerator: "cpu" });
      try {
        const info = await getModelInfo(MODEL_ID);
        const shape = info.inputShapes?.[0] ?? [1, 256, 256, 3];
        const mh = shape[1] ?? 256, mw = shape[2] ?? 256;
        const t0 = performance.now();
        const tensor = await preprocessImage(scaled, mh, mw, "zero-one");
        const result = await runInference({ modelId: MODEL_ID, inputs: [Array.from(tensor)] });
        setPhotoLatMs(Math.round(performance.now() - t0));
        const shapes = (result as { outputShapes?: number[][] }).outputShapes ?? result.outputs.map((o) => [o.length]);
        const mask   = parseSegMask(result.outputs, shapes, mh, mw);
        if (!mask) throw new Error("Could not parse segmentation mask.");
        setResult(await compositePhoto(scaled, mask, bg, w, h));
        setPhotoPhase("done");
      } finally {
        await unloadModel(MODEL_ID).catch(() => {});
      }
    } catch (e) {
      setErrorMsg(String(e));
      setPhotoPhase("error");
    }
  }, [selfieDataUrl, bg]);

  // ── Live mode — RAF loop functions (read only from refs) ───────────────────

  // Draws one composited frame onto the canvas. Reads exclusively from refs.
  const drawLiveFrame = useCallback(() => {
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    const mask   = maskRef.current;
    if (!video || !canvas || video.readyState < 2) return;

    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (!mask) {
      // Waiting for first inference — show raw feed
      ctx.drawImage(video, 0, 0, W, H);
      return;
    }

    // Draw background
    const curBg = bgRef.current;
    if (curBg.kind === "color") {
      ctx.fillStyle = curBg.color;
      ctx.fillRect(0, 0, W, H);
    } else if (bgBitmapRef.current) {
      ctx.drawImage(bgBitmapRef.current, 0, 0, W, H);
    } else {
      ctx.fillStyle = "#222";
      ctx.fillRect(0, 0, W, H);
    }
    const bgPx = ctx.getImageData(0, 0, W, H).data;

    // Capture video frame
    const vidC = new OffscreenCanvas(W, H);
    vidC.getContext("2d")!.drawImage(video, 0, 0, W, H);
    const vidPx = vidC.getContext("2d")!.getImageData(0, 0, W, H).data;

    // Reuse output buffer to avoid GC pressure
    if (!outBufRef.current || outBufRef.current.width !== W || outBufRef.current.height !== H) {
      outBufRef.current = ctx.createImageData(W, H);
    }
    const out = outBufRef.current.data;
    const { classMap, width: mw, height: mh } = mask;

    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const i  = (py * W + px) * 4;
        const mx = Math.min(Math.floor(px * mw / W), mw - 1);
        const my = Math.min(Math.floor(py * mh / H), mh - 1);
        const src = classMap[my * mw + mx] === 1 ? vidPx : bgPx;
        out[i] = src[i]; out[i+1] = src[i+1]; out[i+2] = src[i+2]; out[i+3] = 255;
      }
    }
    ctx.putImageData(outBufRef.current, 0, 0);
  }, []); // no deps — reads only from refs

  // Runs one inference on the current video frame. Called from RAF loop.
  const doInference = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || inferringRef.current) return;
    inferringRef.current = true;
    const mh = modelHRef.current, mw = modelWRef.current;
    try {
      const c = new OffscreenCanvas(mw, mh);
      const ctx2 = c.getContext("2d")!;
      ctx2.drawImage(video, 0, 0, mw, mh);
      const { data } = ctx2.getImageData(0, 0, mw, mh);
      const tensor = new Float32Array(mh * mw * 3);
      for (let i = 0; i < mh * mw; i++) {
        tensor[i * 3]     = data[i * 4]     / 255;
        tensor[i * 3 + 1] = data[i * 4 + 1] / 255;
        tensor[i * 3 + 2] = data[i * 4 + 2] / 255;
      }
      runInference({ modelId: MODEL_ID, inputs: [Array.from(tensor)] })
        .then((result) => {
          if (!liveOnRef.current) return;
          const shapes = (result as { outputShapes?: number[][] }).outputShapes
            ?? result.outputs.map((o) => [o.length]);
          const newMask = parseSegMask(result.outputs, shapes, mh, mw);
          if (newMask) maskRef.current = newMask;
        })
        .catch(() => {})
        .finally(() => { inferringRef.current = false; });
    } catch {
      inferringRef.current = false;
    }
  }, []); // no deps — reads only from refs

  const startLiveLoop = useCallback(() => {
    const loop = () => {
      if (!liveOnRef.current) return;
      drawLiveFrame();
      doInference();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [drawLiveFrame, doInference]);

  // ── Start / stop live ──────────────────────────────────────────────────────

  const startLive = useCallback(async () => {
    if (!isTauri()) { setErrorMsg("Live inference requires the native app."); return; }
    setLiveState("starting");
    setErrorMsg(null);
    maskRef.current  = null;
    inferringRef.current = false;
    outBufRef.current = null;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const modelPath = await invoke<string | null>("get_model_path", { fileName: ENTRY.fileName }).catch(() => null);
      if (!modelPath) {
        setErrorMsg("Selfie Segmenter not found. Open the Tasks panel and download it first.");
        setLiveState("error");
        return;
      }
      await loadModel({ modelId: MODEL_ID, modelPath, accelerator: "cpu" });
      const info   = await getModelInfo(MODEL_ID);
      const shape  = info.inputShapes?.[0] ?? [1, 256, 256, 3];
      modelHRef.current = shape[1] ?? 256;
      modelWRef.current = shape[2] ?? 256;

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      streamRef.current = stream;

      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();

      const canvas = canvasRef.current!;
      canvas.width  = video.videoWidth  || 640;
      canvas.height = video.videoHeight || 480;

      liveOnRef.current = true;
      setLiveState("running");
      startLiveLoop();
    } catch (e) {
      setErrorMsg(String(e));
      setLiveState("error");
      unloadModel(MODEL_ID).catch(() => {});
    }
  }, [startLiveLoop]);

  const stopLive = useCallback(() => {
    liveOnRef.current = false;
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    maskRef.current = null;
    inferringRef.current = false;
    outBufRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    unloadModel(MODEL_ID).catch(() => {});
    setLiveState("idle");
  }, []);

  const switchMode = (m: StudioMode) => {
    if (m === "photo" && liveState === "running") stopLive();
    setMode(m);
    setErrorMsg(null);
  };

  // ── Shared background selector ─────────────────────────────────────────────

  const BgSelector = (
    <div className="studio-bg-section">
      <h3 className="studio-step">Background</h3>
      <p className="studio-bg-sublabel">Colors</p>
      <div className="studio-bg-grid">
        {COLOR_PRESETS.map((p) => (
          <button
            key={p.id}
            className={`studio-swatch ${bg.kind === "color" && bg.id === p.id ? "active" : ""}`}
            style={{ background: p.color }}
            title={p.label}
            onClick={() => setBg({ kind: "color", id: p.id, color: p.color })}
          />
        ))}
      </div>
      {bgImages.length > 0 && (
        <>
          <p className="studio-bg-sublabel">Images</p>
          <div className="studio-bg-grid">
            {bgImages.map((img) => (
              <button
                key={img.id}
                className={`studio-swatch ${bg.kind === "image" && bg.id === img.id ? "active" : ""}`}
                onClick={() => setBg({ kind: "image", id: img.id, dataUrl: img.dataUrl })}
                title="Background image"
              >
                <img src={img.dataUrl} alt="" className="studio-swatch-img" />
              </button>
            ))}
            <button
              className="studio-swatch studio-swatch-upload"
              title="Upload another image"
              onClick={() => bgUploadRef.current?.click()}
            >+</button>
          </div>
        </>
      )}
      {bgImages.length === 0 && (
        <button className="btn-sm secondary studio-add-img-btn" onClick={() => bgUploadRef.current?.click()}>
          + Add background image
        </button>
      )}
      <input ref={bgUploadRef} type="file" accept="image/*" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleBgUpload(f); e.target.value = ""; }} />
    </div>
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="demo-screen studio-screen">
      <header className="demo-header">
        <button className="demo-back" onClick={onBack}>← Back</button>
        <div className="demo-header-text">
          <h1 className="demo-title">Background Studio</h1>
          <p className="demo-subtitle">Remove and replace your background — fully on device</p>
        </div>
        <div className="studio-mode-tabs">
          <button className={`studio-mode-tab ${mode === "photo" ? "active" : ""}`} onClick={() => switchMode("photo")}>
            Photo
          </button>
          <button className={`studio-mode-tab ${mode === "live" ? "active" : ""}`} onClick={() => switchMode("live")}>
            Live
          </button>
        </div>
      </header>

      {errorMsg && <div className="demo-error" style={{ margin: "0.5rem 1.25rem 0" }}>{errorMsg}</div>}

      {/* ── Photo mode ── */}
      {mode === "photo" && (
        <div className="studio-body">
          <div className="studio-controls">
            <section className="studio-section">
              <h3 className="studio-step">Portrait</h3>
              {!selfieDataUrl ? (
                <div className="demo-dropzone" onClick={() => galleryRef.current?.click()}>
                  <span className="demo-dropzone-icon">🤳</span>
                  <p>A portrait or selfie works best</p>
                  <div className="demo-dropzone-actions">
                    <button className="btn-sm" onClick={(e) => { e.stopPropagation(); galleryRef.current?.click(); }}>Gallery</button>
                    {isTauri() && (
                      <button className="btn-sm secondary" onClick={(e) => { e.stopPropagation(); cameraRef.current?.click(); }}>Camera</button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="studio-thumb-row">
                  <img src={selfieDataUrl} alt="Portrait" className="studio-thumb" />
                  <button className="btn-sm secondary"
                    onClick={() => { setSelfie(null); setResult(null); setPhotoPhase("idle"); }}>
                    Change
                  </button>
                </div>
              )}
            </section>
            {BgSelector}
            <section className="studio-section">
              <button
                className="demo-action-btn"
                onClick={runPhoto}
                disabled={!selfieDataUrl || photoPhase === "running" || !isTauri()}
              >
                {photoPhase === "running" ? "Processing…" : "Replace Background"}
              </button>
              {!isTauri() && <p className="demo-notice">Requires the native app.</p>}
              {photoLatMs !== null && photoPhase === "done" && (
                <p className="fitness-latency">Segmented in {photoLatMs} ms</p>
              )}
            </section>
          </div>

          <div className="studio-result-panel">
            {resultDataUrl ? (
              <div className="studio-result">
                <img src={resultDataUrl} alt="Result" className="studio-result-img" />
                <a className="btn-sm studio-dl-btn" href={resultDataUrl} download="studio-result.jpg">Download</a>
              </div>
            ) : selfieDataUrl ? (
              <div className="studio-preview-placeholder">
                <img src={selfieDataUrl} alt="Original" className="studio-result-img studio-result-dim" />
                <span className="studio-placeholder-label">Result appears here</span>
              </div>
            ) : (
              <div className="studio-empty"><span>🖼️</span><p>Upload a photo to get started</p></div>
            )}
          </div>
        </div>
      )}

      {/* ── Live mode ── */}
      {mode === "live" && (
        <div className="studio-body">
          <div className="studio-controls">
            {BgSelector}
            <section className="studio-section">
              {liveState === "idle" || liveState === "error" ? (
                <button className="demo-action-btn" onClick={startLive} disabled={!isTauri()}>
                  Start Camera
                </button>
              ) : liveState === "starting" ? (
                <button className="demo-action-btn" disabled>Starting…</button>
              ) : (
                <button className="demo-action-btn studio-stop-btn" onClick={stopLive}>
                  Stop Camera
                </button>
              )}
              {!isTauri() && <p className="demo-notice">Requires the native app.</p>}
              {liveState === "running" && (
                <p className="fitness-latency">Live — change background above while the camera runs</p>
              )}
            </section>
          </div>

          <div className="studio-result-panel">
            {/* Hidden video source */}
            <video ref={videoRef} playsInline muted style={{ display: "none" }} />
            {liveState === "running" || liveState === "starting" ? (
              <canvas ref={canvasRef} className="studio-live-canvas" />
            ) : (
              <div className="studio-empty">
                <span>📷</span>
                <p>Press "Start Camera" to begin live background replacement</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Hidden file inputs */}
      <input ref={galleryRef} type="file" accept="image/*" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleSelfie(f); e.target.value = ""; }} />
      <input ref={cameraRef} type="file" accept="image/*" capture="user" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleSelfie(f); e.target.value = ""; }} />
    </div>
  );
}
