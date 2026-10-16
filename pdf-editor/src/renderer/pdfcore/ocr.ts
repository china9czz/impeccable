/**
 * Offline-capable OCR via tesseract.js (eng + chi_sim).
 *
 * Worker / WASM load from the bundled npm packages (?url). Language packs
 * prefer ./tessdata (public/, vendored by scripts/vendor-tessdata.mjs); if
 * those files are missing, tesseract.js falls back to the CDN langPath.
 */

import { createWorker, type Worker } from 'tesseract.js';
import workerUrl from 'tesseract.js/dist/worker.min.js?url';
import coreUrl from 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url';
import type { PdfRect } from './types';

export interface OcrWord {
  text: string;
  /** Bounding box in PDF user space (bottom-left origin). */
  rect: PdfRect;
  fontSize: number;
  confidence: number;
}

export interface OcrPageResult {
  words: OcrWord[];
  /** Joined text for status / debugging. */
  text: string;
}

export type OcrProgressFn = (progress: { status: string; progress: number }) => void;

const LANG = 'chi_sim+eng';

let workerPromise: Promise<Worker> | null = null;

function tessdataBase(): string {
  // Vite base is './' in production; resolve against the page URL so Electron
  // file:// and the preview server both find public/tessdata/.
  const base = import.meta.env.BASE_URL || './';
  return new URL('tessdata', new URL(base, window.location.href)).href.replace(/\/?$/, '');
}

async function getWorker(onProgress?: OcrProgressFn): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker(LANG, 1, {
        workerPath: workerUrl,
        corePath: coreUrl,
        langPath: tessdataBase(),
        gzip: true,
        logger: (m) => {
          if (typeof m.progress === 'number') {
            onProgress?.({ status: String(m.status ?? 'recognizing'), progress: m.progress });
          }
        },
      });
      return worker;
    })().catch((error) => {
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

/** Warm the worker (and language packs) without recognizing anything. */
export async function warmOcr(onProgress?: OcrProgressFn): Promise<void> {
  await getWorker(onProgress);
}

/**
 * Run OCR on a canvas that was rendered from a PDF page at the given
 * viewport. Pixel boxes are mapped back to PDF user space via the viewport.
 */
export async function recognizeCanvas(
  canvas: HTMLCanvasElement,
  viewport: { convertToPdfPoint: (x: number, y: number) => number[]; width: number; height: number },
  onProgress?: OcrProgressFn,
): Promise<OcrPageResult> {
  const worker = await getWorker(onProgress);
  // Canvas may be device-pixel sized; CSS size matches the viewport.
  const cssW = viewport.width;
  const cssH = viewport.height;
  const scaleX = cssW / canvas.width;
  const scaleY = cssH / canvas.height;

  const result = await worker.recognize(canvas);
  const words: OcrWord[] = [];

  for (const word of result.data.words ?? []) {
    const text = (word.text ?? '').trim();
    if (!text) continue;
    if ((word.confidence ?? 0) < 35) continue;
    const { x0, y0, x1, y1 } = word.bbox;
    // word.bbox is in the image (canvas bitmap) pixel space.
    const left = x0 * scaleX;
    const top = y0 * scaleY;
    const right = x1 * scaleX;
    const bottom = y1 * scaleY;
    const [pdfX0, pdfY0] = viewport.convertToPdfPoint(left, bottom);
    const [pdfX1, pdfY1] = viewport.convertToPdfPoint(right, top);
    const x = Math.min(pdfX0 ?? 0, pdfX1 ?? 0);
    const y = Math.min(pdfY0 ?? 0, pdfY1 ?? 0);
    const w = Math.abs((pdfX1 ?? 0) - (pdfX0 ?? 0));
    const h = Math.abs((pdfY1 ?? 0) - (pdfY0 ?? 0));
    if (w < 0.5 || h < 0.5) continue;
    words.push({
      text,
      rect: { x, y, w, h },
      fontSize: Math.max(6, h * 0.85),
      confidence: word.confidence ?? 0,
    });
  }

  return {
    words,
    text: words.map((w) => w.text).join(' '),
  };
}

export async function terminateOcr(): Promise<void> {
  if (!workerPromise) return;
  try {
    const worker = await workerPromise;
    await worker.terminate();
  } catch {
    // ignore
  }
  workerPromise = null;
}
