/**
 * pdf.ts — Extract plain text from a PDF ArrayBuffer using pdf.js.
 *
 * The worker is loaded from the same package to avoid CDN dependency.
 * Returns the full text of all pages joined with newlines.
 */

export async function extractPdfText(buffer: ArrayBuffer): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist");

  // Point the worker at the bundled worker file via Vite's ?url import
  // We use a dynamic string to avoid Vite trying to resolve it at build time
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).href;
  }

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
        // Release per-page resources (fonts, images) held by the proxy
        page.cleanup();
      }
    }
  } finally {
    // Release decoded PDF data; without this the document stays in memory
    // for the lifetime of the page.
    pdf.destroy();
  }

  return pageTexts.join("\n\n");
}
