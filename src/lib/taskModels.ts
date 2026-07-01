/**
 * taskModels.ts — catalog and inference helpers for general TFLite task models.
 *
 * Supports image-classification, object-detection, audio-classification,
 * pose-estimation, image-segmentation, depth-estimation, super-resolution,
 * style-transfer, and text-qa.
 */

import { loadModel, unloadModel, runInference, getModelInfo, type ModelInfo } from "tauri-plugin-litert-api";
import { isTauri } from "./llm";

// ── Types ─────────────────────────────────────────────────────────────────────

export type TaskType =
  | "image-classification"
  | "object-detection"
  | "image-segmentation"
  | "pose-estimation"
  | "audio-classification"
  | "depth-estimation"
  | "super-resolution"
  | "style-transfer"
  | "text-qa"
  | "text-classification"
  | "custom";

export type NormalizeMode =
  | "zero-one"     // pixel / 255  — EfficientNet-Lite, SSD
  | "neg-one-one"  // (pixel - 127.5) / 127.5 — MobileNet V1/V2
  | "raw";         // pixels as float32 in [0, 255] — MoveNet

export interface TaskCatalogEntry {
  id: string;
  name: string;
  task: TaskType;
  description: string;
  sizeMb: number;
  /** [batch, height, width, channels] — or [batch, seq] for text */
  inputShape: [number, number, number, number] | [number, number];
  normalizeMode: NormalizeMode;
  /**
   * Native input tensor element type. Most TFLite models take float32; some
   * (e.g. MoveNet Lightning) have a quantized uint8 input expecting raw
   * 0-255 byte values. Defaults to "float32" when omitted.
   */
  inputDtype?: "float32" | "uint8";
  downloadUrl?: string;
  fileName: string;
  labelsUrl?: string;
  labelsFileName?: string;
  source: string;
  accuracy?: string;
  manualDownloadNote?: string;
  /** True when this model is one half of a two-model pipeline (e.g. style transfer). */
  isPairedModel?: boolean;
  /** fileName of the other model in the pair. */
  pairedFileName?: string;
}

export interface ClassificationResult {
  rank: number;
  label: string;
  score: number;
}

export interface DetectionResult {
  label: string;
  score: number;
  /** Normalised [0-1] bounding box. */
  box: { y1: number; x1: number; y2: number; x2: number };
}

export interface RawOutput {
  index: number;
  shape: number[];
  /** First 20 values for preview. */
  preview: number[];
  length: number;
}

export interface PoseKeypoint {
  name: string;
  y: number;
  x: number;
  score: number;
}

export interface SegMask {
  classMap: Uint8Array;
  width: number;
  height: number;
  numClasses: number;
}

export interface DepthMap {
  values: Float32Array;
  width: number;
  height: number;
}

export type InferenceResult =
  | { kind: "classification"; items: ClassificationResult[]; latencyMs: number }
  | { kind: "detection"; items: DetectionResult[]; latencyMs: number }
  | { kind: "audio"; items: ClassificationResult[]; latencyMs: number }
  | { kind: "pose"; keypoints: PoseKeypoint[]; latencyMs: number }
  | { kind: "segmentation"; mask: SegMask; latencyMs: number }
  | { kind: "depth"; map: DepthMap; latencyMs: number }
  | { kind: "image-output"; dataUrl: string; latencyMs: number }
  | { kind: "raw"; outputs: RawOutput[]; latencyMs: number };

// ── Detection box colour palette ─────────────────────────────────────────────

export const DETECTION_PALETTE: string[] = [
  "#ef5350","#ab47bc","#42a5f5","#26c6da","#66bb6a",
  "#ffca28","#ff7043","#ec407a","#26a69a","#5c6bc0",
  "#d4e157","#29b6f6","#8d6e63","#9ccc65","#7e57c2",
  "#4db6ac","#f06292","#ffa726","#80deea","#a5d6a7",
];

// ── COCO 80 class labels (0-based dense index) ───────────────────────────────

export const COCO_LABELS: string[] = [
  "person","bicycle","car","motorcycle","airplane","bus","train","truck","boat",
  "traffic light","fire hydrant","stop sign","parking meter","bench","bird","cat",
  "dog","horse","sheep","cow","elephant","bear","zebra","giraffe","backpack",
  "umbrella","handbag","tie","suitcase","frisbee","skis","snowboard","sports ball",
  "kite","baseball bat","baseball glove","skateboard","surfboard","tennis racket",
  "bottle","wine glass","cup","fork","knife","spoon","bowl","banana","apple",
  "sandwich","orange","broccoli","carrot","hot dog","pizza","donut","cake","chair",
  "couch","potted plant","bed","dining table","toilet","tv","laptop","mouse",
  "remote","keyboard","cell phone","microwave","oven","toaster","sink",
  "refrigerator","book","clock","vase","scissors","teddy bear","hair drier",
  "toothbrush",
];

// ── COCO 91-slot label map (index 0 = background; matches EfficientDet raw output) ──
// Slots 12,26,29,30,45,66,68,69,71,83 are unused in COCO — left as empty strings.
export const COCO_91_LABELS: string[] = [
  "background",
  "person","bicycle","car","motorcycle","airplane","bus","train","truck","boat",
  "traffic light","fire hydrant","","stop sign","parking meter","bench",
  "bird","cat","dog","horse","sheep","cow","elephant","bear","zebra","giraffe",
  "","backpack","umbrella","","","handbag","tie","suitcase","frisbee","skis",
  "snowboard","sports ball","kite","baseball bat","baseball glove","skateboard",
  "surfboard","tennis racket","bottle","","wine glass","cup","fork","knife","spoon",
  "bowl","banana","apple","sandwich","orange","broccoli","carrot","hot dog","pizza",
  "donut","cake","chair","couch","potted plant","bed","","dining table","","",
  "toilet","","tv","laptop","mouse","remote","keyboard","cell phone","microwave",
  "oven","toaster","sink","refrigerator","","book","clock","vase","scissors",
  "teddy bear","hair drier","toothbrush",
];

// ── DeepLab VOC labels & colours ─────────────────────────────────────────────

export const DEEPLAB_LABELS = [
  "background","aeroplane","bicycle","bird","boat","bottle","bus","car","cat",
  "chair","cow","diningtable","dog","horse","motorbike","person","pottedplant",
  "sheep","sofa","train","tvmonitor",
];

export const DEEPLAB_COLORS: [number, number, number][] = [
  [0,0,0],[128,0,0],[0,128,0],[128,128,0],[0,0,128],[128,0,128],[0,128,128],
  [128,128,128],[64,0,0],[192,0,0],[64,128,0],[192,128,0],[64,0,128],[192,0,128],
  [64,128,128],[192,128,128],[0,64,0],[128,64,0],[0,192,0],[128,192,0],[0,64,128],
];

// ── MoveNet keypoints & skeleton ─────────────────────────────────────────────

export const MOVENET_KEYPOINT_NAMES = [
  "nose","left_eye","right_eye","left_ear","right_ear",
  "left_shoulder","right_shoulder","left_elbow","right_elbow",
  "left_wrist","right_wrist","left_hip","right_hip",
  "left_knee","right_knee","left_ankle","right_ankle",
];

export const MOVENET_CONNECTIONS: [number, number][] = [
  [0,1],[0,2],[1,3],[2,4],[5,6],[5,7],[7,9],[6,8],[8,10],
  [5,11],[6,12],[11,12],[11,13],[13,15],[12,14],[14,16],
];

// ── Suggested model catalogue ─────────────────────────────────────────────────

export const TASK_CATALOGUE: TaskCatalogEntry[] = [
  // ── Image classification ────────────────────────────────────────────────────
  {
    id: "efficientnet-lite0",
    name: "EfficientNet-Lite0",
    task: "image-classification",
    description:
      "Fast, lightweight classifier — 1000 ImageNet classes. " +
      "Best starting point: small (~5 MB), runs on CPU in tens of ms.",
    sizeMb: 5.4,
    inputShape: [1, 224, 224, 3],
    normalizeMode: "zero-one",
    downloadUrl:
      "https://storage.googleapis.com/mediapipe-models/image_classifier/efficientnet_lite0/float32/1/efficientnet_lite0.tflite",
    fileName: "efficientnet_lite0.tflite",
    labelsUrl:
      "https://raw.githubusercontent.com/pytorch/hub/master/imagenet_classes.txt",
    labelsFileName: "imagenet_classes.txt",
    source: "MediaPipe",
    accuracy: "Top-1 72.6 % on ImageNet",
  },
  {
    id: "efficientnet-lite2",
    name: "EfficientNet-Lite2",
    task: "image-classification",
    description:
      "Higher-accuracy classifier — 1000 ImageNet classes. " +
      "Larger input (260x260) gives noticeably better results at ~22 MB.",
    sizeMb: 22,
    inputShape: [1, 260, 260, 3],
    normalizeMode: "zero-one",
    downloadUrl:
      "https://storage.googleapis.com/mediapipe-models/image_classifier/efficientnet_lite2/float32/1/efficientnet_lite2.tflite",
    fileName: "efficientnet_lite2.tflite",
    labelsUrl:
      "https://raw.githubusercontent.com/pytorch/hub/master/imagenet_classes.txt",
    labelsFileName: "imagenet_classes.txt",
    source: "MediaPipe",
    accuracy: "Top-1 77.3 % on ImageNet",
  },
  {
    id: "efficientnet-lite4",
    name: "EfficientNet-Lite4",
    task: "image-classification",
    description:
      "Most accurate EfficientNet variant — 1000 ImageNet classes. " +
      "Largest input (300x300), ~51 MB — worth it for quality over speed.",
    sizeMb: 51,
    inputShape: [1, 300, 300, 3],
    normalizeMode: "zero-one",
    fileName: "efficientnet_lite4.tflite",
    labelsUrl:
      "https://raw.githubusercontent.com/pytorch/hub/master/imagenet_classes.txt",
    labelsFileName: "imagenet_classes.txt",
    source: "MediaPipe",
    accuracy: "Top-1 80.9 % on ImageNet",
    manualDownloadNote:
      "Not in MediaPipe CDN. Download efficientnet_lite4.tflite from Kaggle (kaggle.com/models/google/efficientnet-lite) and place in your model folder.",
  },
  // ── Object detection ────────────────────────────────────────────────────────
  {
    id: "efficientdet-lite0",
    name: "EfficientDet-Lite0",
    task: "object-detection",
    description:
      "Real-time object detector — 80 COCO classes with bounding boxes. " +
      "Fast and accurate at 320x320, ~13 MB.",
    sizeMb: 13,
    inputShape: [1, 320, 320, 3],
    normalizeMode: "zero-one",
    downloadUrl:
      "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/efficientdet_lite0.tflite",
    fileName: "efficientdet_lite0.tflite",
    source: "MediaPipe",
    accuracy: "COCO mAP 25.7",
  },
  {
    id: "efficientdet-lite2",
    name: "EfficientDet-Lite2",
    task: "object-detection",
    description:
      "Higher-accuracy object detector — 80 COCO classes. " +
      "448x448 input, ~35 MB — better recall for small objects.",
    sizeMb: 35,
    inputShape: [1, 448, 448, 3],
    normalizeMode: "zero-one",
    downloadUrl:
      "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/float32/1/efficientdet_lite2.tflite",
    fileName: "efficientdet_lite2.tflite",
    source: "MediaPipe",
    accuracy: "COCO mAP 30.5",
  },
  // ── Face detection ─────────────────────────────────────────────────────────
  {
    id: "blaze-face",
    name: "BlazeFace",
    task: "object-detection",
    description:
      "Lightweight face detector from MediaPipe. " +
      "128x128 input, ~0.6 MB — detects faces with bounding boxes.",
    sizeMb: 0.6,
    inputShape: [1, 128, 128, 3],
    normalizeMode: "zero-one",
    downloadUrl:
      "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
    fileName: "blaze_face_short_range.tflite",
    source: "MediaPipe",
  },
  {
    id: "arcface-resnet50",
    name: "ArcFace ResNet50",
    task: "custom",
    description:
      "Face recognition model trained with ArcFace loss. " +
      "112×112 input, 512-d L2-normalised embeddings. 96.87% LFW accuracy. " +
      "Use with BlazeFace for private on-device face identification.",
    sizeMb: 92,
    inputShape: [1, 112, 112, 3],
    normalizeMode: "zero-one",
    downloadUrl: "https://www.digidow.eu/f/datasets/arcface-tensorflowlite/model.tflite",
    fileName: "arcface_resnet50.tflite",
    source: "mobilesec/arcface-tensorflowlite",
    accuracy: "96.87% LFW",
  },
  // ── Audio classification ────────────────────────────────────────────────────
  {
    id: "yamnet",
    name: "YAMNet",
    task: "audio-classification",
    description:
      "Audio event classifier — 521 AudioSet classes. " +
      "Accepts 0.975 s of mono 16 kHz audio (~15600 samples).",
    sizeMb: 3.7,
    inputShape: [1, 15600, 1, 1],
    normalizeMode: "zero-one",
    downloadUrl:
      "https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite",
    fileName: "yamnet.tflite",
    labelsUrl:
      "https://raw.githubusercontent.com/tensorflow/models/master/research/audioset/yamnet/yamnet_class_map.csv",
    labelsFileName: "yamnet_class_map.csv",
    source: "MediaPipe",
    accuracy: "521 AudioSet classes",
  },
  // ── Pose estimation ────────────────────────────────────────────────────────
  {
    id: "movenet-lightning",
    name: "MoveNet Lightning",
    task: "pose-estimation",
    description:
      "Single-person body pose estimator — 17 keypoints. " +
      "192x192 input, ~6.9 MB, expects raw [0-255] pixel values.",
    sizeMb: 6.9,
    inputShape: [1, 192, 192, 3],
    normalizeMode: "raw",
    inputDtype: "uint8",
    fileName: "movenet_lightning_f16.tflite",
    source: "Kaggle",
    accuracy: "COCO 63.0 mAP",
    manualDownloadNote:
      "TF Hub bucket now requires auth. Download from Kaggle: kaggle.com/models/google/movenet/tfLite/singlepose-lightning-tflite-float16/1 and rename to movenet_lightning_f16.tflite",
  },
  // ── Image segmentation ─────────────────────────────────────────────────────
  {
    id: "selfie-segmenter",
    name: "Selfie Segmenter",
    task: "image-segmentation",
    description:
      "Binary person/background mask from MediaPipe. " +
      "256x256 input, ~0.9 MB — great for portrait background removal.",
    sizeMb: 0.9,
    // Verified against the actual downloaded .tflite (tf.lite.Interpreter
    // input_details) — the model is square, not 256x144 as previously listed.
    inputShape: [1, 256, 256, 3],
    normalizeMode: "zero-one",
    downloadUrl:
      "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite",
    fileName: "selfie_segmenter.tflite",
    source: "MediaPipe",
  },
  {
    id: "deeplabv3",
    name: "DeepLab v3",
    task: "image-segmentation",
    description:
      "Semantic segmentation across 21 Pascal VOC classes. " +
      "257x257 input, ~8.6 MB.",
    sizeMb: 8.6,
    inputShape: [1, 257, 257, 3],
    normalizeMode: "neg-one-one",
    downloadUrl:
      "https://storage.googleapis.com/download.tensorflow.org/models/tflite/task_library/image_segmentation/android/lite-model_deeplabv3_1_metadata_2.tflite",
    fileName: "deeplabv3.tflite",
    source: "TensorFlow",
    accuracy: "21 Pascal VOC classes",
  },
  // ── Depth estimation ────────────────────────────────────────────────────────
  {
    id: "midas-small",
    name: "MiDaS v2.1 Small",
    task: "depth-estimation",
    description:
      "Monocular depth estimation from Intel ISL. " +
      "256x256 input, ~13 MB — must be downloaded manually.",
    sizeMb: 13,
    inputShape: [1, 256, 256, 3],
    normalizeMode: "zero-one",
    fileName: "midas_v21_small_256.tflite",
    source: "Intel ISL",
    manualDownloadNote:
      "Download midas_v21_small_256.tflite from https://github.com/isl-org/MiDaS/releases and place in your model folder",
  },
  // ── Style transfer ─────────────────────────────────────────────────────────
  {
    id: "style-predict",
    name: "Style Prediction",
    task: "style-transfer",
    description:
      "First half of the arbitrary style transfer pipeline. " +
      "Encodes a 256x256 style image into a style embedding vector.",
    sizeMb: 2.7,
    inputShape: [1, 256, 256, 3],
    normalizeMode: "zero-one",
    fileName: "style_predict_f16.tflite",
    source: "TF Hub",
    isPairedModel: true,
    pairedFileName: "style_transfer_f16.tflite",
    manualDownloadNote:
      "TF Hub bucket now requires auth. Download from tfhub.dev/google/lite-model/arbitrary-image-stylization-v1-256/fp16/prediction/1 and rename to style_predict_f16.tflite",
  },
  {
    id: "style-transfer",
    name: "Style Transfer",
    task: "style-transfer",
    description:
      "Second half of the style transfer pipeline. " +
      "Takes a 384x384 content image + style vector and outputs a stylised image.",
    sizeMb: 13.5,
    inputShape: [1, 384, 384, 3],
    normalizeMode: "zero-one",
    fileName: "style_transfer_f16.tflite",
    source: "TF Hub",
    isPairedModel: true,
    pairedFileName: "style_predict_f16.tflite",
    manualDownloadNote:
      "TF Hub bucket now requires auth. Download from tfhub.dev/google/lite-model/arbitrary-image-stylization-v1-256/fp16/transfer/1 and rename to style_transfer_f16.tflite",
  },
  // ── Text QA ────────────────────────────────────────────────────────────────
  {
    id: "mobilebert-qa",
    name: "MobileBERT QA",
    task: "text-qa",
    description:
      "Extractive question answering — answers questions given a context passage. " +
      "Requires BERT tokenization; raw output shown without a tokenizer.",
    sizeMb: 25.9,
    inputShape: [1, 384],
    normalizeMode: "raw",
    fileName: "mobilebert_qa.tflite",
    source: "TensorFlow",
    manualDownloadNote:
      "Google moved this model behind Kaggle authentication. Download lite-model_mobilebert_1_metadata_1.tflite from kaggle.com/models/google/mobilebert and rename it to mobilebert_qa.tflite.",
  },
];

// ── Image preprocessing ───────────────────────────────────────────────────────

/**
 * Resize an image to (width x height) and return a flat float32 array
 * of shape [1, H, W, 3] suitable for TFLite image models.
 */
export async function preprocessImage(
  src: string,
  height: number,
  width: number,
  mode: NormalizeMode,
): Promise<Float32Array> {
  const resp = await fetch(src);
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const { data } = ctx.getImageData(0, 0, width, height); // RGBA uint8

  const out = new Float32Array(height * width * 3);
  for (let i = 0; i < height * width; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    if (mode === "zero-one") {
      out[i * 3]     = r / 255;
      out[i * 3 + 1] = g / 255;
      out[i * 3 + 2] = b / 255;
    } else if (mode === "neg-one-one") {
      out[i * 3]     = (r - 127.5) / 127.5;
      out[i * 3 + 1] = (g - 127.5) / 127.5;
      out[i * 3 + 2] = (b - 127.5) / 127.5;
    } else {
      // "raw" — pass pixels as float32 in [0, 255]
      out[i * 3]     = r;
      out[i * 3 + 1] = g;
      out[i * 3 + 2] = b;
    }
  }
  return out;
}

// ── Audio preprocessing ───────────────────────────────────────────────────────

/**
 * Capture `durationMs` milliseconds of microphone audio, resample to 16 kHz mono,
 * and return exactly 15600 float32 samples suitable for YAMNet.
 */
export async function captureAudioSample(durationMs = 975): Promise<Float32Array> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

  const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", ""]
    .find((m) => m === "" || MediaRecorder.isTypeSupported(m)) ?? "";

  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

  await new Promise<void>((resolve, reject) => {
    recorder.onerror = () => reject(new Error("MediaRecorder error"));
    recorder.onstop = () => resolve();
    recorder.start();
    setTimeout(() => recorder.stop(), durationMs + 200);
  });

  stream.getTracks().forEach((t) => t.stop());

  const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
  const arrayBuffer = await blob.arrayBuffer();

  const audioCtx = new AudioContext();
  const decoded = await audioCtx.decodeAudioData(arrayBuffer);
  await audioCtx.close();

  const targetSamples = 15600;
  const offlineCtx = new OfflineAudioContext(1, targetSamples, 16000);
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start(0);
  const rendered = await offlineCtx.startRendering();

  const raw = rendered.getChannelData(0);
  const out = new Float32Array(targetSamples);
  out.set(raw.slice(0, targetSamples));
  return out;
}

/** Decode an audio File to a 15 600-sample 16 kHz mono Float32Array for YAMNet. */
export async function loadAudioFileAsSamples(file: File, targetSamples = 15600): Promise<Float32Array> {
  const arrayBuffer = await file.arrayBuffer();
  const audioCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await audioCtx.decodeAudioData(arrayBuffer);
  } finally {
    await audioCtx.close();
  }
  // Mix down to mono and resample to 16 kHz
  const offlineCtx = new OfflineAudioContext(1, targetSamples, 16000);
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start(0);
  const rendered = await offlineCtx.startRendering();
  const raw = rendered.getChannelData(0);
  const out = new Float32Array(targetSamples);
  out.set(raw.slice(0, targetSamples));
  return out;
}

// ── Postprocessing ────────────────────────────────────────────────────────────

function sigmoid(x: number): number { return 1 / (1 + Math.exp(-x)); }

function softmax(logits: number[]): number[] {
  const max = Math.max(...logits);
  const exps = logits.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((v) => v / sum);
}

/** Return top-K predictions from a flat classification output tensor. */
export function topKClassifications(
  output: number[],
  labels: string[],
  k = 5,
): ClassificationResult[] {
  const scores = output[0] > 1 || output[0] < 0
    ? softmax(output)
    : output;

  return scores
    .map((score, i) => ({ rank: 0, label: labels[i] ?? `class_${i}`, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

// ── BlazeFace anchor-based decoder ───────────────────────────────────────────

/** Generate the 896 anchor centres for BlazeFace short-range (128×128 input). */
function blazeFaceAnchors(): Float32Array {
  // stride 8 → 16×16 grid × 2 anchors = 512; stride 16 → 8×8 grid × 6 = 384 → 896 total
  const out = new Float32Array(896 * 2); // [cx, cy] per anchor
  let idx = 0;
  for (const { stride, n } of [{ stride: 8, n: 2 }, { stride: 16, n: 6 }]) {
    const featSize = 128 / stride;
    for (let y = 0; y < featSize; y++) {
      for (let x = 0; x < featSize; x++) {
        for (let a = 0; a < n; a++) {
          out[idx++] = (x + 0.5) / featSize;
          out[idx++] = (y + 0.5) / featSize;
        }
      }
    }
  }
  return out;
}

const BLAZE_ANCHORS = blazeFaceAnchors();

function boxIoU(a: [number, number, number, number], b: [number, number, number, number]): number {
  const ix1 = Math.max(a[0], b[0]), iy1 = Math.max(a[1], b[1]);
  const ix2 = Math.min(a[2], b[2]), iy2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  if (inter === 0) return 0;
  return inter / ((a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - inter);
}

function nms(
  boxes: Array<[number, number, number, number]>,
  scores: number[],
  iouThresh = 0.3,
): number[] {
  const order = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const keep: number[] = [];
  const suppressed = new Uint8Array(scores.length);
  for (const i of order) {
    if (suppressed[i]) continue;
    keep.push(i);
    for (const j of order) {
      if (j === i || suppressed[j]) continue;
      if (boxIoU(boxes[i], boxes[j]) > iouThresh) suppressed[j] = 1;
    }
  }
  return keep;
}

/**
 * Generate EfficientDet anchor grid for any square input.
 * Returns Float32Array of [cy, cx, h, w] (normalised 0-1) for each anchor.
 * Layout: P3→P7 (strides 8,16,32,64,128), 9 anchors/cell (3 octave scales × 3 aspect ratios).
 */
function generateEfficientDetAnchors(inputH: number, inputW: number): Float32Array {
  const strides = [8, 16, 32, 64, 128];
  const scales  = [1.0, 2 ** (1 / 3), 2 ** (2 / 3)];
  const aspects = [1.0, 2.0, 0.5];
  const base    = 4.0; // anchor_scale factor

  const out: number[] = [];
  for (const stride of strides) {
    const fH = Math.ceil(inputH / stride);
    const fW = Math.ceil(inputW / stride);
    const anchorBase = base * stride;
    for (let fy = 0; fy < fH; fy++) {
      for (let fx = 0; fx < fW; fx++) {
        const cy = ((fy + 0.5) * stride) / inputH;
        const cx = ((fx + 0.5) * stride) / inputW;
        for (const scale of scales) {
          for (const ar of aspects) {
            out.push(cy, cx,
              (anchorBase * scale) / (Math.sqrt(ar) * inputH),
              (anchorBase * scale * Math.sqrt(ar)) / inputW);
          }
        }
      }
    }
  }
  return new Float32Array(out);
}

/**
 * Decode EfficientDet-Lite raw (pre-NMS) output.
 * Expects 2 tensors: class scores [N×C] and box deltas [N×4] (either order).
 * Uses COCO_91_LABELS (index 0 = background, skipped during scoring).
 */
function parseEfficientDetRaw(
  outputs: number[][],
  threshold: number,
  inputH: number,
  inputW: number,
): DetectionResult[] | null {
  const [a, b] = [outputs[0].length, outputs[1].length];

  // Identify which tensor is boxes (divisible by 4) and which is class scores
  let classScores: number[], boxDeltas: number[], numClasses: number;
  if (b % 4 === 0) {
    const n = b / 4;
    if (a % n !== 0 || a / n < 5) return null;
    boxDeltas = outputs[1]; classScores = outputs[0]; numClasses = a / n;
  } else if (a % 4 === 0) {
    const n = a / 4;
    if (b % n !== 0 || b / n < 5) return null;
    boxDeltas = outputs[0]; classScores = outputs[1]; numClasses = b / n;
  } else {
    return null;
  }

  const numAnchors = boxDeltas.length / 4;
  if (numAnchors < 1000) return null; // sanity: not an anchor-based model

  // Verify anchor count matches this input size
  const anchors = generateEfficientDetAnchors(inputH, inputW);
  if (anchors.length / 4 !== numAnchors) return null;

  // Are scores already sigmoid'd?  If any value < 0 they're raw logits.
  const needsSigmoid = classScores.some((v) => v < 0);
  const prob = (v: number) => needsSigmoid ? sigmoid(v) : v;

  // EfficientDet-Lite outputs 90 classes corresponding to COCO IDs 1-90 (no background class).
  // Model class index N → COCO_91_LABELS[N + 1] (shift by 1 to skip the "background" slot).
  const labelForClass = (c: number) => COCO_91_LABELS[c + 1] || `class_${c + 1}`;

  const candidates: { box: [number, number, number, number]; score: number; label: string }[] = [];

  for (let i = 0; i < numAnchors; i++) {
    const cy_a = anchors[i * 4];
    const cx_a = anchors[i * 4 + 1];
    const h_a  = anchors[i * 4 + 2];
    const w_a  = anchors[i * 4 + 3];

    // Best class for this anchor
    let best = threshold, bestCls = -1;
    for (let c = 0; c < numClasses; c++) {
      const s = prob(classScores[i * numClasses + c]);
      if (s > best) { best = s; bestCls = c; }
    }
    if (bestCls < 0) continue;

    // Decode box (RetinaNet convention: [dy, dx, dh, dw])
    const dy = boxDeltas[i * 4];
    const dx = boxDeltas[i * 4 + 1];
    const dh = boxDeltas[i * 4 + 2];
    const dw = boxDeltas[i * 4 + 3];
    const cy = dy * h_a + cy_a;
    const cx = dx * w_a + cx_a;
    const h  = Math.exp(Math.min(dh, 8)) * h_a;
    const w  = Math.exp(Math.min(dw, 8)) * w_a;

    const x1 = Math.max(0, cx - w / 2);
    const y1 = Math.max(0, cy - h / 2);
    const x2 = Math.min(1, cx + w / 2);
    const y2 = Math.min(1, cy + h / 2);
    if (x2 <= x1 || y2 <= y1) continue;

    candidates.push({ box: [x1, y1, x2, y2], score: best, label: labelForClass(bestCls) });
  }

  if (candidates.length === 0) return [];

  const kept = nms(candidates.map((c) => c.box), candidates.map((c) => c.score), 0.5);
  return kept.slice(0, 100).map((k) => ({
    label: candidates[k].label,
    score: candidates[k].score,
    box: { x1: candidates[k].box[0], y1: candidates[k].box[1], x2: candidates[k].box[2], y2: candidates[k].box[3] },
  }));
}

/**
 * Decode BlazeFace short-range output.
 * Tensor 0: [1, 896, 16] raw anchor deltas (4 box + 12 keypoint coords, flattened)
 * Tensor 1: [1, 896, 1]  raw classification logits
 */
function parseBlazeFace(outputs: number[][], threshold: number): DetectionResult[] | null {
  // Handle both output orderings: [regressors, scores] or [scores, regressors]
  let rawBoxes: number[], rawScores: number[];
  if (outputs[0].length === 14336 && outputs[1].length === 896) {
    rawBoxes = outputs[0]; rawScores = outputs[1];
  } else if (outputs[0].length === 896 && outputs[1].length === 14336) {
    rawScores = outputs[0]; rawBoxes = outputs[1];
  } else {
    return null;
  }

  const candidates: { box: [number, number, number, number]; score: number }[] = [];
  for (let i = 0; i < 896; i++) {
    const score = sigmoid(rawScores[i]);
    if (score < threshold) continue;
    const anchorCx = BLAZE_ANCHORS[i * 2];
    const anchorCy = BLAZE_ANCHORS[i * 2 + 1];
    const o = i * 16;
    const cx = rawBoxes[o]     / 128 + anchorCx;
    const cy = rawBoxes[o + 1] / 128 + anchorCy;
    const w  = rawBoxes[o + 2] / 128;
    const h  = rawBoxes[o + 3] / 128;
    candidates.push({
      score,
      box: [
        Math.max(0, cx - w / 2), Math.max(0, cy - h / 2),
        Math.min(1, cx + w / 2), Math.min(1, cy + h / 2),
      ],
    });
  }
  if (candidates.length === 0) return [];

  const kept = nms(candidates.map(c => c.box), candidates.map(c => c.score), 0.3);
  return kept.slice(0, 20).map(k => ({
    label: "face",
    score: candidates[k].score,
    box: { x1: candidates[k].box[0], y1: candidates[k].box[1], x2: candidates[k].box[2], y2: candidates[k].box[3] },
  }));
}

/**
 * Parse any 2- or 4-output detection model.
 *  • 2 outputs, BlazeFace sizes  → BlazeFace anchor decode
 *  • 2 outputs, EfficientDet raw → anchor decode + NMS (uses COCO_91_LABELS)
 *  • 4 outputs (post-NMS)        → standard box/class/score/count tensors
 */
export function parseDetections(
  outputs: number[][],
  labels: string[],
  threshold = 0.3,
  inputH = 320,
  inputW = 320,
): DetectionResult[] | null {
  if (outputs.length === 2) {
    return parseBlazeFace(outputs, threshold)
      ?? parseEfficientDetRaw(outputs, threshold, inputH, inputW);
  }

  // EfficientDet / SSD: 4 outputs — boxes, classes, scores, count
  if (outputs.length < 3) return null;
  const n = outputs[2]?.length ?? 0;
  if (!n) return null;

  const boxes   = outputs[0];
  const classes = outputs[1];
  const scores  = outputs[2];
  const count   = outputs[3] ? Math.round(outputs[3][0]) : n;

  const results: DetectionResult[] = [];
  for (let i = 0; i < Math.min(count, n); i++) {
    const score = scores[i];
    if (score < threshold) continue;
    const classIdx = Math.round(classes[i]);
    results.push({
      label: labels[classIdx] ?? `class_${classIdx}`,
      score,
      box: {
        y1: boxes[i * 4],
        x1: boxes[i * 4 + 1],
        y2: boxes[i * 4 + 2],
        x2: boxes[i * 4 + 3],
      },
    });
  }
  return results.sort((a, b) => b.score - a.score);
}

/**
 * Parse MoveNet output — flat [51] from shape [1, 1, 17, 3]: y, x, score per keypoint.
 */
export function parsePose(output: number[]): PoseKeypoint[] {
  const keypoints: PoseKeypoint[] = [];
  for (let i = 0; i < 17; i++) {
    keypoints.push({
      name: MOVENET_KEYPOINT_NAMES[i] ?? `kp_${i}`,
      y: output[i * 3] ?? 0,
      x: output[i * 3 + 1] ?? 0,
      score: output[i * 3 + 2] ?? 0,
    });
  }
  return keypoints;
}

/**
 * Parse segmentation model output.
 * Handles shapes:
 *   [1, H, W, 1]  — binary (selfie segmenter)
 *   [1, H, W, 2]  — background + person softmax
 *   [1, H, W, 21] — multi-class argmax (DeepLab)
 *   [H*W*C]       — flat (shape metadata missing); fallbackH/W used to reconstruct
 */
export function parseSegMask(
  outputs: number[][],
  outputShapes: number[][],
  fallbackH?: number,
  fallbackW?: number,
): SegMask | null {
  if (!outputs[0] || !outputShapes[0]) return null;
  const shape = outputShapes[0];
  let h = shape[1] ?? 0;
  let w = shape[2] ?? 0;
  let c = shape[3] ?? 1;

  if (h === 0 || w === 0) {
    // Flat output — try to reconstruct dimensions.
    const n = outputs[0].length;
    if (fallbackH && fallbackW && n % (fallbackH * fallbackW) === 0) {
      h = fallbackH; w = fallbackW; c = n / (fallbackH * fallbackW);
    } else {
      // Try square mask.
      const side = Math.round(Math.sqrt(n));
      if (side * side === n) { h = side; w = side; c = 1; }
      else return null;
    }
  }

  const numPixels = h * w;
  const classMap = new Uint8Array(numPixels);
  const data = outputs[0];

  if (c === 1) {
    for (let i = 0; i < numPixels; i++) {
      classMap[i] = (data[i] ?? 0) > 0.5 ? 1 : 0;
    }
    return { classMap, width: w, height: h, numClasses: 2 };
  } else if (c === 2) {
    for (let i = 0; i < numPixels; i++) {
      classMap[i] = (data[i * 2 + 1] ?? 0) > (data[i * 2] ?? 0) ? 1 : 0;
    }
    return { classMap, width: w, height: h, numClasses: 2 };
  } else {
    for (let i = 0; i < numPixels; i++) {
      let maxVal = -Infinity;
      let maxIdx = 0;
      for (let ci = 0; ci < c; ci++) {
        const v = data[i * c + ci] ?? 0;
        if (v > maxVal) { maxVal = v; maxIdx = ci; }
      }
      classMap[i] = maxIdx;
    }
    return { classMap, width: w, height: h, numClasses: c };
  }
}

/**
 * Parse depth estimation model output into a DepthMap.
 */
export function parseDepthMap(outputs: number[][], outputShapes: number[][]): DepthMap | null {
  if (!outputs[0] || !outputShapes[0]) return null;
  const shape = outputShapes[0];
  const h = shape[1] ?? 0;
  const w = shape[2] ?? 0;
  if (h === 0 || w === 0) return null;

  const values = new Float32Array(h * w);
  const src = outputs[0];
  for (let i = 0; i < h * w; i++) {
    values[i] = src[i] ?? 0;
  }
  return { values, width: w, height: h };
}

/** Summarise raw output tensors for display. */
export function summariseOutputs(outputs: number[][], shapes: number[][]): RawOutput[] {
  return outputs.map((out, i) => ({
    index: i,
    shape: shapes[i] ?? [out.length],
    preview: out.slice(0, 20),
    length: out.length,
  }));
}

// ── Image tensor -> data URL ───────────────────────────────────────────────────

/**
 * Convert a flat float32-ish tensor (values in [0, 1]) to a PNG data URL.
 */
export function tensorToDataUrl(tensor: number[], height: number, width: number): string {
  const regularCanvas = document.createElement("canvas");
  regularCanvas.width = width;
  regularCanvas.height = height;
  const ctx = regularCanvas.getContext("2d");
  if (!ctx) return "";
  const imgData = ctx.createImageData(width, height);
  for (let i = 0; i < height * width; i++) {
    imgData.data[i * 4]     = Math.round((tensor[i * 3] ?? 0) * 255);
    imgData.data[i * 4 + 1] = Math.round((tensor[i * 3 + 1] ?? 0) * 255);
    imgData.data[i * 4 + 2] = Math.round((tensor[i * 3 + 2] ?? 0) * 255);
    imgData.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
  return regularCanvas.toDataURL("image/png");
}

// ── Canvas drawing helpers ────────────────────────────────────────────────────

/** Draw MoveNet skeleton on a canvas. */
export function drawPoseSkeleton(
  ctx: CanvasRenderingContext2D,
  keypoints: PoseKeypoint[],
  canvasW: number,
  canvasH: number,
): void {
  ctx.clearRect(0, 0, canvasW, canvasH);

  ctx.strokeStyle = "rgba(0, 200, 255, 0.85)";
  ctx.lineWidth = 2;
  for (const [a, b] of MOVENET_CONNECTIONS) {
    const kpA = keypoints[a];
    const kpB = keypoints[b];
    if (!kpA || !kpB || kpA.score < 0.3 || kpB.score < 0.3) continue;
    ctx.beginPath();
    ctx.moveTo(kpA.x * canvasW, kpA.y * canvasH);
    ctx.lineTo(kpB.x * canvasW, kpB.y * canvasH);
    ctx.stroke();
  }

  for (const kp of keypoints) {
    if (kp.score < 0.3) continue;
    ctx.fillStyle = "rgba(255, 220, 0, 0.9)";
    ctx.beginPath();
    ctx.arc(kp.x * canvasW, kp.y * canvasH, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Draw segmentation mask overlay on a canvas. */
export function drawSegMask(
  ctx: CanvasRenderingContext2D,
  mask: SegMask,
  canvasW: number,
  canvasH: number,
  colors: [number, number, number][] = DEEPLAB_COLORS,
): void {
  const offscreen = new OffscreenCanvas(mask.width, mask.height);
  const offCtx = offscreen.getContext("2d");
  if (!offCtx) return;

  const imgData = offCtx.createImageData(mask.width, mask.height);
  for (let i = 0; i < mask.classMap.length; i++) {
    const cls = mask.classMap[i] ?? 0;
    const color = colors[cls % colors.length] ?? [128, 128, 128];
    const alpha = (mask.numClasses === 2 && cls === 0) ? 0 : 140;
    imgData.data[i * 4]     = color[0];
    imgData.data[i * 4 + 1] = color[1];
    imgData.data[i * 4 + 2] = color[2];
    imgData.data[i * 4 + 3] = alpha;
  }
  offCtx.putImageData(imgData, 0, 0);

  ctx.drawImage(offscreen, 0, 0, canvasW, canvasH);
}

/** Draw depth heatmap (blue = near, red = far) as overlay. */
export function drawDepthHeatmap(
  ctx: CanvasRenderingContext2D,
  depth: DepthMap,
  canvasW: number,
  canvasH: number,
): void {
  const { values, width, height } = depth;
  let minV = Infinity, maxV = -Infinity;
  for (const v of values) {
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const range = maxV - minV || 1;

  const offscreen = new OffscreenCanvas(width, height);
  const offCtx = offscreen.getContext("2d");
  if (!offCtx) return;

  const imgData = offCtx.createImageData(width, height);
  for (let i = 0; i < values.length; i++) {
    const t = (values[i] - minV) / range;
    const r = Math.round(Math.min(255, t * 2 * 255));
    const g = Math.round(t < 0.5 ? t * 2 * 255 : (1 - (t - 0.5) * 2) * 255);
    const b = Math.round(Math.max(0, (1 - t * 2) * 255));
    imgData.data[i * 4]     = r;
    imgData.data[i * 4 + 1] = g;
    imgData.data[i * 4 + 2] = b;
    imgData.data[i * 4 + 3] = 191;
  }
  offCtx.putImageData(imgData, 0, 0);

  ctx.drawImage(offscreen, 0, 0, canvasW, canvasH);
}

// ── Labels download ───────────────────────────────────────────────────────────

/** Fetch a labels file and return an array of class name strings.
 *  Supports plain text (one label per line) and CSV with header row
 *  `index,mid,display_name` (used by YAMNet class map). */
export async function fetchLabels(url: string): Promise<string[]> {
  let text: string | null = null;
  let lastError = "";

  // Try Tauri-side HTTP first (bypasses CORS), then fall back to browser fetch.
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      text = await invoke<string>("fetch_url", { url });
    } catch (e) {
      lastError = String(e);
    }
  }
  if (!text?.trim()) {
    try {
      const resp = await fetch(url, { cache: "no-cache" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      text = await resp.text();
    } catch (e) {
      throw new Error(`fetch failed — Tauri: ${lastError || "n/a"}, browser: ${e}`);
    }
  }
  if (!text?.trim()) throw new Error(`Empty response from ${url}`);

  const lines = text.trim().split(/\r\n|\r|\n/);
  // Detect CSV: first line looks like a header with commas (e.g. "index,mid,display_name")
  if (lines[0]?.includes(",") && /^[a-zA-Z]/.test(lines[0])) {
    // Use the index column from the CSV to place each label at the correct array position.
    // filter(Boolean) must NOT be used here — it would collapse indices and misalign labels.
    const result: string[] = [];
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const m = line.match(/^(\d+),[^,]+,(.*)$/);
      if (!m) continue;
      const idx = parseInt(m[1], 10);
      const name = m[2].replace(/^"|"$/g, "").trim();
      result[idx] = name || `class_${idx}`;
    }
    if (result.length === 0) throw new Error(`CSV parsed but no valid rows found in ${url}`);
    return result;
  }
  const plain = lines.map((l) => l.trim()).filter(Boolean);
  if (plain.length === 0) throw new Error(`Plain-text label file was empty: ${url}`);
  return plain;
}

// ── Model loading helpers ─────────────────────────────────────────────────────

const TASK_MODEL_PREFIX = "task-model-";

export function taskModelId(fileName: string): string {
  return TASK_MODEL_PREFIX + fileName.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export async function loadTaskModel(modelPath: string, fileName: string): Promise<ModelInfo> {
  const modelId = taskModelId(fileName);
  return loadModel({ modelId, modelPath, accelerator: "cpu" });
}

export async function unloadTaskModel(fileName: string): Promise<void> {
  const modelId = taskModelId(fileName);
  await unloadModel(modelId).catch(() => {});
}

export async function getTaskModelInfo(fileName: string): Promise<ModelInfo> {
  return getModelInfo(taskModelId(fileName));
}

export async function runTaskInference(
  fileName: string,
  inputs: number[][],
  inputTypes?: ("float" | "int32" | "int8" | "uint8")[],
): Promise<{ outputs: number[][]; outputShapes: number[][]; latencyMs: number }> {
  const result = await runInference({ modelId: taskModelId(fileName), inputs, inputTypes });
  const outputShapes = (result as { outputShapes?: number[][] }).outputShapes
    ?? result.outputs.map((o) => [o.length]);
  return { outputs: result.outputs, outputShapes, latencyMs: result.latencyMs };
}
