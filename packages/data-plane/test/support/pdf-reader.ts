// Reads a PDF back the way a consumer would (pdf.js): page sizes in points and the selectable text of each page.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

export interface ReadPdf {
  readonly pages: readonly { readonly width: number; readonly height: number; readonly text: string }[];
}

export async function readPdf(bytes: Uint8Array): Promise<ReadPdf> {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const pages: { width: number; height: number; text: string }[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const view = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    pages.push({ width: view.width, height: view.height, text: content.items.map((i) => ("str" in i ? i.str : "")).join(" ") });
  }
  await doc.destroy();
  return { pages };
}

/** Text with all whitespace removed, to compare strings the page wrapped (hashes, paths). */
export const squash = (text: string): string => text.replace(/\s+/g, "");
