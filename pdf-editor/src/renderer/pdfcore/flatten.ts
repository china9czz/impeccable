import fontkit from '@pdf-lib/fontkit';
import { LineCapStyle, PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { Annotation } from './types';
import { hexToRgb01, sanitizeWinAnsi, wrapText } from './coords';
import { isWinAnsi, needsCjk } from './fonts';

export interface FlattenOptions {
  /** Bundled CJK font bytes; when absent, non-WinAnsi text degrades to "?". */
  cjkFontBytes?: Uint8Array | null;
}

export interface FlattenResult {
  bytes: Uint8Array;
  /** True when non-WinAnsi text had to be replaced because no CJK font was available. */
  degradedCjk: boolean;
}

/**
 * Bake all annotations into a copy of the document and return the final
 * bytes. The working document is never mutated here, so saving twice does
 * not double-draw.
 */
export async function flattenAnnotations(
  bytes: Uint8Array,
  annotations: ReadonlyMap<string, Annotation[]>,
  pageIds: readonly string[],
  options: FlattenOptions = {},
): Promise<FlattenResult> {
  let total = 0;
  for (const list of annotations.values()) total += list.length;
  if (total === 0) return { bytes, degradedCjk: false };

  const doc = await PDFDocument.load(bytes);
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);

  let cjkFont: PDFFont | null = null;
  const needsFont =
    Boolean(options.cjkFontBytes) &&
    [...annotations.values()].some((list) =>
      list.some((ann) => {
        if (ann.kind === 'text' || ann.kind === 'note') return needsCjk(ann.text);
        if (ann.kind === 'ocr') return ann.runs.some((r) => needsCjk(r.text));
        return false;
      }),
    );
  if (needsFont && options.cjkFontBytes) {
    try {
      doc.registerFontkit(fontkit);
      // Subset at embed time: only the glyphs actually drawn land in the PDF.
      cjkFont = await doc.embedFont(options.cjkFontBytes, { subset: true });
    } catch {
      cjkFont = null;
    }
  }

  let degradedCjk = false;
  /** Pick a font per run; sanitize only when the CJK font is unavailable. */
  const prepare = (text: string): { text: string; font: PDFFont } => {
    if (isWinAnsi(text)) return { text, font: helvetica };
    if (cjkFont) return { text, font: cjkFont };
    degradedCjk = true;
    return { text: sanitizeWinAnsi(text), font: helvetica };
  };

  const pages = doc.getPages();

  for (let index = 0; index < pageIds.length; index += 1) {
    const pageId = pageIds[index]!;
    const page = pages[index];
    const anns = annotations.get(pageId);
    if (!page || !anns || anns.length === 0) continue;

    for (const ann of anns) {
      const c = hexToRgb01(ann.color);
      const color = rgb(c.r, c.g, c.b);
      switch (ann.kind) {
        case 'highlight':
          page.drawRectangle({
            x: ann.rect.x,
            y: ann.rect.y,
            width: ann.rect.w,
            height: ann.rect.h,
            color,
            opacity: 0.35,
          });
          break;
        case 'rect':
          page.drawRectangle({
            x: ann.rect.x,
            y: ann.rect.y,
            width: ann.rect.w,
            height: ann.rect.h,
            borderColor: color,
            borderWidth: ann.strokeWidth,
          });
          break;
        case 'pen':
          for (let i = 0; i + 3 < ann.points.length; i += 2) {
            page.drawLine({
              start: { x: ann.points[i]!, y: ann.points[i + 1]! },
              end: { x: ann.points[i + 2]!, y: ann.points[i + 3]! },
              thickness: ann.strokeWidth,
              color,
              lineCap: LineCapStyle.Round,
            });
          }
          break;
        case 'note': {
          const marker = 13;
          page.drawRectangle({
            x: ann.x,
            y: ann.y - marker,
            width: marker + 3,
            height: marker,
            color: rgb(1, 0.85, 0.25),
            borderColor: rgb(0.55, 0.45, 0.05),
            borderWidth: 0.5,
          });
          const lines = wrapText(ann.text, 48);
          lines.forEach((line, li) => {
            const run = prepare(line);
            page.drawText(run.text, {
              x: ann.x + marker + 9,
              y: ann.y - 10 - li * 12.5,
              size: 9.5,
              font: run.font,
              color: rgb(0.15, 0.15, 0.15),
            });
          });
          break;
        }
        case 'text': {
          const lines = ann.text.split('\n');
          lines.forEach((line, li) => {
            const baseline = ann.y - ann.fontSize * 0.8 - li * ann.fontSize * 1.25;
            const run = prepare(line);
            page.drawText(run.text, {
              x: ann.x,
              y: baseline,
              size: ann.fontSize,
              font: run.font,
              color,
            });
          });
          break;
        }
        case 'ocr':
          // Invisible but extractable text layer so search works after save.
          drawOcrRuns(page, ann.runs, prepare);
          break;
      }
    }
  }

  return { bytes: await doc.save(), degradedCjk };
}

function drawOcrRuns(
  page: PDFPage,
  runs: { text: string; rect: { x: number; y: number; w: number; h: number }; fontSize: number }[],
  prepare: (text: string) => { text: string; font: PDFFont },
): void {
  for (const run of runs) {
    const prepared = prepare(run.text);
    const size = Math.max(4, Math.min(run.fontSize, run.rect.h * 0.95));
    page.drawText(prepared.text, {
      x: run.rect.x,
      y: run.rect.y + Math.max(0, (run.rect.h - size) * 0.15),
      size,
      font: prepared.font,
      color: rgb(0, 0, 0),
      opacity: 0,
    });
  }
}
