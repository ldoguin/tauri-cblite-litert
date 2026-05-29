/**
 * pdf.ts — Extract plain text and embedded images from a PDF ArrayBuffer using pdf.js.
 *
 * Importing the worker module is a side-effect that sets
 * `globalThis.pdfjsWorker = { WorkerMessageHandler }`.
 * pdf.js checks this before attempting any Worker or dynamic import, so it
 * runs the PDF processing in-thread — no Web Worker, no URL fetching needed.
 */

import "pdfjs-dist/build/pdf.worker.min.mjs";
import * as pdfjsLib from "pdfjs-dist";

export async function extractPdfText(buffer: ArrayBuffer): Promise<string> {
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pageTexts: string[] = [];

  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      try {
        const content = await page.getTextContent();
        const pageText = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (pageText) pageTexts.push(pageText);
      } finally {
        page.cleanup();
      }
    }
  } finally {
    pdf.destroy();
  }

  return pageTexts.join("\n\n");
}

export interface PdfContent {
  text: string;
  /** Embedded images found in the PDF, one entry per unique image. */
  images: Array<{ dataUrl: string; pageNum: number }>;
}

/** Minimum dimension (px) — smaller images are icons/decorations and skipped. */
const MIN_IMAGE_DIM = 50;

/**
 * Extracts both text and embedded raster images from a PDF.
 * Images are deduplicated by a fast fingerprint (dims + corner pixels).
 * Images smaller than MIN_IMAGE_DIM in either axis are skipped.
 */
export async function extractPdfContent(buffer: ArrayBuffer): Promise<PdfContent> {
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pageTexts: string[] = [];
  const images: PdfContent["images"] = [];
  const seenKeys = new Set<string>();

  try {
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      try {
        // ── Text ──────────────────────────────────────────────────────────
        const content = await page.getTextContent();
        const pageText = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (pageText) pageTexts.push(pageText);

        // ── Images ────────────────────────────────────────────────────────
        // getOperatorList() triggers decoding of all resources (incl. images)
        // into page.objs so we can retrieve them below.
        const ops = await page.getOperatorList();
        const imageNames = new Set<string>();
        for (let i = 0; i < ops.fnArray.length; i++) {
          if (ops.fnArray[i] === pdfjsLib.OPS.paintImageXObject) {
            imageNames.add(ops.argsArray[i][0] as string);
          }
        }

        for (const name of imageNames) {
          // Use synchronous get() — throws if the object isn't resolved yet.
          // In main-thread (fake-worker) mode some images end up in commonObjs.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let img: { data: Uint8ClampedArray; width: number; height: number } | null = null;
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            img = (page.objs as any).get(name) ?? null;
          } catch {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              img = (page.commonObjs as any).get(name) ?? null;
            } catch { /* not available — skip */ }
          }

          if (!img || !img.data || img.width < MIN_IMAGE_DIM || img.height < MIN_IMAGE_DIM) continue;

          const { data, width, height } = img;
          const key = `${width}x${height}:${data[0]},${data[4]},${data[8]},${data[data.length - 4]}`;
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);

          const dataUrl = pdfImgToDataUrl(img);
          if (dataUrl) images.push({ dataUrl, pageNum });
        }
      } finally {
        page.cleanup();
      }
    }
  } finally {
    pdf.destroy();
  }

  return { text: pageTexts.join("\n\n"), images };
}

/**
 * Render a single PDF page to a JPEG data URL.
 * `scale` controls resolution: 1.5 ≈ 1080p-equivalent for a typical A4 page.
 */
export async function renderPdfPage(
  buffer: ArrayBuffer,
  pageNum: number,
  scale = 1.5,
): Promise<string> {
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  try {
    if (pageNum < 1 || pageNum > pdf.numPages) {
      throw new Error(`Page ${pageNum} out of range (1–${pdf.numPages})`);
    }
    const page = await pdf.getPage(pageNum);
    try {
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas 2d context unavailable");
      await page.render({ canvasContext: ctx as CanvasRenderingContext2D, viewport }).promise;
      return canvas.toDataURL("image/jpeg", 0.85);
    } finally {
      page.cleanup();
    }
  } finally {
    pdf.destroy();
  }
}

/**
 * Extract text from each page separately, preserving page numbers.
 * Returns one entry per page; pages with fewer than 20 characters are skipped.
 */
export async function extractPdfPages(
  buffer: ArrayBuffer,
): Promise<{ text: string; pageNumber: number }[]> {
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pages: { text: string; pageNumber: number }[] = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      try {
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (text.length > 20) pages.push({ text, pageNumber: i });
      } finally {
        page.cleanup();
      }
    }
  } finally {
    pdf.destroy();
  }
  return pages;
}

/**
 * Extract text from a single page.
 * Returns `{ text, totalPages }` so callers know the document length.
 */
export async function extractPdfPageText(
  buffer: ArrayBuffer,
  pageNum: number,
): Promise<{ text: string; totalPages: number }> {
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const totalPages = pdf.numPages;
  try {
    if (pageNum < 1 || pageNum > totalPages) {
      throw new Error(`Page ${pageNum} out of range (1–${totalPages})`);
    }
    const page = await pdf.getPage(pageNum);
    try {
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      return { text, totalPages };
    } finally {
      page.cleanup();
    }
  } finally {
    pdf.destroy();
  }
}

/**
 * Converts a pdf.js image object (RGBA or RGB pixel data) to a JPEG data URL.
 * Returns null if the data format is unrecognised or canvas is unavailable.
 */
function pdfImgToDataUrl(img: {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}): string | null {
  try {
    const { data, width, height } = img;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    let rgba: Uint8ClampedArray;
    if (data.length === width * height * 4) {
      rgba = data;
    } else if (data.length === width * height * 3) {
      // RGB → RGBA
      rgba = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        rgba[i * 4]     = data[i * 3];
        rgba[i * 4 + 1] = data[i * 3 + 1];
        rgba[i * 4 + 2] = data[i * 3 + 2];
        rgba[i * 4 + 3] = 255;
      }
    } else {
      return null;
    }

    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    return null;
  }
}
