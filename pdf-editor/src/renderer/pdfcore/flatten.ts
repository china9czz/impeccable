import { LineCapStyle, PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { Annotation } from './types';
import { hexToRgb01, sanitizeWinAnsi, wrapText } from './coords';

/**
 * Bake all annotations into a copy of the document and return the final
 * bytes. The working document is never mutated here, so saving twice does
 * not double-draw.
 */
export async function flattenAnnotations(
  bytes: Uint8Array,
  annotations: ReadonlyMap<string, Annotation[]>,
  pageIds: readonly string[],
): Promise<Uint8Array> {
  let total = 0;
  for (const list of annotations.values()) total += list.length;
  if (total === 0) return bytes;

  const doc = await PDFDocument.load(bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();

  pageIds.forEach((pageId, index) => {
    const page = pages[index];
    const anns = annotations.get(pageId);
    if (!page || !anns || anns.length === 0) return;

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
            page.drawText(sanitizeWinAnsi(line), {
              x: ann.x + marker + 9,
              y: ann.y - 10 - li * 12.5,
              size: 9.5,
              font,
              color: rgb(0.15, 0.15, 0.15),
            });
          });
          break;
        }
        case 'text': {
          const lines = ann.text.split('\n');
          lines.forEach((line, li) => {
            const baseline = ann.y - ann.fontSize * 0.8 - li * ann.fontSize * 1.25;
            page.drawText(sanitizeWinAnsi(line), {
              x: ann.x,
              y: baseline,
              size: ann.fontSize,
              font,
              color,
            });
          });
          break;
        }
      }
    }
  });

  return doc.save();
}
