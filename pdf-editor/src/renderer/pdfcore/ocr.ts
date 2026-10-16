/**
 * Offline-capable OCR via tesseract.js (eng + chi_sim).
 *
 * Worker / WASM load from the bundled npm packages (?url). Language packs
 * prefer ./tessdata (public/, vendored by scripts/vendor-tessdata.mjs); if
 * those files are missing, tesseract.js falls back to the CDN langPath.
 */

import { createWorker, type Worker } from 'tesseract.js';
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
/** CDN fallbacks when local public/ assets are missing. */
const CDN_LANG = 'https://cdn.jsdelivr.net/gh/naptha/tessdata@gh-pages/4.0.0';
const CDN_WORKER = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js';
const CDN_CORE = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1';

let workerPromise: Promise<Worker> | null = null;

/** Resolve a path under the Vite `public/` root (works for Electron file:// too). */
function publicUrl(rel: string): string {
  const base = import.meta.env.BASE_URL || './';
  return new URL(rel, new URL(base, window.location.href)).href.replace(/\/?$/, '');
}

async function headOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

async function resolvePaths(): Promise<{ workerPath: string; corePath: string; langPath: string }> {
  const localWorker = `${publicUrl('tesseract')}/worker.min.js`;
  const localCore = `${publicUrl('tesseract')}/`;
  const localLang = publicUrl('tessdata');

  const workerPath = (await headOk(localWorker)) ? localWorker : CDN_WORKER;
  // Probe a known core file; tesseract.js appends filenames under corePath.
  const corePath = (await headOk(`${localCore}tesseract-core-simd-lstm.wasm.js`))
    ? localCore
    : CDN_CORE;
  const langPath = (await headOk(`${localLang}/eng.traineddata.gz`)) ? localLang : CDN_LANG;
  return { workerPath, corePath, langPath };
}

async function getWorker(onProgress?: OcrProgressFn): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const paths = await resolvePaths();
      const worker = await createWorker(LANG, 1, {
        ...paths,
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
  const raw: OcrWord[] = [];

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
    raw.push({
      text,
      rect: { x, y, w, h },
      fontSize: Math.max(6, h * 0.85),
      confidence: word.confidence ?? 0,
    });
  }

  // chi_sim often emits one glyph per "word"; merge neighbors so search for
  // multi-character Chinese queries (你好) works without special casing.
  const words = mergeAdjacentCjk(raw);

  return {
    words,
    text: words.map((w) => w.text).join(' '),
  };
}

const CJK_RE = /^[\u3400-\u9fff\uf900-\ufaff]+$/;

function mergeAdjacentCjk(words: OcrWord[]): OcrWord[] {
  const out: OcrWord[] = [];
  for (const word of words) {
    const prev = out[out.length - 1];
    if (prev && CJK_RE.test(prev.text) && CJK_RE.test(word.text)) {
      const gap = word.rect.x - (prev.rect.x + prev.rect.w);
      const sameLine = Math.abs(word.rect.y - prev.rect.y) < Math.max(prev.rect.h, word.rect.h) * 0.55;
      if (sameLine && gap < Math.max(prev.rect.h, word.rect.h) * 1.4) {
        prev.text += word.text;
        prev.rect.w = word.rect.x + word.rect.w - prev.rect.x;
        prev.rect.h = Math.max(prev.rect.h, word.rect.h);
        prev.fontSize = Math.max(prev.fontSize, word.fontSize);
        prev.confidence = Math.min(prev.confidence, word.confidence);
        continue;
      }
    }
    out.push({ ...word, rect: { ...word.rect } });
  }
  return out;
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
