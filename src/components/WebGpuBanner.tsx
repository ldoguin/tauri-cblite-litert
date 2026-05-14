/**
 * WebGpuBanner — shown once on page load.
 *
 * Detects WebGPU support and renders:
 *   - Nothing if WebGPU is available (no noise for happy path)
 *   - A dismissible warning with browser-specific instructions if not
 */

import { useEffect, useState } from "react";

type GpuStatus =
  | "checking"
  | "supported"
  | "no-adapter"   // navigator.gpu exists but requestAdapter() returned null
  | "no-api";      // navigator.gpu is undefined

async function detectWebGpu(): Promise<GpuStatus> {
  if (typeof navigator === "undefined" || !("gpu" in navigator)) return "no-api";
  try {
    const adapter = await (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown> } })
      .gpu.requestAdapter();
    return adapter ? "supported" : "no-adapter";
  } catch {
    return "no-adapter";
  }
}

function getBrowser(): "chrome" | "firefox" | "safari" | "other" {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("firefox")) return "firefox";
  if (ua.includes("safari") && !ua.includes("chrome")) return "safari";
  if (ua.includes("chrome") || ua.includes("chromium")) return "chrome";
  return "other";
}

const INSTRUCTIONS: Record<
  "no-adapter" | "no-api",
  Record<ReturnType<typeof getBrowser>, { steps: string[]; flag?: string }>
> = {
  "no-api": {
    chrome: {
      steps: [
        "Update Chrome to version 113 or later (chrome://settings/help)",
        "Open chrome://flags and enable #enable-unsafe-webgpu",
        "Restart Chrome",
      ],
      flag: "chrome://flags/#enable-unsafe-webgpu",
    },
    firefox: {
      steps: [
        "Open about:config and set dom.webgpu.enabled = true",
        "Set gfx.webrender.all = true",
        "Restart Firefox",
      ],
      flag: "about:config",
    },
    safari: {
      steps: [
        "Update to Safari 18+ (macOS Sonoma or iOS 18)",
        "Go to Safari → Settings → Feature Flags → enable WebGPU",
      ],
    },
    other: {
      steps: [
        "Use Chrome 113+, Edge 113+, or Safari 18+ for WebGPU support",
        "Firefox requires dom.webgpu.enabled = true in about:config",
      ],
    },
  },
  "no-adapter": {
    chrome: {
      steps: [
        "Your GPU driver may be blocklisted — try updating your graphics drivers",
        "Open chrome://flags and enable #enable-unsafe-webgpu to bypass the blocklist",
        "On Linux, also set #enable-vulkan and restart",
      ],
      flag: "chrome://flags/#enable-unsafe-webgpu",
    },
    firefox: {
      steps: [
        "Open about:config and verify dom.webgpu.enabled = true",
        "Check that your GPU drivers are up to date",
        "On Linux, WebGPU requires Vulkan — install vulkan-icd-loader",
      ],
    },
    safari: {
      steps: [
        "Ensure your Mac has a Metal-compatible GPU (2012 or later)",
        "Update macOS to Sonoma or later",
      ],
    },
    other: {
      steps: [
        "Update your GPU drivers",
        "Try Chrome 113+ or Edge 113+ with up-to-date drivers",
      ],
    },
  },
};

const DISMISSED_KEY = "rag-chatbot:webgpu-banner-dismissed";

export function WebGpuBanner() {
  const [status, setStatus] = useState<GpuStatus>("checking");
  const [dismissed, setDismissed] = useState(
    () => sessionStorage.getItem(DISMISSED_KEY) === "1",
  );

  const dismiss = () => {
    sessionStorage.setItem(DISMISSED_KEY, "1");
    setDismissed(true);
  };

  useEffect(() => {
    // Only show on web — Tauri uses native GPU access
    if ("__TAURI_INTERNALS__" in window) { setStatus("supported"); return; }
    let cancelled = false;
    detectWebGpu().then((s) => { if (!cancelled) setStatus(s); }).catch(() => {
      if (!cancelled) setStatus("no-api");
    });
    return () => { cancelled = true; };
  }, []);

  if (status === "checking" || status === "supported" || dismissed) return null;

  const browser = getBrowser();
  const info = INSTRUCTIONS[status][browser];
  const isNoApi = status === "no-api";

  return (
    <div className="webgpu-banner">
      <div className="webgpu-banner-inner">
        <div className="webgpu-banner-icon">{isNoApi ? "⚠️" : "⚠️"}</div>
        <div className="webgpu-banner-body">
          <strong>
            {isNoApi
              ? "WebGPU is not available in this browser"
              : "WebGPU is supported but no GPU adapter was found"}
          </strong>
          <p>
            {isNoApi
              ? "On-device LLM inference (Gemma, Llama…) requires WebGPU. The app still works — use the API config for cloud LLM, or try a WebGPU-capable browser."
              : "WebGPU is enabled but your GPU could not be initialised. LLM inference will fall back to CPU (Wasm), which is significantly slower."}
          </p>
          <ol className="webgpu-steps">
            {info.steps.map((s) => (
              <li key={s}>
                {info.flag && s.includes(info.flag.split("/")[0])
                  ? <>{s.split(info.flag)[0]}<a href={info.flag} target="_blank" rel="noreferrer">{info.flag}</a>{s.split(info.flag)[1]}</>
                  : s}
              </li>
            ))}
          </ol>
        </div>
        <button className="webgpu-dismiss" onClick={dismiss} title="Dismiss" aria-label="Dismiss WebGPU warning">✕</button>
      </div>
    </div>
  );
}
