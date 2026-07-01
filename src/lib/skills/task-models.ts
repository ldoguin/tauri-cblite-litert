/**
 * task-models.ts — Agent tools that run on-device TFLite inference.
 *
 * Each tool is self-contained: it locates the model file, loads it under a
 * dedicated "task-tool-" ID (separate from the Tasks panel's "task-model-"
 * namespace so the two never conflict), runs inference, and unloads on exit.
 *
 * Supported task types: image-classification, object-detection.
 * (Audio, pose, segmentation, etc. require richer input formats; add later.)
 */

import { loadModel, unloadModel, runInference } from "tauri-plugin-litert-api";
import type { Tool } from "../tools";
import {
  TASK_CATALOGUE,
  preprocessImage,
  topKClassifications,
  parseDetections,
  fetchLabels,
  COCO_LABELS,
  type TaskCatalogEntry,
} from "../taskModels";

// ── Helpers ───────────────────────────────────────────────────────────────────

// Separate prefix so tool-loaded models don't clash with the Tasks panel.
const PREFIX = "task-tool-";

function toolModelId(fileName: string) {
  return PREFIX + fileName;
}

async function getModelPath(fileName: string): Promise<string | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("get_model_path", { fileName }).catch(() => null);
}

// Label cache — fetched once per entry, reused across calls.
const labelCache = new Map<string, string[]>();

async function getLabels(entry: TaskCatalogEntry): Promise<string[]> {
  if (entry.task === "object-detection") return COCO_LABELS;
  if (!entry.labelsUrl) return [];
  const cached = labelCache.get(entry.id);
  if (cached) return cached;
  try {
    const loaded = await fetchLabels(entry.labelsUrl);
    if (loaded.length > 0) labelCache.set(entry.id, loaded);
    return loaded;
  } catch {
    return [];
  }
}

async function withModel<T>(
  path: string,
  fileName: string,
  fn: (modelId: string) => Promise<T>,
): Promise<T> {
  const modelId = toolModelId(fileName);
  await loadModel({ modelId, modelPath: path, accelerator: "cpu" });
  try {
    return await fn(modelId);
  } finally {
    await unloadModel(modelId).catch(() => {});
  }
}

// ── Image classification ──────────────────────────────────────────────────────

function imageClassificationTool(entry: TaskCatalogEntry): Tool {
  const shape = entry.inputShape as [number, number, number, number];
  const [, h, w] = shape;
  return {
    id: `task_${entry.id}`,
    name: entry.name,
    description:
      `Classify what is in an image using ${entry.name} (on-device, no internet required). ` +
      `Returns the top-5 predicted categories with confidence scores. ` +
      `Accepts any https:// image URL or a data: URL.`,
    requiresNetwork: false,
    params: [
      {
        name: "image_url",
        type: "string",
        description: "HTTPS or data URL of the image to classify",
        required: true,
      },
    ],
    async run({ image_url }) {
      if (!image_url || typeof image_url !== "string") return "Error: image_url is required";
      const path = await getModelPath(entry.fileName);
      if (!path) {
        return `${entry.name} is not downloaded. Open the Tasks panel and download it first (${entry.sizeMb} MB).`;
      }
      const labels = await getLabels(entry);
      return withModel(path, entry.fileName, async (modelId) => {
        const tensor = await preprocessImage(image_url, h, w, entry.normalizeMode);
        const result = await runInference({ modelId, inputs: [Array.from(tensor)] });
        const outputs = result.outputs;
        if (!outputs[0] || !labels.length) {
          return `Inference complete but labels unavailable — raw output has ${outputs[0]?.length ?? 0} values.`;
        }
        const items = topKClassifications(outputs[0], labels, 5);
        return (
          `${entry.name} — ${result.latencyMs} ms\n` +
          items.map((r) => `${r.rank}. ${r.label} (${(r.score * 100).toFixed(1)}%)`).join("\n")
        );
      });
    },
  };
}

// ── Object detection ──────────────────────────────────────────────────────────

function objectDetectionTool(entry: TaskCatalogEntry): Tool {
  const shape = entry.inputShape as [number, number, number, number];
  const [, h, w] = shape;
  return {
    id: `task_${entry.id}`,
    name: entry.name,
    description:
      `Detect and locate objects in an image using ${entry.name} (on-device, no internet required). ` +
      `Returns each detected object's label, confidence score, and normalised bounding box [0–1]. ` +
      `Accepts any https:// image URL or a data: URL.`,
    requiresNetwork: false,
    params: [
      {
        name: "image_url",
        type: "string",
        description: "HTTPS or data URL of the image to analyse",
        required: true,
      },
      {
        name: "threshold",
        type: "number",
        description: "Minimum confidence 0–1 (default 0.3)",
        required: false,
      },
    ],
    async run({ image_url, threshold }) {
      if (!image_url || typeof image_url !== "string") return "Error: image_url is required";
      const path = await getModelPath(entry.fileName);
      if (!path) {
        return `${entry.name} is not downloaded. Open the Tasks panel and download it first (${entry.sizeMb} MB).`;
      }
      const conf = typeof threshold === "number" ? Math.max(0, Math.min(1, threshold)) : 0.3;
      const labels = await getLabels(entry);
      return withModel(path, entry.fileName, async (modelId) => {
        const tensor = await preprocessImage(image_url, h, w, entry.normalizeMode);
        const result = await runInference({ modelId, inputs: [Array.from(tensor)] });
        const detections = parseDetections(result.outputs, labels, conf, h, w);
        if (!detections || detections.length === 0) {
          return `${entry.name} — ${result.latencyMs} ms — no objects detected above ${Math.round(conf * 100)}% confidence.`;
        }
        return (
          `${entry.name} — ${result.latencyMs} ms — ${detections.length} object(s) detected:\n` +
          detections
            .map(
              (d, i) =>
                `${i + 1}. ${d.label} (${(d.score * 100).toFixed(1)}%) ` +
                `[top=${d.box.y1.toFixed(2)} left=${d.box.x1.toFixed(2)} ` +
                `bottom=${d.box.y2.toFixed(2)} right=${d.box.x2.toFixed(2)}]`,
            )
            .join("\n")
        );
      });
    },
  };
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Returns one Tool per downloadable task model that produces text-friendly
 * output (classification and detection). Paired model halves are skipped.
 */
export function createTaskModelTools(): Tool[] {
  return TASK_CATALOGUE.flatMap((entry) => {
    if (entry.isPairedModel) return [];
    if (!entry.downloadUrl && !entry.fileName) return [];
    if (entry.task === "image-classification") return [imageClassificationTool(entry)];
    if (entry.task === "object-detection")     return [objectDetectionTool(entry)];
    return [];
  });
}
