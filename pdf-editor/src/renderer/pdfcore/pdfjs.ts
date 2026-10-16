import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PdfRect } from './types';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfJsDocument = pdfjs.PDFDocumentProxy;
export type PdfJsPage = pdfjs.PDFPageProxy;
export type PageViewport = pdfjs.PageViewport;
export type RenderTask = pdfjs.RenderTask;

/**
 * Load a document for rendering. The bytes are copied because pdf.js
 * transfers the buffer to its worker, which would detach the caller's copy.
 */
export async function loadPdfJs(data: Uint8Array): Promise<PdfJsDocument> {
  const task = pdfjs.getDocument({ data: data.slice() });
  return task.promise;
}

export interface PageTextItem {
  str: string;
  rect: PdfRect;
}

/**
 * Extract text items with approximate bounding boxes in PDF user space.
 * item.transform places the baseline origin; the box extends ascent above and
 * a little descent below the baseline.
 */
export async function extractPageText(page: PdfJsPage): Promise<PageTextItem[]> {
  const content = await page.getTextContent();
  const items: PageTextItem[] = [];
  for (const item of content.items) {
    if (!('str' in item) || item.str.length === 0) continue;
    const x = item.transform[4] ?? 0;
    const baseline = item.transform[5] ?? 0;
    const height = item.height > 0 ? item.height : 10;
    items.push({
      str: item.str,
      rect: {
        x,
        y: baseline - height * 0.22,
        w: item.width,
        h: height * 1.18,
      },
    });
  }
  return items;
}
